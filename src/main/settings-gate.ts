// What a settings patch from the library window is allowed to change.
//
// The window is a renderer, so a patch from it is a claim rather than a
// setting. Two gates stand between it and settings.json: the preload casts a
// fixed vocabulary of keys to the types the store expects (FIELDS in
// library-preload.ts), and this filters again on arrival — a preload is only
// the first gate. Both are typed from LibrarySettingKey, so they cannot drift
// apart without a compile error.
//
// Pure, with no Electron import, so it is tested directly.

import type { AudioDevice, LibrarySettingKey, Settings } from '../shared/types';

/**
 * Settings the library window is allowed to change.
 *
 * Everything else in the store names a place — the notes folder, the Ollama
 * host, the whisper install root — and a renderer that could set one of those
 * could point this app's reading and writing anywhere on the machine. The folder
 * is changed through a dialog instead, where the path comes from the user rather
 * than from the page.
 */
const KEYS: Record<LibrarySettingKey, true> = {
  suggestOnAudio: true,
  startAtLogin: true,
  liveTranscript: true,
  captureMic: true,
  captureSystem: true,
  separateChannels: true,
  // Not a path: an opaque device handle Chromium issues, checked below against
  // the list the capture worker actually reported.
  micDeviceId: true,
  micDeviceLabel: true,
  silenceStopMinutes: true,
  maxRecordingMinutes: true,
  preventSleep: true,
  hotkey: true,
  dictateHotkey: true,
  dictateEngine: true,
  dictateAutoPaste: true,
  liveEngine: true,
  transcribeEngine: true,
  whisperModel: true,
  whisperThreads: true,
  transcribeModel: true,
  summaryModel: true,
};

export const LIBRARY_SETTINGS: ReadonlySet<string> = new Set(Object.keys(KEYS));

/** The settings that name a place on this machine or the network. */
export const PATH_SETTINGS = ['notesDir', 'ollamaHost', 'whisperRoot'] as const;

/**
 * A compile error the day a path-shaped key is added to LibrarySettingKey.
 * `Never<T>` only accepts never, and the intersection of the two lists must be.
 */
type Never<T extends never> = T;
export type NoPathSettings = Never<Extract<LibrarySettingKey, (typeof PATH_SETTINGS)[number]>>;

/** What is actually installed, to hold the named-thing settings against. */
export interface Installed {
  /** GGML weights whisper.cpp found. */
  whisperModels: readonly string[];
  /** Models Ollama lists. */
  models: readonly string[];
  /** Audio inputs the capture worker reported. */
  devices: readonly AudioDevice[];
}

/**
 * Filters a patch from the library window down to what it may change.
 *
 * Whatever type each value really has, the store coerces it against the
 * default before it is written; this is only about which keys, and about the
 * values that name something real.
 */
export function gateLibraryPatch(patch: unknown, installed: Installed): Partial<Settings> {
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (LIBRARY_SETTINGS.has(key)) allowed[key] = value;
  }
  const clean = allowed as Partial<Settings>;
  // settings.ts checks the type of a model name, not whether it exists — and
  // whisperModel is resolved against a folder of weights, so a name from a
  // page is the one string here that reaches the filesystem. Both are picked
  // from a list the window was given, so anything else is not a setting.
  if ('whisperModel' in clean && !installed.whisperModels.includes(clean.whisperModel as string)) {
    delete clean.whisperModel;
  }
  if ('transcribeModel' in clean && !installed.models.includes(clean.transcribeModel as string)) {
    delete clean.transcribeModel;
  }
  if ('summaryModel' in clean && !installed.models.includes(clean.summaryModel as string)) delete clean.summaryModel;
  // A device id is opaque rather than a path, but it still names something
  // real, so it is held to the same rule: one of the ones the capture worker
  // reported, or the empty string that means "whatever Windows defaults to".
  if ('micDeviceId' in clean && clean.micDeviceId && !installed.devices.some((d) => d.id === clean.micDeviceId)) {
    delete clean.micDeviceId;
    delete clean.micDeviceLabel;
  }
  return clean;
}
