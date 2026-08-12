'use strict';

// Bridge for the meeting library window. Near enough read-only over the notes
// folder: the page can list, open and quote meetings, and cannot write, rename
// or delete one. The two exceptions both name a meeting and nothing else —
// `record` starts or stops one, and `reprocess` asks the main process to run
// its own pipeline over a folder that already has audio. Every call names a
// meeting by its folder name and the main process resolves it; no path ever
// crosses this boundary in the other direction.
//
// Settings are the one thing the window changes, and they go through `settings`
// below: a fixed vocabulary of keys, each coerced to the type the store expects,
// with nothing that names a path or a host among them.

const { contextBridge, ipcRenderer } = require('electron');

/** Things the window may ask the shell to open. Mirrors OPEN_TARGETS in library.js. */
const TARGETS = ['folder', 'pdf', 'notes', 'transcript', 'audio'];

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
  hotkey: String,
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
  /** @param {string} query filters by title and transcript text; '' lists everything. */
  list: (query) => ipcRenderer.invoke('library:list', String(query ?? '')),
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
  /** Fires when a recording starts or a pipeline run finishes, so the list can catch up. */
  onChanged: (fn) => ipcRenderer.on('library:changed', () => fn()),
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
    editQuickCopy: () => ipcRenderer.send('settings:editQuickCopy'),
    /** A setting changed elsewhere, or an Ollama poll found (or lost) the daemon. */
    onChanged: (fn) => ipcRenderer.on('settings:changed', () => fn()),
  },
});
