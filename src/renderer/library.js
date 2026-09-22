'use strict';

// View layer for the meeting library. Everything it can do is bounded by the
// `library` bridge in library-preload.js; it has no Node access and no path of
// its own — a meeting is a folder name it hands back to the main process.
//
// Every string rendered here has been through either a language model or a
// hand-edited file, so it reaches the DOM as text, never as markup.

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const searchingEl = document.getElementById('searching');
const readerEl = document.getElementById('reader');
const placeholder = document.getElementById('placeholder');
const queryEl = document.getElementById('query');
const recordEl = document.getElementById('record');
const recordLabelEl = document.getElementById('record-label');
const recordGlyphEl = recordEl.querySelector('.record-glyph');
const navEls = [...document.querySelectorAll('.nav-item')];
const sectionNameEl = document.getElementById('section-name');

/** The sidebar's features, by the mode each one puts the window in. */
const SECTIONS = { reader: 'Recording', quickcopy: 'Quick copy', settings: 'Settings' };

/**
 * How long quick copy waits after the last keystroke before writing the list.
 * The tray is rebuilt on every save, so this is about not doing that per key.
 */
const QUICK_COPY_SAVE_MS = 600;

/** Mirrors LIMITS in src/main/snippets.js, so the store never has to truncate. */
const QUICK_COPY_MAX = { label: 60, text: 20_000 };

/** Keystrokes settle before the main process reads every transcript on disk. */
const SEARCH_DEBOUNCE_MS = 180;

/**
 * How long the record button waits for the folder list to confirm a click.
 *
 * Stopping runs a whole pipeline, but the confirmation comes from the audio file
 * closing, which is quick. This is only the backstop for the cases that produce
 * no change at all — a recording too short to keep, a start that failed.
 */
const RECORD_CONFIRM_MS = 10_000;

const view = {
  /** Cards currently in the rail, newest first. */
  meetings: [],
  /** Folder name of the open meeting, or null. */
  selected: null,
  /** The meeting the reader is showing, kept so settings can be closed back onto it. */
  meeting: null,
  /** The query the rail was built from, reused to highlight the reader. */
  query: '',
  /** 'notes' | 'transcript' — sticky across meetings, the way a reader expects. */
  tab: 'notes',
  /**
   * Which feature the sidebar has open: 'reader' (Recording — the rail and the
   * meeting it has open), 'quickcopy' or 'settings'. Only the first shows the rail.
   */
  mode: 'reader',
  /** settingsState() from the main process, or null before it has been asked for. */
  settings: null,
  /**
   * Which GGML weights the whisper.cpp install button would fetch.
   *
   * Lives here rather than in settings: nothing has been chosen until the
   * download finishes, and writing a whisperModel that is not on disk is
   * exactly the state the settings pane exists to mark in red.
   */
  whisperPick: 'base',
  /**
   * True while the title is an open text box.
   *
   * The reader redraws whenever the folder changes, and a pipeline finishing
   * elsewhere would otherwise throw away half a typed title.
   */
  renaming: false,
  activity: { recordingId: null, processingIds: [], processing: [] },
  /**
   * What the last record click asked for, until the rail confirms it happened.
   * Recording is started and stopped in the main process, so this window learns
   * the result the same way it learns about a recording started from the tray.
   */
  recordWanted: null,
  /**
   * The microphone test in the settings pane: whether one is running, the last
   * level the dictation worker reported, and the note under the meter.
   */
  micTest: { testing: false, level: 0, note: '' },
  /** The meter's DOM, so a level can move the bar without re-rendering the pane. */
  micTestEls: null,
};

let searchTimer = null;
let recordTimer = null;
/**
 * Sequence number for list requests.
 *
 * A search reads every transcript on disk, so a query over a big folder can
 * take longer than the one typed after it. Without this the slower, older
 * result lands last and the rail ends up showing matches for a query that is no
 * longer in the box.
 */
let listSeq = 0;

// ----------------------------------------------------------------- formatting

const fmtDuration = (seconds) => {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
};

/** mm:ss for a transcript gutter, growing an hours field once there is one. */
const fmtClock = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
};

const fmtTime = (date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * The heading a meeting sits under. Recent days get their name, because that is
 * how someone looking for "the one from Tuesday" thinks about it; anything
 * older is only ever found by month.
 */
function dateGroup(date) {
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  if (date.getFullYear() === new Date().getFullYear()) return date.toLocaleDateString([], { month: 'long' });
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: this string came out of a language model.
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Text with every occurrence of the active query wrapped in a <mark>.
 *
 * Built by splitting on index rather than by replacing into HTML — the whole
 * point of highlighting a transcript is that its content is untrusted.
 *
 * @returns {DocumentFragment}
 */
function highlighted(text, query) {
  const frag = document.createDocumentFragment();
  const needle = query.trim().toLowerCase();
  if (!needle) {
    frag.append(document.createTextNode(text));
    return frag;
  }

  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) frag.append(document.createTextNode(text.slice(from, at)));
    frag.append(el('mark', '', text.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  frag.append(document.createTextNode(text.slice(from)));
  return frag;
}

// ------------------------------------------------------------------ progress

/** Where the pipeline has got to on one meeting, or null if it is not running. */
const progressFor = (id) => (view.activity.processing ?? []).find((p) => p.id === id) ?? null;

/**
 * A pipeline stage, short enough to sit in a card's pill.
 *
 * The tray has said "Transcribing 12/60…" since the pipeline existed while this
 * card said "Working…", and an hour of audio is a long time to be told only
 * that something is happening.
 */
function progressTag(p) {
  if (!p) return 'Working…';
  if (p.phase === 'transcribing' && p.total) return `Transcribing ${p.done}/${p.total}`;
  if (p.phase === 'summarising') return p.total ? `Condensing ${p.done}/${p.total}` : 'Writing notes';
  if (p.phase === 'designing') return 'Designing';
  if (p.phase === 'rendering') return 'Exporting PDF';
  return 'Working…';
}

/** The same thing in a sentence, for the reader where there is room for one. */
function progressSentence(p) {
  if (!p) return 'Starting…';
  if (p.phase === 'transcribing' && p.total) {
    return `Transcribing the audio — chunk ${Math.min(p.done + 1, p.total)} of ${p.total}.`;
  }
  if (p.phase === 'summarising') {
    return p.total ? `Condensing the transcript — part ${p.done + 1} of ${p.total}.` : 'Writing the notes.';
  }
  if (p.phase === 'designing') return 'Designing the printed brief.';
  if (p.phase === 'rendering') return 'Exporting the PDF.';
  return p.label || 'Starting…';
}

/** 0..1 through the run, or null when the stage has nothing to count. */
const progressFraction = (p) => (p && p.total ? Math.min(1, p.done / p.total) : null);

// ------------------------------------------------------------------- the rail

/** What a folder without notes should say for itself, if anything. */
function cardTag(meeting) {
  if (meeting.id === view.activity.recordingId) return { text: 'Recording', className: 'recording' };
  if (view.activity.processingIds.includes(meeting.id)) {
    return { text: progressTag(progressFor(meeting.id)), className: 'working' };
  }
  if (meeting.status === 'failed') return { text: 'Failed', className: 'failed' };
  if (meeting.status === 'unprocessed') return { text: 'No notes', className: '' };
  if (meeting.status === 'pending') return { text: 'Audio only', className: '' };
  return null;
}

function card(meeting) {
  const started = new Date(meeting.startedAt);
  const row = el('button', 'card');
  row.type = 'button';
  row.dataset.id = meeting.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(meeting.id === view.selected));
  if (meeting.id === view.selected) row.classList.add('selected');

  const title = el('div', 'card-title');
  title.append(highlighted(meeting.title, view.query));
  row.append(title);

  const meta = el('div', 'card-meta');
  meta.append(el('span', '', fmtTime(started)));
  if (meeting.durationSeconds) {
    meta.append(el('span', 'dot', '·'), el('span', '', fmtDuration(meeting.durationSeconds)));
  }
  const tag = cardTag(meeting);
  if (tag) meta.append(el('span', `tag ${tag.className}`, tag.text));
  if (meeting.matches) meta.append(el('span', 'tag hits', `${meeting.matches} hit${meeting.matches === 1 ? '' : 's'}`));
  row.append(meta);

  if (meeting.preview) {
    const preview = el('div', 'card-preview');
    preview.append(highlighted(meeting.preview, view.query));
    row.append(preview);
  }

  row.addEventListener('click', () => openMeeting(meeting.id));
  return row;
}

function renderList() {
  const { meetings, query } = view;
  countEl.textContent = query
    ? `${meetings.length} match${meetings.length === 1 ? '' : 'es'}`
    : `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`;

  if (!meetings.length) {
    listEl.replaceChildren(
      el(
        'p',
        'rail-empty',
        query
          ? 'Nothing said in any meeting matches that.'
          : 'No recordings yet. Start one from the tray and it will appear here when the notes are ready.',
      ),
    );
    return;
  }

  const nodes = [];
  let group = '';
  for (const meeting of meetings) {
    const next = dateGroup(new Date(meeting.startedAt));
    if (next !== group) {
      group = next;
      nodes.push(el('div', 'group', group));
    }
    nodes.push(card(meeting));
  }
  listEl.replaceChildren(...nodes);
}

// ----------------------------------------------------------------- the reader

function metaRow(meeting) {
  const started = new Date(meeting.startedAt);
  const bits = [started.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })];
  bits.push(fmtTime(started));
  if (meeting.durationSeconds) bits.push(fmtDuration(meeting.durationSeconds));

  const sources = [meeting.sources.mic && 'mic', meeting.sources.system && 'system audio'].filter(Boolean);
  if (sources.length) bits.push(sources.join(' + '));

  const row = el('div', 'doc-meta');
  bits.forEach((bit, i) => {
    if (i) row.append(el('span', 'dot', '·'));
    row.append(el('span', '', bit));
  });
  return row;
}

// -------------------------------------------------------------- what is copied

/**
 * The transcript as text, with the speaker kept on each line where there is one.
 *
 * Pasting a transcript into anything else is the point of the button, and a
 * two-channel meeting pasted without its labels loses the one thing that
 * separates a transcript from a wall of sentences. `withTimes` prepends each
 * line's `[mm:ss]` — the version for quoting "the bit about pricing" rather
 * than reproducing the meeting.
 */
const transcriptText = (meeting, withTimes = false) =>
  meeting.transcript
    .map((line) => {
      const who = line.speaker ? `${window.library.speakers[line.speaker]}: ` : '';
      const at = withTimes && line.startSeconds !== null ? `[${fmtClock(line.startSeconds)}] ` : '';
      return `${at}${who}${line.text}`;
    })
    .join('\n\n');

/** Just the checkboxes — the thing people actually paste into Slack or Jira. */
const actionItemsMarkdown = (meeting) =>
  meeting.actionItems
    .map((a) => `- [ ] ${a.task}${a.owner ? ` — **${a.owner}**` : ''}${a.due ? ` *(${a.due})*` : ''}`)
    .join('\n');

/**
 * The notes as Markdown.
 *
 * Built here from the structured meeting rather than read back out of
 * notes.md — that file only exists once the pipeline has finished, and this
 * button is at its most useful on the meeting that just landed. It is also the
 * shape "copy the action items" is a subset of.
 */
function notesMarkdown(meeting) {
  const started = new Date(meeting.startedAt);
  const lines = [`# ${meeting.title}`, '', `*${started.toLocaleString()} · ${fmtDuration(meeting.durationSeconds)}*`, ''];

  if (meeting.summary.length) {
    lines.push('## Summary', '');
    for (const bullet of meeting.summary) lines.push(`- ${bullet}`);
    lines.push('');
  }

  lines.push('## Decisions', '');
  if (meeting.decisions.length) {
    for (const d of meeting.decisions) lines.push(`- **${d.decision}**${d.context ? ` — ${d.context}` : ''}`);
  } else {
    lines.push('- *Nothing was settled in this meeting.*');
  }
  lines.push('');

  lines.push('## Action items', '');
  lines.push(actionItemsMarkdown(meeting) || '- *Nobody left with anything to do.*');
  lines.push('');
  return lines.join('\n');
}

// ----------------------------------------------------------------- the actions

/**
 * A button that copies, and says so.
 *
 * The clipboard gives no feedback of its own, and a button that does nothing
 * visible reads as one that did not work.
 */
/**
 * Stroke paths for the side panel's icons, drawn on a 24-unit grid. Fixed
 * strings built with createElementNS — nothing here is ever parsed as markup.
 */
const ICONS = {
  pdf: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6M9 17h4'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  audio: ['M8 5v14l11-7z'],
  copy: ['M8 8h12v12H8z', 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'],
  check: ['M5 12l5 5L20 7'],
  list: ['M9 6h11M9 12h11M9 18h11', 'M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  rename: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
};

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * One row of the side panel: an icon and a label, with a tooltip that says why
 * it is greyed out when it is. A disabled button that does not explain itself
 * reads as a broken one.
 */
function panelButton({ label, tip = label, iconName, className = '', enabled = true, why, action, onClick }) {
  const button = el('button', `panel-button${className ? ` ${className}` : ''}`);
  button.type = 'button';
  if (action) button.dataset.action = action;
  const text = el('span', 'panel-label', label);
  button.append(icon(iconName), text);
  button.disabled = !enabled;
  // The label can be hidden when the panel folds to a row of icons, so the
  // tooltip always says the whole thing.
  button.title = !enabled && why ? why : tip;
  if (enabled) button.addEventListener('click', () => onClick(button, text));
  return button;
}

/**
 * A button that copies, and says so.
 *
 * The clipboard gives no feedback of its own, and a button that does nothing
 * visible reads as one that did not work.
 */
function copyButton(label, enabled, text, { why, action, iconName = 'copy' } = {}) {
  return panelButton({
    label,
    tip: `Copy ${label.toLowerCase()}`,
    iconName,
    enabled,
    why,
    action,
    onClick: (button, labelEl) => {
      window.library.copy(text());
      labelEl.textContent = 'Copied';
      button.classList.add('copied');
      button.firstChild.replaceWith(icon('check'));
      setTimeout(() => {
        labelEl.textContent = label;
        button.classList.remove('copied');
        button.firstChild.replaceWith(icon(iconName));
      }, 1200);
    },
  });
}

/**
 * The meeting's actions, as a panel beside the reading column rather than a
 * row of buttons above it.
 *
 * Grouped by what they do — open a file, copy text out, change the archive —
 * so the eye finds a verb before it reads a label, and pinned while the page
 * scrolls so a transcript read to the end still has its copy button in reach.
 * The destructive group sits last and apart, where it is never clicked on the
 * way to something else.
 */
function actionPanel(meeting) {
  const panel = el('aside', 'doc-panel');
  panel.setAttribute('aria-label', 'Meeting actions');

  const group = (heading, ...buttons) => {
    const section = el('div', 'panel-group');
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', heading);
    section.append(el('div', 'panel-heading', heading), ...buttons);
    panel.append(section);
  };

  const noNotes = meeting.status === 'ready' ? '' : 'Available once the notes are written.';
  const noTranscript = 'Available once there is a transcript.';

  group(
    'Open',
    panelButton({
      label: 'PDF brief',
      tip: 'Open the PDF brief',
      iconName: 'pdf',
      className: 'primary',
      enabled: meeting.files.pdf,
      why: 'The PDF is written with the notes.',
      onClick: () => window.library.open(meeting.id, 'pdf'),
    }),
    panelButton({
      label: 'Play audio',
      iconName: 'audio',
      enabled: meeting.files.audio,
      why: 'This meeting has no audio file.',
      onClick: () => window.library.open(meeting.id, 'audio'),
    }),
    panelButton({
      label: 'Show folder',
      tip: 'Open the meeting folder',
      iconName: 'folder',
      onClick: () => window.library.open(meeting.id, 'folder'),
    }),
  );

  group(
    'Copy',
    copyButton('Notes', meeting.status === 'ready', () => notesMarkdown(meeting), { why: noNotes }),
    // The single most-pasted thing a meeting produces, and until now the only
    // way at it was to open the PDF and retype it.
    copyButton('Action items', meeting.actionItems.length > 0, () => actionItemsMarkdown(meeting), {
      why: 'No action items in this meeting.',
      iconName: 'list',
    }),
    copyButton('Transcript', meeting.transcript.length > 0, () => transcriptText(meeting), {
      why: noTranscript,
      action: 'copy-transcript',
    }),
    // The quote-able version: the same words with each line's [mm:ss] in front.
    // Only offered when the transcript actually has times to quote.
    copyButton(
      'With timestamps',
      meeting.transcript.some((line) => line.startSeconds !== null),
      () => transcriptText(meeting, true),
      { why: 'This transcript has no timestamps.', iconName: 'clock' },
    ),
  );

  // Editing the archive sits apart from reading it, at the bottom of the panel.
  group(
    'Manage',
    panelButton({ label: 'Rename', tip: 'Rename this meeting', iconName: 'rename', onClick: () => startRename(meeting) }),
    panelButton({
      label: 'Delete',
      tip: 'Move this meeting to the Recycle Bin',
      iconName: 'trash',
      className: 'danger',
      onClick: (button) => removeMeeting(meeting, button),
    }),
  );
  return panel;
}

/**
 * Turns the title into a text box.
 *
 * A meeting is called whatever the summariser made of it, for ever — which is
 * how an archive becomes a hundred rows of "Weekly Sync Discussion". The folder
 * name is left alone: it is the meeting's id everywhere else, and a timestamp
 * is a better permanent name than anything typed in a hurry.
 */
function startRename(meeting) {
  const heading = readerEl.querySelector('.doc-header h1');
  if (!heading || view.renaming) return;
  view.renaming = true;

  const input = el('input', 'title-input');
  input.type = 'text';
  input.value = meeting.title;
  input.maxLength = 120;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Meeting title');
  heading.replaceChildren(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    view.renaming = false;
    const wanted = input.value.trim();
    // Unchanged, or cancelled: put the heading back without a round trip.
    if (!save || wanted === meeting.title) {
      renderReader(meeting);
      return;
    }
    const result = await window.library.rename(meeting.id, wanted);
    // A rename changes the rail as well as the reader, so the refresh behind
    // library:changed is what redraws this — but a failure never fires one, and
    // the pane must not be left holding a dead input.
    if (!result?.ok) renderReader(meeting);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      // Stop it reaching the window handler, which reads Escape as "close".
      e.stopPropagation();
      e.preventDefault();
      finish(false);
    }
  });
  // Clicking away commits, the way a rename does everywhere else.
  input.addEventListener('blur', () => finish(true));
}

/**
 * Deletes a meeting, once the main process has asked whether that is meant.
 *
 * The confirmation is raised there rather than here: this is the one thing the
 * window can do that destroys work, and a page cannot be the thing that
 * vouches for having asked first.
 */
async function removeMeeting(meeting, button) {
  button.disabled = true;
  const result = await window.library.delete(meeting.id);
  if (result?.ok) {
    // The folder is gone; the refresh behind library:changed drops the card.
    view.selected = null;
    view.meeting = null;
    renderPlaceholder();
    return;
  }
  button.disabled = false;
  // No reason means the confirmation was declined, which needs no comment.
  if (result?.reason) button.parentElement?.append(el('span', 'notice-warn', result.reason));
}

function tabs(meeting) {
  const bar = el('div', 'tabs');
  const options = [
    ['notes', 'Notes'],
    ['transcript', meeting.transcript.length ? `Transcript · ${meeting.transcript.length}` : 'Transcript'],
  ];
  for (const [id, label] of options) {
    const button = el('button', `tab${view.tab === id ? ' active' : ''}`, label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(view.tab === id));
    button.addEventListener('click', () => {
      if (view.tab === id) return;
      view.tab = id;
      // The tab someone reads in is a habit, not a decision — keep it across
      // meetings and across launches.
      sessionStorage.setItem('minarrador:tab', id);
      renderReader(meeting);
    });
    bar.append(button);
  }
  return bar;
}

/**
 * The button that finishes a meeting the pipeline never did.
 *
 * The most likely failure in the app is Ollama not running at the moment Stop
 * was pressed, and the audio is always kept — so this is the difference between
 * a folder that is a dead WAV and one that is a meeting. It replaces an
 * instruction to run `npm run pipeline`, which assumed a checkout nobody who
 * installed the app has.
 *
 * The click is confirmed by the folder changing under us: main starts the run
 * and returns immediately, and the `library:changed` that follows rebuilds this
 * pane with the "Still working" notice in place of the button.
 */
function generateButton(meeting) {
  const wrap = el('div', 'notice-actions');
  const label = meeting.status === 'failed' ? 'Try again' : 'Generate notes';
  const button = el('button', 'button primary', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Starting…';
    const result = await window.library.reprocess(meeting.id);
    if (result?.ok) return;
    button.disabled = false;
    button.textContent = label;
    wrap.append(el('span', 'notice-warn', result?.reason || 'Could not start that run.'));
  });

  wrap.append(button, el('span', 'notice-hint', 'Transcribes the saved audio again and rewrites the notes.'));
  return wrap;
}

/**
 * The "this is still running" notice, with where it has got to.
 *
 * The numbers were already being produced — the tray has shown them since the
 * pipeline existed — they simply never left the main process. An hour of audio
 * is a long time to be told only that something is happening.
 */
function workingNotice(meeting) {
  const notice = el('div', 'notice');
  notice.append(
    el('strong', '', 'Still working. '),
    'Transcription and notes are running now — this page fills in when they land.',
  );

  const p = progressFor(meeting.id);
  notice.append(el('div', 'notice-progress', progressSentence(p)));
  const track = el('div', 'progress-track');
  const bar = el('div', 'progress-bar');
  const fraction = progressFraction(p);
  // No bar at all rather than an empty one for a stage with nothing to count:
  // a bar stuck at zero reads as a run that is not moving.
  track.classList.toggle('indeterminate', fraction === null);
  bar.style.width = fraction === null ? '100%' : `${Math.round(fraction * 100)}%`;
  track.append(bar);
  notice.append(track);
  return notice;
}

/** The "there are no notes here" explanation, phrased for why there are none. */
function notesNotice(meeting) {
  if (view.activity.processingIds.includes(meeting.id)) return workingNotice(meeting);
  const notice = el('div', 'notice');
  if (meeting.id === view.activity.recordingId) {
    notice.append(el('strong', '', 'Recording. '), 'Notes are written once you stop, from a full pass over the saved audio.');
    return notice;
  }

  if (meeting.status === 'failed') {
    notice.append(
      el('strong', '', 'The notes run failed. '),
      'The audio is safe in this folder, so nothing is lost — fix what went wrong and run it again.',
    );
    // Quoted rather than pointed at: it is one sentence, and it is almost always
    // the reason the button below would fail too.
    if (meeting.error) notice.append(el('div', 'notice-error', meeting.error));
  } else {
    notice.append(
      el('strong', '', 'No notes for this recording. '),
      'The audio was saved but the pipeline never finished.',
    );
  }
  if (meeting.files.audio) notice.append(generateButton(meeting));
  return notice;
}

function notesView(meeting) {
  const frag = document.createDocumentFragment();
  if (meeting.status !== 'ready') {
    frag.append(notesNotice(meeting));
    if (!meeting.transcript.length) return frag;
  }

  if (meeting.summary.length) {
    frag.append(el('h2', '', 'Summary'));
    const ul = el('ul', 'bullets');
    for (const bullet of meeting.summary) {
      const li = el('li');
      li.append(highlighted(bullet, view.query));
      ul.append(li);
    }
    frag.append(ul);
  }

  if (meeting.status === 'ready') {
    frag.append(el('h2', '', 'Decisions'));
    if (meeting.decisions.length) {
      for (const d of meeting.decisions) {
        const block = el('div', 'decision');
        block.append(highlighted(d.decision, view.query));
        if (d.context) block.append(el('span', 'why', d.context));
        frag.append(block);
      }
    } else {
      frag.append(el('p', 'none', 'Nothing was settled in this meeting.'));
    }

    frag.append(el('h2', '', 'Action items'));
    if (meeting.actionItems.length) {
      for (const a of meeting.actionItems) {
        const row = el('div', 'action');
        // A meeting with a transcript can be jumped to where the action was
        // actually said — the click is what makes the summary a map instead of
        // a list. Rows without one stay plain text.
        if (meeting.transcript.length) {
          row.classList.add('linkable');
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.setAttribute('title', 'Show where this was said in the transcript');
          row.addEventListener('click', () => jumpToAction(meeting, a));
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              jumpToAction(meeting, a);
            }
          });
        }
        row.append(el('span', 'box'));
        const task = el('span', 'task');
        task.append(highlighted(a.task, view.query));
        row.append(task);
        if (a.owner) row.append(el('span', 'owner', a.owner));
        if (a.due) row.append(el('span', 'due', a.due));
        frag.append(row);
      }
    } else {
      frag.append(el('p', 'none', 'Nobody left with anything to do.'));
    }
  }
  return frag;
}

/**
 * Jumps from an action item to the transcript lines that produced it.
 *
 * The notes model does not record which segment a task came from, so this is a
 * best-effort match rather than a link: the owner's name, then the meaningful
 * words of the task, scored against each line. The best match is picked out of
 * the rendered transcript and flashed, which turns the summary from a list into
 * a map of the meeting.
 */
function jumpToAction(meeting, action) {
  if (!meeting.transcript.length) return;
  view.tab = 'transcript';
  renderReader(meeting);

  const owner = (action.owner || '').trim().toLowerCase();
  const words = (action.task || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  const terms = [...new Set(owner ? [owner, ...words] : words)].filter(Boolean);
  if (!terms.length) return;

  const scored = meeting.transcript
    .map((line, i) => {
      const text = line.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!text.includes(term)) continue;
        // The owner's name carries the line, so one mention of it outweighs a
        // task word — but never lets a wrong line win.
        score += term === owner ? 4 : 1;
      }
      return { i, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return;

  const row = readerEl.querySelectorAll('.line')[scored[0].i];
  if (!row) return;
  row.classList.add('jump');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => row.classList.remove('jump'), 2500);
}

function transcriptView(meeting) {
  const frag = document.createDocumentFragment();
  if (!meeting.transcript.length) {
    // A run in progress is the most likely reason this tab is empty, and the
    // transcript is the artefact it is producing — so this is the tab someone
    // watches it on. "Not been transcribed yet" while it is being transcribed
    // is the same silence the card's bare "Working…" used to be.
    if (view.activity.processingIds.includes(meeting.id)) {
      frag.append(workingNotice(meeting));
      return frag;
    }

    const notice = el('div', 'notice');
    notice.append(
      el('strong', '', 'No transcript. '),
      meeting.files.audio
        ? 'The recording has not been transcribed yet.'
        : 'This folder has no audio in it either.',
    );
    // Same button as the notes tab, and the same two states it must not offer
    // itself in: nothing to work from, and a meeting still recording.
    const busy = meeting.id === view.activity.recordingId;
    if (meeting.files.audio && meeting.status !== 'ready' && !busy) notice.append(generateButton(meeting));
    frag.append(notice);
    return frag;
  }

  // Lines kept from the live preview are a different thing from a transcript:
  // rougher, untimed, and missing whatever was said while the engine was busy.
  // Saying so is what keeps them useful rather than misleading.
  if (meeting.transcriptSource === 'live') {
    const notice = el('div', 'notice');
    notice.append(
      el('strong', '', 'Rough live transcript. '),
      'This is what the preview heard while the meeting ran, kept because the full pass never happened. ' +
        'Generating the notes replaces it with a careful transcription of the saved audio.',
    );
    frag.append(notice);
  }

  for (const line of meeting.transcript) {
    const row = el('div', 'line');
    // Timestamps come from the chunk boundaries the pipeline transcribed at, so
    // a line is placed to the minute, not to the word. Better than no anchor at
    // all when scrubbing back to "the bit about pricing".
    row.append(el('span', 'at', line.startSeconds === null ? '' : fmtClock(line.startSeconds)));
    const said = el('span', 'said');
    // The microphone and the system audio were recorded on separate channels
    // and transcribed separately, so a line already knows which side of the
    // call it came from. Nobody has to have said a name out loud.
    if (line.speaker) said.append(el('span', `who ${line.speaker}`, meeting.speakers?.[line.speaker] ?? line.speaker));
    said.append(highlighted(line.text, view.query));
    row.append(said);
    frag.append(row);
  }
  return frag;
}

function renderReader(meeting) {
  // The heading spans the page; below it the reading column and the actions
  // panel sit side by side, so nothing but the meeting stands between the
  // title and what was said.
  const page = el('div', 'doc-page');
  const header = el('header', 'doc-header');
  const title = el('h1');
  title.append(highlighted(meeting.title, view.query));
  header.append(title, metaRow(meeting));

  const doc = el('div', 'doc');
  doc.append(tabs(meeting));
  doc.append(view.tab === 'transcript' ? transcriptView(meeting) : notesView(meeting));

  const body = el('div', 'doc-body');
  body.append(doc, actionPanel(meeting));
  page.append(header, body);
  readerEl.replaceChildren(page);
}

// --------------------------------------------------------------- the settings

// Everything the tray's Settings submenu used to hold, plus the one thing a
// submenu could not show: whether the value a setting names is actually there.
// A model that was never pulled and a model that is running look identical in a
// radio list, and the difference is the whole meeting's notes — so a setting
// pointing at something missing is marked, in red, with what to do about it.

/** A row that is a checkbox: the whole label toggles it. */
function toggleRow({ title, hint, alert: alertText, key, checked, disabled }) {
  const row = el('label', `row${alertText ? ' missing' : ''}`);
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', 'row-alert', alertText));

  const box = el('input', 'switch');
  box.type = 'checkbox';
  box.checked = Boolean(checked);
  box.disabled = Boolean(disabled);
  box.addEventListener('change', () => saveSetting({ [key]: box.checked }));

  row.append(body, box);
  return row;
}

/**
 * A row that is a dropdown.
 *
 * `missing` is the red state: the value in settings.json is not among the
 * options, because whatever it names is not installed any more. The value stays
 * selected rather than being silently swapped for the first thing in the list —
 * the app already does that for models when it can, and where it cannot, saying
 * so is more useful than pretending.
 */
function selectRow({ title, hint, alert: alertText, note, ok, options, value, missing, disabled, onPick }) {
  const row = el('div', `row${missing ? ' missing' : ''}`);
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', missing ? 'row-alert' : 'row-hint', alertText));
  if (note) body.append(el('span', 'row-hint', note));
  if (ok) body.append(el('span', 'row-ok', ok));

  const picker = el('select', 'control');
  picker.disabled = Boolean(disabled) || options.length === 0;
  for (const option of options) {
    const node = el('option', '', option.label);
    node.value = option.value;
    node.selected = option.value === value;
    picker.append(node);
  }
  picker.addEventListener('change', () => onPick(picker.value));

  row.append(body, picker);
  return row;
}

/** A row whose control is a button: a folder to pick, an app to start, a list to edit. */
function buttonRow({ title, hint, alert: alertText, ok, value, missing, label, primary, disabled, onClick }) {
  const row = el('div', `row${missing ? ' missing' : ''}`);
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (value) body.append(el('span', 'value', value));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', missing ? 'row-alert' : 'row-hint', alertText));
  if (ok) body.append(el('span', 'row-ok', ok));

  const button = el('button', `button${primary ? ' primary' : ''}`, label);
  button.type = 'button';
  button.disabled = Boolean(disabled);
  button.addEventListener('click', () => onClick(button));

  row.append(body, button);
  return row;
}

/**
 * A row that is a dropdown *and* a button: pick a thing, then fetch it.
 *
 * Only used by the two first-run downloads, where the choice and the action
 * belong to the same sentence — "install whisper.cpp with these weights" is one
 * decision, and splitting it across two rows would read as two.
 */
function downloadRow({ title, hint, alert: alertText, options, value, onPick, label, disabled, onClick }) {
  const row = el('div', 'row missing');
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', 'row-alert', alertText));

  const controls = el('span', 'row-controls');
  if (options) {
    const picker = el('select', 'control narrow');
    for (const option of options) {
      const node = el('option', '', option.label);
      node.value = option.value;
      node.selected = option.value === value;
      picker.append(node);
    }
    picker.disabled = Boolean(disabled);
    picker.addEventListener('change', () => onPick(picker.value));
    controls.append(picker);
  }

  const button = el('button', 'button primary', label);
  button.type = 'button';
  button.disabled = Boolean(disabled);
  button.addEventListener('click', () => onClick(button));
  controls.append(button);

  row.append(body, controls);
  return row;
}

/**
 * The download in flight, wherever it was started from.
 *
 * At the top of the pane rather than in the section that launched it: it is
 * minutes of work with nothing else to look at, and burying it under a section
 * heading would mean scrolling to find out whether it is still going.
 */
function setupRow(setup) {
  const row = el('div', 'row');
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', `Downloading ${setup.label}`));
  const detail = setup.total
    ? `${setup.status} — ${fmtBytes(setup.completed)} of ${fmtBytes(setup.total)}`
    : setup.status || 'starting…';
  body.append(el('span', 'row-hint', detail));

  const track = el('div', 'progress-track');
  const bar = el('div', 'progress-bar');
  track.classList.toggle('indeterminate', !setup.total);
  bar.style.width = setup.total ? `${Math.round((setup.completed / setup.total) * 100)}%` : '100%';
  track.append(bar);
  body.append(track);

  const button = el('button', 'button', 'Cancel');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    view.settings = await window.library.settings.cancelSetup();
    if (view.mode === 'settings') renderSettings();
  });

  row.append(body, button);
  return row;
}

const group = (frag, heading, rows) => {
  frag.append(el('h2', '', heading));
  const box = el('div', 'rows');
  box.append(...rows);
  frag.append(box);
};

/**
 * "Default: x", but only once the value has been moved off it.
 *
 * A pane that reprinted the default beside every row would be noise; the useful
 * moment is the one where a setting is no longer what the app shipped with, and
 * the person reading it wants to know what it used to be.
 */
const defaultNote = (value, fallback, label = fallback) =>
  fallback === undefined || value === fallback ? '' : `Default: ${label}`;

/** Options for a model dropdown, keeping a value that is no longer installed. */
function modelOptions(names, current, suffix = () => '') {
  const options = names.map((name) => ({ value: name, label: `${name}${suffix(name)}` }));
  if (current && !names.includes(current)) {
    options.unshift({ value: current, label: `${current} — not installed` });
  }
  return options;
}

/** "20 minutes", "4 hours", or the word for the value that turns a limit off. */
function minuteOptions(values, never) {
  return values.map((n) => ({
    value: String(n),
    label: n === 0 ? never : n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'}` : `${n} minutes`,
  }));
}

const SILENCE_CHOICES = [0, 5, 10, 15, 30, 60];
const MAX_LENGTH_CHOICES = [0, 60, 120, 180, 240, 480];

const fmtBytes = (bytes) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

function recordingSection(frag, s) {
  const noSource = !s.settings.captureMic && !s.settings.captureSystem;
  const hotkeyOff = s.hotkey.value === 'off';
  const hotkeyDefault = s.hotkey.choices.find((c) => c.value === s.defaults.hotkey);
  group(frag, 'Recording', [
    selectRow({
      title: 'Start and stop shortcut',
      hint: 'Works anywhere in Windows, so a call can be recorded without hunting for the tray icon first.',
      // A shortcut another application already holds registers as nothing at
      // all — the one failure here that looks exactly like success.
      alert: hotkeyOff || s.hotkey.registered ? '' : 'Another application already holds this shortcut. Pick a different one.',
      missing: !hotkeyOff && !s.hotkey.registered,
      options: s.hotkey.choices,
      value: s.hotkey.value,
      note: defaultNote(s.hotkey.value, s.defaults.hotkey, hotkeyDefault?.label ?? s.defaults.hotkey),
      onPick: (value) => saveSetting({ hotkey: value }),
    }),
    toggleRow({
      title: 'Suggest recording when audio is detected',
      hint: 'Minarrador watches the levels while idle and offers to start a meeting.',
      key: 'suggestOnAudio',
      checked: s.settings.suggestOnAudio,
    }),
    toggleRow({
      title: 'Start Minarrador at login',
      hint: 'Starts hidden, in the tray.',
      key: 'startAtLogin',
      checked: s.settings.startAtLogin,
    }),
    toggleRow({
      title: 'Open the live transcript when recording starts',
      hint: 'A rough preview while the meeting runs. The saved transcript is a separate, fuller pass.',
      key: 'liveTranscript',
      checked: s.settings.liveTranscript,
    }),
    toggleRow({
      title: 'Record the microphone',
      hint: s.recording ? 'Cannot be changed while a meeting is recording.' : 'Your side of the conversation.',
      alert: noSource ? 'Both sources are off — a recording would capture nothing.' : '',
      key: 'captureMic',
      checked: s.settings.captureMic,
      disabled: s.recording,
    }),
    toggleRow({
      title: 'Record system audio',
      hint: s.recording ? 'Cannot be changed while a meeting is recording.' : 'Everyone else, as your speakers hear them.',
      alert: noSource ? 'Both sources are off — a recording would capture nothing.' : '',
      key: 'captureSystem',
      checked: s.settings.captureSystem,
      disabled: s.recording,
    }),
    micRow(s),
    micTestRow(),
    toggleRow({
      title: 'Keep the two sources on separate channels',
      hint:
        'Records you on the left and everyone else on the right, so the transcript can say who said what ' +
        'and the notes can name who owns an action item. Costs about twice the disk.',
      key: 'separateChannels',
      checked: s.settings.separateChannels,
      disabled: s.recording,
    }),
  ]);

  group(frag, 'Limits', [
    selectRow({
      title: 'Stop after silence',
      hint: 'Ends a meeting that nobody stopped. The notes are written from what was actually said.',
      options: minuteOptions(SILENCE_CHOICES, 'Never'),
      value: String(s.settings.silenceStopMinutes),
      note: defaultNote(
        s.settings.silenceStopMinutes,
        s.defaults.silenceStopMinutes,
        `${s.defaults.silenceStopMinutes} minutes`,
      ),
      onPick: (value) => saveSetting({ silenceStopMinutes: Number(value) }),
    }),
    selectRow({
      title: 'Longest recording',
      // The backstop for the first one failing to notice: hold music, a fan the
      // microphone can hear, a call left connected over a weekend.
      hint: 'A hard ceiling. Minarrador stops and writes the notes when a meeting reaches it.',
      alert:
        s.settings.silenceStopMinutes === 0 && s.settings.maxRecordingMinutes === 0
          ? 'Nothing will stop a recording you forget about.'
          : '',
      missing: s.settings.silenceStopMinutes === 0 && s.settings.maxRecordingMinutes === 0,
      options: minuteOptions(MAX_LENGTH_CHOICES, 'No limit'),
      value: String(s.settings.maxRecordingMinutes),
      note: defaultNote(
        s.settings.maxRecordingMinutes,
        s.defaults.maxRecordingMinutes,
        `${s.defaults.maxRecordingMinutes / 60} hours`,
      ),
      onPick: (value) => saveSetting({ maxRecordingMinutes: Number(value) }),
    }),
    toggleRow({
      title: 'Keep the machine awake while recording',
      // Honest about what it can and cannot do: Windows suspends on a lid close
      // whatever this says, which is why the app also rebuilds on resume.
      hint:
        'Stops Windows suspending an idle machine mid-meeting. Closing the lid still suspends it — Minarrador ' +
        'rebuilds the audio graph on wake and carries on into the same file.',
      key: 'preventSleep',
      checked: s.settings.preventSleep,
    }),
  ]);
}

/**
 * Which microphone is being recorded — and, when it is not the chosen one, that
 * it is not.
 *
 * The gap this exists for: `getUserMedia` with no deviceId takes the Windows
 * default, so a meeting can record the laptop lid while the headset sits
 * unused, and every indicator in the app says the microphone is fine.
 */
function micRow(s) {
  const { devices, active, chosen, chosenLabel } = s.mic;
  const known = devices.some((d) => d.id === chosen);
  const options = [{ value: '', label: 'System default' }, ...devices.map((d) => ({ value: d.id, label: d.label }))];
  if (chosen && !known) options.push({ value: chosen, label: `${chosenLabel || 'Chosen device'} — not connected` });

  return selectRow({
    title: 'Microphone',
    hint: devices.length
      ? 'Which input your side of the conversation is recorded from.'
      : 'Available once Minarrador has opened a microphone at least once.',
    // Naming what is open is the whole point: a green tick next to "Mic" only
    // ever meant that something opened.
    ok: active ? `Recording from ${active}` : '',
    alert: chosen && !known ? 'That device is not connected. The system default is being used instead.' : '',
    missing: Boolean(chosen) && !known,
    options,
    value: chosen,
    disabled: !s.settings.captureMic || s.recording || !devices.length,
    onPick: (value) =>
      saveSetting({
        micDeviceId: value,
        // Stored alongside because Chromium's ids are salted per origin and are
        // not guaranteed to come back the same after a restart.
        micDeviceLabel: devices.find((d) => d.id === value)?.label ?? '',
      }),
  });
}

/**
 * The "Test microphone" row: a button that opens the chosen mic and a meter
 * that shows what it hears, so "is it my mic or the app?" is answered without
 * recording anything. It borrows the dictation worker, which already opens the
 * mic on demand and reports an RMS level — a test is a session that records
 * nothing and transcribes nothing.
 */
function micTestRow() {
  const t = view.micTest;
  const row = el('div', 'row');
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', 'Test microphone'));

  const note = el('span', 'row-hint', t.note || 'Opens the chosen microphone and shows what it hears. Nothing is recorded.');
  const track = el('div', 'mic-meter');
  const bar = el('div', 'mic-meter-bar');
  bar.style.width = `${Math.min(100, Math.round(t.level * 600))}%`;
  track.append(bar);
  body.append(note, track);

  const button = el('button', `button${t.testing ? ' danger' : ''}`, t.testing ? 'Stop' : 'Test');
  button.type = 'button';
  button.addEventListener('click', async () => {
    if (view.micTest.testing) {
      window.library.settings.testMicStop();
      view.micTest = { testing: false, level: 0, note: '' };
      if (view.mode === 'settings') renderSettings();
      return;
    }
    const result = await window.library.settings.testMicStart();
    if (!result?.ok) {
      view.micTest = { testing: false, level: 0, note: result?.reason || 'Could not open the microphone.' };
      if (view.mode === 'settings') renderSettings();
      return;
    }
    view.micTest = { testing: true, level: 0, note: '' };
    if (view.mode === 'settings') renderSettings();
  });

  view.micTestEls = { note, bar, button };
  row.append(body, button);
  return row;
}

function liveSection(frag, s) {
  const whisper = s.whisper;
  const installed = Boolean(whisper?.available);
  const wantsWhisper = s.settings.liveEngine === 'whisper';
  const models = whisper?.models ?? [];
  const model = whisper?.model ?? '';
  const busy = Boolean(s.setup);

  const rows = [];
  // The way out of "this app cannot transcribe anything". It used to say `npm
  // run whisper:setup`, which needs a checkout, npm and a terminal — none of
  // which exist for anyone who installed the build, so the app shipped able to
  // be in a state it could not get out of.
  if (!installed) {
    rows.push(
      downloadRow({
        title: 'Install whisper.cpp',
        hint:
          'A local speech recogniser: several times faster than the audio model, and it means Ollama is only ' +
          'needed for the notes. Downloaded once, from GitHub and Hugging Face. No meeting data is involved.',
        alert: 'Not installed. Transcription falls back to the Ollama audio model, which takes about as long as the meeting did.',
        options: s.whisperModels,
        value: view.whisperPick,
        onPick: (value) => {
          view.whisperPick = value;
        },
        label: busy ? 'Downloading…' : 'Download',
        disabled: busy,
        onClick: async () => {
          const result = await window.library.settings.installWhisper(view.whisperPick);
          view.settings = await window.library.settings.get();
          if (view.mode === 'settings') renderSettings();
          return result;
        },
      }),
    );
  }

  rows.push(
    selectRow({
      title: 'Engine',
      hint: 'whisper.cpp is a local speech recogniser and runs several times faster than the audio model.',
      alert: wantsWhisper && !installed ? 'whisper.cpp is not installed — falling back to Ollama.' : '',
      missing: wantsWhisper && !installed,
      options: [
        { value: 'whisper', label: installed ? `whisper.cpp — ${model}` : 'whisper.cpp — not installed' },
        { value: 'ollama', label: `Ollama — ${s.settings.transcribeModel}` },
      ],
      value: s.settings.liveEngine,
      note: defaultNote(s.settings.liveEngine, s.defaults.liveEngine, 'whisper.cpp'),
      onPick: (value) => saveSetting({ liveEngine: value }),
    }),
    selectRow({
      title: 'Whisper model',
      hint: 'Bigger weights are more accurate and slower. Captions trail further behind as they grow.',
      alert: installed ? '' : 'No GGML models yet — install one above.',
      note: defaultNote(model, s.defaults.whisperModel),
      missing: !installed,
      options: modelOptions(models, model),
      value: model,
      disabled: !installed,
      onPick: (value) => saveSetting({ whisperModel: value }),
    }),
    selectRow({
      title: 'Whisper decode threads',
      hint: 'The large models need more than the automatic share to keep up with the room. Applies to the next segment.',
      note: defaultNote(whisper?.threads ?? 0, s.defaults.whisperThreads, 'automatic'),
      options: (whisper?.threadChoices ?? [0]).map((n) => ({
        value: String(n),
        label: n === 0 ? `Automatic (${whisper?.effectiveThreads ?? 4})` : `${n} threads`,
      })),
      value: String(whisper?.threads ?? 0),
      disabled: !installed,
      onPick: (value) => saveSetting({ whisperThreads: Number(value) }),
    }),
  );

  group(frag, 'Live transcript', rows);
}

function ollamaSection(frag, s) {
  const { models, audioModels, ollama } = s;
  const audio = new Set(audioModels);
  const missingTranscribe = !models.includes(s.settings.transcribeModel);
  const missingSummary = !models.includes(s.settings.summaryModel);
  const whisperInstalled = Boolean(s.whisper?.available);
  const whisperModel = s.whisper?.model ?? '';
  const wantsWhisper = s.settings.transcribeEngine === 'whisper';
  const busy = Boolean(s.setup);

  // A running Ollama with nothing pulled is the other half of an install that
  // cannot work, and `ollama pull` in a terminal is not an answer for anyone
  // who arrived here via an installer. Only the models this app is set to use
  // are on offer — main refuses anything else, so no tag typed anywhere could
  // reach the daemon.
  const pulls = (s.pullable ?? []).map((name) =>
    downloadRow({
      title: `Download ${name}`,
      hint: 'Ollama fetches this to your machine and Minarrador uses it from there. It is the model the settings below name.',
      alert: 'Configured but not installed. Nothing can be transcribed or summarised until it is.',
      label: busy ? 'Downloading…' : 'Download',
      disabled: busy || !ollama.up,
      onClick: async () => {
        const result = await window.library.settings.pullModel(name);
        view.settings = await window.library.settings.get();
        if (view.mode === 'settings') renderSettings();
        return result;
      },
    }),
  );

  group(frag, 'Transcription and notes', [
    ...(ollama.up ? pulls : []),
    buttonRow({
      title: 'Ollama',
      value: ollama.host,
      hint: 'Writes the saved transcript and the notes. Nothing is sent anywhere else.',
      alert: ollama.up
        ? ''
        : ollama.installed
          ? 'Not running. A meeting stopped now would keep its audio but get no notes.'
          : 'Not installed on this machine. Get it from https://ollama.com/download, then pull a model.',
      ok: ollama.up ? `Running · ${models.length} model${models.length === 1 ? '' : 's'} installed` : '',
      missing: !ollama.up,
      label: ollama.checking ? 'Starting…' : 'Open Ollama',
      primary: !ollama.up,
      disabled: ollama.up || ollama.checking || !ollama.installed,
      onClick: async () => {
        // The main process starts the daemon and waits for it to answer, which
        // takes seconds; the pane redraws from settings:changed either way.
        view.settings = await window.library.settings.openOllama();
        if (view.mode === 'settings') renderSettings();
      },
    }),
    selectRow({
      title: 'Saved transcript engine',
      hint:
        'whisper.cpp reads an hour of audio in a few minutes on the default weights, and needs nothing ' +
        'from Ollama — which is then only required for the notes.',
      alert: wantsWhisper && !whisperInstalled
        ? 'whisper.cpp is not installed — the audio model transcribes instead. Run npm run whisper:setup.'
        : '',
      missing: wantsWhisper && !whisperInstalled,
      options: [
        { value: 'whisper', label: whisperInstalled ? `whisper.cpp — ${whisperModel}` : 'whisper.cpp — not installed' },
        { value: 'ollama', label: `Ollama — ${s.settings.transcribeModel}` },
      ],
      value: s.settings.transcribeEngine,
      note: defaultNote(s.settings.transcribeEngine, s.defaults.transcribeEngine, 'whisper.cpp'),
      onPick: (value) => saveSetting({ transcribeEngine: value }),
    }),
    selectRow({
      title: 'Transcription model',
      hint: 'The audio model, used for the saved transcript and the live preview whenever whisper.cpp is not.',
      alert: models.length ? '' : 'No models to choose from while Ollama is unreachable.',
      missing: missingTranscribe,
      note: defaultNote(s.settings.transcribeModel, s.defaults.transcribeModel),
      options: modelOptions(models, s.settings.transcribeModel, (name) => (audio.has(name) ? ' · audio' : '')),
      value: s.settings.transcribeModel,
      disabled: !models.length,
      onPick: (value) => saveSetting({ transcribeModel: value }),
    }),
    selectRow({
      title: 'Notes model',
      hint: 'Turns the transcript into the summary, decisions and action items.',
      alert: models.length ? '' : 'No models to choose from while Ollama is unreachable.',
      missing: missingSummary,
      note: defaultNote(s.settings.summaryModel, s.defaults.summaryModel),
      options: modelOptions(models, s.settings.summaryModel),
      value: s.settings.summaryModel,
      disabled: !models.length,
      onPick: (value) => saveSetting({ summaryModel: value }),
    }),
  ]);
}

function storageSection(frag, s) {
  const free = s.disk?.free ?? null;
  // Two channels is ~230 MB an hour, one is ~115. Saying so beside the number
  // is what turns "41 GB free" into something anyone can act on.
  const space = free === null ? '' : `${fmtBytes(free)} free — about ${Math.floor(free / (230 * 1024 ** 2))} hours of recording`;

  group(frag, 'Storage and shorthands', [
    buttonRow({
      title: 'Meetings folder',
      value: s.settings.notesDir,
      hint: 'One folder per recording: the audio, the transcript, the notes and the PDF brief.',
      alert: !s.notesDirExists
        ? 'This folder does not exist any more. Pick another, or the library stays empty.'
        : s.disk?.low
          ? `Running out of space — ${space}.`
          : '',
      ok: s.notesDirExists && !s.disk?.low && space ? space : '',
      missing: !s.notesDirExists || Boolean(s.disk?.low),
      label: 'Change…',
      onClick: async () => {
        view.settings = await window.library.settings.chooseNotesFolder();
        if (view.mode === 'settings') renderSettings();
      },
    }),
    buttonRow({
      title: 'Quick copy',
      hint: s.snippetCount
        ? `${s.snippetCount} shorthand${s.snippetCount === 1 ? '' : 's'} at the top of the tray menu, one click to the clipboard.`
        : 'Phrases you type all day, one click from the tray menu to the clipboard.',
      alert: s.snippetCount ? '' : 'Nothing saved yet — the tray section is empty until you add one.',
      label: 'Edit quick copy…',
      onClick: () => showSection('quickcopy'),
    }),
  ]);
}

/**
 * A button that says whether it worked, in place, then goes back to its label.
 * A diagnostics copy or a capture restart otherwise has no visible result.
 */
async function runAction(button, busy, done, action) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busy;
  const ok = await action().catch(() => false);
  button.textContent = ok ? done : 'Failed';
  setTimeout(() => {
    button.textContent = label;
    button.disabled = false;
  }, 1500);
}

function troubleshootingSection(frag) {
  group(frag, 'Troubleshooting', [
    buttonRow({
      title: 'Log file',
      hint: 'What Minarrador has been doing, kept on this machine. The first thing to look at when something failed.',
      label: 'Open log file',
      onClick: (button) => runAction(button, 'Opening…', 'Opened', () => window.library.settings.openLog()),
    }),
    buttonRow({
      title: 'Diagnostics',
      hint: 'Versions, engines, devices and settings as text on the clipboard — no audio or transcripts.',
      label: 'Copy diagnostics',
      onClick: (button) => runAction(button, 'Copying…', 'Copied', () => window.library.settings.copyDiagnostics()),
    }),
    buttonRow({
      title: 'Audio capture',
      hint: 'Rebuilds the microphone and system-audio capture. A recording in progress continues into the same file.',
      label: 'Restart audio capture',
      onClick: (button) => runAction(button, 'Restarting…', 'Restarted', () => window.library.settings.restartCapture()),
    }),
  ]);
}

function voiceSection(frag, s) {
  const dh = s.dictateHotkey ?? { value: 'off', registered: false, choices: [] };
  const whisperInstalled = Boolean(s.whisper?.available);
  group(frag, 'Voice input', [
    selectRow({
      title: 'Dictate shortcut',
      hint:
        'Press it to start the microphone, press it again to stop, transcribe and paste. ' +
        'Works anywhere in Windows, like the recording shortcut.',
      alert:
        dh.value === 'off' || dh.registered ? '' : 'Another application already holds this shortcut. Pick a different one.',
      missing: dh.value !== 'off' && !dh.registered,
      options: dh.choices,
      value: dh.value,
      onPick: (value) => saveSetting({ dictateHotkey: value }),
    }),
    selectRow({
      title: 'Transcribe with',
      hint:
        'Which engine writes the dictated text. The Ollama audio model is the careful pass — the sentence as it was ' +
        'said; whisper.cpp is the fast one.',
      alert: !whisperInstalled && s.settings.dictateEngine === 'whisper'
        ? 'whisper.cpp is not installed — the audio model will be used instead.'
        : '',
      missing: !whisperInstalled && s.settings.dictateEngine === 'whisper',
      options: [
        { value: 'ollama', label: `Ollama — ${s.settings.transcribeModel}` },
        { value: 'whisper', label: whisperInstalled ? `whisper.cpp — ${s.whisper.model}` : 'whisper.cpp — not installed' },
      ],
      value: s.settings.dictateEngine,
      note: defaultNote(s.settings.dictateEngine, s.defaults.dictateEngine, 'Ollama'),
      onPick: (value) => saveSetting({ dictateEngine: value }),
    }),
    toggleRow({
      title: 'Paste where you were typing',
      hint:
        'Types the text into the window that had the cursor, using Windows itself. The clipboard always gets ' +
        'a copy too, and nothing is ever sent anywhere else.',
      key: 'dictateAutoPaste',
      checked: s.settings.dictateAutoPaste,
    }),
    buttonRow({
      title: 'Dictation history',
      hint: 'Everything you dictated, editable and copyable, kept on this machine.',
      label: 'Open dictations…',
      onClick: () => window.library.settings.openDictations(),
    }),
  ]);
}

function renderSettings() {
  const s = view.settings;
  const doc = el('div', 'doc settings');
  doc.append(el('h1', '', 'Settings'));
  if (!s) {
    doc.append(el('p', 'settings-lead', 'Reading the settings…'));
    readerEl.replaceChildren(doc);
    return;
  }

  doc.append(
    el(
      'p',
      'settings-lead',
      'Everything Minarrador uses runs on this machine. Anything marked in red is set to something that is not there.',
    ),
  );

  const frag = document.createDocumentFragment();
  // A download in flight goes above every section, because it is the only thing
  // on this pane that is happening rather than set.
  if (s.setup) {
    const box = el('div', 'rows');
    box.append(setupRow(s.setup));
    frag.append(box);
  }
  recordingSection(frag, s);
  ollamaSection(frag, s);
  liveSection(frag, s);
  voiceSection(frag, s);
  storageSection(frag, s);
  troubleshootingSection(frag);
  doc.append(frag);
  // The whole pitch of the app, said where the privacy-sensitive settings live.
  doc.append(
    el(
      'p',
      'settings-foot',
      'Everything Minarrador does runs on this machine — audio, transcripts and notes never leave it.' +
        (s.version ? ` Version ${s.version}.` : ''),
    ),
  );
  readerEl.replaceChildren(doc);
}

/** Writes one setting and redraws from the state the main process wrote. */
async function saveSetting(patch) {
  view.settings = await window.library.settings.set(patch);
  if (view.mode === 'settings') renderSettings();
}

/**
 * Switches the sidebar feature. Leaving quick copy writes it first, so a
 * shorthand typed a moment ago is never lost to a click on another feature.
 */
async function showSection(mode) {
  if (!Object.hasOwn(SECTIONS, mode)) return;
  if (view.mode === 'quickcopy' && mode !== 'quickcopy') await saveQuickCopy();
  const entering = view.mode !== mode;
  view.mode = mode;
  document.body.dataset.mode = mode;
  sectionNameEl.textContent = SECTIONS[mode];
  for (const item of navEls) {
    if (item.dataset.mode === mode) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (entering) readerEl.scrollTop = 0;

  if (mode === 'settings') {
    renderSettings(); // whatever was last read, so the pane is never blank
    view.settings = await window.library.settings.get();
    if (view.mode === 'settings') renderSettings();
  } else if (mode === 'quickcopy') {
    // Re-entering reloads from disk; staying put keeps what is being typed.
    if (entering) renderQuickCopy();
  } else if (view.meeting) {
    renderReader(view.meeting);
  } else {
    renderPlaceholder();
  }
}

const openSettings = () => showSection('settings');

// ------------------------------------------------------------------ first run

/**
 * What is missing before this app can turn a meeting into notes.
 *
 * The library is the front door, and until now a fresh install opened it to a
 * cheerful empty archive — the fact that nothing was installed to transcribe
 * with was only visible to somebody who went looking in Settings. Recording
 * still works and the audio is still kept, so this is a notice rather than a
 * wall.
 *
 * @returns {string[]} one sentence per thing to fix, empty when nothing is
 */
function setupGaps(s) {
  if (!s) return [];
  const gaps = [];
  if (!s.ollama.up) {
    gaps.push(
      s.ollama.installed
        ? 'Ollama is not running. It writes the notes — start it from Settings.'
        : 'Ollama is not installed. It writes the notes; get it from ollama.com/download.',
    );
  } else if (!s.models.includes(s.settings.summaryModel)) {
    gaps.push(`The notes model (${s.settings.summaryModel}) is not installed. Settings can download it.`);
  }
  if (!s.whisper?.available && (!s.ollama.up || !s.models.includes(s.settings.transcribeModel))) {
    gaps.push('Nothing is installed to transcribe with. Settings can fetch whisper.cpp, which is the fast option.');
  }
  return gaps;
}

/** The placeholder, plus the reasons the app cannot finish a meeting yet. */
function renderPlaceholder() {
  const gaps = setupGaps(view.settings);
  if (!gaps.length) {
    readerEl.replaceChildren(placeholder);
    return;
  }

  const wrap = el('div', 'doc');
  wrap.append(placeholder);
  const notice = el('div', 'notice');
  notice.append(
    el('strong', '', 'Minarrador is not ready to write notes. '),
    'Recording works and the audio is always kept, so nothing is lost in the meantime.',
  );
  const list = el('ul', 'bullets');
  for (const gap of gaps) list.append(el('li', '', gap));
  notice.append(list);

  const actions = el('div', 'notice-actions');
  const button = el('button', 'button primary', 'Open settings');
  button.type = 'button';
  button.addEventListener('click', () => openSettings());
  actions.append(button);
  notice.append(actions);

  wrap.append(notice);
  readerEl.replaceChildren(wrap);
}

// ----------------------------------------------------------------- quick copy

/**
 * The quick-copy editor: the list behind the tray's top section.
 *
 * Edited as a whole and saved as a whole — there is no per-item identity to
 * keep in sync, so deleting a card is simply not sending it. It saves itself a
 * moment after the typing stops, and again on the way out of the feature or
 * the window, so there is no state in which work on screen is not on its way
 * to disk.
 */
const quickCopy = { dirty: false, saving: null, timer: null, listEl: null, statusEl: null };

function setQuickCopyStatus(text, dirty) {
  if (!quickCopy.statusEl) return;
  quickCopy.statusEl.textContent = text;
  quickCopy.statusEl.classList.toggle('dirty', dirty);
}

function markQuickCopyDirty() {
  quickCopy.dirty = true;
  setQuickCopyStatus('Unsaved changes', true);
  clearTimeout(quickCopy.timer);
  quickCopy.timer = setTimeout(() => saveQuickCopy(), QUICK_COPY_SAVE_MS);
}

/** How many lines a card's text runs to beyond the one the card shows. */
function refreshCardMore(row) {
  const extra = row.querySelector('.qc-text').value.split('\n').length - 1;
  const more = row.querySelector('.qc-more');
  more.hidden = extra < 1;
  more.textContent = `+${extra} line${extra === 1 ? '' : 's'}`;
}

/**
 * One shorthand as a single compact row: name, the first line of the text, and
 * two icon buttons. The text still edits in place — it grows to fit while it
 * has focus — and the pencil opens the full editor for anything longer.
 */
function quickCopyCard(snippet = { label: '', text: '' }) {
  const row = el('div', 'qc-card');

  const name = el('input', 'qc-name');
  name.type = 'text';
  name.maxLength = QUICK_COPY_MAX.label;
  name.placeholder = 'Name (optional)';
  name.title = 'What the tray shows';
  name.value = snippet.label;

  const text = el('textarea', 'qc-text');
  text.rows = 1;
  text.maxLength = QUICK_COPY_MAX.text;
  text.placeholder = 'Text to put on the clipboard…';
  text.value = snippet.text;
  text.spellcheck = false;

  const more = el('span', 'qc-more');
  more.hidden = true;

  const edit = el('button', 'qc-icon qc-edit', '✎');
  edit.type = 'button';
  edit.title = 'Open in editor';
  edit.setAttribute('aria-label', 'Open shorthand in editor');
  edit.addEventListener('click', () => openQuickCopyEditor(row));

  const remove = el('button', 'qc-icon qc-remove', '✕');
  remove.type = 'button';
  remove.title = 'Delete';
  remove.setAttribute('aria-label', 'Delete shorthand');
  remove.addEventListener('click', () => {
    row.remove();
    refreshQuickCopyEmpty();
    markQuickCopyDirty();
  });

  const field = el('div', 'qc-field');
  field.append(text, more);
  row.append(name, field, edit, remove);
  text.addEventListener('input', () => refreshCardMore(row));
  refreshCardMore(row);
  return row;
}

// ------------------------------------------------------- quick copy editor

/**
 * The full editor behind a card's pencil: a large plain-text area with the
 * tools a clipboard phrase actually needs — case, whitespace, line joins,
 * bullets, find and replace, a date stamp — and a live count against the
 * store's limit.
 *
 * Every tool edits through `insertText`, so each one is a single step on the
 * textarea's own undo stack and Ctrl+Z behaves the way it does everywhere else.
 * Closing keeps the edit (Escape, ✕, Done, a click outside); only "Discard
 * changes" throws it away, since no key in this app is a way to lose work.
 */
const qcEditor = {
  dialog: null,
  row: null,
  original: null,
  name: null,
  text: null,
  stats: null,
  findBar: null,
  find: null,
  replace: null,
  matchCase: null,
  findCount: null,
};

/** Replaces the selection — or, with nothing selected, everything — undoably. */
function qcReplaceSelection(fn, { whole = false } = {}) {
  const t = qcEditor.text;
  t.focus();
  let { selectionStart: a, selectionEnd: b } = t;
  if (whole || a === b) {
    a = 0;
    b = t.value.length;
  }
  const before = t.value.slice(a, b);
  const after = fn(before).slice(0, QUICK_COPY_MAX.text - (t.value.length - before.length));
  if (after === before) return;
  t.setSelectionRange(a, b);
  document.execCommand('insertText', false, after);
  t.setSelectionRange(a, a + after.length);
  qcRefreshStats();
}

function qcInsert(str) {
  qcEditor.text.focus();
  document.execCommand('insertText', false, str);
  qcRefreshStats();
}

function qcHistory(command) {
  qcEditor.text.focus();
  document.execCommand(command);
  qcRefreshStats();
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-("'“‘])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
const sentenceCase = (s) => s.toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_, p, c) => p + c.toUpperCase());

function toggleBullets(s) {
  const lines = s.split('\n');
  const bulleted = lines.filter((l) => l.trim()).every((l) => /^\s*[•\-*] /.test(l));
  return lines.map((l) => (!l.trim() ? l : bulleted ? l.replace(/^(\s*)[•\-*] /, '$1') : `• ${l}`)).join('\n');
}

/** The toolbar, in groups. A tool with `toggle` is a pressed/unpressed switch. */
const QC_TOOLS = [
  [
    { label: '↶', title: 'Undo (Ctrl+Z)', run: () => qcHistory('undo') },
    { label: '↷', title: 'Redo (Ctrl+Y)', run: () => qcHistory('redo') },
  ],
  [
    { label: 'AB', title: 'UPPERCASE', run: () => qcReplaceSelection((s) => s.toUpperCase()) },
    { label: 'ab', title: 'lowercase', run: () => qcReplaceSelection((s) => s.toLowerCase()) },
    { label: 'Ab', title: 'Title Case', run: () => qcReplaceSelection(titleCase) },
    { label: 'Ab.', title: 'Sentence case', run: () => qcReplaceSelection(sentenceCase) },
  ],
  [
    {
      label: 'Trim',
      title: 'Remove trailing spaces, and blank lines at the start and end',
      run: () => qcReplaceSelection((s) => s.replace(/[ \t]+$/gm, '').replace(/^\s*\n|\n\s*$/g, ''), { whole: true }),
    },
    { label: '¶', title: 'Collapse runs of blank lines into one', run: () => qcReplaceSelection((s) => s.replace(/\n{3,}/g, '\n\n')) },
    { label: 'Join', title: 'Join the selected lines into one', run: () => qcReplaceSelection((s) => s.replace(/[ \t]*\n+[ \t]*/g, ' ')) },
    { label: '•', title: 'Toggle bullets on the selected lines', run: () => qcReplaceSelection(toggleBullets) },
  ],
  [
    {
      label: 'Date',
      title: "Insert today's date",
      run: () => qcInsert(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })),
    },
    {
      label: 'Time',
      title: 'Insert the current time',
      run: () => qcInsert(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
    },
  ],
  [
    { label: 'Find', title: 'Find and replace (Ctrl+F)', toggle: 'find', run: () => qcToggleFind() },
    { label: 'Wrap', title: 'Wrap long lines', toggle: 'wrap', pressed: true, run: (b) => qcToggleClass(b, 'nowrap', true) },
    { label: 'Mono', title: 'Monospaced font', toggle: 'mono', run: (b) => qcToggleClass(b, 'mono') },
  ],
];

function qcToggleClass(btn, cls, inverted = false) {
  const on = qcEditor.text.classList.toggle(cls);
  btn.setAttribute('aria-pressed', String(inverted ? !on : on));
  qcEditor.text.focus();
}

function qcRefreshStats() {
  const t = qcEditor.text;
  const v = t.value;
  const words = (v.match(/\S+/g) ?? []).length;
  const lines = v ? v.split('\n').length : 0;
  const upto = v.slice(0, t.selectionStart).split('\n');
  const sel = Math.abs(t.selectionEnd - t.selectionStart);
  qcEditor.stats.textContent =
    `${v.length.toLocaleString()} / ${QUICK_COPY_MAX.text.toLocaleString()} chars · ` +
    `${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'} · ` +
    `Ln ${upto.length}, Col ${upto[upto.length - 1].length + 1}` +
    (sel ? ` · ${sel} selected` : '');
  qcEditor.stats.classList.toggle('full', v.length >= QUICK_COPY_MAX.text);
  qcRefreshFindCount();
}

// Find and replace works on literal text, never a regex, so nothing typed misfires.

const qcFold = (s) => (qcEditor.matchCase.checked ? s : s.toLowerCase());

function qcRefreshFindCount() {
  if (!qcEditor.findBar || qcEditor.findBar.hidden) return;
  const n = qcFold(qcEditor.find.value);
  qcEditor.findCount.textContent = n ? `${qcFold(qcEditor.text.value).split(n).length - 1} found` : '';
}

function qcFindNext() {
  const n = qcFold(qcEditor.find.value);
  if (!n) return;
  const t = qcEditor.text;
  const hay = qcFold(t.value);
  let at = hay.indexOf(n, t.selectionEnd);
  if (at === -1) at = hay.indexOf(n); // wrap round to the top
  if (at === -1) return;
  t.focus();
  t.setSelectionRange(at, at + n.length);
  // Selecting does not always scroll a textarea to the match; bring it into view.
  const lh = parseFloat(getComputedStyle(t).lineHeight) || 20;
  const y = (t.value.slice(0, at).split('\n').length - 1) * lh;
  if (y < t.scrollTop || y > t.scrollTop + t.clientHeight - lh) t.scrollTop = Math.max(0, y - 2 * lh);
  qcRefreshStats();
}

function qcReplaceOne() {
  const t = qcEditor.text;
  const n = qcFold(qcEditor.find.value);
  if (n && qcFold(t.value.slice(t.selectionStart, t.selectionEnd)) === n) {
    t.focus();
    document.execCommand('insertText', false, qcEditor.replace.value);
  }
  qcFindNext();
}

function qcReplaceAll() {
  const n = qcEditor.find.value;
  if (!n) return;
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), qcEditor.matchCase.checked ? 'g' : 'gi');
  const rep = qcEditor.replace.value;
  qcReplaceSelection((s) => s.replace(re, () => rep), { whole: true });
}

function qcToggleFind(force) {
  const bar = qcEditor.findBar;
  bar.hidden = force === undefined ? !bar.hidden : !force;
  qcEditor.dialog.querySelector('[data-toggle="find"]')?.setAttribute('aria-pressed', String(!bar.hidden));
  if (bar.hidden) {
    qcEditor.text.focus();
    return;
  }
  const t = qcEditor.text;
  const sel = t.value.slice(t.selectionStart, t.selectionEnd);
  if (sel && !sel.includes('\n')) qcEditor.find.value = sel;
  qcEditor.find.focus();
  qcEditor.find.select();
  qcRefreshFindCount();
}

/** A button that acts on the textarea without taking its selection away first. */
function qcButton(className, label, title, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => onClick(b));
  return b;
}

function buildQuickCopyEditor() {
  const dialog = el('dialog', 'qc-editor');
  dialog.setAttribute('aria-label', 'Edit shorthand');

  const head = el('div', 'qce-head');
  const name = el('input', 'qce-name');
  name.type = 'text';
  name.maxLength = QUICK_COPY_MAX.label;
  name.placeholder = 'Name (optional) — this is what the tray shows';
  head.append(name, qcButton('qc-icon', '✕', 'Close (Esc) — keeps your changes', () => closeQuickCopyEditor(true)));

  const toolbar = el('div', 'qce-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  for (const group of QC_TOOLS) {
    const g = el('div', 'qce-group');
    for (const tool of group) {
      const b = qcButton('qce-tool', tool.label, tool.title, tool.run);
      if (tool.toggle) {
        b.dataset.toggle = tool.toggle;
        b.setAttribute('aria-pressed', String(Boolean(tool.pressed)));
      }
      g.append(b);
    }
    toolbar.append(g);
  }

  const findBar = el('div', 'qce-find');
  findBar.hidden = true;
  const find = el('input', 'qce-input');
  find.type = 'text';
  find.placeholder = 'Find';
  const replace = el('input', 'qce-input');
  replace.type = 'text';
  replace.placeholder = 'Replace with';
  const caseLabel = el('label', 'qce-case');
  caseLabel.title = 'Match case';
  const matchCase = el('input');
  matchCase.type = 'checkbox';
  caseLabel.append(matchCase, document.createTextNode('Aa'));
  const findCount = el('span', 'qce-count');
  find.addEventListener('input', () => qcRefreshFindCount());
  matchCase.addEventListener('change', () => qcRefreshFindCount());
  find.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    qcFindNext();
  });
  replace.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) qcReplaceAll();
    else qcReplaceOne();
  });
  findBar.append(
    find,
    replace,
    caseLabel,
    findCount,
    qcButton('qce-tool', 'Next', 'Find next (Enter, F3)', qcFindNext),
    qcButton('qce-tool', 'Replace', 'Replace this match', qcReplaceOne),
    qcButton('qce-tool', 'All', 'Replace every match (Ctrl+Enter)', qcReplaceAll),
  );

  const text = el('textarea', 'qce-text');
  text.maxLength = QUICK_COPY_MAX.text;
  text.placeholder = 'The text to put on the clipboard…';
  for (const ev of ['input', 'select', 'keyup', 'mouseup']) text.addEventListener(ev, () => qcRefreshStats());
  text.addEventListener('keydown', (e) => {
    // Tab indents, as in any editor; Shift+Tab takes one indent back off.
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = text;
    if (a === b && !e.shiftKey) {
      qcInsert('\t');
      return;
    }
    text.setSelectionRange(text.value.lastIndexOf('\n', a - 1) + 1, b);
    qcReplaceSelection((s) => (e.shiftKey ? s.replace(/^(\t| {1,4})/gm, '') : s.replace(/^/gm, '\t')));
  });

  const foot = el('div', 'qce-foot');
  const stats = el('span', 'qce-stats');
  const copy = qcButton('button', 'Copy', 'Put this text on the clipboard now', (b) => {
    window.library.copy(text.value);
    b.textContent = 'Copied';
    setTimeout(() => {
      b.textContent = 'Copy';
    }, 1200);
  });
  foot.append(
    stats,
    qcButton('button danger', 'Discard changes', '', () => closeQuickCopyEditor(false)),
    copy,
    qcButton('button primary', 'Done', 'Save and close (Ctrl+Enter)', () => closeQuickCopyEditor(true)),
  );

  dialog.append(head, toolbar, findBar, text, foot);

  dialog.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault(); // no native cancel: closing goes through one path
      if (!findBar.hidden && findBar.contains(document.activeElement)) qcToggleFind(false);
      else closeQuickCopyEditor(true);
    } else if (mod && (key === 'enter' || key === 's') && !findBar.contains(document.activeElement)) {
      e.preventDefault();
      closeQuickCopyEditor(true);
    } else if (mod && (key === 'f' || key === 'h')) {
      e.preventDefault();
      qcToggleFind(true);
      if (key === 'h') replace.focus();
    } else if (e.key === 'F3') {
      e.preventDefault();
      qcFindNext();
    }
  });
  // A press on the backdrop lands on the dialog itself, outside its box.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeQuickCopyEditor(true);
  });

  document.body.append(dialog);
  Object.assign(qcEditor, { dialog, name, text, stats, findBar, find, replace, matchCase, findCount });
}

function openQuickCopyEditor(row) {
  if (!qcEditor.dialog) buildQuickCopyEditor();
  const label = row.querySelector('.qc-name').value;
  const text = row.querySelector('.qc-text').value;
  qcEditor.row = row;
  qcEditor.original = { label, text };
  qcEditor.name.value = label;
  qcEditor.text.value = text;
  qcToggleFind(false);
  qcEditor.dialog.showModal();
  qcEditor.text.focus();
  qcEditor.text.setSelectionRange(0, 0);
  qcEditor.text.scrollTop = 0;
  qcRefreshStats();
}

/** @param {boolean} keep write the edit back to the card, or throw it away */
function closeQuickCopyEditor(keep) {
  const { dialog, row, original } = qcEditor;
  if (!dialog?.open) return;
  const label = qcEditor.name.value;
  const text = qcEditor.text.value;
  dialog.close();
  qcEditor.row = null;
  if (!row?.isConnected) return; // deleted, or the pane re-rendered underneath
  row.querySelector('.qc-edit')?.focus();
  if (!keep || (label === original.label && text === original.text)) return;
  row.querySelector('.qc-name').value = label;
  row.querySelector('.qc-text').value = text;
  row.classList.remove('incomplete');
  refreshCardMore(row);
  markQuickCopyDirty();
  saveQuickCopy();
}

/** Shows the placeholder only while there is genuinely nothing to show. */
function refreshQuickCopyEmpty() {
  const list = quickCopy.listEl;
  if (!list) return;
  const empty = list.querySelector('.none');
  if (list.querySelector('.qc-card')) empty?.remove();
  else if (!empty) {
    list.append(el('p', 'none', 'Nothing here yet. Add a shorthand and it appears at the top of the tray menu, ready to copy.'));
  }
}

const collectQuickCopy = () =>
  [...(quickCopy.listEl?.querySelectorAll('.qc-card') ?? [])].map((row) => ({
    label: row.querySelector('.qc-name').value,
    text: row.querySelector('.qc-text').value,
  }));

/**
 * Writes the list and marks whatever the store refused to keep.
 *
 * Never re-renders from the result: a card with an empty body is dropped by the
 * store, and making it vanish while someone is still filling it in would look
 * like the editor eating their work. The card stays, flagged, and starts
 * counting the moment it has text.
 */
async function saveQuickCopy() {
  clearTimeout(quickCopy.timer);
  if (quickCopy.saving) await quickCopy.saving;
  if (!quickCopy.dirty || !quickCopy.listEl) return;
  const cards = [...quickCopy.listEl.querySelectorAll('.qc-card')];
  quickCopy.dirty = false;
  setQuickCopyStatus('Saving…', false);
  quickCopy.saving = (async () => {
    try {
      await window.library.quickCopy.save(collectQuickCopy());
      if (!quickCopy.dirty) setQuickCopyStatus('Saved', false);
      for (const row of cards) row.classList.toggle('incomplete', !row.querySelector('.qc-text').value.trim());
    } catch {
      // The store writes to disk; if that failed the work is still on screen,
      // and saying so beats a silent "Saved".
      quickCopy.dirty = true;
      setQuickCopyStatus('Could not save', true);
    } finally {
      quickCopy.saving = null;
    }
  })();
  await quickCopy.saving;
}

async function renderQuickCopy() {
  const doc = el('div', 'doc');
  doc.append(
    el('h1', '', 'Quick copy'),
    el('p', 'settings-lead', 'Phrases you type all day. Each one becomes an item at the top of the tray menu that copies it on click.'),
  );

  const toolbar = el('div', 'qc-toolbar');
  const add = el('button', 'button primary', '+ New shorthand');
  add.type = 'button';
  const status = el('span', 'qc-status', 'Loading…');
  toolbar.append(add, status);

  const list = el('div', 'qc-list');
  list.addEventListener('input', (e) => {
    e.target.closest('.qc-card')?.classList.remove('incomplete');
    markQuickCopyDirty();
  });
  // Leaving a field is as good a moment as any to put it on disk.
  list.addEventListener('focusout', () => {
    if (quickCopy.dirty) saveQuickCopy();
  });
  add.addEventListener('click', () => {
    const row = quickCopyCard();
    list.append(row);
    refreshQuickCopyEmpty();
    row.querySelector('.qc-name').focus();
    row.scrollIntoView({ block: 'nearest' });
  });

  doc.append(toolbar, list);
  quickCopy.listEl = list;
  quickCopy.statusEl = status;
  quickCopy.dirty = false;
  readerEl.replaceChildren(doc);

  let snippets;
  try {
    snippets = await window.library.quickCopy.list();
  } catch {
    setQuickCopyStatus('Could not read the list', true);
    return;
  }
  // Someone clicked away, or back again, before the list arrived.
  if (view.mode !== 'quickcopy' || quickCopy.listEl !== list) return;
  list.replaceChildren(...snippets.map((snippet) => quickCopyCard(snippet)));
  refreshQuickCopyEmpty();
  setQuickCopyStatus('Saved', false);
}

/** Closing is not a way to discard: whatever is on screen goes to disk first. */
async function closeWindow() {
  await saveQuickCopy();
  window.library.close();
}

// ------------------------------------------------------------------ recording

/**
 * The record button, which is the only thing in this window that acts on the
 * world rather than reading it.
 *
 * Its state comes from the rail — `activity.recordingId` is the folder the main
 * process is recording into — so a meeting started from the tray shows up here
 * as a Stop button without this window being told anything special.
 */
function renderRecordButton() {
  const on = Boolean(view.activity.recordingId);
  const pending = view.recordWanted !== null && view.recordWanted !== on;
  if (!pending) {
    view.recordWanted = null;
    clearTimeout(recordTimer);
  }

  recordEl.classList.toggle('stop', on);
  recordEl.disabled = pending;
  recordGlyphEl.textContent = on ? '■' : '+';
  recordLabelEl.textContent = pending
    ? view.recordWanted
      ? 'Starting…'
      : 'Stopping…'
    : on
      ? 'Stop recording'
      : 'New recording';
  recordEl.title = on ? 'Stop the meeting being recorded' : 'Start recording a meeting';
}

/**
 * The one action this window has, shared by the record button and its Ctrl+N:
 * start or stop the recording, and learn the result from the rail.
 *
 * Nothing here waits for the answer: stopping runs the whole pipeline, and the
 * confirmation is the folder list changing under us.
 */
function toggleRecord() {
  const wanted = !view.activity.recordingId;
  view.recordWanted = wanted;
  renderRecordButton();
  window.library.record(wanted);
  clearTimeout(recordTimer);
  recordTimer = setTimeout(() => {
    view.recordWanted = null;
    renderRecordButton();
  }, RECORD_CONFIRM_MS);
}

recordEl.addEventListener('click', toggleRecord);

// -------------------------------------------------------------------- loading

/**
 * Reads a meeting into the reader, if the reader is what is on screen.
 *
 * Also called from the refresh path, where the settings pane may well be open —
 * hence the checks: a pipeline finishing must not throw someone out of the
 * setting they were changing.
 */
/**
 * Moves the numbers on, and nothing else.
 *
 * The counterpart to refresh(): that one re-reads the notes folder and every
 * transcript in it, which is far too much for a chunk counter ticking several
 * times a minute. This updates the two places a number appears — the card's
 * pill and the reader's notice — from a payload that cost the main process
 * nothing to send.
 */
function renderProgress(activity) {
  view.activity = { ...view.activity, ...activity };
  for (const p of view.activity.processing ?? []) {
    const tag = listEl.querySelector(`.card[data-id="${CSS.escape(p.id)}"] .tag.working`);
    if (tag) tag.textContent = progressTag(p);
  }

  if (view.mode !== 'reader' || !view.selected) return;
  const line = readerEl.querySelector('.notice-progress');
  if (!line) return;
  const p = progressFor(view.selected);
  line.textContent = progressSentence(p);
  const fraction = progressFraction(p);
  const track = readerEl.querySelector('.progress-track');
  const bar = readerEl.querySelector('.progress-bar');
  if (!track || !bar) return;
  track.classList.toggle('indeterminate', fraction === null);
  bar.style.width = fraction === null ? '100%' : `${Math.round(fraction * 100)}%`;
}

async function select(id) {
  view.selected = id;
  for (const row of listEl.querySelectorAll('.card')) {
    const on = row.dataset.id === id;
    row.classList.toggle('selected', on);
    row.setAttribute('aria-selected', String(on));
  }

  const meeting = await window.library.read(id);
  // The folder can vanish between listing and opening it — a manual delete
  // while the window sat there. Fall back to a fresh list rather than a blank.
  if (!meeting) {
    view.selected = null;
    view.meeting = null;
    if (view.mode === 'reader') renderPlaceholder();
    await refresh();
    return;
  }
  if (view.selected !== id) return; // A faster click won.
  view.meeting = meeting;
  // The window reopens onto the same meeting it was closed on; a recording that
  // finished belongs at the top, so a stale id simply falls back to newest.
  sessionStorage.setItem('minarrador:lastMeeting', id);
  if (view.mode !== 'reader') return;
  // A pipeline finishing somewhere else must not throw away a half-typed
  // title. The rail behind it is already up to date either way.
  if (view.renaming) return;
  readerEl.scrollTop = 0;
  renderReader(meeting);
}

/** A click in the rail, which is only on screen while Recording is. */
function openMeeting(id) {
  select(id);
}

/**
 * Rebuilds the rail from disk, keeping the open meeting open.
 *
 * Called on every search keystroke and whenever a recording starts or finishes,
 * so it must never steal the reader from whatever is being read.
 */
async function refresh() {
  const seq = ++listSeq;
  const { meetings, activity } = await window.library.list(view.query);
  if (seq !== listSeq) return; // A later query already answered.
  view.meetings = meetings;
  view.activity = activity;
  searchingEl.hidden = true;
  // The record button reads its state from here, so a meeting started from the
  // tray flips it without this window being told anything else.
  renderRecordButton();
  if (view.selected && !meetings.some((m) => m.id === view.selected)) {
    // Filtered out by the current search, not gone: keep it on screen, just
    // unhighlighted in a rail that no longer lists it.
    listEl.querySelector('.card.selected')?.classList.remove('selected');
  }
  renderList();
}

// ------------------------------------------------------------------- controls

queryEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    view.query = queryEl.value;
    // A search reads every transcript on disk, so it can outlast the keystroke;
    // say the wait is happening rather than leaving the rail to look unresponded.
    searchingEl.hidden = false;
    refresh();
    // Re-render the open meeting so its highlights follow the query.
    if (view.selected) select(view.selected);
  }, SEARCH_DEBOUNCE_MS);
});

/** Moves the selection through the rail, so a list can be read without the mouse. */
function step(delta) {
  const ids = view.meetings.map((m) => m.id);
  if (!ids.length) return;
  const next = ids[Math.min(ids.length - 1, Math.max(0, ids.indexOf(view.selected) + delta))];
  if (next === view.selected) return;
  openMeeting(next);
  listEl.querySelector('.card.selected')?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  // The shorthand editor is modal and handles its own keys; nothing here —
  // Escape closing the window least of all — should act behind it.
  if (qcEditor.dialog?.open) return;
  if (e.key === 'Escape') {
    // Escape backs out one layer at a time — another feature back to
    // Recording, then a search, then the window itself. Closing outright would
    // be the wrong guess twice.
    if (view.mode !== 'reader') {
      showSection('reader');
      return;
    }
    if (queryEl.value) {
      queryEl.value = '';
      view.query = '';
      refresh();
      return;
    }
    closeWindow();
    return;
  }
  // Ctrl+1, Ctrl+2… follow the sidebar top to bottom.
  if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    const item = document.querySelectorAll('.nav-features .nav-item')[Number(e.key) - 1];
    if (item) {
      e.preventDefault();
      showSection(item.dataset.mode);
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && view.mode === 'quickcopy') {
    e.preventDefault();
    saveQuickCopy();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (view.mode !== 'reader') return;
    e.preventDefault();
    queryEl.focus();
    queryEl.select();
    return;
  }
  // Start/stop the recording and the settings pane, reachable without the
  // mouse from whichever feature is open.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    toggleRecord();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    showSection(view.mode === 'settings' ? 'reader' : 'settings');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
    // The only text boxes on this page are the search and a rename, and a box
    // with a selection in it has its own copy to do. Otherwise this is exactly
    // what the "Copy transcript" action button does — click it, so the "Copied"
    // feedback comes along for free.
    if (view.mode !== 'reader' || e.target.closest('input, textarea')) return;
    const copy = readerEl.querySelector('[data-action="copy-transcript"]');
    if (copy && !copy.disabled) {
      e.preventDefault();
      copy.click();
    }
    return;
  }
  // Arrows walk the list unless they are being used to move a text cursor.
  if (
    (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
    view.mode === 'reader' &&
    !e.target.closest('input, textarea, select')
  ) {
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  }
});

document.getElementById('folder').addEventListener('click', () => window.library.openNotesFolder());
document.getElementById('minimize').addEventListener('click', () => window.library.minimize());
document.getElementById('close').addEventListener('click', () => closeWindow());
for (const item of navEls) item.addEventListener('click', () => showSection(item.dataset.mode));

// A run advancing is a number changing, not a folder changing: it updates what
// is on screen without anything being re-read from disk.
window.library.onProgress((activity) => renderProgress(activity));

// A recording that just finished belongs at the top of the list without anyone
// having to reopen the window.
window.library.onChanged(async () => {
  await refresh();
  if (view.selected) select(view.selected);
  // Starting or stopping a meeting also decides whether the capture sources can
  // be changed, which only the settings pane shows.
  if (view.mode === 'settings') {
    view.settings = await window.library.settings.get();
    if (view.mode === 'settings') renderSettings();
  }
});

// A model list arriving, or Ollama coming up sixty seconds after someone
// started it, is the whole reason this pane can be trusted to say what is
// missing — so it redraws rather than waiting to be reopened. The empty-archive
// notice is built from the same state, so it follows along.
window.library.settings.onChanged(async () => {
  view.settings = await window.library.settings.get();
  if (view.mode === 'settings') renderSettings();
  else if (!view.selected) renderPlaceholder();
});

// A mic test reports a level roughly ten times a second; the meter moves in
// place, and only the start and the auto-stop re-render the row.
window.library.settings.onMicTest((p) => {
  if (typeof p.testing === 'boolean') view.micTest.testing = p.testing;
  if (typeof p.level === 'number') view.micTest.level = p.level;
  if (p.micError) view.micTest.note = `The microphone could not be opened: ${p.micError}`;
  else if (p.micLabel) view.micTest.note = `Hearing ${p.micLabel}.`;

  if (p.testing === false) {
    view.micTest = { testing: false, level: 0, note: '' };
    if (view.mode === 'settings') renderSettings();
    return;
  }
  const els = view.micTestEls;
  if (!els || view.mode !== 'settings') return;
  if (els.bar) els.bar.style.width = `${Math.min(100, Math.round(view.micTest.level * 600))}%`;
  if (els.note && view.micTest.note) els.note.textContent = view.micTest.note;
});

// Main asking for a section, e.g. the tray's quick-copy "add one…" item.
window.library.onShow((section) => showSection(section));

// The settings are read at launch rather than when the pane is opened, because
// the placeholder is built from them: a first run with nothing installed opens
// onto an empty archive, and the reason it will stay empty belongs there.
Promise.all([refresh(), window.library.settings.get()]).then(([, settings]) => {
  view.settings = settings;
  // The tab is sticky across launches; the meeting is too, falling back to the
  // newest when it is gone — the window is usually opened to read the one that
  // just finished.
  if (sessionStorage.getItem('minarrador:tab') === 'transcript') view.tab = 'transcript';
  const remembered = sessionStorage.getItem('minarrador:lastMeeting');
  const first = view.meetings.find((m) => m.id === remembered) ?? view.meetings[0];
  if (first) select(first.id);
  else renderPlaceholder();
});
