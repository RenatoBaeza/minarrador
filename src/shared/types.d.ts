// Shapes that cross the bridge between the main process and a window.
//
// A declaration file rather than a module, deliberately: the main process is
// compiled to CommonJS and the pages to browser scripts, so a runtime module
// shared by both would have to be emitted twice in two formats. Types have no
// runtime, so both sides can import these and neither has to load anything.

/** Which side of a two-channel recording said a line; '' when nobody can say. */
export type Speaker = 'mic' | 'system' | '';

/** A transcription engine: whisper.cpp, or the Ollama audio model. */
export type Engine = 'whisper' | 'ollama';

/** Everything settings.json holds. The store in src/main/settings.ts owns the defaults. */
export interface Settings {
  notesDir: string;
  ollamaHost: string;
  transcribeModel: string;
  summaryModel: string;
  captureMic: boolean;
  captureSystem: boolean;
  micDeviceId: string;
  micDeviceLabel: string;
  separateChannels: boolean;
  suggestOnAudio: boolean;
  silenceStopMinutes: number;
  maxRecordingMinutes: number;
  preventSleep: boolean;
  startAtLogin: boolean;
  liveTranscript: boolean;
  liveEngine: Engine;
  transcribeEngine: Engine;
  whisperModel: string;
  whisperRoot: string;
  whisperThreads: number;
  chunkSeconds: number;
  /** One of HOTKEY_CHOICES. */
  hotkey: string;
  /** One of DICTATE_HOTKEY_CHOICES. */
  dictateHotkey: string;
  dictateEngine: Engine;
  dictateAutoPaste: boolean;
}

/**
 * The settings the library window may change — and so the only ones that ever
 * arrive from a renderer.
 *
 * Nothing here names a place: the notes folder, the Ollama host and the whisper
 * root are paths, and a page that could set one could point this app's reading
 * and writing anywhere on the machine. The preload's FIELDS and main's gate are
 * both typed from this one list, so the two cannot drift apart.
 */
export type LibrarySettingKey =
  | 'suggestOnAudio'
  | 'startAtLogin'
  | 'liveTranscript'
  | 'captureMic'
  | 'captureSystem'
  | 'separateChannels'
  | 'micDeviceId'
  | 'micDeviceLabel'
  | 'silenceStopMinutes'
  | 'maxRecordingMinutes'
  | 'preventSleep'
  | 'hotkey'
  | 'dictateHotkey'
  | 'dictateEngine'
  | 'dictateAutoPaste'
  | 'liveEngine'
  | 'transcribeEngine'
  | 'whisperModel'
  | 'whisperThreads'
  | 'transcribeModel'
  | 'summaryModel';

/** A quick-copy shorthand. */
export interface Snippet {
  label: string;
  text: string;
}

/** How urgent a task is; 'none' sorts last. */
export type TodoPriority = 'none' | 'low' | 'medium' | 'high';

/** One task on the to-do list. */
export interface Todo {
  id: string;
  title: string;
  /** Free text, edited in the task editor. */
  description: string;
  /** '' for a task that belongs to no project. */
  project: string;
  priority: TodoPriority;
  /** YYYY-MM-DD, or '' for no due date. */
  due: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One entry in the dictation archive. */
export interface Dictation {
  id: string;
  text: string;
  createdAt: string;
}

/** The answer to a request that can be refused; `reason` is '' for a quiet no. */
export interface Outcome {
  ok: boolean;
  reason?: string;
}

/** How far one pipeline run has got, as a card shows it. */
export interface JobProgress {
  phase: string;
  done: number;
  total: number;
  label: string;
}

/** What the library shows on folders the app is still busy with. */
export interface LibraryActivity {
  recordingId: string | null;
  processingIds: string[];
  processing: (JobProgress & { id: string })[];
}

/** One step of the library's list: the cards, and what is happening to them. */
export interface LibraryList {
  meetings: MeetingCard[];
  activity: LibraryActivity;
}

/** What the page is told about one disk-usage entry: an id, never a path. */
export interface DiskEntry {
  id: number;
  name: string;
  isDirectory: boolean;
  size: number;
  hasChildren?: boolean;
  inaccessible?: string;
}

export interface DiskProgress {
  files: number;
  dirs: number;
  current: string;
}

export interface DiskChoice extends Outcome {
  root?: DiskEntry;
  entries?: DiskEntry[];
}

/** Compact view of the whisper.cpp engine for the settings pane and diagnostics. */
export interface WhisperDescription {
  root: string;
  binary: string;
  model: string;
  models: string[];
  /** 0 means automatic; effectiveThreads is what the server was actually told. */
  threads: number;
  effectiveThreads: number;
  threadChoices: number[];
  available: boolean;
  running: boolean;
  port: number | null;
  lastError: string;
}

/** A download in flight — an Ollama model or whisper.cpp itself. */
export interface SetupState {
  kind: 'model' | 'whisper';
  label: string;
  status: string;
  completed: number;
  total: number;
}

export interface Choice<T> {
  value: T;
  label: string;
}

export interface HotkeyState {
  value: string;
  registered: boolean;
  choices: Choice<string>[];
}

/** Everything the settings pane renders. Assembled by settingsState() in main. */
export interface SettingsState {
  version: string;
  settings: Settings;
  defaults: Settings;
  models: string[];
  audioModels: string[];
  whisper: WhisperDescription | null;
  ollama: { host: string; up: boolean; checking: boolean; installed: boolean };
  /** What the live preview is really using, which is not always what was asked for. */
  liveEngine: Engine;
  mic: { devices: AudioDevice[]; active: string; chosen: string; chosenLabel: string };
  recordingChannels: number;
  disk: { free: number | null; low: boolean };
  setup: SetupState | null;
  whisperModels: Choice<string>[];
  pullable: string[];
  hotkey: HotkeyState;
  dictateHotkey: HotkeyState;
  dictation: { active: boolean; transcribing: boolean };
  notesDirExists: boolean;
  snippetCount: number;
  recording: boolean;
}

/**
 * One light on the record button's health strip.
 *
 * `wait` is the first seconds of a recording, before a source has had the
 * chance to hear anything; `off` is a source the settings turned off.
 */
export interface HealthItem {
  key: 'mic' | 'system' | 'whisper' | 'ollama';
  label: string;
  state: 'ok' | 'warn' | 'wait' | 'off';
  detail: string;
}

/** Whether the next (or the just-started) meeting will produce notes. Built by health() in main. */
export interface Health {
  items: HealthItem[];
  recording: boolean;
  /** Seconds into the recording, or 0 when idle. */
  elapsed: number;
  /** Whether the strip should be on screen at all. */
  show: boolean;
}

/** The settings pane's mic meter: a level, a status, or the end of the test. */
export interface MicTestUpdate {
  testing: boolean;
  level?: number;
  micLabel?: string;
  micError?: string;
}

/** What the dictation indicator shows. */
export interface DictateIndicatorState {
  state: 'listening' | 'transcribing' | 'done' | 'error';
  text?: string;
  error?: string;
}

/** The live transcript window's header. */
export interface TranscriptWindowState {
  recording: boolean;
  label: string;
  engine: string;
}

/** An audio input as the capture worker lists it. */
export interface AudioDevice {
  id: string;
  label: string;
}

/** RMS levels, 0..1, as the capture worker reports them ~5 times a second. */
export interface CaptureLevels {
  mixed: number;
  mic: number;
  system: number;
}

/** What the capture worker managed to open, and why not when it did not. */
export interface CaptureStatus {
  micOk: boolean;
  systemOk: boolean;
  micError: string;
  systemError: string;
  micLabel: string;
  running: boolean;
  fatal?: string;
  /** Something worth logging that is not a failure — a source restarting. */
  note?: string;
}

/** What the dictation worker reports about its microphone. */
export interface DictateStatus {
  micOk?: boolean;
  micError?: string;
  micLabel?: string;
  fatal?: string;
}

/** Where a meeting's transcript came from — a rough one is labelled as such. */
export type TranscriptSource = 'pipeline' | 'live' | 'none';

/** Why a meeting has notes or does not. */
export type MeetingStatus = 'ready' | 'failed' | 'unprocessed' | 'pending';

/** A meeting as a rail card: enough to render it, nothing that costs a full read. */
export interface MeetingCard {
  id: string;
  title: string;
  /** The model's own title, kept so a rename can be undone back to it. */
  generatedTitle: string;
  renamed: boolean;
  startedAt: string;
  durationSeconds: number;
  status: MeetingStatus;
  preview: string;
  decisions: number;
  actionItems: number;
  transcriptSource: TranscriptSource;
  files: { audio: boolean; transcript: boolean; notes: boolean; pdf: boolean };
  /** Search hits, present only on a filtered list. */
  matches?: number;
}

export interface TranscriptLine {
  startSeconds: number | null;
  speaker: Speaker;
  text: string;
}

export interface Decision {
  decision: string;
  context: string;
}

export interface ActionItem {
  task: string;
  owner: string;
  due: string;
}

/**
 * Everything the reader pane shows for one meeting. The card's two counts
 * become the lists they were counting.
 */
export interface MeetingDetail extends Omit<MeetingCard, 'decisions' | 'actionItems'> {
  summary: string[];
  decisions: Decision[];
  actionItems: ActionItem[];
  transcript: TranscriptLine[];
  error: string;
  sources: { mic: boolean; system: boolean };
  speakers: { readonly mic: string; readonly system: string };
  models: { transcribe: string; summary: string };
}
