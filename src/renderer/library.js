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
  /** 'reader' | 'settings' — which of the two the right-hand pane is showing. */
  mode: 'reader',
  /** settingsState() from the main process, or null before it has been asked for. */
  settings: null,
  activity: { recordingId: null, processingIds: [] },
  /**
   * What the last record click asked for, until the rail confirms it happened.
   * Recording is started and stopped in the main process, so this window learns
   * the result the same way it learns about a recording started from the tray.
   */
  recordWanted: null,
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

/** The "there are no notes here" explanation, phrased for why there are none. */
function notesNotice(meeting) {
  const notice = el('div', 'notice');
  if (view.activity.processingIds.includes(meeting.id)) {
    notice.append(el('strong', '', 'Still working. '), 'Transcription and notes are running now — this page fills in when they land.');
    return notice;
  }
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
    // Same button as the notes tab, and the same three states it must not offer
    // itself in: nothing to work from, a meeting still recording, and a run
    // already under way.
    const busy =
      meeting.id === view.activity.recordingId || view.activity.processingIds.includes(meeting.id);
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
  ]);
}

function liveSection(frag, s) {
  const whisper = s.whisper;
  const installed = Boolean(whisper?.available);
  const wantsWhisper = s.settings.liveEngine === 'whisper';
  const models = whisper?.models ?? [];
  const model = whisper?.model ?? '';

  group(frag, 'Live transcript', [
    selectRow({
      title: 'Engine',
      hint: 'whisper.cpp is a local speech recogniser and runs several times faster than the audio model.',
      alert: wantsWhisper && !installed ? 'whisper.cpp is not installed — falling back to Ollama. Run npm run whisper:setup.' : '',
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
      alert: installed ? '' : 'No GGML models — run npm run whisper:setup to fetch one.',
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
  ]);
}

function ollamaSection(frag, s) {
  const { models, audioModels, ollama } = s;
  const audio = new Set(audioModels);
  const missingTranscribe = !models.includes(s.settings.transcribeModel);
  const missingSummary = !models.includes(s.settings.summaryModel);
  const whisperInstalled = Boolean(s.whisper?.available);
  const whisperModel = s.whisper?.model ?? '';
  const wantsWhisper = s.settings.transcribeEngine === 'whisper';

  group(frag, 'Transcription and notes', [
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
  group(frag, 'Storage and shorthands', [
    buttonRow({
      title: 'Meetings folder',
      value: s.settings.notesDir,
      hint: 'One folder per recording: the audio, the transcript, the notes and the PDF brief.',
      alert: s.notesDirExists ? '' : 'This folder does not exist any more. Pick another, or the library stays empty.',
      missing: !s.notesDirExists,
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
  recordingSection(frag, s);
  liveSection(frag, s);
  ollamaSection(frag, s);
  storageSection(frag, s);
  doc.append(frag);
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
  else readerEl.replaceChildren(placeholder);
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

recordEl.addEventListener('click', () => {
  const wanted = !view.activity.recordingId;
  view.recordWanted = wanted;
  renderRecordButton();
  // Nothing here waits for the answer: stopping runs the whole pipeline, and the
  // confirmation is the folder list changing under us.
  window.library.record(wanted);
  clearTimeout(recordTimer);
  recordTimer = setTimeout(() => {
    view.recordWanted = null;
    renderRecordButton();
  }, RECORD_CONFIRM_MS);
});

// -------------------------------------------------------------------- loading

/**
 * Reads a meeting into the reader, if the reader is what is on screen.
 *
 * Also called from the refresh path, where the settings pane may well be open —
 * hence the checks: a pipeline finishing must not throw someone out of the
 * setting they were changing.
 */
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
    if (view.mode === 'reader') readerEl.replaceChildren(placeholder);
    await refresh();
    return;
  }
  if (view.selected !== id) return; // A faster click won.
  view.meeting = meeting;
  if (view.mode !== 'reader') return;
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
  const { meetings, activity } = await window.library.list(view.query);
  if (seq !== listSeq) return; // A later query already answered.
  view.meetings = meetings;
  view.activity = activity;
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
  // Arrows walk the list unless they are being used to move a text cursor.
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target !== queryEl) {
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  }
});

document.getElementById('folder').addEventListener('click', () => window.library.openNotesFolder());
document.getElementById('minimize').addEventListener('click', () => window.library.minimize());
document.getElementById('close').addEventListener('click', () => window.library.close());
settingsEl.addEventListener('click', () => (view.mode === 'settings' ? closeSettings() : openSettings()));

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
// missing — so it redraws rather than waiting to be reopened.
window.library.settings.onChanged(async () => {
  if (view.mode !== 'settings') return;
  view.settings = await window.library.settings.get();
  if (view.mode === 'settings') renderSettings();
});

// The tray's Settings… item, which opens this window straight onto the pane.
window.library.onShowSettings(() => openSettings());

refresh().then(() => {
  // Open the newest meeting on launch: the window is almost always opened to
  // read the one that just finished.
  if (view.meetings.length) select(view.meetings[0].id);
});
