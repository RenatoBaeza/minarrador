// The library window's bridge to the Rust core: the `window.library` API the
// pages were written against, implemented over Tauri commands and events.
//
// Like the Electron preload before it, it casts every settings patch to a fixed
// vocabulary of keys and types (FIELDS) before sending it — and the core
// filters again on arrival (settings_gate.rs), so neither side trusts the page.

import { enableDrag, invoke, listen } from './bridge-common.js';
import type { LibraryBridge, LibrarySection, OpenTarget, SpeakerNames } from './bridges';
import type { Health, LibrarySettingKey, LiveLine, Snippet, Todo } from '../shared/types';

const TARGETS: readonly OpenTarget[] = ['folder', 'pdf', 'notes', 'transcript', 'audio'];
const SPEAKERS: SpeakerNames = { mic: 'You', system: 'Others' };
const SECTIONS: readonly LibrarySection[] = ['reader', 'quickcopy', 'disk', 'todos', 'settings'];

const FIELDS: Record<LibrarySettingKey, (value: unknown) => unknown> = {
  suggestOnAudio: Boolean,
  startAtLogin: Boolean,
  liveTranscript: Boolean,
  captureMic: Boolean,
  captureSystem: Boolean,
  separateChannels: Boolean,
  micDeviceId: String,
  micDeviceLabel: String,
  silenceStopMinutes: Number,
  maxRecordingMinutes: Number,
  preventSleep: Boolean,
  hotkey: String,
  dictateHotkey: String,
  dictateEngine: String,
  dictateAutoPaste: Boolean,
  desktopTodos: Boolean,
  liveEngine: String,
  transcribeEngine: String,
  whisperModel: String,
  whisperThreads: Number,
  transcribeModel: String,
  summaryModel: String,
};

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
  list: (query) => invoke('library_list', { query: String(query ?? '') }),
  read: (id) => invoke('library_read', { id: String(id ?? '') }),
  open: (id, target) =>
    TARGETS.includes(target) ? invoke('library_open', { id: String(id ?? ''), target }) : Promise.resolve(false),
  openNotesFolder: () => invoke('library_open_notes_folder'),
  copy: (text) => void invoke('library_copy', { text: String(text ?? '') }),
  record: (on) => invoke('library_record', { on: Boolean(on) }),
  pause: (paused) => invoke('library_pause', { paused: Boolean(paused) }),
  stop: () => invoke('library_stop'),
  reprocess: (id) => invoke('library_reprocess', { id: String(id ?? '') }),
  rename: (id, title) => invoke('library_rename', { id: String(id ?? ''), title: String(title ?? '') }),
  delete: (id) => invoke('library_delete', { id: String(id ?? '') }),
  // Tauri serves a custom scheme as http://<scheme>.localhost on Windows.
  audioUrl: (id) => `http://meeting-audio.localhost/${encodeURIComponent(String(id ?? ''))}`,
  health: () => invoke('library_health'),
  onHealth: (fn) =>
    listen<Health>('library:health', (payload) => {
      if (payload && Array.isArray(payload.items)) fn(payload);
    }),
  onChanged: (fn) => listen('library:changed', () => fn()),
  onProgress: (fn) => listen('library:progress', (activity) => fn(activity ?? {})),
  onLiveLine: (fn) =>
    listen<Partial<LiveLine>>('library:liveLine', (line) =>
      fn({
        id: String(line?.id ?? ''),
        text: String(line?.text ?? ''),
        speaker: line?.speaker === 'mic' || line?.speaker === 'system' ? line.speaker : '',
      }),
    ),
  onShow: (fn) => {
    const show = (section: unknown): void => {
      if (SECTIONS.includes(section as LibrarySection)) fn(section as LibrarySection);
    };
    listen('library:show', show);
    // The section the window was opened onto, asked for once the page listens.
    void invoke<string | null>('library_initial_section').then(show);
  },
  minimize: () => void invoke('library_minimize'),
  close: () => void invoke('library_close'),
  quickCopy: {
    list: () => invoke('snippets_list'),
    save: (items) => invoke('snippets_save', { items: plainSnippets(items) }),
  },
  todos: {
    list: () => invoke('todos_list'),
    save: (items) => invoke('todos_save', { items: plainTodos(items) }),
  },
  disk: {
    choose: () => invoke('disk_choose'),
    cancel: () => invoke('disk_cancel'),
    list: (id) => invoke('disk_list', { id: Number(id) }),
    reveal: (id) => invoke('disk_reveal', { id: Number(id) }),
    trash: (id) => invoke('disk_trash', { id: Number(id) }),
    onProgress: (fn) => listen('disk:progress', (p) => fn(p ?? {})),
  },
  settings: {
    get: () => invoke('settings_get'),
    set: (values) => invoke('settings_set', { patch: patch(values) }),
    chooseNotesFolder: () => invoke('settings_choose_notes_folder'),
    openOllama: () => invoke('settings_open_ollama'),
    pullModel: (name) => invoke('settings_pull_model', { name: String(name ?? '') }),
    installWhisper: (model) => invoke('settings_install_whisper', { model: String(model ?? '') }),
    cancelSetup: () => invoke('settings_cancel_setup'),
    testMicStart: () => invoke('settings_test_mic'),
    testMicStop: () => invoke('settings_test_mic_stop'),
    onMicTest: (fn) => listen('settings:micTest', (payload) => fn(payload ?? {})),
    openDictations: () => void invoke('settings_open_dictations'),
    openLog: () => invoke('settings_open_log'),
    copyDiagnostics: () => invoke('settings_copy_diagnostics'),
    restartCapture: () => invoke('settings_restart_capture'),
    onChanged: (fn) => listen('settings:changed', () => fn()),
  },
};

window.library = api;
enableDrag('.titlebar', { maximize: true });
