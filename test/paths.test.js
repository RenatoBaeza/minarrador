'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { folderStamp, createMeetingDir, FILES } = require('../src/main/paths');

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
    notes: 'notes.md',
    notesJson: 'notes.json',
    html: 'notes.html',
    pdf: 'notes.pdf',
    meta: 'meta.json',
  });
});
