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

/**
 * What a channel of a two-channel recording is called in a transcript.
 *
 * The keys are the channels the capture graph produces — left is the
 * microphone, right is everything the system played — and the values are what
 * goes in front of a line. Kept here with the file names because that is what
 * this is: part of the format of transcript.txt and live-transcript.txt, which
 * are read back by the library and by whoever opens the folder.
 */
const SPEAKERS = { mic: 'You', system: 'Others' };

/** One transcript line, labelled when it is known who said it. */
const speakerLine = (speaker, text) => (SPEAKERS[speaker] ? `${SPEAKERS[speaker]}: ${text}` : String(text));

/**
 * Pulls a speaker label back off a line written by {@link speakerLine}.
 *
 * Only needed for the live preview, which is a flat text file — the pipeline's
 * transcript keeps the speaker as a field in transcript.json.
 *
 * @returns {{ speaker: string, text: string }} `speaker` is '' when unlabelled
 */
function parseSpeakerLine(line) {
  const text = String(line ?? '');
  for (const [speaker, label] of Object.entries(SPEAKERS)) {
    if (text.startsWith(`${label}: `)) return { speaker, text: text.slice(label.length + 2) };
  }
  return { speaker: '', text };
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
  /**
   * A title the user typed, which wins over the one the model produced.
   *
   * Its own file rather than a field in notes.json or meta.json because both of
   * those are rewritten every time the notes are generated again: a rename
   * would survive until the first re-run and then quietly revert. Nothing in
   * the pipeline touches this one.
   */
  title: 'title.txt',
};

/** Longest title worth keeping; past this it is a paragraph, not a name. */
const MAX_TITLE = 120;

/**
 * A user-typed title, flattened to the one line a rail card can show.
 *
 * @returns {string} '' when there is nothing left, which means "use the model's"
 */
const normaliseTitle = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

/** The title someone typed over this meeting, or '' if they never did. */
function readTitle(dir) {
  try {
    return normaliseTitle(fs.readFileSync(path.join(dir, FILES.title), 'utf8'));
  } catch {
    // No override, which is the normal case.
    return '';
  }
}

// Required lazily so this module stays importable outside Electron (tests, tools).
const userData = () => require('electron').app.getPath('userData');

module.exports = {
  folderStamp,
  parseFolderStamp,
  createMeetingDir,
  FILES,
  SPEAKERS,
  speakerLine,
  parseSpeakerLine,
  normaliseTitle,
  readTitle,
  MAX_TITLE,
  userData,
};
