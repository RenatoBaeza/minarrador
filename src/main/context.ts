// The state every part of the main process shares, and nothing else.
//
// main.ts used to hold this beside two and a half thousand lines of the code
// that reads it. The modules that split out of it — recording, the windows, the
// IPC namespaces — all need the same handful of things: what phase the app is
// in, the settings, and the long-lived controllers. They live here so none of
// those modules has to import another just to read a flag.
//
// No Electron import, on purpose: recording.ts is tested under plain Node, and
// it reads everything it needs from here.

import type { AppTray } from './tray';
import type { CaptureController } from './capture';
import type { DictationController } from './dictation';
import type { WhisperServer } from './whisper';
import type { JobProgress, Settings, SetupState } from '../shared/types';

/**
 * Slowest rate at which a progress stream is pushed to the library window.
 *
 * Progress ticks once per transcribed chunk, which on a short chunk setting is
 * every few seconds. It rides its own channel rather than `library:changed`
 * precisely so it cannot make the window re-read every transcript on disk, and
 * this keeps even the cheap path from being spammed.
 */
export const PROGRESS_MIN_MS = 700;

/**
 * Free space below which the settings pane warns about the notes volume.
 *
 * A recording is ~115 MB an hour in mono and ~230 MB in stereo, so this is most
 * of a working day of audio.
 */
export const DISK_WARN_BYTES = 2 * 1024 ** 3;

/** A pipeline run in flight: how to stop it, and where it has got to. */
export interface Job {
  abort: AbortController;
  progress: JobProgress;
}

export interface AppState {
  phase: 'idle' | 'recording' | 'processing';
  progress: string;
  currentDir: string | null;
  /**
   * Where live preview lines are written, which outlives currentDir by a beat.
   *
   * A segment already being transcribed when Stop is pressed comes back a
   * second later, by which time the recording is over — and that line was said
   * during the meeting, so it belongs in its folder. Replaced by the next
   * recording rather than cleared, so it is never pointing at nothing.
   */
  liveDir: string | null;
  recordingStartedAt: Date | null;
  /** Elapsed seconds at which the "still recording" warning last went out. */
  warnedLongAt: number;
  /** Free space last read on the notes volume, and when — see checkDisk. */
  disk: { free: number | null; checkedAt: number; warned: boolean };
  /** powerSaveBlocker handle held for the duration of a recording, or null. */
  sleepBlocker: number | null;
  lastDir: string | null;
  ollamaUp: boolean;
  /** True while a look-for-Ollama pass is in flight, so the menu can say so. */
  ollamaChecking: boolean;
  models: string[];
  audioModels: string[];
  /**
   * Meetings still being processed, keyed by folder so a quit can name them.
   *
   * `abort` stops that run's model requests; `progress` is the same detail the
   * tray shows, kept per meeting so the library can show it on the right card
   * rather than the bare "Working…" it used to.
   */
  jobs: Map<string, Job>;
  /**
   * The one download the app will run at a time, or null.
   *
   * One at a time on purpose: both of these are the way out of "this app cannot
   * transcribe anything", they are the only things here that take minutes with
   * nothing to show but a bar, and two at once over one connection is slower
   * than either alone.
   */
  setup: (SetupState & { abort: AbortController }) | null;
  /** Whether the desktop actually gave us the start/stop shortcut. */
  hotkeyRegistered: boolean;
  /** Whether the desktop actually gave us the voice-input shortcut. */
  dictateHotkeyRegistered: boolean;
  /** The accelerator that was actually registered, so a change can release it. */
  dictateHotkeyAcc: string | null;
  /**
   * The meeting the tray's Retry Notes item would run, or null.
   *
   * Recomputed only when the folder changes — never from refreshTray, which
   * ticks once a second while recording and would have it walking the whole
   * notes folder for a clock.
   */
  retry: { id: string; label: string } | null;
  /** Guards the shutdown sequence against re-entering before-quit. */
  quitting: boolean;
  /** True while a recording is being closed — see finalizeRecording. */
  stopping: boolean;
  /** True while the settings pane's mic test has the microphone open. */
  micTesting: boolean;
  /**
   * The loudest each source has been since the recording started, for the
   * health strip on the record button: a system channel that has been open
   * and silent for ten seconds is the meeting audio going somewhere else.
   */
  heard: { mic: number; system: number };
}

export const state: AppState = {
  phase: 'idle',
  progress: '',
  currentDir: null,
  liveDir: null,
  recordingStartedAt: null,
  warnedLongAt: 0,
  disk: { free: null, checkedAt: 0, warned: false },
  sleepBlocker: null,
  lastDir: null,
  ollamaUp: false,
  ollamaChecking: false,
  models: [],
  audioModels: [],
  jobs: new Map(),
  setup: null,
  hotkeyRegistered: false,
  dictateHotkeyRegistered: false,
  dictateHotkeyAcc: null,
  retry: null,
  quitting: false,
  stopping: false,
  micTesting: false,
  heard: { mic: 0, system: 0 },
};

/**
 * The long-lived pieces startup() builds, and the settings they run on.
 *
 * `settings` is loaded first thing in startup(); nothing that reads it runs
 * before then, which is why it is not nullable. The controllers are null until
 * they exist and after shutdown, and every reader treats them that way.
 */
export const ctx: {
  settings: Settings;
  capture: CaptureController | null;
  dictation: DictationController | null;
  whisper: WhisperServer | null;
  tray: AppTray | null;
} = {
  settings: undefined as unknown as Settings,
  capture: null,
  dictation: null,
  whisper: null,
  tray: null,
};

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Clears a timer that may never have been set. */
export const clear = (timer: NodeJS.Timeout | null): void => {
  if (timer) clearTimeout(timer);
};

/** An accelerator as a person would read it. 'off' is a value, not a shortcut. */
export function hotkeyLabel(accelerator: string): string {
  if (!accelerator || accelerator === 'off') return 'No shortcut';
  return accelerator.replace('CommandOrControl', 'Ctrl').replace('Super', 'Win').replace(/\+/g, ' + ');
}

export const human = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * One field of a request a page sent. Everything that arrives over IPC is a
 * claim rather than a type, so it is read as unknown and checked where used.
 */
export const field = (req: unknown, key: string): unknown =>
  req && typeof req === 'object' ? (req as Record<string, unknown>)[key] : undefined;
