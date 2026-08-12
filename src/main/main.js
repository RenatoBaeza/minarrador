'use strict';

// Minarrador — local-only meeting notes.
// Tray-only app: no main window ever appears. The single hidden renderer exists
// solely to run the Web Audio graph, which is unavailable in the main process.

const { app, Notification, clipboard, dialog, globalShortcut, shell, nativeImage, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');
const settingsStore = require('./settings');
const snippetsStore = require('./snippets');
const library = require('./library');
const { CaptureController } = require('./capture');
const { AppTray } = require('./tray');
const { Ollama, findOllama, launchOllama } = require('./ollama');
const { WhisperServer } = require('./whisper');
const { runPipeline, fmtDuration } = require('./pipeline');
const { createMeetingDir, FILES } = require('./paths');

const APP_ID = 'com.rntbz.minarrador';

/** How often to look for the Ollama daemon while idle. */
const OLLAMA_POLL_MS = 60_000;

/**
 * How long to keep looking after starting Ollama ourselves, and how often.
 *
 * A cold start is the service coming up, not a model loading, so it is seconds
 * rather than minutes — but the first run after an update can be slower, and
 * giving up early would report a failure that did not happen.
 */
const OLLAMA_START_TIMEOUT_MS = 30_000;
const OLLAMA_START_STEP_MS = 1500;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Settings the library window is allowed to change.
 *
 * Everything else in the store names a place — the notes folder, the Ollama
 * host, the whisper install root — and a renderer that could set one of those
 * could point this app's reading and writing anywhere on the machine. The folder
 * is changed through a dialog instead, where the path comes from the user rather
 * than from the page.
 */
const LIBRARY_SETTINGS = new Set([
  'suggestOnAudio',
  'startAtLogin',
  'liveTranscript',
  'captureMic',
  'captureSystem',
  'hotkey',
  'liveEngine',
  'transcribeEngine',
  'whisperModel',
  'whisperThreads',
  'transcribeModel',
  'summaryModel',
]);

/**
 * A main-process fault is the one failure this app has no way to show.
 *
 * There is no window to put a stack in, and Electron's default handler pops a
 * dialog that says "A JavaScript error occurred in the main process" and never
 * writes to the log file the tray menu offers — so the one artefact a bug report
 * is built from is the one place the error does not appear.
 *
 * Neither handler exits. A recording in progress is worth more than a tidy
 * process: the WAV is written here in the main process, and staying up means the
 * meeting keeps landing on disk and Stop still works.
 */
process.on('uncaughtException', (err) => {
  log.error('uncaught exception in the main process', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection in the main process', reason instanceof Error ? reason : String(reason));
});

/**
 * The identity Windows files this process under.
 *
 * Windows keys an app's taskbar name and icon off the AppUserModelID, resolving
 * it to whichever Start Menu shortcut claims that ID — not off the window icon
 * or the .exe. Showing a toast makes Electron register such a shortcut, so a
 * `npm start` run under the shipped ID plants an "Electron" shortcut pointing at
 * node_modules that outranks the installed one, and the packaged app then wears
 * the Electron logo. Dev keeps its own ID so it can only ever shadow itself.
 */
const USER_MODEL_ID = app.isPackaged ? APP_ID : `${APP_ID}.dev`;

/** Launched by the login item, or otherwise asked to stay out of the way. */
const startedHidden = process.argv.includes('--hidden');

const state = {
  /** 'idle' | 'recording' | 'processing' */
  phase: 'idle',
  progress: '',
  currentDir: null,
  /**
   * Where live preview lines are written, which outlives currentDir by a beat.
   *
   * A segment already being transcribed when Stop is pressed comes back a
   * second later, by which time the recording is over — and that line was said
   * during the meeting, so it belongs in its folder. Replaced by the next
   * recording rather than cleared, so it is never pointing at nothing.
   */
  liveDir: null,
  recordingStartedAt: null,
  lastDir: null,
  ollamaUp: false,
  /** True while a look-for-Ollama pass is in flight, so the menu can say so. */
  ollamaChecking: false,
  models: [],
  audioModels: [],
  /**
   * Meetings still being processed, keyed by folder so a quit can name them.
   * The value aborts that run's model requests.
   * @type {Map<string, AbortController>}
   */
  jobs: new Map(),
  /** Whether the desktop actually gave us the start/stop shortcut. */
  hotkeyRegistered: false,
  /**
   * The meeting the tray's Retry Notes item would run, or null.
   *
   * Recomputed only when the folder changes — never from refreshTray, which
   * ticks once a second while recording and would have it walking the whole
   * notes folder for a clock.
   *
   * @type {{ id: string, label: string } | null}
   */
  retry: null,
  /** Guards the shutdown sequence against re-entering before-quit. */
  quitting: false,
};

let tray = null;
let capture = null;
let whisper = null;
let settings = null;
let uiTimer = null;
let ollamaTimer = null;
let transcriptionWindow = null;
let snippetsWindow = null;
let libraryWindow = null;

// ------------------------------------------------------------------------ UI

const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let appIconCache = null;

/**
 * The app icon, shared by every surface that shows one.
 *
 * On Windows the .ico is the same multi-size icon the installer puts on the
 * shortcut, so the taskbar, Alt-Tab and the window thumbnail all pick the size
 * they want instead of rescaling one PNG into something soft.
 */
function appIcon() {
  if (appIconCache) return appIconCache;
  const preferred = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  let img = nativeImage.createFromPath(path.join(ASSETS, preferred));
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  appIconCache = img;
  return img;
}

/**
 * The live transcript window: a read-only preview of what the model is hearing.
 *
 * It loads transcript.html, never capture.html — the latter is the hidden audio
 * worker, and opening a second copy of it would build a second Web Audio graph
 * competing for the same microphone and loopback stream.
 *
 * Frameless: the header doubles as the drag handle and carries its own close
 * button, so the page is the whole window with no OS chrome around it.
 */
function showTranscriptWindow() {
  if (transcriptionWindow && !transcriptionWindow.isDestroyed()) {
    if (transcriptionWindow.isMinimized()) transcriptionWindow.restore();
    transcriptionWindow.show();
    transcriptionWindow.focus();
    return transcriptionWindow;
  }

  transcriptionWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 320,
    minHeight: 240,
    show: false,
    frame: false,
    title: 'Live Transcription',
    backgroundColor: '#16161a',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(RENDERER, 'transcript-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  transcriptionWindow.once('ready-to-show', () => transcriptionWindow?.show());
  transcriptionWindow.on('closed', () => {
    transcriptionWindow = null;
  });
  transcriptionWindow.loadFile(path.join(RENDERER, 'transcript.html')).catch((err) => {
    log.error('transcript window failed to load', err);
  });
  return transcriptionWindow;
}

function toggleTranscriptWindow() {
  if (transcriptionWindow && !transcriptionWindow.isDestroyed() && transcriptionWindow.isVisible()) {
    transcriptionWindow.close();
    return;
  }
  showTranscriptWindow();
  sendToTranscript('transcript:state', transcriptState());
}

/**
 * The quick-copy editor: the list behind the tray's top section.
 *
 * Frameless and dark like the transcript window, and single-instance for the
 * same reason every window here is — two copies of an editor over one file
 * means whichever is saved last wins, silently.
 */
function showSnippetsWindow() {
  if (snippetsWindow && !snippetsWindow.isDestroyed()) {
    if (snippetsWindow.isMinimized()) snippetsWindow.restore();
    snippetsWindow.show();
    snippetsWindow.focus();
    return snippetsWindow;
  }

  snippetsWindow = new BrowserWindow({
    width: 520,
    height: 620,
    minWidth: 380,
    minHeight: 320,
    show: false,
    frame: false,
    title: 'Quick Copy',
    backgroundColor: '#16161a',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(RENDERER, 'snippets-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  snippetsWindow.once('ready-to-show', () => snippetsWindow?.show());
  snippetsWindow.on('closed', () => {
    snippetsWindow = null;
  });
  snippetsWindow.loadFile(path.join(RENDERER, 'snippets.html')).catch((err) => {
    log.error('quick copy window failed to load', err);
  });
  return snippetsWindow;
}

/**
 * The meeting library: the archive of everything ever recorded, and the only
 * window in this app someone opens without a meeting in progress.
 *
 * Left-clicking the tray icon lands here, so it is the app's front door — hence
 * the size, and hence single-instance like the rest: a second copy would be a
 * second reader over the same folders with nothing to gain from the split.
 *
 * Read-only over the notes folder: everything it shows comes out of library.js,
 * which never writes. Settings are the exception, and they go through the same
 * store the tray used to write — see the `settings:*` channels below.
 *
 * @param {{ settings?: boolean }} [options] `settings` opens on the settings
 *   pane rather than the archive, which is how the tray's Settings… item lands.
 */
function showLibraryWindow({ settings: toSettings = false } = {}) {
  const showSettings = (win) => {
    if (toSettings) win.webContents.send('library:showSettings');
  };

  if (libraryWindow && !libraryWindow.isDestroyed()) {
    if (libraryWindow.isMinimized()) libraryWindow.restore();
    libraryWindow.show();
    libraryWindow.focus();
    showSettings(libraryWindow);
    return libraryWindow;
  }

  libraryWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 780,
    minHeight: 480,
    show: false,
    frame: false,
    title: 'Meetings',
    backgroundColor: '#16161a',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(RENDERER, 'library-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  libraryWindow.once('ready-to-show', () => libraryWindow?.show());
  // The page has to exist before it can be told which pane to open on, so a
  // freshly built window waits for its script rather than sending into nothing.
  libraryWindow.webContents.once('did-finish-load', () => {
    if (libraryWindow && !libraryWindow.isDestroyed()) showSettings(libraryWindow);
  });
  libraryWindow.on('closed', () => {
    libraryWindow = null;
  });
  libraryWindow.loadFile(path.join(RENDERER, 'library.html')).catch((err) => {
    log.error('library window failed to load', err);
  });
  return libraryWindow;
}

/**
 * Tells an open library its list is stale.
 *
 * Sent at the four moments the folder actually changes — a recording starting
 * or ending, a pipeline run starting or finishing — rather than from
 * refreshTray, which ticks once a second while recording and would have the
 * window re-reading every transcript on disk for a clock.
 */
function notifyLibrary() {
  // The same four moments decide which meeting the tray offers to retry, so the
  // one walk of the folder answers both. Reading it here rather than in
  // refreshTray is the whole point: this fires four times a meeting, that fires
  // once a second.
  state.retry = findRetryCandidate();
  if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:changed');
  refreshTray();
}

/**
 * The newest meeting that has audio and no notes, which is what "Retry Notes"
 * in the tray means.
 *
 * Anything the app is currently busy with is excluded: the folder being
 * recorded into has no audio to work from yet, and one already in state.jobs is
 * having its notes written right now.
 */
function findRetryCandidate() {
  try {
    const recordingId = state.phase === 'recording' && state.currentDir ? path.basename(state.currentDir) : null;
    const busy = new Set([...state.jobs.keys()].map((dir) => path.basename(dir)));
    const found = library
      .listMeetings(settings.notesDir)
      .find((m) => m.files.audio && m.status !== 'ready' && m.id !== recordingId && !busy.has(m.id));
    if (!found) return null;
    const at = new Date(found.startedAt);
    const label = Number.isNaN(at.getTime())
      ? found.id
      : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return { id: found.id, label };
  } catch (err) {
    log.warn('could not look for a meeting to retry:', err.message);
    return null;
  }
}

/**
 * Tells an open library that a setting, a model list or the Ollama daemon
 * changed under it.
 *
 * Separate from {@link notifyLibrary} because the two go stale for different
 * reasons and at wildly different rates: the folder changes four times a
 * meeting, while the settings pane has to catch an Ollama poll finding the
 * daemon sixty seconds after someone clicked Open Ollama.
 */
function notifySettings() {
  if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('settings:changed');
}

/**
 * Everything the settings pane renders: the values themselves, the defaults to
 * fall back to, and what is actually installed to back them.
 *
 * The last part is the point. A model name in settings.json says nothing about
 * whether it is pulled, and the tray's radio lists could only ever show what was
 * there — the pane needs both so it can mark a setting pointing at something
 * missing rather than letting it look configured.
 */
function settingsState() {
  return {
    settings,
    defaults: settingsStore.defaults(),
    models: state.models,
    audioModels: state.audioModels,
    whisper: whisper?.describe() ?? null,
    ollama: {
      host: settings.ollamaHost,
      up: state.ollamaUp,
      checking: state.ollamaChecking,
      // Whether there is anything to start, which is the difference between
      // "click here" and "install it first".
      installed: Boolean(findOllama()),
    },
    /** What the live preview is really using, which is not always what was asked for. */
    liveEngine: capture?.liveTranscriber.engine ?? settings.liveEngine,
    /**
     * The shortcut, the ones on offer, and whether the desktop actually gave us
     * this one — a global shortcut another application already holds registers
     * as a silent no-op, which is precisely the kind of gap this pane exists to
     * show.
     */
    hotkey: {
      value: settings.hotkey,
      registered: state.hotkeyRegistered,
      choices: settingsStore.HOTKEY_CHOICES.map((value) => ({ value, label: hotkeyLabel(value) })),
    },
    notesDirExists: fs.existsSync(settings.notesDir),
    snippetCount: snippetsStore.load().length,
    /** Capture sources cannot be changed mid-meeting; the pane says so. */
    recording: state.phase === 'recording',
  };
}

/** What the library shows on folders the app is still busy with. */
function libraryActivity() {
  return {
    recordingId: state.phase === 'recording' && state.currentDir ? path.basename(state.currentDir) : null,
    processingIds: [...state.jobs.keys()].map((dir) => path.basename(dir)),
  };
}

/**
 * Keeps the live preview on disk as it is produced.
 *
 * The preview used to exist only in a window, and was cleared the moment
 * processing started — so a pipeline that then failed left the user with audio
 * and nothing else, having thrown away text that already existed. Appended line
 * by line rather than written at the end, because the case this is for is the
 * one where there is no end: a crash, a power cut, a quit mid-meeting.
 *
 * Best-effort by design. A preview that cannot be written must never interrupt
 * the recording, which is the artefact that actually matters.
 */
function appendLiveTranscript(text) {
  const line = String(text ?? '').trim();
  if (!state.liveDir || !line) return;
  try {
    fs.appendFileSync(path.join(state.liveDir, FILES.liveTranscript), `${line}\n`);
  } catch (err) {
    log.warn('could not append to the live transcript:', err.message);
  }
}

/** Posts to the transcript window when one is open; a no-op otherwise. */
function sendToTranscript(channel, payload) {
  if (transcriptionWindow && !transcriptionWindow.isDestroyed()) {
    transcriptionWindow.webContents.send(channel, payload);
  }
}

function transcriptState() {
  const engine = capture?.liveTranscriber.engine === 'whisper' ? 'whisper.cpp' : settings?.transcribeModel;
  return {
    recording: state.phase === 'recording',
    label: state.phase === 'recording' ? 'Recording' : state.phase === 'processing' ? state.progress || 'Processing…' : 'Idle',
    // Which engine is producing these lines. Worth showing: the two differ
    // enough in speed and phrasing that "why is this slow" has a real answer.
    engine: state.phase === 'recording' && settings?.liveTranscript ? engine : '',
  };
}

function refreshTray() {
  sendToTranscript('transcript:state', transcriptState());
  if (!tray) return;
  tray.update({
    state: state.phase,
    elapsed: capture?.elapsedSeconds ?? 0,
    progress: state.progress,
    settings,
    status: capture?.status ?? {},
    ollamaUp: state.ollamaUp,
    ollamaChecking: state.ollamaChecking,
    whisper: whisper?.describe() ?? null,
    liveEngine: capture?.liveTranscriber.engine ?? settings?.liveEngine,
    lastDir: state.lastDir,
    retry: state.retry,
    snippets: snippetsStore.load(),
  });
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) {
    log.info(`notification: ${title} — ${body}`);
    return;
  }
  const n = new Notification({
    title,
    body,
    icon: appIcon(),
    silent: false,
  });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ------------------------------------------------------------------ recording

/** An accelerator as a person would read it. 'off' is a value, not a shortcut. */
function hotkeyLabel(accelerator) {
  if (!accelerator || accelerator === 'off') return 'No shortcut';
  return accelerator.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');
}

/**
 * Registers the global start/stop shortcut.
 *
 * The point of a global one is the first twenty seconds of a call, where
 * finding a tray icon, right-clicking it and reading a menu is exactly the
 * amount of friction that means the meeting goes unrecorded. Registration can
 * fail without throwing — another application holding the same combination just
 * gets it — so the result is kept for the settings pane to show.
 */
function applyHotkey() {
  globalShortcut.unregisterAll();
  state.hotkeyRegistered = false;
  const accelerator = settings.hotkey;
  if (!accelerator || accelerator === 'off') return;
  try {
    state.hotkeyRegistered = globalShortcut.register(accelerator, toggleRecording);
  } catch (err) {
    log.warn(`could not register the hotkey ${accelerator}:`, err.message);
  }
  log.info(
    state.hotkeyRegistered
      ? `hotkey ${accelerator} registered`
      : `hotkey ${accelerator} is held by another application`,
  );
}

/** What the shortcut does: one key for both ends of a meeting. */
function toggleRecording() {
  if (state.phase === 'recording') {
    stopRecording().catch((err) => log.error('stop from the hotkey failed', err));
  } else {
    startRecording();
  }
}

function startRecording() {
  if (state.phase === 'recording') return;
  try {
    fs.mkdirSync(settings.notesDir, { recursive: true });
    const dir = createMeetingDir(settings.notesDir);
    state.currentDir = dir;
    state.liveDir = dir;
    state.recordingStartedAt = new Date();
    capture.startRecording(path.join(dir, FILES.audio));
    state.phase = 'recording';
    if (settings.liveTranscript) showTranscriptWindow();
    sendToTranscript('transcript:clear');
    refreshTray();
    notifyLibrary();
    // A recording started from a shortcut has no other confirmation at all, and
    // a tray icon changing colour is not one anywhere: this is the difference
    // between knowing the meeting is being captured and hoping it is.
    notify(
      'Recording',
      state.hotkeyRegistered
        ? `Minarrador is capturing this meeting. Press ${hotkeyLabel(settings.hotkey)} again to stop.`
        : 'Minarrador is capturing this meeting. Stop it from the tray icon.',
    );
  } catch (err) {
    log.error('startRecording failed', err);
    dialog.showErrorBox('Minarrador', `Could not start recording:\n\n${err.message}`);
    state.phase = 'idle';
    refreshTray();
  }
}

/**
 * Closes the WAV and writes meta.json, without running the pipeline.
 *
 * Split out from stopRecording so shutdown can secure the irreplaceable part —
 * the audio — without waiting on a transcription that may take minutes.
 *
 * @returns {{ dir: string, meta: object } | null} null when nothing was kept
 */
async function finalizeRecording() {
  if (state.phase !== 'recording') return null;
  const dir = state.currentDir;
  const startedAt = state.recordingStartedAt;
  const sources = { mic: capture.status.micOk, system: capture.status.systemOk };

  const result = await capture.stopRecording();
  state.phase = 'idle';
  state.currentDir = null;
  refreshTray();

  if (!result || result.seconds < 1) {
    log.warn('discarding recording shorter than a second:', dir);
    // Nothing may be written back into a folder that is about to stop existing.
    state.liveDir = null;
    fs.rmSync(dir, { recursive: true, force: true });
    notify('Nothing recorded', 'The recording was too short to keep.');
    notifyLibrary(); // The folder the library was showing as recording is gone.
    return null;
  }

  const meta = {
    startedAt: (startedAt ?? new Date()).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: result.seconds,
    sources,
  };
  fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta, null, 2));
  // The folder is now a meeting the library can list, notes or no notes.
  notifyLibrary();
  return { dir, meta };
}

/**
 * How a folder tells someone how to finish the job.
 *
 * Both notes used to say only `npm run pipeline -- "<dir>"`, which assumes a
 * repository, a checkout and npm — none of which exist for anyone who installed
 * the build. The app can now do it itself, so that is what these say first.
 */
const HOW_TO_FINISH =
  'Open Minarrador (left-click the tray icon), pick this recording, and press Generate notes.\n' +
  'From a source checkout you can also run:\n\n  npm run pipeline -- "%DIR%"\n';

const howToFinish = (dir) => HOW_TO_FINISH.replace('%DIR%', dir);

/**
 * Leaves a folder able to explain itself.
 *
 * A meeting folder with audio in it and no notes looks identical whether the app
 * quit mid-recording, quit mid-pipeline, or never ran the pipeline at all. This
 * is what tells the three apart, and it carries the way to finish the job — the
 * audio is the irreplaceable part, and it is already safe on disk.
 *
 * Synchronous on purpose: both callers are on the quit path, where nothing waits
 * for a promise.
 */
function writeResumeNote(dir, reason) {
  try {
    fs.writeFileSync(
      path.join(dir, 'UNPROCESSED.txt'),
      `${reason}\n\nThe audio is still in ${FILES.audio}.\n\n${howToFinish(dir)}`,
    );
  } catch (err) {
    log.warn('could not write the resume note in', dir, err.message);
  }
}

/**
 * @param {{ reveal?: boolean }} [options] `reveal` opens the finished folder in
 *   Explorer. On by default for the tray, where there is nowhere else to land;
 *   off when the library stopped the recording, since that window is already
 *   showing the meeting and will fill in the notes on its own.
 */
async function stopRecording({ reveal = true } = {}) {
  const finished = await finalizeRecording();
  if (!finished) return;

  // The pipeline is minutes of work and the notification at the end of it is
  // the next thing anybody hears, so say the audio is safe now — for a stop
  // from the shortcut this is the only acknowledgement there is.
  notify('Recording saved', `${fmtDuration(finished.meta.durationSeconds)} captured. Writing the notes now…`);

  // Opening Explorer is the "your notes are ready" signal, so it waits for the
  // whole chain — transcription, notes, and the PDF export that ends it. A run
  // that failed leaves a half-written folder with no brief in it; that case gets
  // the failure notification, not a folder popped open as though it were done.
  const out = await processMeeting(finished.dir, finished.meta);
  if (!out || !reveal) return;

  const err = await shell.openPath(finished.dir);
  if (err) log.warn('could not open the notes folder:', err);
}

// --------------------------------------------------------------- post-process

/**
 * Runs the pipeline over a finished recording.
 *
 * @returns {Promise<object|null>} the pipeline result, or null if it failed —
 *   callers use that to tell a complete folder from a half-written one.
 */
async function processMeeting(dir, meta) {
  // The rough live preview is superseded by the proper pass that follows, so
  // clear it — but never force a window open on someone who closed it. The
  // preview's own file stays on disk until the pipeline writes a real
  // transcript over the top of it.
  sendToTranscript('transcript:clear');

  // A folder carries one explanation at a time, and both of these are now out
  // of date. Left in place, a successful re-run would keep the meeting marked
  // as failed in the library for ever.
  for (const name of ['ERROR.txt', 'UNPROCESSED.txt']) {
    fs.rmSync(path.join(dir, name), { force: true });
  }

  const abort = new AbortController();
  state.jobs.set(dir, abort);
  if (state.phase === 'idle') state.phase = 'processing';
  state.progress = 'Preparing…';
  refreshTray();
  notifyLibrary();

  const onProgress = (p) => {
    if (p.phase === 'transcribing') {
      state.progress = `Transcribing ${p.done}/${p.total}…`;
      if (p.text) sendToTranscript('transcript:line', p.text);
    } else if (p.phase === 'summarising') {
      state.progress = p.total ? `Condensing ${p.done}/${p.total}…` : 'Writing notes…';
    } else if (p.phase === 'designing') {
      state.progress = 'Designing the brief…';
    } else if (p.phase === 'rendering') {
      state.progress = 'Exporting PDF…';
    }
    refreshTray();
  };

  try {
    // whisper.cpp transcribes the saved audio too when it is installed, which
    // is what leaves Ollama needed only for the notes.
    const out = await runPipeline(dir, settings, { onProgress, meta, signal: abort.signal, whisper });
    state.lastDir = dir;
    log.info('pipeline complete:', dir);
    notify(
      out.notes.title,
      `${fmtDuration(meta.durationSeconds)} · ${out.notes.action_items.length} action item(s). Click to open the folder.`,
      () => shell.openPath(dir),
    );
    return out;
  } catch (err) {
    // A run cancelled by quit is not a failure to report: shutdown has already
    // left its own note in the folder, and there is nobody left to notify.
    if (abort.signal.aborted) {
      log.warn('pipeline cancelled for', dir);
      return null;
    }
    log.error('pipeline failed for', dir, err);
    try {
      fs.writeFileSync(
        path.join(dir, 'ERROR.txt'),
        `Processing failed at ${new Date().toISOString()}\n\n${err.stack ?? err.message}\n\n` +
          `The audio is still in ${FILES.audio}. Fix the problem (usually: start Ollama, or pull the model),\n` +
          `then generate the notes again.\n\n${howToFinish(dir)}`,
      );
    } catch {}
    notify('Notes failed', `${err.message.slice(0,180)} — audio was saved. Click to open the folder.`, () => shell.openPath(dir));
    return null;
  } finally {
    state.jobs.delete(dir);
    if (state.jobs.size === 0) {
      if (state.phase === 'processing') state.phase = 'idle';
      state.progress = '';
    }
    refreshTray();
    // Whichever way the run ended, the folder now holds something new to read.
    notifyLibrary();
    // The transcript window stays open; closing it is the user's call.
  }
}

/**
 * Runs the pipeline again over a meeting that already has its audio.
 *
 * The most likely failure in the app is Ollama not running at the moment
 * someone hits Stop, and until this existed the only way out of it was a
 * checkout, npm, and a command line — so for anyone who installed the build,
 * every meeting recorded before starting the daemon was a dead folder. The
 * chain is re-runnable and each stage overwrites its own artefact, so this is
 * simply {@link processMeeting} again.
 *
 * Not awaited by its callers: a run is minutes of work, and both the tray and
 * the library find out it finished from `library:changed` like everything else.
 *
 * @param {string} id meeting folder name, as the library names one
 * @returns {{ ok: boolean, reason?: string }}
 */
function reprocessMeeting(id) {
  const dir = library.meetingDir(settings.notesDir, id);
  if (!dir) return { ok: false, reason: 'That recording is not in the meetings folder any more.' };
  if (!fs.existsSync(path.join(dir, FILES.audio))) {
    return { ok: false, reason: 'There is no audio in that folder to work from.' };
  }
  if (state.jobs.has(dir)) return { ok: false, reason: 'Those notes are already being written.' };
  if (state.phase === 'recording' && state.currentDir === dir) {
    return { ok: false, reason: 'That meeting is still recording.' };
  }

  // meta.json is written when the audio file closes, so it is normally there
  // even for a meeting that never got its notes. A folder missing it still has
  // its audio, and the pipeline fills the duration in from the WAV itself.
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, FILES.meta), 'utf8'));
  } catch {
    meta = { startedAt: fs.statSync(path.join(dir, FILES.audio)).mtime.toISOString(), durationSeconds: 0 };
  }

  log.info('generating notes again for', dir);
  processMeeting(dir, meta).catch((err) => log.error('re-running the pipeline failed for', dir, err));
  return { ok: true };
}

// ------------------------------------------------------------------- services

async function refreshOllama() {
  const client = new Ollama(settings.ollamaHost);
  const up = await client.isUp();
  const changed = up !== state.ollamaUp;
  state.ollamaUp = up;
  if (up && (changed || state.models.length === 0)) {
    state.models = await client.listModels();
    state.audioModels = await client.audioModels();
    // Keep the configured models pointing at something that exists.
    //
    // Tested against the installed list, never against audioModels: the audio
    // capability is probed per model with a request that reports nothing when
    // it fails, so a daemon busy loading something else can make a perfectly
    // good model look unusable. Switching on that weaker signal silently moved
    // a working setup onto whichever model Ollama happened to list first, which
    // in practice meant a smaller variant that returns repetition loops instead
    // of a transcript.
    if (state.models.length && !state.models.includes(settings.transcribeModel)) {
      const replacement = state.audioModels[0] ?? state.models[0];
      const previous = settings.transcribeModel;
      settings = settingsStore.save({ transcribeModel: replacement });
      log.warn(`transcription model ${previous} is not installed; switched to ${replacement}`);
      notify(
        'Transcription model changed',
        `${previous} is no longer installed, so Minarrador switched to ${replacement}. ` +
          'Pick another under Settings → Transcription model.',
      );
    }
    if (state.models.length && !state.models.includes(settings.summaryModel)) {
      settings = settingsStore.save({ summaryModel: state.models[0] });
      log.warn('notes model missing; switched to', settings.summaryModel);
    }
  } else if (!up) {
    state.models = [];
    state.audioModels = [];
  }
  // A model swap above changes what the live preview should be asking for.
  applyLiveConfig();
  refreshTray();
  if (changed || state.models.length) notifySettings();
}

/**
 * Starts Ollama and waits for it to answer.
 *
 * This used to be "try to find Ollama again", which asked the user to go and
 * start a daemon themselves and then come back — for the single most common
 * failure in the app, since a meeting stopped with Ollama down loses its notes.
 * The daemon is a local executable this process can perfectly well launch, so it
 * launches it and then waits, rather than waiting out the 60s poll.
 *
 * Safe to call when Ollama is already up: it becomes a refresh.
 */
async function openOllama() {
  if (state.ollamaChecking) return;
  state.ollamaChecking = true;
  refreshTray();
  notifySettings();

  let launched = null;
  try {
    if (!state.ollamaUp) launched = launchOllama();
    if (launched) log.info('starting Ollama:', launched);

    const deadline = Date.now() + OLLAMA_START_TIMEOUT_MS;
    // Always one pass, so a call with Ollama already up still refreshes the
    // model lists rather than sleeping and reporting stale ones.
    for (;;) {
      await refreshOllama();
      if (state.ollamaUp || !launched || Date.now() >= deadline) break;
      await delay(OLLAMA_START_STEP_MS);
    }
  } catch (err) {
    log.error('could not start Ollama', err);
    notify('Could not start Ollama', err.message);
    return;
  } finally {
    state.ollamaChecking = false;
    refreshTray();
    notifySettings();
  }

  if (state.ollamaUp) {
    notify('Ollama is running', `${state.models.length} model(s) available at ${settings.ollamaHost}.`);
  } else {
    notify(
      'Ollama did not answer',
      `${path.basename(launched ?? 'ollama')} was started but nothing is listening at ${settings.ollamaHost} yet.`,
    );
  }
}

/**
 * Writes a settings change and applies whatever it touches.
 *
 * The single path for both surfaces that can change one — the tray, and the
 * library's settings pane — so a setting cannot end up saved but not applied
 * depending on where it was clicked.
 */
function applySetting(patch) {
  settings = settingsStore.save(patch);
  if ('startAtLogin' in patch) applyLoginItem();
  if ('hotkey' in patch) applyHotkey();
  if ('captureMic' in patch || 'captureSystem' in patch) applyCaptureConfig();
  // Whisper first: which engine the live transcriber can actually use depends on
  // what the server resolved to.
  if ('whisperModel' in patch || 'whisperRoot' in patch || 'whisperThreads' in patch) applyWhisperConfig();
  if ('liveTranscript' in patch || 'transcribeModel' in patch || 'liveEngine' in patch || 'whisperModel' in patch) {
    applyLiveConfig();
  }
  refreshTray();
  notifySettings();
  return settings;
}

/** Asks for a new notes folder. Everything that reads one is pointed at it. */
async function chooseNotesFolder() {
  const res = await dialog.showOpenDialog({
    title: 'Choose where meetings are saved',
    defaultPath: settings.notesDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return false;
  settings = settingsStore.save({ notesDir: res.filePaths[0] });
  fs.mkdirSync(settings.notesDir, { recursive: true });
  refreshTray();
  notifySettings();
  // An open library is now looking at the wrong folder entirely.
  notifyLibrary();
  return true;
}

function applyLoginItem() {
  app.setLoginItemSettings({
    openAtLogin: settings.startAtLogin,
    // Tray-only anyway, but be explicit so a future window build stays hidden.
    args: ['--hidden'],
  });
}

function applyCaptureConfig() {
  capture.setActive(true, { captureMic: settings.captureMic, captureSystem: settings.captureSystem });
}

function applyWhisperConfig() {
  whisper?.configure({
    root: settings.whisperRoot,
    model: settings.whisperModel,
    threads: settings.whisperThreads,
  });
}

function applyLiveConfig() {
  capture?.configureLive({
    enabled: settings.liveTranscript,
    engine: settings.liveEngine,
    model: settings.transcribeModel,
  });
}

function diagnostics() {
  return JSON.stringify(
    {
      version: app.getVersion(),
      // electron version omitted
      platform: `${process.platform} ${process.arch}`,
      packaged: app.isPackaged,
      startedHidden,
      phase: state.phase,
      ollamaUp: state.ollamaUp,
      models: state.models,
      audioModels: state.audioModels,
      whisper: whisper?.describe(),
      liveEngine: capture?.liveTranscriber.engine,
      hotkeyRegistered: state.hotkeyRegistered,
      retry: state.retry,
      captureStatus: capture?.status,
      levels: capture?.levels,
      settings,
      logPath: log.path,
    },
    null,
    2,
  );
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // No window to focus; surface the tray menu instead.
    notify('Minarrador is already running', 'Look for the waveform icon in your system tray.');
  });

  app.setAppUserModelId(USER_MODEL_ID);
  // Tray-only app. Merely having a listener here stops Electron's default
  // "quit when the last window closes" behaviour.
  app.on('window-all-closed', () => {});

  // Every page this app loads is a local file it ships. Nothing should ever
  // navigate elsewhere or spawn a window, so refuse both outright rather than
  // relying on the pages themselves to behave — model-authored HTML reaches
  // one of these renderers.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log.warn('blocked window.open to', url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) {
        log.warn('blocked navigation to', url);
        event.preventDefault();
      }
    });
    contents.on('will-attach-webview', (event) => {
      log.warn('blocked a webview attach');
      event.preventDefault();
    });
  });

  // The transcript window is the only renderer allowed to change this, and the
  // preload restricts it to a known list before it ever reaches here.
  ipcMain.on('transcript:setLanguage', (event, lang) => {
    if (event.sender.id !== transcriptionWindow?.webContents.id) return;
    capture?.configureLive({ language: typeof lang === 'string' ? lang : '' });
    log.info('live transcript language ->', lang || 'auto');
  });

  // Frameless windows have no system close button, so the page asks for one.
  ipcMain.on('transcript:close', (event) => {
    if (event.sender.id !== transcriptionWindow?.webContents.id) return;
    transcriptionWindow.close();
  });

  // Quick copy is the only store a renderer can write to, so every channel below
  // checks the sender: the editor window, or nothing. The store normalises the
  // payload regardless — it also has to survive a hand-edited snippets.json.
  ipcMain.handle('snippets:list', (event) => {
    if (event.sender.id !== snippetsWindow?.webContents.id) return [];
    return snippetsStore.load();
  });

  ipcMain.handle('snippets:save', (event, list) => {
    if (event.sender.id !== snippetsWindow?.webContents.id) return [];
    const saved = snippetsStore.save(list);
    // The menu is rebuilt from the store, so a save is what makes a new
    // shorthand clickable — no restart, no reopening the menu twice.
    refreshTray();
    // The settings pane counts them, and the editor is opened from it.
    notifySettings();
    log.info(`quick copy: ${saved.length} shorthand(s) saved`);
    return saved;
  });

  ipcMain.on('snippets:close', (event) => {
    if (event.sender.id !== snippetsWindow?.webContents.id) return;
    snippetsWindow.close();
  });

  // The library reads the notes folder and nothing else. Its channels are
  // sender-checked like every other renderer's, and the folder name it sends
  // back is resolved by library.js rather than trusted as a path — the notes
  // folder is full of user files, and a window that could name any path could
  // hand any of them to the shell.
  const fromLibrary = (event) => event.sender.id === libraryWindow?.webContents.id;

  ipcMain.handle('library:list', (event, query) => {
    if (!fromLibrary(event)) return { meetings: [], activity: libraryActivity() };
    try {
      return { meetings: library.listMeetings(settings.notesDir, { query }), activity: libraryActivity() };
    } catch (err) {
      log.error('library list failed', err);
      return { meetings: [], activity: libraryActivity() };
    }
  });

  ipcMain.handle('library:read', (event, id) => {
    if (!fromLibrary(event)) return null;
    try {
      return library.readMeeting(settings.notesDir, id);
    } catch (err) {
      log.error('library read failed for', id, err);
      return null;
    }
  });

  ipcMain.handle('library:open', async (event, req) => {
    if (!fromLibrary(event)) return false;
    const file = library.openTarget(settings.notesDir, req?.id, req?.target);
    if (!file) return false;
    const err = await shell.openPath(file);
    if (err) log.warn('could not open', file, err);
    return !err;
  });

  ipcMain.handle('library:openNotesFolder', async (event) => {
    if (!fromLibrary(event)) return false;
    const err = await shell.openPath(settings.notesDir);
    if (err) log.warn('could not open the notes folder:', err);
    return !err;
  });

  // The library is a reader, so the clipboard is the one way text leaves it.
  ipcMain.on('library:copy', (event, text) => {
    if (!fromLibrary(event)) return;
    clipboard.writeText(String(text ?? ''));
  });

  ipcMain.on('library:minimize', (event) => {
    if (!fromLibrary(event)) return;
    libraryWindow.minimize();
  });

  ipcMain.on('library:close', (event) => {
    if (!fromLibrary(event)) return;
    libraryWindow.close();
  });

  // Producing the notes for a meeting that has none — the way out of the app's
  // most likely failure, and the reason the reader's "Generate notes" button
  // exists. The id is a folder name and reprocessMeeting resolves it through
  // library.meetingDir like every other channel here.
  ipcMain.handle('library:reprocess', (event, id) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return reprocessMeeting(String(id ?? ''));
  });

  // Starting a meeting from the library rather than the tray. Neither call is
  // awaited: startRecording is synchronous, and stopRecording runs the whole
  // pipeline, which is minutes of work no click should hang on. The window finds
  // out what happened from library:changed, the same way it finds out about a
  // recording started from the tray.
  ipcMain.handle('library:record', (event, on) => {
    if (!fromLibrary(event)) return false;
    if (on) {
      startRecording();
    } else {
      stopRecording({ reveal: false }).catch((err) => log.error('stop from the library failed', err));
    }
    return true;
  });

  // Settings. The library is the only surface that changes one now, and it is
  // still a renderer: the patch is filtered to the keys below, and the two that
  // name something on disk are checked against what is actually installed.
  ipcMain.handle('settings:get', (event) => (fromLibrary(event) ? settingsState() : null));

  ipcMain.handle('settings:set', (event, patch) => {
    if (!fromLibrary(event)) return null;
    const clean = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (LIBRARY_SETTINGS.has(key)) clean[key] = value;
    }
    // settings.js checks the type of a model name, not whether it exists — and
    // whisperModel is resolved against a folder of weights, so a name from a
    // page is the one string here that reaches the filesystem. Both are picked
    // from a list the window was given, so anything else is not a setting.
    if ('whisperModel' in clean && !(whisper?.models ?? []).includes(clean.whisperModel)) delete clean.whisperModel;
    if ('transcribeModel' in clean && !state.models.includes(clean.transcribeModel)) delete clean.transcribeModel;
    if ('summaryModel' in clean && !state.models.includes(clean.summaryModel)) delete clean.summaryModel;

    if (Object.keys(clean).length) {
      applySetting(clean);
      log.info('settings changed:', Object.keys(clean).join(', '));
    }
    return settingsState();
  });

  ipcMain.handle('settings:chooseNotesFolder', async (event) => {
    if (!fromLibrary(event)) return null;
    await chooseNotesFolder();
    return settingsState();
  });

  ipcMain.handle('settings:openOllama', async (event) => {
    if (!fromLibrary(event)) return null;
    await openOllama();
    return settingsState();
  });

  // Quick copy is edited from here, but the list itself stays in the tray: the
  // editor is configuration, the list is the thing used mid-meeting.
  ipcMain.on('settings:editQuickCopy', (event) => {
    if (!fromLibrary(event)) return;
    showSnippetsWindow();
  });

  /**
   * Brings the app up. Everything here has to succeed for there to be a tray
   * icon at all, which is why the caller treats a throw as fatal — see below.
   */
  async function startup() {
    log.init(app.getPath('userData'));
    log.info(`Minarrador ${app.getVersion()} starting (hidden=${startedHidden}, packaged=${app.isPackaged})`);

    settings = settingsStore.load();
    fs.mkdirSync(settings.notesDir, { recursive: true });
    applyLoginItem();

    CaptureController.installMediaHandlers();
    whisper = new WhisperServer({
      root: settings.whisperRoot,
      model: settings.whisperModel,
      threads: settings.whisperThreads,
    });
    log.info(
      whisper.available
        ? `whisper.cpp found: ${path.basename(whisper.model)} in ${whisper.root}`
        : `whisper.cpp not installed in ${whisper.root} — the live preview falls back to Ollama`,
    );
    // A crash takes the preview with it until the next recording; the meeting
    // itself and the proper transcription afterwards are untouched.
    whisper.on('exit', refreshTray);
    whisper.on('ready', refreshTray);

    capture = new CaptureController({ ollamaHost: settings.ollamaHost, whisper });
    capture.on('status', refreshTray);
    capture.on('transcript', (text) => {
      sendToTranscript('transcript:line', text);
      appendLiveTranscript(text);
    });
    capture.on('speech', () => {
      if (!settings.suggestOnAudio || state.phase === 'recording') return;
      notify('Sounds like a meeting', 'Minarrador heard sustained audio. Click to start recording.', startRecording);
    });
    // The worker rebuilds itself; this is only about telling the person in the
    // meeting, who otherwise has no way to know the room stopped being recorded.
    capture.on('rendererGone', ({ wasRecording, recovering }) => {
      refreshTray();
      if (!recovering) {
        notify(
          'Audio capture has stopped',
          wasRecording
            ? 'The capture worker keeps crashing. Stop the recording to keep what was captured so far.'
            : 'The capture worker keeps crashing. Try Troubleshooting → Restart Audio Capture.',
        );
      } else if (wasRecording) {
        notify('Audio capture restarted', 'A few seconds of the meeting were lost. Recording continues into the same file.');
      }
    });

    tray = new AppTray({
      startRecording,
      stopRecording,
      openLast: () => {
        if (!state.lastDir) return;
        const pdf = path.join(state.lastDir, FILES.pdf);
        shell.openPath(fs.existsSync(pdf) ? pdf : state.lastDir);
      },
      openLog: () => shell.openPath(log.path),
      openOllama,
      // The tray's way out of a meeting that lost its notes, for someone who is
      // not going to open a window to find the same button.
      retryNotes: () => {
        if (!state.retry) return;
        const { ok, reason } = reprocessMeeting(state.retry.id);
        if (!ok) notify('Cannot generate those notes', reason);
      },
      openLibrary: () => showLibraryWindow(),
      openSettings: () => showLibraryWindow({ settings: true }),
      toggleTranscript: toggleTranscriptWindow,
      diagnostics,
      restartCapture: () => {
        capture.setActive(false);
        setTimeout(applyCaptureConfig, 600);
      },
      // before-quit owns the shutdown sequence, including its re-entrancy guard.
      quit: () => app.quit(),
    });

    await capture.init();
    applyCaptureConfig();
    applyLiveConfig();
    applyHotkey();
    // Also finds the newest meeting still owed its notes, so the tray can offer
    // to write them for a run that failed in an earlier session.
    notifyLibrary();

    await refreshOllama();
    // The poll is fire-and-forget, so it swallows its own failures: an
    // unhandled rejection every 60 seconds would bury the log in the one file
    // a bug report is built from.
    ollamaTimer = setInterval(() => {
      refreshOllama().catch((err) => log.warn('Ollama poll failed:', err.message));
    }, OLLAMA_POLL_MS);
    // Keeps the recording clock in the tooltip/menu moving.
    uiTimer = setInterval(() => {
      if (state.phase === 'recording') refreshTray();
    }, 1000);

    if (!startedHidden) {
      notify('Minarrador is running', 'Use the waveform icon in your system tray to start recording.');
    }
  }

  // A tray-only app that fails to start has nowhere to say so: no window, no
  // icon, just a process sitting in Task Manager. Say it in the one place
  // guaranteed to be visible, then leave rather than pretending to run.
  app.whenReady()
    .then(startup)
    .catch((err) => {
      log.error('startup failed', err);
      dialog.showErrorBox(
        'Minarrador could not start',
        `${err.message}\n\n${log.path ? `Details are in ${log.path}` : 'The log file was never created.'}`,
      );
      app.exit(1);
    });

  /** Releases everything the app holds. Runs once, on the way out. */
  function shutdown() {
    clearInterval(uiTimer);
    clearInterval(ollamaTimer);
    uiTimer = null;
    ollamaTimer = null;
    // A global shortcut outlives the window that registered it, so hand it back
    // rather than leaving the combination dead for the next application.
    globalShortcut.unregisterAll();

    // A meeting still being processed is about to lose its pipeline. Stop the
    // model requests rather than leaving them to be cut mid-socket, and leave
    // the folder able to explain itself — every stage that finished has already
    // written its artefact, so this is only ever the tail of the chain.
    for (const [dir, abort] of state.jobs) {
      abort.abort();
      log.warn('quit requested while processing', dir);
      writeResumeNote(dir, 'Minarrador quit while these notes were still being written.');
    }
    state.jobs.clear();

    capture?.destroy();
    tray?.destroy();
  }

  app.on('before-quit', (e) => {
    // Quitting mid-meeting must not lose the audio, but it must not hang for
    // the several minutes a pipeline run can take either. Close the file, leave
    // a note explaining how to produce the notes later, then quit.
    if (capture?.isRecording && !state.quitting) {
      e.preventDefault();
      state.quitting = true;
      log.info('quit requested while recording — closing the audio file first');
      finalizeRecording()
        .then((finished) => {
          if (!finished) return;
          writeResumeNote(finished.dir, 'Minarrador quit while this meeting was still recording, so the audio was saved but the notes were never generated.');
          notify('Recording saved', 'Minarrador quit before writing the notes. Click to open the folder.', () =>
            shell.openPath(finished.dir),
          );
        })
        .catch((err) => log.error('failed to finalize recording during quit', err))
        .finally(() => app.quit());
      return;
    }

    shutdown();
  });
}
