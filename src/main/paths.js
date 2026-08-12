'use strict';

const path = require('node:path');
const fs = require('node:fs');

/** Slug used for the per-meeting folder name: 2026-08-11_14-32-05. */
function folderStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/**
 * Inverse of folderStamp: the local time a folder name encodes, or null when
 * the name was not written by this app. Tolerates the `-2` suffix two meetings
 * in the same second get.
 *
 * Reconstructing the date is not enough on its own — `Date` happily rolls
 * `2026-13-45` over into the following year — so the parse is only accepted
 * when it stamps back to the name it came from.
 *
 * @param {string} name folder name, e.g. '2026-08-11_14-32-05'
 * @returns {Date|null}
 */
function parseFolderStamp(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/.exec(String(name ?? ''));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return folderStamp(date) === name.slice(0, 19) ? date : null;
}

/** Creates and returns a fresh folder for one recording. */
function createMeetingDir(notesDir, date = new Date()) {
  let dir = path.join(notesDir, folderStamp(date));
  let n = 2;
  while (fs.existsSync(dir)) dir = path.join(notesDir, `${folderStamp(date)}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const FILES = {
  audio: 'audio.wav',
  transcript: 'transcript.txt',
  transcriptJson: 'transcript.json',
  /**
   * The live preview, kept as it is produced.
   *
   * Rough by construction and always superseded by `transcript`, which is a
   * separate careful pass over the saved WAV — but it is written line by line
   * during the meeting, so it is the one piece of text that survives a pipeline
   * that never ran. That turns the worst case from "a WAV" into "a rough
   * transcript", which is why it is a first-class artefact rather than a log.
   */
  liveTranscript: 'live-transcript.txt',
  notes: 'notes.md',
  notesJson: 'notes.json',
  html: 'notes.html',
  pdf: 'notes.pdf',
  meta: 'meta.json',
};

// Required lazily so this module stays importable outside Electron (tests, tools).
const userData = () => require('electron').app.getPath('userData');

module.exports = { folderStamp, parseFolderStamp, createMeetingDir, FILES, userData };
