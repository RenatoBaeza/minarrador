'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WavWriter, buildWav, readWav, rms, splitIntoChunks, HEADER_BYTES } = require('../src/main/wav');

const RATE = 16000;

/** PCM for `seconds` of a sine at `amplitude` (0..1). */
function tone(seconds, amplitude = 0.5, rate = RATE) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * amplitude * 32767), i * 2);
  }
  return buf;
}

const silence = (seconds, rate = RATE) => Buffer.alloc(Math.round(seconds * rate) * 2);

function tmpFile(name) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-test-')), name);
  test.after?.(() => fs.rmSync(path.dirname(p), { recursive: true, force: true }));
  return p;
}

test('buildWav writes a header readWav can parse back', () => {
  const pcm = tone(0.25);
  const wav = buildWav(pcm, RATE, 1);

  assert.equal(wav.length, pcm.length + HEADER_BYTES);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');

  const file = tmpFile('roundtrip.wav');
  fs.writeFileSync(file, wav);
  const read = readWav(file);

  assert.equal(read.sampleRate, RATE);
  assert.equal(read.channels, 1);
  assert.equal(read.seconds.toFixed(3), '0.250');
  assert.deepEqual(read.pcm, pcm);
});

test('readWav rejects files that are not RIFF/WAVE', () => {
  const file = tmpFile('bogus.wav');
  fs.writeFileSync(file, Buffer.from('definitely not a wav file at all'));
  assert.throws(() => readWav(file), /Not a RIFF\/WAVE file/);
});

test('readWav rejects bit depths the pipeline cannot handle', () => {
  const wav = buildWav(tone(0.1), RATE, 1);
  wav.writeUInt16LE(24, 34); // bits per sample
  const file = tmpFile('24bit.wav');
  fs.writeFileSync(file, wav);
  assert.throws(() => readWav(file), /Expected 16-bit PCM, got 24-bit/);
});

test('readWav recovers audio from a header the writer never patched', () => {
  // A crash mid-meeting leaves the data-chunk length at its initial zero.
  const pcm = tone(0.5);
  const wav = buildWav(pcm, RATE, 1);
  wav.writeUInt32LE(0, 40);

  const file = tmpFile('unpatched.wav');
  fs.writeFileSync(file, wav);

  const read = readWav(file);
  assert.equal(read.pcm.length, pcm.length, 'should fall back to the bytes actually present');
});

test('readWav ignores a data length that overruns the file', () => {
  const pcm = tone(0.3);
  const wav = buildWav(pcm, RATE, 1);
  wav.writeUInt32LE(pcm.length * 4, 40); // claims far more than exists

  const file = tmpFile('overrun.wav');
  fs.writeFileSync(file, wav);
  assert.equal(readWav(file).pcm.length, pcm.length);
});

test('rms distinguishes silence from signal', () => {
  assert.equal(rms(silence(0.1)), 0);

  const loud = rms(tone(0.1, 1.0));
  const quiet = rms(tone(0.1, 0.05));
  assert.ok(loud > 0.6, `full-scale sine should read high, got ${loud}`);
  assert.ok(quiet < loud / 5, 'a quiet tone should read far below a loud one');
});

test('rms tolerates odd offsets rather than reading past a sample', () => {
  const pcm = tone(0.05);
  assert.doesNotThrow(() => rms(pcm, 1, pcm.length - 1));
  assert.equal(rms(pcm, 10, 10), 0, 'an empty range has no energy');
});

test('WavWriter patches the header on close and reports duration', () => {
  const file = tmpFile('written.wav');
  const writer = new WavWriter(file, { sampleRate: RATE, channels: 1 });

  const pcm = tone(1.5);
  writer.write(pcm.subarray(0, pcm.length / 2));
  writer.write(pcm.subarray(pcm.length / 2));
  writer.write(Buffer.alloc(0)); // must be a no-op, not a corrupt write

  const result = writer.close();
  assert.equal(result.bytes, pcm.length);
  assert.equal(result.seconds.toFixed(2), '1.50');

  const read = readWav(file);
  assert.deepEqual(read.pcm, pcm);
});

test('WavWriter close is idempotent', () => {
  const writer = new WavWriter(tmpFile('twice.wav'), { sampleRate: RATE, channels: 1 });
  writer.write(tone(0.1));
  const first = writer.close();
  const second = writer.close();
  assert.deepEqual(second, first);
});

test('splitIntoChunks covers the input exactly once, in order', () => {
  const pcm = tone(185); // just over three minutes
  const chunks = splitIntoChunks(pcm, RATE, 60);

  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  assert.equal(chunks[0].startSeconds, 0);

  let bytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    bytes += chunks[i].pcm.length;
    assert.equal(chunks[i].pcm.length % 2, 0, 'chunks must not split a 16-bit sample');
    if (i > 0) {
      assert.equal(chunks[i].startSeconds, chunks[i - 1].endSeconds, 'chunks must be contiguous');
    }
  }
  assert.equal(bytes, pcm.length, 'every byte should land in exactly one chunk');
  assert.equal(chunks.at(-1).endSeconds.toFixed(2), (pcm.length / (RATE * 2)).toFixed(2));
});

test('splitIntoChunks moves the cut into a silent gap', () => {
  // Speech, a clear pause either side of the 60s mark, then more speech.
  const pcm = Buffer.concat([tone(59), silence(2), tone(30)]);
  const [first] = splitIntoChunks(pcm, RATE, 60, 4);

  assert.ok(
    first.endSeconds > 59 && first.endSeconds < 61,
    `cut should land inside the 59-61s pause, got ${first.endSeconds}`,
  );
});

test('splitIntoChunks handles input shorter than one chunk', () => {
  const pcm = tone(3);
  const chunks = splitIntoChunks(pcm, RATE, 60);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm.length, pcm.length);
});

test('splitIntoChunks returns nothing for empty audio', () => {
  assert.deepEqual(splitIntoChunks(Buffer.alloc(0), RATE, 60), []);
});
