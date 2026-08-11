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
  notes: 'notes.md',
  notesJson: 'notes.json',
  html: 'notes.html',
  pdf: 'notes.pdf',
  meta: 'meta.json',
};

// Required lazily so this module stays importable outside Electron (tests, tools).
const userData = () => require('electron').app.getPath('userData');

module.exports = { folderStamp, createMeetingDir, FILES, userData };
