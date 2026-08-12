'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The logger keeps module-level state (the path it was pointed at, and the size
// it believes the file to be), so every test gets its own directory and re-inits
// onto it rather than sharing one.
const log = require('../src/main/logger');

/** A scratch directory the logger is pointed at, removed when the test ends. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  log.init(dir);
  return { dir, file: path.join(dir, 'minarrador.log') };
}

/** Silences the console mirror, which would otherwise spray the test output. */
function quiet(t) {
  const original = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = original;
  });
}

test('init creates the directory it is pointed at', (t) => {
  quiet(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-log-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const dir = path.join(parent, 'nested', 'userData');
  log.init(dir);
  log.info('hello');

  assert.equal(fs.readFileSync(path.join(dir, 'minarrador.log'), 'utf8').trim().endsWith('hello'), true);
});

test('each level is written with its tag and a timestamp', (t) => {
  quiet(t);
  const { file } = scratch(t);

  log.info('an info line');
  log.warn('a warning');
  log.error('a failure');

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[info] an info line$/);
  assert.match(lines[1], /\[warn] a warning$/);
  assert.match(lines[2], /\[error] a failure$/);
});

test('an Error is logged with its stack, not as an empty object', (t) => {
  quiet(t);
  const { file } = scratch(t);

  log.error('pipeline failed', new Error('Ollama is not reachable'));

  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /pipeline failed Error: Ollama is not reachable/);
  assert.match(written, /at /, 'the stack is the point of logging an Error');
});

test('a circular argument is logged instead of taking the caller down', (t) => {
  quiet(t);
  const { file } = scratch(t);

  // JSON.stringify throws on this, and it used to do so outside the try below —
  // so a diagnostic log call could crash the very thing it was reporting on.
  const circular = { phase: 'recording' };
  circular.self = circular;

  assert.doesNotThrow(() => log.info('state', circular));
  assert.doesNotThrow(() => log.info('threads', 8n));

  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /\[info] state /);
  assert.match(written, /\[info] threads 8/);
});

test('logging never throws even when the file cannot be written', (t) => {
  quiet(t);
  const { dir, file } = scratch(t);

  log.info('first');
  // Replace the file with a directory: appendFileSync then fails with EISDIR.
  fs.rmSync(file);
  fs.mkdirSync(file);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.doesNotThrow(() => log.error('the app must survive this'));
});

test('a log that outgrows the cap is rotated during the session, not just at startup', (t) => {
  quiet(t);
  const { file } = scratch(t);

  // A login item runs for weeks between restarts. Checking the size only at init
  // meant the file simply grew for the whole of that.
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i * chunk.length <= log.MAX_BYTES; i++) log.info(chunk);

  assert.equal(fs.existsSync(`${file}.1`), true, 'the old generation should have been kept');
  assert.ok(fs.statSync(file).size < log.MAX_BYTES, 'the live file should have started over');
});

test('init rotates a file that was already over the cap', (t) => {
  quiet(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'minarrador.log');
  fs.writeFileSync(file, 'y'.repeat(log.MAX_BYTES + 1));

  log.init(dir);
  log.info('after restart');

  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.match(fs.readFileSync(file, 'utf8'), /after restart/);
});

test('path reports where the tray menu will open', (t) => {
  quiet(t);
  const { file } = scratch(t);
  assert.equal(log.path, file);
});
