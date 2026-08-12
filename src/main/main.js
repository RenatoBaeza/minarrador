'use strict';

// Minarrador — local-only meeting notes.
// Tray-only app: no main window ever appears. The single hidden renderer exists
// solely to run the Web Audio graph, which is unavailable in the main process.

const {
  app,
  Notification,
  clipboard,
  dialog,
  globalShortcut,
  powerMonitor,
  powerSaveBlocker,
  screen,
  shell,
  nativeImage,
  BrowserWindow,
  ipcMain,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');
const settingsStore = require('./settings');
const snippetsStore = require('./snippets');
const dictationsStore = require('./dictations');
const library = require('./library');
const { CaptureController } = require('./capture');
const { AppTray } = require('./tray');
const { Ollama, findOllama, launchOllama } = require('./ollama');
const { WhisperServer, installRoot } = require('./whisper');
const whisperSetup = require('./whisper-setup');
const { DictationController, dictationEngineFor } = require('./dictation');
const { pasteClipboardInForeground } = require('./paste');
const { runPipeline, fmtDuration } = require('./pipeline');
const { createMeetingDir, FILES, speakerLine, normaliseTitle } = require('./paths');

const APP_ID = 'com.rntbz.minarrador';

/** How often to look for the Ollama daemon while idle. */
const OLLAMA_POLL_MS = 60_000;

/**
 * How much room the notes folder's volume must have before a meeting starts,
 * and how little is left before one is ended.
 *
 * A recording is ~115 MB an hour in mono and ~230 MB in stereo, so the warning
 * threshold is most of a working day of audio and the refusal is under two
 * hours of it. The floor matters more than the numbers: a disk that fills
 * mid-meeting stops the WAV growing while every other part of the app carries
 * on saying "Recording", which is the failure this app exists not to have.
 */
const DISK_WARN_BYTES = 2 * 1024 ** 3;
const DISK_REFUSE_BYTES = 300 * 1024 ** 2;
const DISK_STOP_BYTES = 150 * 1024 ** 2;
/** How often the free space is re-read while recording. */
const DISK_CHECK_MS = 30_000;

/**
 * When a long recording says so, and how often it repeats itself.
 *
 * Separate from the hard cap: the cap is for the recording nobody is watching,
 * this is for the person who is and has simply forgotten. Three hours is past
 * every real meeting and well short of the four-hour default ceiling.
 */
const LONG_RECORDING_SECONDS = 3 * 3600;
const LONG_RECORDING_REPEAT_SECONDS = 3600;

/**
 * Slowest rate at which pipeline progress is pushed to the library window.
 *
 * Progress ticks once per transcribed chunk, which on a short chunk setting is
 * every few seconds. It rides its own channel rather than `library:changed`
 * precisely so it cannot make the window re-read every transcript on disk, and
 * this keeps even the cheap path from being spammed.
 */
const PROGRESS_MIN_MS = 700;

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
  'separateChannels',
  // Not a path: an opaque device handle Chromium issues, checked below against
  // the list the capture worker actually reported.
  'micDeviceId',
  'micDeviceLabel',
  'silenceStopMinutes',
  'maxRecordingMinutes',
  'preventSleep',
  'hotkey',
  'dictateHotkey',
  'dictateEngine',
  'dictateAutoPaste',
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
  /** Elapsed seconds at which the "still recording" warning last went out. */
  warnedLongAt: 0,
  /** Free space last read on the notes volume, and when — see checkDisk. */
  disk: { free: null, checkedAt: 0, warned: false },
  /** powerSaveBlocker handle held for the duration of a recording, or null. */
  sleepBlocker: null,
  lastDir: null,
  ollamaUp: false,
  /** True while a look-for-Ollama pass is in flight, so the menu can say so. */
  ollamaChecking: false,
  models: [],
  audioModels: [],
  /**
   * Meetings still being processed, keyed by folder so a quit can name them.
   *
   * `abort` stops that run's model requests; `progress` is the same detail the
   * tray shows, kept per meeting so the library can show it on the right card
   * rather than the bare "Working…" it used to.
   *
   * @type {Map<string, { abort: AbortController, progress: { phase: string, done: number, total: number, label: string } }>}
   */
  jobs: new Map(),
  /**
   * The one download the app will run at a time, or null.
   *
   * One at a time on purpose: both of these are the way out of "this app cannot
   * transcribe anything", they are the only things here that take minutes with
   * nothing to show but a bar, and two at once over one connection is slower
   * than either alone.
   *
   * @type {{ kind: 'model'|'whisper', label: string, status: string, completed: number, total: number, abort: AbortController } | null}
   */
  setup: null,
  /** Whether the desktop actually gave us the start/stop shortcut. */
  hotkeyRegistered: false,
  /** Whether the desktop actually gave us the voice-input shortcut. */
  dictateHotkeyRegistered: false,
  /** The accelerator that was actually registered, so a change can release it. */
  dictateHotkeyAcc: null,
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
  /** True while a recording is being closed — see finalizeRecording. */
  stopping: false,
};

let tray = null;
let capture = null;
let dictation = null;
let whisper = null;
let settings = null;
let uiTimer = null;
let ollamaTimer = null;
/**
 * Throttles for the two streams that tick faster than a window wants redrawing.
 *
 * One each rather than one shared, because a download and a pipeline run can
 * perfectly well be happening at once, and a shared clock would have each of
 * them swallowing the other's updates.
 */
let lastProgressAt = 0;
let lastSetupAt = 0;
let transcriptionWindow = null;
let snippetsWindow = null;
let libraryWindow = null;
let dictationsWindow = null;
let dictateIndicator = null;
/** When the "Pasted" pill last got told to leave, so a second dictation can bring it back. */
let dictateIndicatorTimer = null;

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
 * The dictations archive: everything the voice-input hotkey has transcribed.
 *
 * Frameless and single-instance like every other window here — two copies of an
 * editor over one file means whichever is saved last wins, silently.
 */
function showDictationsWindow() {
  if (dictationsWindow && !dictationsWindow.isDestroyed()) {
    if (dictationsWindow.isMinimized()) dictationsWindow.restore();
    dictationsWindow.show();
    dictationsWindow.focus();
    return dictationsWindow;
  }

  dictationsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 420,
    minHeight: 320,
    show: false,
    frame: false,
    title: 'Dictations',
    backgroundColor: '#16161a',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(RENDERER, 'dictations-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  dictationsWindow.once('ready-to-show', () => dictationsWindow?.show());
  dictationsWindow.on('closed', () => {
    dictationsWindow = null;
  });
  dictationsWindow.loadFile(path.join(RENDERER, 'dictations.html')).catch((err) => {
    log.error('dictations window failed to load', err);
  });
  return dictationsWindow;
}

/**
 * Tells an open dictations window that the list changed, so it re-reads the
 * store. A dictation landing mid-edit leaves the row alone — the window skips
 * a refresh while it has unsaved text.
 */
function notifyDictations() {
  if (dictationsWindow && !dictationsWindow.isDestroyed()) {
    dictationsWindow.webContents.send('dictations:changed');
  }
}

// ------------------------------------------------------------------ voice input
//
// The dictation hotkey: press to start the microphone, press again to stop,
// transcribe locally, paste where you were typing, and copy it anyway. The
// controller owns the audio and the text comes back here for everything that
// touches the outside world — the clipboard, the paste, the archive, the
// indicator.

/**
 * The floating pill that says a dictation is in flight.
 *
 * `focusable: false` is the whole point: the window it floats over is the one
 * the finished text is about to be pasted into, and a window that could take
 * the cursor would move the target. It is positioned over the primary display's
 * work area, out of the way of whatever is being read.
 */
function showDictateIndicator() {
  if (dictateIndicator && !dictateIndicator.isDestroyed()) {
    dictateIndicator.show();
    return dictateIndicator;
  }

  const width = 380;
  const height = 64;
  const wa = screen.getPrimaryDisplay().workArea;
  dictateIndicator = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + wa.height - height - 48),
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#16161a',
    webPreferences: {
      preload: path.join(RENDERER, 'dictate-indicator-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dictateIndicator.on('closed', () => {
    dictateIndicator = null;
  });
  dictateIndicator.loadFile(path.join(RENDERER, 'dictate-indicator.html')).catch((err) => {
    log.error('dictate indicator failed to load', err);
  });
  dictateIndicator.once('ready-to-show', () => dictateIndicator?.show());
  return dictateIndicator;
}

/** Sends state to the indicator if it is up; a no-op otherwise. */
function sendToDictate(payload) {
  if (dictateIndicator && !dictateIndicator.isDestroyed()) {
    dictateIndicator.webContents.send('dictate:state', payload);
  }
}

/** The indicator leaves by itself a few seconds after it has said "Pasted". */
function scheduleIndicatorHide() {
  clearTimeout(dictateIndicatorTimer);
  dictateIndicatorTimer = setTimeout(() => {
    dictateIndicatorTimer = null;
    if (dictateIndicator && !dictateIndicator.isDestroyed()) dictateIndicator.hide();
  }, 4000);
}

/**
 * Registers the voice-input global shortcut.
 *
 * Separate from {@link applyHotkey}: the two accelerators are different
 * gestures and must be unregistered independently — an unregisterAll here would
 * take the meeting shortcut with it. Registration fails silently when another
 * application holds the combination, so the result is kept for the settings
 * pane, exactly as the meeting hotkey's is.
 */
function applyDictateHotkey() {
  // Release the combination that is actually registered, not the one being set
  // now — applySetting has already written the new value by the time this runs.
  if (state.dictateHotkeyRegistered && state.dictateHotkeyAcc) {
    globalShortcut.unregister(state.dictateHotkeyAcc);
  }
  state.dictateHotkeyRegistered = false;
  state.dictateHotkeyAcc = null;
  const accelerator = settings.dictateHotkey;
  if (!accelerator || accelerator === 'off') return;
  try {
    state.dictateHotkeyRegistered = globalShortcut.register(accelerator, toggleDictation);
    if (state.dictateHotkeyRegistered) state.dictateHotkeyAcc = accelerator;
  } catch (err) {
    log.warn(`could not register the dictate hotkey ${accelerator}:`, err.message);
  }
  log.info(
    state.dictateHotkeyRegistered
      ? `dictate hotkey ${accelerator} registered`
      : `dictate hotkey ${accelerator} is held by another application`,
  );
}

/** One key for both ends of a dictation, exactly as for a meeting. */
function toggleDictation() {
  if (dictation?.active) {
    stopDictation().catch((err) => log.error('stop from the dictate hotkey failed', err));
  } else {
    startDictation();
  }
}

function startDictation() {
  if (!dictation || dictation.active) return;
  // A dictation that cannot be transcribed later is not worth starting, and
  // saying so on the way in is kinder than after a sentence of audio. This
  // only fires when there is no engine on the machine at all — an Ollama that
  // is merely down can be started, and the stop path keeps the clip if it is not.
  if (!whisper?.available && !findOllama()) {
    notify('Voice input is not ready', 'Neither Ollama nor whisper.cpp is installed, so nothing could transcribe it.');
    return;
  }
  dictation.start({
    micDeviceId: settings.micDeviceId,
    micDeviceLabel: settings.micDeviceLabel,
    transcribeModel: settings.transcribeModel,
    liveEngine: settings.liveEngine,
  });
  showDictateIndicator();
  sendToDictate({ state: 'listening' });
  refreshTray();
}

/**
 * Closes the mic, transcribes what was said, and hands the text to the world.
 *
 * This is the whole feature: the paste and the clipboard and the archive all
 * fan out from the single string that comes back here.
 */
async function stopDictation() {
  if (!dictation?.active) return;
  sendToDictate({ state: 'transcribing' });
  refreshTray();

  const engine = dictationEngineFor(settings, whisper, state.ollamaUp);
  const model = engine === 'whisper' ? '' : settings.transcribeModel;
  let result;
  try {
    result = await dictation.stop({ engine, model });
  } catch (err) {
    log.error('dictation stop failed', err);
    sendToDictate({ state: 'error', error: err.message });
    notify('Voice input failed', err.message);
    scheduleIndicatorHide();
    refreshTray();
    return;
  }

  refreshTray();

  if (!result.text) {
    if (result.error) {
      // The words are gone but the audio is not — the clip was kept, so the
      // failure is fixable rather than final.
      const body = result.saved
        ? `Could not transcribe: ${result.error}. The audio is kept — open it to check.`
        : `Could not transcribe: ${result.error}.`;
      notify('Voice input failed', body, result.saved ? () => shell.openPath(path.dirname(result.saved)) : undefined);
      sendToDictate({ state: 'error', error: result.error });
    } else {
      notify('Nothing heard', 'No speech was captured. Press the voice-input shortcut and try again.');
      sendToDictate({ state: 'error', error: 'Nothing was heard' });
    }
    scheduleIndicatorHide();
    return;
  }

  // The clipboard always gets the text, whatever happens with the paste.
  clipboard.writeText(result.text);

  // Copying to the clipboard alone would be the fallback the paste is meant to
  // avoid, so the paste runs first and its failure is reported in the same
  // notification that confirms the text.
  let pasted = false;
  if (settings.dictateAutoPaste) {
    pasted = await pasteClipboardInForeground();
    if (!pasted) log.warn('the auto-paste did not land (elevated window?) — the clipboard still holds the text');
  }

  // The archive is the history the user asked for; the paste is transient.
  dictationsStore.add(result.text);
  notifyDictations();

  const preview = result.text.length > 90 ? `${result.text.slice(0, 90)}…` : result.text;
  notify(
    pasted ? 'Dictated and pasted' : settings.dictateAutoPaste ? 'Dictated — copied to clipboard' : 'Dictated',
    `${preview}${settings.dictateAutoPaste && !pasted ? ' (could not paste here; the text is on your clipboard)' : ''}`,
    () => showDictationsWindow(),
  );
  sendToDictate({ state: 'done' });
  scheduleIndicatorHide();
  log.info('dictation finished:', result.seconds.toFixed(1), 's');
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
     * The microphones on this machine, and the one actually open.
     *
     * `micLabel` is the point of the pair: a capture status of micOk: true says
     * a microphone opened, not that it is the one being talked into, and a
     * meeting recorded off the laptop lid instead of the headset looks
     * identical to a good one until it is played back.
     */
    mic: {
      devices: capture?.devices ?? [],
      active: capture?.status.micLabel ?? '',
      chosen: settings.micDeviceId,
      chosenLabel: settings.micDeviceLabel,
    },
    /** Whether a recording is being written as two channels right now. */
    recordingChannels: capture?.recordingChannels ?? 1,
    /** Free space where meetings are saved, so the pane can say before it matters. */
    disk: { free: state.disk.free, low: state.disk.free !== null && state.disk.free < DISK_WARN_BYTES },
    /** The download in flight, if any — an Ollama model or whisper.cpp itself. */
    setup: setupState(),
    /**
     * GGML weights the app can fetch, for a machine with no whisper.cpp at all.
     *
     * Name first, then what it costs: the size and the speed are the whole basis
     * for choosing, and a dropdown of bare descriptions would not say which
     * model is being picked.
     */
    whisperModels: Object.entries(whisperSetup.MODELS).map(([value, note]) => ({
      value,
      label: `${value} — ${note}`,
    })),
    /**
     * Models named by the settings but missing from Ollama, which is precisely
     * the state a fresh install is in. Nothing else may be pulled: a tag is
     * free text, and these two came from the store rather than from a page.
     */
    pullable: [...new Set([settings.transcribeModel, settings.summaryModel])].filter(
      (name) => name && !state.models.includes(name),
    ),
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
    dictateHotkey: {
      value: settings.dictateHotkey,
      registered: state.dictateHotkeyRegistered,
      choices: settingsStore.DICTATE_HOTKEY_CHOICES.map((value) => ({ value, label: hotkeyLabel(value) })),
    },
    /** What the voice-input controller is doing, for the tray and the settings pane. */
    dictation: {
      active: Boolean(dictation?.active),
      transcribing: Boolean(dictation?.transcribing),
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
    /**
     * Where each run has got to. The tray has said "Transcribing 12/60…" since
     * the pipeline existed while the library card said only "Working…", and the
     * numbers were already being produced — they just never left this process.
     */
    processing: [...state.jobs].map(([dir, job]) => ({ id: path.basename(dir), ...job.progress })),
  };
}

/**
 * Tells an open library how far a pipeline run has got.
 *
 * Its own channel because it fires on a completely different budget from
 * `library:changed`: that one means "the folder changed, re-read it", which
 * costs a walk of the notes directory and a read of every transcript, and it is
 * sent four times a meeting. This is a number moving, several times a minute,
 * and the window updates a card in place from it without touching the disk.
 */
function notifyProgress() {
  const now = Date.now();
  if (now - lastProgressAt < PROGRESS_MIN_MS) return;
  lastProgressAt = now;
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.webContents.send('library:progress', libraryActivity());
  }
}

/** What the settings pane renders for a download in flight, or null. */
function setupState() {
  if (!state.setup) return null;
  const { kind, label, status, completed, total } = state.setup;
  return { kind, label, status, completed, total };
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
 *
 * @param {string} speaker 'mic' | 'system' | '' — which channel carried the
 *   line, when the recording kept the two apart and one of them clearly did
 */
function appendLiveTranscript(text, speaker) {
  const line = String(text ?? '').trim();
  if (!state.liveDir || !line) return;
  try {
    fs.appendFileSync(path.join(state.liveDir, FILES.liveTranscript), `${speakerLine(speaker, line)}\n`);
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
    dictation: {
      active: Boolean(dictation?.active),
      transcribing: Boolean(dictation?.transcribing),
      hotkey: settings.dictateHotkey === 'off' ? '' : hotkeyLabel(settings.dictateHotkey),
    },
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
  return accelerator.replace('CommandOrControl', 'Ctrl').replace('Super', 'Win').replace(/\+/g, ' + ');
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

const human = (bytes) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * Free bytes on the volume the notes folder is on.
 *
 * @returns {number|null} null when it cannot be read, which is treated
 *   throughout as "no reason to stop" — a filesystem that will not report its
 *   size is not a filesystem that is known to be full.
 */
function freeSpace(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch (err) {
    log.warn('could not read the free space on', dir, err.message);
    return null;
  }
}

/**
 * Re-reads the free space, at most every DISK_CHECK_MS, and acts on it.
 *
 * Nothing else notices a disk filling up. The WavWriter reports the write that
 * finally fails, but by then the meeting has already stopped being recorded;
 * this is what makes the difference between a truncated file and a warning in
 * time to do something about it.
 */
function checkDisk({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - state.disk.checkedAt < DISK_CHECK_MS) return state.disk.free;
  state.disk.checkedAt = now;
  state.disk.free = freeSpace(settings.notesDir);
  const free = state.disk.free;
  if (free === null) return null;

  if (state.phase === 'recording' && free < DISK_STOP_BYTES) {
    log.error(`stopping the recording: only ${human(free)} left on the notes volume`);
    notify('Out of disk space', `Minarrador stopped recording with ${human(free)} left. The audio so far is saved.`);
    stopRecording().catch((err) => log.error('stop on a full disk failed', err));
    return free;
  }
  if (free < DISK_WARN_BYTES && !state.disk.warned) {
    state.disk.warned = true;
    notify('Running out of space', `${human(free)} left where meetings are saved. An hour of recording needs about 230 MB.`);
    notifySettings();
  } else if (free >= DISK_WARN_BYTES && state.disk.warned) {
    state.disk.warned = false;
    notifySettings();
  }
  return free;
}

/**
 * Holds off system sleep for as long as a meeting is being recorded.
 *
 * `prevent-app-suspension` stops Windows suspending on idle, which is the case
 * that actually happens: a call where nobody touches the keyboard for an hour.
 * It does not — cannot — stop a lid close or an explicit sleep, so it is half
 * the answer; the other half is rebuilding the audio graph on resume, since
 * what the graph's state is after a suspend is nobody's guess.
 */
function applySleepBlocker() {
  const wanted = settings.preventSleep && state.phase === 'recording';
  if (wanted === (state.sleepBlocker !== null)) return;
  if (wanted) {
    state.sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    log.info('holding off system sleep for the duration of the recording');
    return;
  }
  if (powerSaveBlocker.isStarted(state.sleepBlocker)) powerSaveBlocker.stop(state.sleepBlocker);
  state.sleepBlocker = null;
}

function startRecording() {
  if (state.phase === 'recording') return;
  try {
    fs.mkdirSync(settings.notesDir, { recursive: true });

    // Checked before the folder is made rather than after: a meeting that
    // cannot be written is better refused with a sentence than started and
    // silently truncated twenty minutes in.
    const free = checkDisk({ force: true });
    if (free !== null && free < DISK_REFUSE_BYTES) {
      dialog.showErrorBox(
        'Minarrador',
        `There is only ${human(free)} free where meetings are saved.\n\n` +
          'Free up some space, or choose another folder under Settings → Meetings folder.',
      );
      return;
    }

    const dir = createMeetingDir(settings.notesDir);
    state.currentDir = dir;
    state.liveDir = dir;
    state.recordingStartedAt = new Date();
    state.warnedLongAt = 0;
    capture.startRecording(path.join(dir, FILES.audio), {
      separateChannels: settings.separateChannels,
      silenceMinutes: settings.silenceStopMinutes,
    });
    state.phase = 'recording';
    applySleepBlocker();
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
    applySleepBlocker();
    refreshTray();
  }
}

/**
 * Ends a recording nobody is going to end themselves.
 *
 * Nothing in the app used to cap a recording at all: a meeting left running on
 * a Friday was still running on Monday, and the pipeline then spent the morning
 * on a WAV of an empty office. Both limits are settings, and both default to
 * something no real meeting reaches.
 */
function checkRecordingLimits() {
  if (state.phase !== 'recording') return;
  const elapsed = capture?.elapsedSeconds ?? 0;

  const cap = settings.maxRecordingMinutes * 60;
  if (cap && elapsed >= cap) {
    log.warn(`stopping the recording at the ${settings.maxRecordingMinutes}-minute ceiling`);
    notify('Recording stopped', `This meeting reached the ${fmtDuration(cap)} limit. The notes are being written now.`);
    stopRecording().catch((err) => log.error('stop at the duration cap failed', err));
    return;
  }

  // Not a cap, a reminder — for the person who is still there and has simply
  // forgotten. It repeats, because one notification three hours ago is not
  // something anybody is still looking at.
  if (elapsed >= LONG_RECORDING_SECONDS && elapsed - state.warnedLongAt >= LONG_RECORDING_REPEAT_SECONDS) {
    state.warnedLongAt = elapsed;
    notify(
      'Still recording',
      `Minarrador has been recording for ${fmtDuration(elapsed)}. Click to stop and write the notes.`,
      () => stopRecording().catch((err) => log.error('stop from the long-recording notice failed', err)),
    );
  }

  checkDisk();
}

/**
 * Closes the WAV and writes meta.json, without running the pipeline.
 *
 * Split out from stopRecording so shutdown can secure the irreplaceable part —
 * the audio — without waiting on a transcription that may take minutes.
 *
 * There are now several things that can decide a meeting is over — the tray, the
 * shortcut, the library, the silence watcher, the duration cap, a full disk, a
 * quit — and two of them arriving together used to mean two pipeline runs over
 * one folder, or worse: the second call finding the writer already closed,
 * reading that as "nothing was recorded", and deleting the meeting. `stopping`
 * is what makes the first caller the only one.
 *
 * @returns {{ dir: string, meta: object } | null} null when nothing was kept
 */
async function finalizeRecording() {
  if (state.phase !== 'recording' || state.stopping) return null;
  state.stopping = true;
  const dir = state.currentDir;
  const startedAt = state.recordingStartedAt;
  const sources = { mic: capture.status.micOk, system: capture.status.systemOk };

  let result;
  try {
    result = await capture.stopRecording();
  } finally {
    // Released once the file is closed, not when the pipeline finishes — the
    // next meeting must not have to wait for minutes of transcription.
    state.stopping = false;
  }
  state.phase = 'idle';
  state.currentDir = null;
  applySleepBlocker();
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
    /** 2 means the file keeps the microphone and the room on separate channels. */
    channels: result.channels ?? 1,
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
  const job = { abort, progress: { phase: 'preparing', done: 0, total: 0, label: 'Preparing…' } };
  state.jobs.set(dir, job);
  if (state.phase === 'idle') state.phase = 'processing';
  state.progress = job.progress.label;
  refreshTray();
  notifyLibrary();

  const onProgress = (p) => {
    if (p.phase === 'transcribing') {
      state.progress = `Transcribing ${p.done}/${p.total}…`;
      if (p.text) sendToTranscript('transcript:line', { text: p.text, speaker: p.speaker });
    } else if (p.phase === 'summarising') {
      state.progress = p.total ? `Condensing ${p.done}/${p.total}…` : 'Writing notes…';
    } else if (p.phase === 'designing') {
      state.progress = 'Designing the brief…';
    } else if (p.phase === 'rendering') {
      state.progress = 'Exporting PDF…';
    }
    // Kept per meeting as well as on the tray: two runs can overlap — stopping
    // one meeting while the previous is still processing is allowed — and a
    // single progress string cannot say which card it belongs to.
    job.progress = { phase: p.phase, done: p.done ?? 0, total: p.total ?? 0, label: state.progress };
    refreshTray();
    notifyProgress();
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

// ----------------------------------------------------------- editing the archive
//
// library.js reads the notes folder and never writes to it, which is what keeps
// a window that only ever lists folder names from being able to touch the rest
// of somebody's disk. The two things the archive nonetheless has to allow live
// here instead: the window asks, main resolves the id through library.meetingDir
// like every other channel, and main does the work.

/**
 * Moves a meeting to the Recycle Bin.
 *
 * `trashItem` rather than an rm: this is a folder holding the only copy of a
 * conversation, and the difference between the two is whether a misclick is
 * recoverable. The confirmation is raised here rather than in the page for the
 * same reason it is a native dialog anywhere — the window that would be asking
 * is the window doing the asking.
 *
 * @param {string} id meeting folder name
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function deleteMeeting(id) {
  const dir = library.meetingDir(settings.notesDir, id);
  if (!dir) return { ok: false, reason: 'That recording is not in the meetings folder any more.' };
  if (state.phase === 'recording' && state.currentDir === dir) {
    return { ok: false, reason: 'That meeting is still recording.' };
  }
  if (state.jobs.has(dir)) return { ok: false, reason: 'Those notes are still being written.' };

  const card = library.describeMeeting(dir);
  const parent = libraryWindow && !libraryWindow.isDestroyed() ? libraryWindow : null;
  const options = {
    type: 'warning',
    buttons: ['Move to Recycle Bin', 'Keep'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete this recording?',
    message: `Delete “${card.title}”?`,
    detail:
      'The audio, the transcript, the notes and the brief all go to the Recycle Bin together. ' +
      'Nothing else in Minarrador keeps a copy.',
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response !== 0) return { ok: false };

  const failure = await shell.trashItem(dir).then(
    () => '',
    (err) => err.message,
  );
  if (failure) {
    log.error('could not delete', dir, failure);
    return { ok: false, reason: `Windows would not move that folder to the Recycle Bin: ${failure}` };
  }
  log.info('deleted', dir);
  if (state.lastDir === dir) state.lastDir = null;
  notifyLibrary();
  return { ok: true };
}

/**
 * Retitles a meeting, or gives it back the title the model wrote.
 *
 * The folder name is left alone: it is the meeting's id everywhere — in
 * state.jobs, in the tray's retry item, in whatever the user has already
 * opened — and it is a timestamp, which is a better permanent name than
 * anything typed in a hurry. The title is what people read, and it goes in its
 * own file so the next pipeline run cannot overwrite it.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
function renameMeeting(id, title) {
  const dir = library.meetingDir(settings.notesDir, id);
  if (!dir) return { ok: false, reason: 'That recording is not in the meetings folder any more.' };
  const clean = normaliseTitle(title);
  try {
    if (clean) fs.writeFileSync(path.join(dir, FILES.title), `${clean}\n`);
    else fs.rmSync(path.join(dir, FILES.title), { force: true });
  } catch (err) {
    log.warn('could not rename', dir, err.message);
    return { ok: false, reason: `That title could not be saved: ${err.message}` };
  }
  log.info(clean ? `renamed ${path.basename(dir)} to "${clean}"` : `reverted the title of ${path.basename(dir)}`);
  notifyLibrary();
  return { ok: true };
}

// ------------------------------------------------------------------- first run
//
// Everything below exists because the app can be installed into a state where
// it cannot do its job — Ollama with nothing pulled, no whisper.cpp — and the
// only instructions for getting out of it used to be terminal commands, which
// is nobody's idea of a first run when the app arrived as an installer.

/** Records where a download has got to and lets the settings pane redraw. */
function setupProgress(patch) {
  if (!state.setup) return;
  Object.assign(state.setup, patch);
  const now = Date.now();
  if (now - lastSetupAt < PROGRESS_MIN_MS && !patch.done) return;
  lastSetupAt = now;
  notifySettings();
}

/**
 * Runs one download to completion, with the pane able to watch and cancel it.
 *
 * @param {{ kind: 'model'|'whisper', label: string }} what
 * @param {(ctx: { signal: AbortSignal, onProgress: (p: object) => void }) => Promise<unknown>} run
 */
async function runSetup(what, run) {
  if (state.setup) return { ok: false, reason: `${state.setup.label} is already downloading.` };
  const abort = new AbortController();
  state.setup = { ...what, status: 'starting', completed: 0, total: 0, abort };
  notifySettings();
  try {
    await run({
      signal: abort.signal,
      onProgress: (p) => setupProgress(p),
    });
    return { ok: true };
  } catch (err) {
    if (abort.signal.aborted) {
      log.info(`${what.label}: cancelled`);
      return { ok: false, reason: '' };
    }
    log.error(`${what.label} failed`, err);
    return { ok: false, reason: err.message };
  } finally {
    state.setup = null;
    notifySettings();
  }
}

/**
 * Pulls one of the models this app is configured to use.
 *
 * Only those two: a model tag is free text, and the point of restricting it is
 * that nothing a page can invent reaches `ollama pull`. Both of these came out
 * of the settings store, which is where the offer to pull them comes from too.
 */
async function pullModel(name) {
  if (!state.ollamaUp) return { ok: false, reason: `Nothing is listening at ${settings.ollamaHost}.` };
  if (![settings.transcribeModel, settings.summaryModel].includes(name)) {
    return { ok: false, reason: 'Minarrador only downloads the models it is set to use.' };
  }

  const ollama = new Ollama(settings.ollamaHost);
  const result = await runSetup({ kind: 'model', label: name }, ({ signal, onProgress }) =>
    ollama.pull(name, { signal, onProgress: (p) => onProgress({ status: p.status, completed: p.completed, total: p.total }) }),
  );
  if (result.ok) {
    await refreshOllama();
    notify('Model ready', `${name} is installed. Minarrador can transcribe and write notes now.`);
  } else if (result.reason) {
    notify('Could not download the model', result.reason);
  }
  return result;
}

/**
 * Fetches whisper.cpp — the binary and one set of weights — into the app's own
 * install root, and points the settings at what arrived.
 */
async function installWhisper(model) {
  if (!Object.hasOwn(whisperSetup.MODELS, model)) {
    return { ok: false, reason: 'That is not a model Minarrador knows how to fetch.' };
  }
  const root = settings.whisperRoot || installRoot();
  if (!root) return { ok: false, reason: 'There is nowhere to install whisper.cpp on this machine.' };

  const result = await runSetup({ kind: 'whisper', label: `whisper.cpp · ggml-${model}` }, ({ signal, onProgress }) =>
    whisperSetup.install({
      root,
      model,
      signal,
      onProgress: (p) =>
        onProgress({
          status: p.phase === 'unpacking' ? 'unpacking' : p.label || p.phase,
          completed: p.completed ?? 0,
          total: p.total ?? 0,
        }),
    }),
  );

  if (!result.ok) {
    if (result.reason) notify('Could not install whisper.cpp', result.reason);
    return result;
  }

  // Naming the weights that arrived is what turns a finished download into a
  // live engine: applySetting re-resolves the install and re-points the live
  // transcriber, so nothing has to be restarted.
  applySetting({ whisperModel: `ggml-${model}.bin` });
  log.info('whisper.cpp installed into', root);
  notify('whisper.cpp is ready', `ggml-${model} is installed. Transcription runs locally and several times faster now.`);
  return result;
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
  if ('dictateHotkey' in patch) applyDictateHotkey();
  if ('preventSleep' in patch) applySleepBlocker();
  if ('silenceStopMinutes' in patch) capture?.silence.configure({ minutes: settings.silenceStopMinutes });
  // A different microphone means a different stream, which means the graph is
  // rebuilt around it — there is no way to swap a source under a live one.
  if (
    'captureMic' in patch ||
    'captureSystem' in patch ||
    'micDeviceId' in patch ||
    'micDeviceLabel' in patch
  ) {
    applyCaptureConfig();
  }
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
  // A different folder is very likely a different volume, so everything known
  // about the free space — including whether it has been warned about — is now
  // about somewhere else.
  state.disk = { free: null, checkedAt: 0, warned: false };
  checkDisk({ force: true });
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
  capture.setActive(true, {
    captureMic: settings.captureMic,
    captureSystem: settings.captureSystem,
    micDeviceId: settings.micDeviceId,
    micDeviceLabel: settings.micDeviceLabel,
  });
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
      dictateActive: Boolean(dictation?.active),
      dictateHotkeyRegistered: state.dictateHotkeyRegistered,
      retry: state.retry,
      captureStatus: capture?.status,
      // Which microphones exist and which one is open — the first thing to ask
      // about "it recorded nothing" or "it recorded the wrong room".
      micDevices: capture?.devices,
      recordingChannels: capture?.recordingChannels,
      levels: capture?.levels,
      diskFreeBytes: state.disk.free,
      sleepBlocked: state.sleepBlocker !== null,
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

  // The dictations archive is the other store a renderer can write to, so its
  // channels are sender-checked the same way the quick-copy ones are, and the
  // store normalises the payload regardless.
  const fromDictations = (event) => event.sender.id === dictationsWindow?.webContents.id;

  ipcMain.handle('dictations:list', (event) => {
    if (!fromDictations(event)) return [];
    return dictationsStore.list();
  });

  ipcMain.handle('dictations:update', (event, req) => {
    if (!fromDictations(event)) return null;
    return dictationsStore.update(String(req?.id ?? ''), String(req?.text ?? ''));
  });

  ipcMain.handle('dictations:remove', (event, id) => {
    if (!fromDictations(event)) return null;
    return dictationsStore.remove(String(id ?? ''));
  });

  ipcMain.on('dictations:copy', (event, text) => {
    if (!fromDictations(event)) return;
    clipboard.writeText(String(text ?? ''));
  });

  ipcMain.on('dictations:close', (event) => {
    if (!fromDictations(event)) return;
    dictationsWindow.close();
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

  // The two ways the archive changes. Both name a meeting and nothing else, and
  // both are done here rather than in library.js, which stays a reader.
  ipcMain.handle('library:delete', async (event, id) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return deleteMeeting(String(id ?? ''));
  });

  ipcMain.handle('library:rename', (event, req) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return renameMeeting(String(req?.id ?? ''), req?.title);
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
  ipcMain.handle('settings:get', (event) => {
    if (!fromLibrary(event)) return null;
    // Opening the pane is the one moment the free space is worth a syscall
    // outside a recording — otherwise the storage row would have nothing to say
    // until the first meeting had been recorded. checkDisk throttles itself.
    checkDisk();
    return settingsState();
  });

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
    // A device id is opaque rather than a path, but it still names something
    // real, so it is held to the same rule: one of the ones the capture worker
    // reported, or the empty string that means "whatever Windows defaults to".
    if ('micDeviceId' in clean && clean.micDeviceId && !capture.devices.some((d) => d.id === clean.micDeviceId)) {
      delete clean.micDeviceId;
      delete clean.micDeviceLabel;
    }

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

  // The dictations archive lives in the tray too; the settings pane is just
  // another way to find it.
  ipcMain.on('settings:openDictations', (event) => {
    if (!fromLibrary(event)) return;
    showDictationsWindow();
  });

  // The way out of an install that cannot transcribe anything. Both take
  // minutes, so both report progress through settings:changed rather than
  // leaving the pane on a spinner, and both can be called off.
  ipcMain.handle('settings:pullModel', async (event, name) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return pullModel(String(name ?? ''));
  });

  ipcMain.handle('settings:installWhisper', async (event, model) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return installWhisper(String(model ?? ''));
  });

  ipcMain.handle('settings:cancelSetup', (event) => {
    if (!fromLibrary(event)) return null;
    state.setup?.abort.abort();
    return settingsState();
  });

  /**
   * Survives the machine going to sleep in the middle of a meeting.
   *
   * Closing a laptop lid suspends the machine whatever a power-save blocker
   * says, and what the Web Audio graph's state is on the other side of that is
   * undefined — in practice it comes back with dead device tracks, so the tray
   * says "Recording" while the WAV stops growing. Nothing notices, which is the
   * same class of failure as a dead capture renderer and gets the same answer:
   * rebuild the graph, re-arm it into the same file, and say how much was lost.
   *
   * The audio between the suspend and the rebuild is gone. Nothing can recover
   * it; the point is that the rest of the meeting is not.
   */
  function installPowerHandlers() {
    let sleptAt = 0;

    powerMonitor.on('suspend', () => {
      sleptAt = Date.now();
      if (state.phase !== 'recording') return;
      // Nothing useful can be done here — the process is about to stop running
      // — but the log is what makes the gap in the audio explainable later.
      log.warn('the machine is suspending while a meeting is being recorded');
    });

    powerMonitor.on('resume', () => {
      const asleep = sleptAt ? Math.round((Date.now() - sleptAt) / 1000) : 0;
      sleptAt = 0;
      log.info(`the machine resumed${asleep ? ` after ${fmtDuration(asleep)}` : ''}`);
      const wasRecording = state.phase === 'recording';
      capture?.restart();
      // Sleeping through a meeting is exactly how a recording ends up hours
      // long, so the limits get a look the moment the clock is believable again.
      if (!wasRecording) return;
      state.disk.checkedAt = 0;
      notify(
        'Recording resumed',
        `The machine was asleep${asleep ? ` for ${fmtDuration(asleep)}` : ''}. That part of the meeting was not recorded, but this one continues.`,
      );
      checkRecordingLimits();
    });
  }

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
    // Read once at startup so the library has something to say about the volume
    // before the first meeting is recorded onto it.
    checkDisk({ force: true });

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
    capture.on('status', () => {
      refreshTray();
      // Which microphone opened, and whether the chosen one was there to open,
      // are both things the settings pane shows.
      notifySettings();
    });
    capture.on('devices', notifySettings);
    capture.on('transcript', (text, speaker) => {
      sendToTranscript('transcript:line', { text, speaker });
      appendLiveTranscript(text, speaker);
    });
    capture.on('speech', () => {
      if (!settings.suggestOnAudio || state.phase === 'recording') return;
      notify('Sounds like a meeting', 'Minarrador heard sustained audio. Click to start recording.', startRecording);
    });
    // A meeting that ended without anybody saying so. Stopping it writes the
    // notes for what was actually said, which is the point — the alternative is
    // a folder nobody asked for holding hours of an empty room.
    capture.on('silence', ({ minutes }) => {
      if (state.phase !== 'recording') return;
      log.info(`stopping the recording after ${minutes} minutes of silence`);
      notify('Recording stopped', `Nothing was audible for ${minutes} minutes, so Minarrador stopped and is writing the notes.`);
      stopRecording().catch((err) => log.error('stop on silence failed', err));
    });
    // The WAV stopped growing. Everything else still looks like a recording, so
    // this is the only chance to say so before the meeting is over.
    capture.on('writeFailed', ({ error, seconds }) => {
      log.error('the recording could not be written:', error);
      notify('Recording stopped', `Minarrador could not keep writing the audio (${error}). ${fmtDuration(seconds)} was saved.`);
      stopRecording().catch((err) => log.error('stop after a write failure failed', err));
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

    dictation = new DictationController({
      ollamaHost: settings.ollamaHost,
      whisper,
      // A transcription that fails keeps its audio here rather than losing it,
      // which is the same "never lose the meeting" rule the WAV path follows.
      errorDir: path.join(app.getPath('userData'), 'dictation-errors'),
    });
    // A live caption while dictating, shown on the indicator so the person
    // speaking knows it is being heard.
    dictation.on('live', (text) => {
      if (dictation?.active) sendToDictate({ state: 'listening', text });
    });
    // The hotkey is a toggle, so a session nobody stopped would otherwise run
    // to the controller's hard ceiling and then keep the mic warm forever.
    dictation.on('cap', () => {
      if (!dictation?.active) return;
      log.warn('stopping the dictation at the length cap');
      notify('Voice input stopped', 'That was a long one — Minarrador cut it off at the five-minute ceiling.');
      stopDictation().catch((err) => log.error('stop at the dictation cap failed', err));
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
      toggleDictation,
      openDictations: () => showDictationsWindow(),
      diagnostics,
      // Rebuilding is the controller's job now, because a recording in progress
      // has to be re-armed into the same file afterwards — the tray and the
      // wake-from-sleep handler both want exactly that.
      restartCapture: () => capture.restart(),
      // before-quit owns the shutdown sequence, including its re-entrancy guard.
      quit: () => app.quit(),
    });

    await capture.init();
    applyCaptureConfig();
    applyLiveConfig();
    applyHotkey();
    await dictation.init();
    applyDictateHotkey();
    installPowerHandlers();
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
    // Keeps the recording clock in the tooltip/menu moving, and is the one
    // heartbeat the duration cap, the long-recording notice and the free-space
    // check all ride on — none of them is worth a timer of its own.
    uiTimer = setInterval(() => {
      if (state.phase !== 'recording') return;
      refreshTray();
      checkRecordingLimits();
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
    // Same for the sleep block: a process that exits holding one leaves the
    // machine unable to suspend on idle until the next reboot.
    state.phase = 'idle';
    applySleepBlocker();
    // A download in flight has nobody left to report to, and half a model is
    // worse than none — whisper-setup renames into place, so an aborted one
    // leaves no install that later looks real.
    state.setup?.abort.abort();

    // A meeting still being processed is about to lose its pipeline. Stop the
    // model requests rather than leaving them to be cut mid-socket, and leave
    // the folder able to explain itself — every stage that finished has already
    // written its artefact, so this is only ever the tail of the chain.
    for (const [dir, job] of state.jobs) {
      job.abort.abort();
      log.warn('quit requested while processing', dir);
      writeResumeNote(dir, 'Minarrador quit while these notes were still being written.');
    }
    state.jobs.clear();

    capture?.destroy();

    // A dictation in flight has no file to finalize — the audio lives only in
    // memory — so it is dropped rather than transcribed into a process that is
    // already on its way out.
    dictation?.cancel();
    dictation?.destroy();
    clearTimeout(dictateIndicatorTimer);
    dictateIndicatorTimer = null;

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
