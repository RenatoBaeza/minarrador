'use strict';

// Bridge for the meeting library window. Everything it can do names a meeting
// by its folder name, and the main process resolves it; no path ever crosses
// this boundary in either direction. The page can list, open and quote
// meetings, and the four things it can change all go through main:
//
//   record     start or stop the meeting being recorded
//   reprocess  run the pipeline again over a folder that already has audio
//   rename     write the title someone typed over the one the model guessed
//   delete     move a meeting to the Recycle Bin, after main has confirmed it
//
// Settings go through `settings` below: a fixed vocabulary of keys, each
// coerced to the type the store expects, with nothing that names a path or a
// host among them.

const { contextBridge, ipcRenderer } = require('electron');

/** Things the window may ask the shell to open. Mirrors OPEN_TARGETS in library.js. */
const TARGETS = ['folder', 'pdf', 'notes', 'transcript', 'audio'];

/** How the two sides of a two-channel recording are named. Mirrors SPEAKERS in paths.js. */
const SPEAKERS = { mic: 'You', system: 'Others' };

/**
 * Settings the page may change, and what each one is.
 *
 * Mirrors LIBRARY_SETTINGS in main.js — main filters again on arrival, since a
 * preload is only the first gate — and pins the type here so a DOM value (which
 * is always a string) cannot arrive as one where a boolean was meant.
 */
const FIELDS = {
  suggestOnAudio: Boolean,
  startAtLogin: Boolean,
  liveTranscript: Boolean,
  captureMic: Boolean,
  captureSystem: Boolean,
  separateChannels: Boolean,
  // An opaque handle Chromium issued for a device, not a path — and main checks
  // it against the list the capture worker reported before it is stored.
  micDeviceId: String,
  micDeviceLabel: String,
  silenceStopMinutes: Number,
  maxRecordingMinutes: Number,
  preventSleep: Boolean,
  hotkey: String,
  dictateHotkey: String,
  dictateEngine: String,
  dictateAutoPaste: Boolean,
  liveEngine: String,
  transcribeEngine: String,
  whisperModel: String,
  whisperThreads: Number,
  transcribeModel: String,
  summaryModel: String,
};

const patch = (values) => {
  const out = {};
  for (const [key, cast] of Object.entries(FIELDS)) {
    if (values && Object.hasOwn(values, key)) out[key] = cast(values[key]);
  }
  return out;
};

contextBridge.exposeInMainWorld('library', {
  speakers: SPEAKERS,
  /**
   * @param {string} query filters by title and transcript text; '' lists everything
   * @param {'all'|'needs'|'recent'} filter narrows the archive: meetings still
   *   owed notes, or this week's. main checks the value, as it checks everything.
   */
  list: (query, filter) => ipcRenderer.invoke('library:list', { query: String(query ?? ''), filter }),
  read: (id) => ipcRenderer.invoke('library:read', String(id ?? '')),
  /** @returns {Promise<boolean>} false when the file is not there to open. */
  open: (id, target) =>
    TARGETS.includes(target)
      ? ipcRenderer.invoke('library:open', { id: String(id ?? ''), target })
      : Promise.resolve(false),
  openNotesFolder: () => ipcRenderer.invoke('library:openNotesFolder'),
  copy: (text) => ipcRenderer.send('library:copy', String(text ?? '')),
  /** Starts or stops a recording. The result arrives as an onChanged, not a return. */
  record: (on) => ipcRenderer.invoke('library:record', Boolean(on)),
  /**
   * Runs the transcription and notes again over a meeting that has audio.
   *
   * @returns {Promise<{ ok: boolean, reason?: string }>} whether the run
   *   started — how it *ends* arrives as an onChanged, minutes later.
   */
  reprocess: (id) => ipcRenderer.invoke('library:reprocess', String(id ?? '')),
  /**
   * Retitles a meeting. An empty title puts the model's own one back.
   *
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  rename: (id, title) => ipcRenderer.invoke('library:rename', { id: String(id ?? ''), title: String(title ?? '') }),
  /**
   * Moves a meeting to the Recycle Bin.
   *
   * Main raises the confirmation itself — a window cannot be trusted to have
   * asked before it calls, and this is the one call here that destroys work.
   *
   * @returns {Promise<{ ok: boolean, reason?: string }>} `ok` false with no
   *   reason means the confirmation was declined.
   */
  delete: (id) => ipcRenderer.invoke('library:delete', String(id ?? '')),
  /** Fires when a recording starts or a pipeline run finishes, so the list can catch up. */
  onChanged: (fn) => ipcRenderer.on('library:changed', () => fn()),
  /**
   * Fires as a pipeline run advances — several times a minute.
   *
   * Carries the whole activity payload, so the page can update the card and the
   * reader in place. Deliberately not `onChanged`: that one means "re-read the
   * folder", which walks the notes directory and every transcript in it.
   */
  onProgress: (fn) => ipcRenderer.on('library:progress', (_e, activity) => fn(activity ?? {})),
  /** The tray's Settings… item, landing in an already-open window. */
  onShowSettings: (fn) => ipcRenderer.on('library:showSettings', () => fn()),
  minimize: () => ipcRenderer.send('library:minimize'),
  close: () => ipcRenderer.send('library:close'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    /** @returns {Promise<object>} the state after the change, never the patch back. */
    set: (values) => ipcRenderer.invoke('settings:set', patch(values)),
    chooseNotesFolder: () => ipcRenderer.invoke('settings:chooseNotesFolder'),
    openOllama: () => ipcRenderer.invoke('settings:openOllama'),
    /**
     * Downloads a model into Ollama. Main only accepts the two names this app
     * is configured to use, so nothing typed here could ever reach it.
     */
    pullModel: (name) => ipcRenderer.invoke('settings:pullModel', String(name ?? '')),
    /** Fetches whisper.cpp and a set of weights, for a machine that has neither. */
    installWhisper: (model) => ipcRenderer.invoke('settings:installWhisper', String(model ?? '')),
    cancelSetup: () => ipcRenderer.invoke('settings:cancelSetup'),
    /** Opens the mic for the settings pane's level meter; stop closes it again. */
    testMicStart: () => ipcRenderer.invoke('settings:testMic'),
    testMicStop: () => ipcRenderer.invoke('settings:testMicStop'),
    /** A level (≈10/s), a mic status, or the end of the test. */
    onMicTest: (fn) => ipcRenderer.on('settings:micTest', (_e, payload) => fn(payload ?? {})),
    editQuickCopy: () => ipcRenderer.send('settings:editQuickCopy'),
    /** Opens the dictations archive window, from the settings pane. */
    openDictations: () => ipcRenderer.send('settings:openDictations'),
    /** A setting changed elsewhere, or an Ollama poll found (or lost) the daemon. */
    onChanged: (fn) => ipcRenderer.on('settings:changed', () => fn()),
  },
});
