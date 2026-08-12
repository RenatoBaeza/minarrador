'use strict';

const fs = require('node:fs');
const path = require('node:path');

let cache = null;
let file = null;

/** Required lazily so this module stays importable outside Electron (tests, tools). */
const electronPath = (name) => require('electron').app.getPath(name);

/**
 * Shortcuts the app is willing to register, and the only values `hotkey` may
 * hold.
 *
 * A fixed list rather than free text for two reasons. A global shortcut is
 * registered against the whole desktop, so a typo is not a typo — it is either
 * nothing at all, or something the user then cannot use in any other
 * application; and the setting is written from a renderer, which should never be
 * able to invent one. 'off' is a value rather than an empty string because the
 * store falls an empty string back to the default, so there would otherwise be
 * no way to say "none".
 */
const HOTKEY_CHOICES = [
  'CommandOrControl+Shift+R',
  'CommandOrControl+Shift+M',
  'CommandOrControl+Alt+R',
  'Alt+Shift+R',
  'off',
];

function defaults() {
  return {
    notesDir: path.join(electronPath('documents'), 'Minarrador'),
    ollamaHost: 'http://127.0.0.1:11434',
    transcribeModel: 'gemma4:12b',
    summaryModel: 'gemma4:12b',
    captureMic: true,
    captureSystem: true,
    /**
     * Which microphone to record, or '' for whatever Windows calls the default.
     *
     * The label is stored beside the id because Chromium salts device ids per
     * origin and does not always reissue the same one after a restart — the
     * name on the device is the more durable of the two, and having both means
     * a headset is still found when only one of them survives.
     */
    micDeviceId: '',
    micDeviceLabel: '',
    /**
     * Keep the microphone and the system audio on separate channels of the WAV.
     *
     * The reason the notes can say who owns an action item: the two sources are
     * never the same signal, so mixing them down threw away a speaker
     * separation the graph already had. Costs twice the disk (~230 MB/hour) for
     * a meeting where both sides are live, which is the trade this turns off.
     */
    separateChannels: true,
    /** Watch levels while idle and offer to start recording. */
    suggestOnAudio: true,
    /**
     * Stop a recording that has heard nothing for this many minutes; 0 never does.
     *
     * For the meeting that ended without anyone pressing Stop. Fifteen minutes
     * is longer than any pause in a real call and short enough that a forgotten
     * recording costs a coffee break rather than a weekend.
     */
    silenceStopMinutes: 15,
    /**
     * Hard ceiling on one recording, in minutes; 0 removes it.
     *
     * The backstop for silence detection failing to notice — a call left on
     * hold music, a fan the mic can hear. Four hours is past the length of any
     * meeting and still leaves a WAV the pipeline can get through.
     */
    maxRecordingMinutes: 240,
    /** Hold off system sleep while recording, so a meeting is not cut in half. */
    preventSleep: true,
    startAtLogin: true,
    /** Show the live transcript window while recording. */
    liveTranscript: true,
    /**
     * Which engine produces the live preview: 'whisper' (whisper.cpp, a local
     * binary — see `npm run whisper:setup`) or 'ollama' (the audio model, also
     * used for the post-recording pass). whisper falls back to ollama on its
     * own when it is not installed.
     */
    liveEngine: 'whisper',
    /**
     * Which engine writes the *saved* transcript, the one the notes are built
     * from. Same two names as liveEngine and the same silent fallback, but a
     * separate setting: the live preview trades accuracy for latency and this
     * pass does not, so someone can perfectly well want whisper.cpp for one and
     * the audio model for the other.
     */
    transcribeEngine: 'whisper',
    /** GGML weights for whisper.cpp; a bare name resolves inside its models folder. */
    whisperModel: 'ggml-base.bin',
    /** Override where whisper.cpp lives; '' discovers vendor/ or the packaged resources. */
    whisperRoot: '',
    /** Decode threads for whisper.cpp; 0 lets it choose. */
    whisperThreads: 0,
    /** Seconds of audio per transcription request. */
    chunkSeconds: 60,
    /** Global shortcut that starts or stops a recording; 'off' registers none. */
    hotkey: HOTKEY_CHOICES[0],
  };
}

/** Values a field is allowed to hold, beyond simply matching its default's type. */
const ENUMS = {
  liveEngine: ['whisper', 'ollama'],
  transcribeEngine: ['whisper', 'ollama'],
  hotkey: HOTKEY_CHOICES,
};

/** Numeric fields with a range that has to hold however the file was edited. */
const RANGES = {
  // Chunks drive both request size and model context use; keep them sane.
  chunkSeconds: [5, 300],
  // 0 means "let whisper.cpp decide"; the ceiling is a guard against a typo
  // spawning hundreds of decode threads mid-meeting.
  whisperThreads: [0, 64],
  // Both 0 mean "never", so neither may be clamped up off it. The ceilings only
  // exist so a hand-edited file cannot describe a cap that is not one.
  silenceStopMinutes: [0, 240],
  maxRecordingMinutes: [0, 1440],
};

/**
 * Settings are a plain JSON file a user may hand-edit, and a wrong type here
 * surfaces far away — a numeric notesDir becomes a path.join crash at Start,
 * a string chunkSeconds becomes a NaN-length chunk mid-pipeline. Coerce each
 * field against its default and drop anything that does not fit.
 *
 * @param {unknown} stored parsed contents of settings.json
 * @param {Record<string, unknown>} base defaults to fall back to
 */
function coerce(stored, base) {
  const out = { ...base };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;

  for (const [key, fallback] of Object.entries(base)) {
    if (!(key in stored)) continue;
    const value = /** @type {Record<string, unknown>} */ (stored)[key];

    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
  }

  // Both passes below are keyed on what `base` actually defines, never on the
  // full settings shape: coerce is also called with a partial base, and writing
  // a key that was not asked for turns a clamp into an invented setting.

  // Fields with a fixed vocabulary: anything else would reach code that switches
  // on the value and silently take the wrong branch.
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (key in out && !allowed.includes(out[key])) out[key] = base[key];
  }
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    if (key in out) out[key] = Math.min(hi, Math.max(lo, Math.round(out[key])));
  }
  return out;
}

function load() {
  if (cache) return cache;
  file = path.join(electronPath('userData'), 'settings.json');
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First run, or a corrupt file we can safely discard.
  }
  cache = coerce(stored, defaults());
  return cache;
}

function save(patch) {
  const next = coerce({ ...load(), ...patch }, defaults());
  cache = next;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated file behind.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

module.exports = { load, save, defaults, coerce, HOTKEY_CHOICES };
