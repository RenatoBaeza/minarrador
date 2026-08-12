'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { trimSilence, dictationEngineFor } = require('../src/main/dictation');
const { rms } = require('../src/main/wav');

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/** `seconds` of a 300 Hz tone, comfortably above the silence gate. */
function toneSeconds(seconds) {
  const buf = Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));
  for (let i = 0; i < buf.length; i += 2) {
    buf.writeInt16LE(Math.round(Math.sin(((i / 2) * 2 * Math.PI * 300) / SAMPLE_RATE) * 8000), i);
  }
  return buf;
}

const silentSeconds = (seconds) => Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));

// ------------------------------------------------------------------- trimSilence

test('trimSilence removes the room tone either side of the speech', () => {
  const clip = Buffer.concat([silentSeconds(1), toneSeconds(2), silentSeconds(1)]);
  const trimmed = trimSilence(clip);

  // A 50 ms window resolution eats at most a window off each edge.
  assert.ok(trimmed.length > 1.5 * BYTES_PER_SECOND, `expected ~2s of speech, got ${trimmed.length} bytes`);
  assert.ok(trimmed.length <= 2.1 * BYTES_PER_SECOND, `expected no more than ~2s, got ${trimmed.length} bytes`);
  assert.ok(rms(trimmed) >= 0.004, 'what is left must actually be audible');
});

test('trimSilence trims both ends independently', () => {
  // Speech that starts halfway in but ends on the very end of the buffer.
  const clip = Buffer.concat([silentSeconds(3), toneSeconds(1)]);
  const trimmed = trimSilence(clip);

  assert.ok(trimmed.length <= 1.1 * BYTES_PER_SECOND, `only the tail should remain, got ${trimmed.length} bytes`);
  assert.ok(trimmed.length > 0.9 * BYTES_PER_SECOND);
});

test('trimSilence returns an empty buffer for an all-silent clip', () => {
  const trimmed = trimSilence(silentSeconds(3));
  assert.equal(trimmed.length, 0);
});

test('trimSilence leaves an already-audible clip basically intact', () => {
  const tone = toneSeconds(2);
  const trimmed = trimSilence(tone);
  // The gate windows start on a tone, so nothing gets eaten on the left.
  assert.ok(trimmed.length >= tone.length - 0.1 * BYTES_PER_SECOND, `${trimmed.length} vs ${tone.length}`);
});

// ------------------------------------------------------------ dictationEngineFor

test('dictationEngineFor prefers whisper.cpp when it is installed', () => {
  assert.equal(dictationEngineFor({ dictateEngine: 'whisper' }, { available: true }, false), 'whisper');
});

test('dictationEngineFor uses Ollama when that is what was asked and it is up', () => {
  assert.equal(dictationEngineFor({ dictateEngine: 'ollama' }, { available: true }, true), 'ollama');
});

test('dictationEngineFor falls back to whisper.cpp when Ollama is down but whisper exists', () => {
  assert.equal(dictationEngineFor({ dictateEngine: 'ollama' }, { available: true }, false), 'whisper');
});

test('dictationEngineFor falls back to Ollama when whisper.cpp was asked but is missing', () => {
  assert.equal(dictationEngineFor({ dictateEngine: 'whisper' }, { available: false }, true), 'ollama');
});

test('dictationEngineFor picks Ollama as the last resort so a failure can surface', () => {
  assert.equal(dictationEngineFor({ dictateEngine: 'whisper' }, { available: false }, false), 'ollama');
});
