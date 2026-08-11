'use strict';

const fs = require('node:fs');
const path = require('node:path');

let cache = null;
let file = null;

/** Required lazily so this module stays importable outside Electron (tests, tools). */
const electronPath = (name) => require('electron').app.getPath(name);

function defaults() {
  return {
    notesDir: path.join(electronPath('documents'), 'Minarrador'),
    ollamaHost: 'http://127.0.0.1:11434',
    transcribeModel: 'gemma4:12b',
    summaryModel: 'gemma4:12b',
    captureMic: true,
    captureSystem: true,
    /** Watch levels while idle and offer to start recording. */
    suggestOnAudio: true,
    startAtLogin: true,
    /** Show the live transcript window while recording. */
    liveTranscript: true,
    /** Seconds of audio per transcription request. */
    chunkSeconds: 60,
  };
}

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

  // Chunks drive both request size and model context use; keep them sane.
  out.chunkSeconds = Math.min(300, Math.max(5, Math.round(out.chunkSeconds)));
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

module.exports = { load, save, defaults, coerce };
