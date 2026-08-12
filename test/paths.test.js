'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
} = require('../src/main/paths');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('folderStamp sorts chronologically as plain text', () => {
  assert.equal(folderStamp(new Date(2026, 7, 11, 14, 32, 5)), '2026-08-11_14-32-05');
  assert.equal(folderStamp(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01_00-00-00');
  assert.equal(folderStamp(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31_23-59-59');
});

test('folderStamp produces a name Windows will accept', () => {
  const stamp = folderStamp(new Date(2026, 7, 11, 14, 32, 5));
  assert.doesNotMatch(stamp, /[<>:"/\\|?*]/, 'no character Explorer rejects');
});

test('parseFolderStamp reads back what folderStamp wrote', () => {
  for (const when of [new Date(2026, 7, 11, 14, 32, 5), new Date(2026, 0, 1, 0, 0, 0), new Date(2026, 11, 31, 23, 59, 59)]) {
    assert.deepEqual(parseFolderStamp(folderStamp(when)), when);
  }
});

test('parseFolderStamp tolerates the suffix a second meeting in the same second gets', () => {
  assert.deepEqual(parseFolderStamp('2026-08-11_14-32-05-2'), new Date(2026, 7, 11, 14, 32, 5));
});

test('parseFolderStamp returns null for a name this app did not write', () => {
  for (const name of [
    'Screenshots',
    '',
    null,
    undefined,
    '2026-08-11',
    '2026-08-11_14-32',
    'meeting-2026-08-11_14-32-05',
    // Reconstructable, but only because Date rolls the overflow into next year.
    '2026-13-45_14-32-05',
    '2026-08-11_25-00-00',
  ]) {
    assert.equal(parseFolderStamp(name), null, `should refuse ${JSON.stringify(name)}`);
  }
});

test('createMeetingDir creates the folder it returns', (t) => {
  const root = tmpDir(t);
  const dir = createMeetingDir(root, new Date(2026, 7, 11, 14, 32, 5));

  assert.ok(fs.existsSync(dir));
  assert.equal(path.basename(dir), '2026-08-11_14-32-05');
  assert.equal(path.dirname(dir), root);
});

test('createMeetingDir never reuses a folder when two meetings share a second', (t) => {
  const root = tmpDir(t);
  const when = new Date(2026, 7, 11, 14, 32, 5);

  const dirs = [createMeetingDir(root, when), createMeetingDir(root, when), createMeetingDir(root, when)];

  assert.equal(new Set(dirs).size, 3, 'each recording needs its own folder');
  assert.deepEqual(dirs.map((d) => path.basename(d)), [
    '2026-08-11_14-32-05',
    '2026-08-11_14-32-05-2',
    '2026-08-11_14-32-05-3',
  ]);
  for (const dir of dirs) assert.ok(fs.existsSync(dir));
});

test('createMeetingDir builds missing parent directories', (t) => {
  const root = path.join(tmpDir(t), 'nested', 'notes');
  const dir = createMeetingDir(root);
  assert.ok(fs.existsSync(dir));
});

test('FILES names are stable, since the folder is the app’s public contract', () => {
  assert.deepEqual(FILES, {
    audio: 'audio.wav',
    transcript: 'transcript.txt',
    transcriptJson: 'transcript.json',
    liveTranscript: 'live-transcript.txt',
    notes: 'notes.md',
    notesJson: 'notes.json',
    html: 'notes.html',
    pdf: 'notes.pdf',
    meta: 'meta.json',
    title: 'title.txt',
  });
});

// ------------------------------------------------------------------- speakers
//
// The prefix is part of the transcript file format: it is written by the
// pipeline and by the live preview, and read back by the library. A round trip
// that does not hold turns a speaker label into part of what somebody said.

test('speakerLine labels a line, and leaves an unattributed one alone', () => {
  assert.equal(speakerLine('mic', 'so where did we land'), `${SPEAKERS.mic}: so where did we land`);
  assert.equal(speakerLine('system', 'we did not'), `${SPEAKERS.system}: we did not`);
  assert.equal(speakerLine('', 'a mono recording'), 'a mono recording');
  assert.equal(speakerLine('nonsense', 'not a channel'), 'not a channel');
});

test('parseSpeakerLine reads back exactly what speakerLine wrote', () => {
  for (const speaker of ['mic', 'system', '']) {
    const text = 'the quick brown fox: with a colon in it';
    assert.deepEqual(parseSpeakerLine(speakerLine(speaker, text)), { speaker, text });
  }
});

test('parseSpeakerLine leaves a line that merely looks labelled alone', () => {
  // A real sentence can start with a word and a colon; only the exact labels count.
  assert.deepEqual(parseSpeakerLine('Ana: I will draft it'), { speaker: '', text: 'Ana: I will draft it' });
  assert.deepEqual(parseSpeakerLine(`${SPEAKERS.mic}:no space`), { speaker: '', text: `${SPEAKERS.mic}:no space` });
  assert.deepEqual(parseSpeakerLine(''), { speaker: '', text: '' });
  assert.deepEqual(parseSpeakerLine(null), { speaker: '', text: '' });
});

// ---------------------------------------------------------------------- titles

test('normaliseTitle flattens a title to the one line a card can show', () => {
  assert.equal(normaliseTitle('  Pricing   review\n\n'), 'Pricing review');
  assert.equal(normaliseTitle('a\tb\nc'), 'a b c');
  assert.equal(normaliseTitle('   '), '', 'nothing left means "use the model’s title"');
  assert.equal(normaliseTitle(undefined), '');
  assert.equal(normaliseTitle('x'.repeat(500)).length, MAX_TITLE);
});

test('readTitle finds a typed title, and shrugs at a folder without one', (t) => {
  const dir = tmpDir(t);
  assert.equal(readTitle(dir), '', 'no override is the normal case');

  fs.writeFileSync(path.join(dir, FILES.title), 'Pricing review\n');
  assert.equal(readTitle(dir), 'Pricing review');

  // A file hand-edited to nothing means the same as no file at all, rather than
  // titling the meeting with an empty string.
  fs.writeFileSync(path.join(dir, FILES.title), '\n \n');
  assert.equal(readTitle(dir), '');
});
