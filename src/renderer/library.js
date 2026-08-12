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
const settingsEl = document.getElementById('settings');

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
   * The rail filter: 'all' | 'needs' | 'recent'.
   *
   * 'needs' is the set of meetings owed notes (everything the pipeline never
   * finished), and 'recent' is the last week — the two filters that actually
   * change what someone is looking for, unlike a flat list of the whole archive.
   */
  filter: 'all',
  /** 'reader' | 'settings' — which of the two the right-hand pane is showing. */
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

/** Which rail filter is active, so the segmented control agrees with the list. */
function renderFilters() {
  for (const btn of document.querySelectorAll('.filter')) {
    const on = btn.dataset.filter === view.filter;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

function renderList() {
  const { meetings, query } = view;
  countEl.textContent = query
    ? `${meetings.length} match${meetings.length === 1 ? '' : 'es'}`
    : view.filter === 'needs'
      ? `${meetings.length} meeting${meetings.length === 1 ? '' : 's'} still owed notes`
      : view.filter === 'recent'
        ? `${meetings.length} from this week`
        : `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`;

  if (!meetings.length) {
    listEl.replaceChildren(
      el(
        'p',
        'rail-empty',
        query
          ? 'Nothing said in any meeting matches that.'
          : view.filter === 'needs'
            ? 'Nothing is owed notes — every recording is written up.'
            : view.filter === 'recent'
              ? 'Nothing was recorded this week.'
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
function copyButton(label, enabled, text) {
  const button = el('button', 'button', label);
  button.type = 'button';
  button.disabled = !enabled;
  if (enabled) {
    button.addEventListener('click', () => {
      window.library.copy(text());
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = label;
      }, 1200);
    });
  }
  return button;
}

function actionBar(meeting) {
  const bar = el('div', 'actions');

  const act = (label, className, enabled, onClick) => {
    const button = el('button', className, label);
    button.type = 'button';
    button.disabled = !enabled;
    if (enabled) button.addEventListener('click', () => onClick(button));
    bar.append(button);
    return button;
  };

  act('Open PDF brief', 'button primary', meeting.files.pdf, () => window.library.open(meeting.id, 'pdf'));
  act('Open folder', 'button', true, () => window.library.open(meeting.id, 'folder'));
  act('Play audio', 'button', meeting.files.audio, () => window.library.open(meeting.id, 'audio'));

  bar.append(
    copyButton('Copy notes', meeting.status === 'ready', () => notesMarkdown(meeting)),
    // The single most-pasted thing a meeting produces, and until now the only
    // way at it was to open the PDF and retype it.
    copyButton('Copy action items', meeting.actionItems.length > 0, () => actionItemsMarkdown(meeting)),
    copyButton('Copy transcript', meeting.transcript.length > 0, () => transcriptText(meeting)),
    // The quote-able version: the same words with each line's [mm:ss] in front.
    // Only offered when the transcript actually has times to quote.
    copyButton(
      'Copy with timestamps',
      meeting.transcript.some((line) => line.startSeconds !== null),
      () => transcriptText(meeting, true),
    ),
  );

  // Editing the archive sits apart from reading it, at the other end of the row.
  bar.append(el('span', 'spacer'));
  act('Rename', 'button', true, () => startRename(meeting));
  act('Delete', 'button danger', true, (button) => removeMeeting(meeting, button));
  return bar;
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
  const heading = readerEl.querySelector('.doc h1');
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
  const doc = el('div', 'doc');
  const title = el('h1');
  title.append(highlighted(meeting.title, view.query));
  doc.append(title, metaRow(meeting), actionBar(meeting), tabs(meeting));
  doc.append(view.tab === 'transcript' ? transcriptView(meeting) : notesView(meeting));
  readerEl.replaceChildren(doc);
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
      onClick: () => window.library.settings.editQuickCopy(),
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
  doc.append(frag);
  // The whole pitch of the app, said where the privacy-sensitive settings live.
  doc.append(
    el(
      'p',
      'settings-foot',
      'Everything Minarrador does runs on this machine — audio, transcripts and notes never leave it.',
    ),
  );
  readerEl.replaceChildren(doc);
}

/** Writes one setting and redraws from the state the main process wrote. */
async function saveSetting(patch) {
  view.settings = await window.library.settings.set(patch);
  if (view.mode === 'settings') renderSettings();
}

async function openSettings() {
  view.mode = 'settings';
  settingsEl.setAttribute('aria-pressed', 'true');
  renderSettings(); // whatever was last read, so the pane is never blank
  view.settings = await window.library.settings.get();
  if (view.mode === 'settings') renderSettings();
}

/** Back to the archive, onto whichever meeting was open before. */
function closeSettings() {
  view.mode = 'reader';
  settingsEl.setAttribute('aria-pressed', 'false');
  if (view.meeting) renderReader(view.meeting);
  else renderPlaceholder();
}

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
    renderPlaceholder();
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

/** A click in the rail. The archive is what the rail is for, so it takes the pane back. */
function openMeeting(id) {
  if (view.mode === 'settings') {
    view.mode = 'reader';
    settingsEl.setAttribute('aria-pressed', 'false');
  }
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
  const { meetings, activity } = await window.library.list(view.query, view.filter);
  if (seq !== listSeq) return; // A later query already answered.
  view.meetings = meetings;
  view.activity = activity;
  searchingEl.hidden = true;
  // The record button reads its state from here, so a meeting started from the
  // tray flips it without this window being told anything else.
  renderRecordButton();
  renderFilters();
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
  if (e.key === 'Escape') {
    // Escape backs out one layer at a time — the settings pane, then a search,
    // then the window itself. Closing outright would be the wrong guess twice.
    if (view.mode === 'settings') {
      closeSettings();
      return;
    }
    if (queryEl.value) {
      queryEl.value = '';
      view.query = '';
      refresh();
      return;
    }
    window.library.close();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    queryEl.focus();
    queryEl.select();
    return;
  }
  // The two things the header does, reachable without the mouse: start/stop the
  // recording, and the settings pane that decides how the app can run.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    toggleRecord();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    toggleSettings();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
    // The only text boxes on this page are the search and a rename, and a box
    // with a selection in it has its own copy to do. Otherwise this is exactly
    // what the "Copy transcript" action button does — click it, so the "Copied"
    // feedback comes along for free.
    if (e.target.closest('input, textarea')) return;
    // Starts-with: the button reads "Copied" for a second after it copies, and
    // a repeat keystroke should still land.
    const copy = [...readerEl.querySelectorAll('.actions .button')].find((b) => b.textContent.startsWith('Copy transcript'));
    if (copy && !copy.disabled) {
      e.preventDefault();
      copy.click();
    }
    return;
  }
  // Arrows walk the list unless they are being used to move a text cursor.
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target !== queryEl) {
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  }
});

document.getElementById('folder').addEventListener('click', () => window.library.openNotesFolder());
document.getElementById('minimize').addEventListener('click', () => window.library.minimize());
document.getElementById('close').addEventListener('click', () => window.library.close());
// The rail filters narrow the whole archive down to the sets that actually
// change what someone is looking for; the query still applies on top.
for (const btn of document.querySelectorAll('.filter')) {
  btn.addEventListener('click', () => {
    if (view.filter === btn.dataset.filter) return;
    view.filter = btn.dataset.filter;
    refresh();
  });
}
function toggleSettings() {
  if (view.mode === 'settings') closeSettings();
  else openSettings();
}

settingsEl.addEventListener('click', toggleSettings);

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

// The tray's Settings… item, which opens this window straight onto the pane.
window.library.onShowSettings(() => openSettings());

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
