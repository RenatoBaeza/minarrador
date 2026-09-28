// The surface each preload exposes on `window`, typed once for both sides.
//
// A preload implements one of these and a page calls it, so the two can never
// disagree about a method's name or what it returns. Types only: a sandboxed
// preload can require nothing but Electron, and a page nothing at all.

import type {
  AudioDevice,
  CaptureLevels,
  CaptureStatus,
  DictateIndicatorState,
  DictateStatus,
  Dictation,
  DiskChoice,
  DiskEntry,
  DiskProgress,
  Health,
  LibraryActivity,
  LibraryList,
  MeetingDetail,
  MicTestUpdate,
  Outcome,
  Settings,
  SettingsState,
  Snippet,
  Speaker,
  Todo,
  TranscriptWindowState,
} from '../shared/types';

/** Names for the two sides of a two-channel recording. */
export interface SpeakerNames {
  readonly mic: string;
  readonly system: string;
}

/** What the capture worker is told to open. */
export interface CaptureConfig {
  active: boolean;
  captureMic: boolean;
  captureSystem: boolean;
  micDeviceId: string;
  micDeviceLabel: string;
}

export interface CaptureBridge {
  sendPcm(buffer: ArrayBuffer): void;
  sendLevel(levels: CaptureLevels): void;
  sendStatus(status: Partial<CaptureStatus>): void;
  sendDevices(devices: AudioDevice[]): void;
  onConfigure(fn: (cfg: CaptureConfig) => void): void;
  /** `channels` is the WAV layout main is writing: 1 summed, or 2 kept apart. */
  onSetRecording(fn: (value: boolean, channels: number) => void): void;
}

export interface DictateStart {
  micDeviceId: string;
  micDeviceLabel: string;
  /** A settings-pane mic test: levels only, nothing recorded. */
  test?: boolean;
}

export interface DictateBridge {
  sendPcm(buffer: ArrayBuffer): void;
  sendLevel(level: number): void;
  sendStatus(status: DictateStatus & { micOk?: boolean }): void;
  onStart(fn: (cfg: DictateStart) => void): void;
  onStop(fn: () => void): void;
}

export interface DictateIndicatorBridge {
  onState(fn: (payload: Partial<DictateIndicatorState>) => void): void;
}

export interface TranscriptBridge {
  speakers: SpeakerNames;
  onClear(fn: () => void): void;
  onLine(fn: (line: { text: string; speaker: Speaker }) => void): void;
  onState(fn: (state: Partial<TranscriptWindowState>) => void): void;
  copy(text: string): void;
  close(): void;
}

export interface DictationsBridge {
  list(): Promise<Dictation[]>;
  /** The list after the change, or null when the id was gone. */
  update(id: string, text: string): Promise<Dictation[] | null>;
  remove(id: string): Promise<Dictation[] | null>;
  copy(text: string): void;
  close(): void;
  onChanged(fn: () => void): void;
}

/** Things the library window may ask the shell to open. */
export type OpenTarget = 'folder' | 'pdf' | 'notes' | 'transcript' | 'audio';

/** The sidebar features main may open the library window onto. */
export type LibrarySection = 'reader' | 'quickcopy' | 'disk' | 'todos' | 'settings';

export interface LibraryBridge {
  speakers: SpeakerNames;
  list(query: string): Promise<LibraryList>;
  read(id: string): Promise<MeetingDetail | null>;
  open(id: string, target: OpenTarget): Promise<boolean>;
  openNotesFolder(): Promise<boolean>;
  copy(text: string): void;
  record(on: boolean): Promise<boolean>;
  reprocess(id: string): Promise<Outcome>;
  rename(id: string, title: string): Promise<Outcome>;
  delete(id: string): Promise<Outcome>;
  audioUrl(id: string): string;
  health(): Promise<Health | null>;
  onHealth(fn: (health: Health) => void): void;
  onChanged(fn: () => void): void;
  onProgress(fn: (activity: Partial<LibraryActivity>) => void): void;
  onShow(fn: (section: LibrarySection) => void): void;
  minimize(): void;
  close(): void;

  quickCopy: {
    list(): Promise<Snippet[]>;
    save(items: Snippet[]): Promise<Snippet[]>;
  };

  todos: {
    list(): Promise<Todo[]>;
    save(items: Todo[]): Promise<Todo[]>;
  };

  disk: {
    choose(): Promise<DiskChoice>;
    cancel(): Promise<boolean>;
    list(id: number): Promise<DiskEntry[] | null>;
    reveal(id: number): Promise<boolean>;
    trash(id: number): Promise<Outcome>;
    onProgress(fn: (p: Partial<DiskProgress>) => void): void;
  };

  settings: {
    get(): Promise<SettingsState>;
    set(values: Partial<Settings>): Promise<SettingsState>;
    chooseNotesFolder(): Promise<SettingsState>;
    openOllama(): Promise<SettingsState>;
    pullModel(name: string): Promise<Outcome>;
    installWhisper(model: string): Promise<Outcome>;
    cancelSetup(): Promise<SettingsState>;
    testMicStart(): Promise<Outcome>;
    testMicStop(): Promise<SettingsState>;
    onMicTest(fn: (payload: Partial<MicTestUpdate>) => void): void;
    openDictations(): void;
    openLog(): Promise<boolean>;
    copyDiagnostics(): Promise<boolean>;
    restartCapture(): Promise<boolean>;
    onChanged(fn: () => void): void;
  };
}

declare global {
  // Each window's preload exposes exactly one of these; a page reaches its own
  // through `window.<name>`, never as a bare global.
  interface Window {
    capture: CaptureBridge;
    dictate: DictateBridge;
    dictateIndicator: DictateIndicatorBridge;
    transcript: TranscriptBridge;
    dictations: DictationsBridge;
    library: LibraryBridge;
  }
}
