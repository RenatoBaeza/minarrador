'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let cache = null;
let file = null;

function defaults() {
  return {
    notesDir: path.join(app.getPath('documents'), 'Minarrador'),
    ollamaHost: 'http://127.0.0.1:11434',
    transcribeModel: 'gemma4:12b',
    summaryModel: 'gemma4:12b',
    captureMic: true,
    captureSystem: true,
    /** Watch levels while idle and offer to start recording. */
    suggestOnAudio: true,
    startAtLogin: true,
    /** Seconds of audio per transcription request. */
    chunkSeconds: 60,
  };
}

function load() {
  if (cache) return cache;
  file = path.join(app.getPath('userData'), 'settings.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First run, or a corrupt file we can safely discard.
  }
  cache = { ...defaults(), ...stored };
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, defaults };
