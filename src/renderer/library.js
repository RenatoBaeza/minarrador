'use strict';

// View layer for the meeting library. Everything it can do is bounded by the
// `library` bridge in library-preload.js; it has no Node access and no path of
// its own — a meeting is a folder name it hands back to the main process.
//
// Every string rendered here has been through either a language model or a
// hand-edited file, so it reaches the DOM as text, never as markup.

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const readerEl = document.getElementById('reader');
const placeholder = document.getElementById('placeholder');
const queryEl = document.getElementById('query');

/** Keystrokes settle before the main process reads every transcript on disk. */
const SEARCH_DEBOUNCE_MS = 180;

const view = {
  /** Cards currently in the rail, newest first. */
  meetings: [],
  /** Folder name of the open meeting, or null. */
  selected: null,
  /** The query the rail was built from, reused to highlight the reader. */
  query: '',
  /** 'notes' | 'transcript' — sticky across meetings, the way a reader expects. */
  tab: 'notes',
  activity: { recordingId: null, processingIds: [] },
};

let searchTimer = null;
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

/** mm:ss for a transcript gutter, where the numbers have to line up. */
const fmtClock = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
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

// ------------------------------------------------------------------- the rail

/** What a folder without notes should say for itself, if anything. */
function cardTag(meeting) {
  if (meeting.id === view.activity.recordingId) return { text: 'Recording', className: 'recording' };
  if (view.activity.processingIds.includes(meeting.id)) return { text: 'Working…', className: 'working' };
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

  row.addEventListener('click', () => select(meeting.id));
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

function actionBar(meeting) {
  const bar = el('div', 'actions');

  const act = (label, className, enabled, onClick) => {
    const button = el('button', className, label);
    button.type = 'button';
    button.disabled = !enabled;
    if (enabled) button.addEventListener('click', () => onClick(button));
    bar.append(button);
  };

  act('Open PDF brief', 'button primary', meeting.files.pdf, () => window.library.open(meeting.id, 'pdf'));
  act('Open folder', 'button', true, () => window.library.open(meeting.id, 'folder'));
  act('Play audio', 'button', meeting.files.audio, () => window.library.open(meeting.id, 'audio'));
  act('Copy transcript', 'button', meeting.transcript.length > 0, (button) => {
    window.library.copy(meeting.transcript.map((line) => line.text).join('\n\n'));
    // The clipboard gives no feedback of its own, and a button that does
    // nothing visible reads as one that did not work.
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy transcript';
    }, 1200);
  });
  return bar;
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
      renderReader(meeting);
    });
    bar.append(button);
  }
  return bar;
}

/** The "there are no notes here" explanation, phrased for why there are none. */
function notesNotice(meeting) {
  const notice = el('div', 'notice');
  if (view.activity.processingIds.includes(meeting.id)) {
    notice.append(el('strong', '', 'Still working. '), 'Transcription and notes are running now — this page fills in when they land.');
  } else if (meeting.id === view.activity.recordingId) {
    notice.append(el('strong', '', 'Recording. '), 'Notes are written once you stop, from a full pass over the saved audio.');
  } else if (meeting.status === 'failed') {
    notice.append(
      el('strong', '', 'The notes run failed. '),
      'The audio is safe in this folder, and ERROR.txt says what went wrong — usually Ollama being down. Re-run it with ',
      el('code', '', `npm run pipeline -- "${meeting.folder}"`),
    );
  } else {
    notice.append(
      el('strong', '', 'No notes for this recording. '),
      'The audio was saved but the pipeline never finished. Produce them with ',
      el('code', '', `npm run pipeline -- "${meeting.folder}"`),
    );
  }
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

function transcriptView(meeting) {
  const frag = document.createDocumentFragment();
  if (!meeting.transcript.length) {
    const notice = el('div', 'notice');
    notice.append(
      el('strong', '', 'No transcript. '),
      meeting.files.audio
        ? 'The recording has not been transcribed yet.'
        : 'This folder has no audio in it either.',
    );
    frag.append(notice);
    return frag;
  }

  for (const line of meeting.transcript) {
    const row = el('div', 'line');
    // Timestamps come from the chunk boundaries the pipeline transcribed at, so
    // a line is placed to the minute, not to the word. Better than no anchor at
    // all when scrubbing back to "the bit about pricing".
    row.append(el('span', 'at', line.startSeconds === null ? '' : fmtClock(line.startSeconds)));
    const said = el('span', 'said');
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

// -------------------------------------------------------------------- loading

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
    readerEl.replaceChildren(placeholder);
    await refresh();
    return;
  }
  if (view.selected !== id) return; // A faster click won.
  readerEl.scrollTop = 0;
  renderReader(meeting);
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
  select(next);
  listEl.querySelector('.card.selected')?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Escape clears a search before it closes the window: the first press is
    // almost always "show me everything again".
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
  // Arrows walk the list unless they are being used to move a text cursor.
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target !== queryEl) {
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  }
});

document.getElementById('folder').addEventListener('click', () => window.library.openNotesFolder());
document.getElementById('minimize').addEventListener('click', () => window.library.minimize());
document.getElementById('close').addEventListener('click', () => window.library.close());

// A recording that just finished belongs at the top of the list without anyone
// having to reopen the window.
window.library.onChanged(() => {
  refresh();
  if (view.selected) select(view.selected);
});

refresh().then(() => {
  // Open the newest meeting on launch: the window is almost always opened to
  // read the one that just finished.
  if (view.meetings.length) select(view.meetings[0].id);
});
