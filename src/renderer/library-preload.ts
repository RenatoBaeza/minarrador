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
// Quick copy goes through `quickCopy` below: the one list this window writes,
// pinned to two strings per entry before it leaves the page.
//
// The to-do list goes through `todos` below: saved as a whole, like quick copy,
// with every field pinned to its type before it leaves the page.
//
// Disk usage goes through `disk` below: the folder comes from a dialog in main,
// and every entry after that is an id the scan issued.
//
// Settings go through `settings` below: a fixed vocabulary of keys, each
// coerced to the type the store expects, with nothing that names a path or a
// host among them.

import { contextBridge, ipcRenderer } from 'electron';

import type { LibraryBridge, LibrarySection, OpenTarget, SpeakerNames } from './bridges';
import type { LibrarySettingKey, Snippet, Todo } from '../shared/types';

/** Things the window may ask the shell to open. Mirrors OPEN_TARGETS in library.ts. */
const TARGETS: readonly OpenTarget[] = ['folder', 'pdf', 'notes', 'transcript', 'audio'];

/** How the two sides of a two-channel recording are named. Mirrors SPEAKERS in paths.ts. */
const SPEAKERS: SpeakerNames = { mic: 'You', system: 'Others' };

/**
 * Settings the page may change, and what each one is.
 *
 * Typed from LibrarySettingKey, like main's gate in settings-gate.ts — main
 * filters again on arrival, since a preload is only the first gate — and pins the type here so a DOM value (which
 * is always a string) cannot arrive as one where a boolean was meant.
 */
const FIELDS: Record<LibrarySettingKey, (value: unknown) => unknown> = {
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

/** The sidebar features main may open this window onto. Mirrors SECTIONS in library.ts. */
const SECTIONS: readonly LibrarySection[] = ['reader', 'quickcopy', 'disk', 'todos', 'settings'];

const plainSnippets = (items: unknown): Snippet[] =>
  (Array.isArray(items) ? (items as Partial<Snippet>[]) : []).map((item) => ({
    label: String(item?.label ?? ''),
    text: String(item?.text ?? ''),
  }));

const plainTodos = (items: unknown): Todo[] =>
  (Array.isArray(items) ? (items as Partial<Todo>[]) : []).map((item) => ({
    id: String(item?.id ?? ''),
    title: String(item?.title ?? ''),
    description: String(item?.description ?? ''),
    project: String(item?.project ?? ''),
    priority: String(item?.priority ?? 'none') as Todo['priority'],
    due: String(item?.due ?? ''),
    done: item?.done === true,
    createdAt: String(item?.createdAt ?? ''),
    updatedAt: String(item?.updatedAt ?? ''),
  }));

const patch = (values: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!values || typeof values !== 'object') return out;
  for (const [key, cast] of Object.entries(FIELDS)) {
    if (Object.hasOwn(values, key)) out[key] = cast((values as Record<string, unknown>)[key]);
  }
  return out;
};

const api: LibraryBridge = {
  speakers: SPEAKERS,
  /** `query` filters by title and transcript text; '' lists everything. */
  list: (query) => ipcRenderer.invoke('library:list', { query: String(query ?? '') }),
  read: (id) => ipcRenderer.invoke('library:read', String(id ?? '')),
  /** Resolves false when the file is not there to open. */
  open: (id, target) =>
    TARGETS.includes(target)
      ? ipcRenderer.invoke('library:open', { id: String(id ?? ''), target })
      : Promise.resolve(false),
  openNotesFolder: () => ipcRenderer.invoke('library:openNotesFolder'),
  copy: (text) => ipcRenderer.send('library:copy', String(text ?? '')),
  /** Starts or stops a recording. The result arrives as an onChanged, not a return. */
  record: (on) => ipcRenderer.invoke('library:record', Boolean(on)),
  /** Pauses or resumes the meeting being recorded. The clock arrives as onProgress. */
  pause: (paused) => ipcRenderer.invoke('library:pause', Boolean(paused)),
  /**
   * Stops the meeting being recorded. Main asks first, natively — ending a
   * meeting cannot be taken back, and the page is not the one to vouch for it.
   */
  stop: () => ipcRenderer.invoke('library:stop'),
  /**
   * Runs the transcription and notes again over a meeting that has audio.
   * Resolves to whether the run started — how it *ends* arrives as an
   * onChanged, minutes later.
   */
  reprocess: (id) => ipcRenderer.invoke('library:reprocess', String(id ?? '')),
  /** Retitles a meeting. An empty title puts the model's own one back. */
  rename: (id, title) => ipcRenderer.invoke('library:rename', { id: String(id ?? ''), title: String(title ?? '') }),
  /**
   * Moves a meeting to the Recycle Bin.
   *
   * Main raises the confirmation itself — a window cannot be trusted to have
   * asked before it calls, and this is the one call here that destroys work.
   * `ok` false with no reason means the confirmation was declined.
   */
  delete: (id) => ipcRenderer.invoke('library:delete', String(id ?? '')),
  /**
   * Where the reader's player loads a meeting's audio from. The protocol
   * resolves only a meeting id, through the same check as every channel here,
   * and serves it downmixed to mono.
   */
  audioUrl: (id) => `meeting-audio://meeting/${encodeURIComponent(String(id ?? ''))}`,
  /** Whether the next meeting will produce notes: the lights under the record button. */
  health: () => ipcRenderer.invoke('library:health'),
  /** The same, pushed when a source, a model or the first seconds of a recording change it. */
  onHealth: (fn) => {
    ipcRenderer.on('library:health', (_e, payload) => {
      if (payload && Array.isArray(payload.items)) fn(payload);
    });
  },
  /** Fires when a recording starts or a pipeline run finishes, so the list can catch up. */
  onChanged: (fn) => {
    ipcRenderer.on('library:changed', () => fn());
  },
  /**
   * Fires as a pipeline run advances — several times a minute.
   *
   * Carries the whole activity payload, so the page can update the card and the
   * reader in place. Deliberately not `onChanged`: that one means "re-read the
   * folder", which walks the notes directory and every transcript in it.
   */
  onProgress: (fn) => {
    ipcRenderer.on('library:progress', (_e, activity) => fn(activity ?? {}));
  },
  /**
   * The live preview, a caption at a time. Only ever one of the two speaker
   * names reaches the page; anything else is an unlabelled line.
   */
  onLiveLine: (fn) => {
    ipcRenderer.on('library:liveLine', (_e, line) =>
      fn({
        id: String(line?.id ?? ''),
        text: String(line?.text ?? ''),
        speaker: line?.speaker === 'mic' || line?.speaker === 'system' ? line.speaker : '',
      }),
    );
  },
  /** Main asking for a feature, landing in an already-open window. */
  onShow: (fn) => {
    ipcRenderer.on('library:show', (_e, section) => {
      if (SECTIONS.includes(section)) fn(section);
    });
  },
  minimize: () => ipcRenderer.send('library:minimize'),
  close: () => ipcRenderer.send('library:close'),

  quickCopy: {
    list: () => ipcRenderer.invoke('snippets:list'),
    /** Resolves to the list as it was actually stored. */
    save: (items) => ipcRenderer.invoke('snippets:save', plainSnippets(items)),
  },

  todos: {
    list: () => ipcRenderer.invoke('todos:list'),
    /** Resolves to the list as it was actually stored. */
    save: (items) => ipcRenderer.invoke('todos:save', plainTodos(items)),
  },

  /**
   * Disk usage. The folder is picked in a native dialog; after that every entry
   * is the numeric id the scan issued, so no path is ever sent from this page.
   */
  disk: {
    /**
     * Resolves when the walk finishes; `ok` false with no reason is a
     * cancelled dialog.
     */
    choose: () => ipcRenderer.invoke('disk:choose'),
    cancel: () => ipcRenderer.invoke('disk:cancel'),
    /** The folder's entries, largest first. */
    list: (id) => ipcRenderer.invoke('disk:list', Number(id)),
    /** Shows the entry selected in Explorer. */
    reveal: (id) => ipcRenderer.invoke('disk:reveal', Number(id)),
    /** Moves an entry to the Recycle Bin. Main raises the confirmation itself. */
    trash: (id) => ipcRenderer.invoke('disk:trash', Number(id)),
    /** `{ files, dirs, current }` a few times a second while a walk runs. */
    onProgress: (fn) => {
      ipcRenderer.on('disk:progress', (_e, p) => fn(p ?? {}));
    },
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    /** Resolves to the state after the change, never the patch back. */
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
    onMicTest: (fn) => {
      ipcRenderer.on('settings:micTest', (_e, payload) => fn(payload ?? {}));
    },
    /** Opens the dictations archive window, from the settings pane. */
    openDictations: () => ipcRenderer.send('settings:openDictations'),
    /** Troubleshooting: each resolves true when it did what it says. */
    openLog: () => ipcRenderer.invoke('settings:openLog'),
    copyDiagnostics: () => ipcRenderer.invoke('settings:copyDiagnostics'),
    restartCapture: () => ipcRenderer.invoke('settings:restartCapture'),
    /** A setting changed elsewhere, or an Ollama poll found (or lost) the daemon. */
    onChanged: (fn) => {
      ipcRenderer.on('settings:changed', () => fn());
    },
  },
};

contextBridge.exposeInMainWorld('library', api);
