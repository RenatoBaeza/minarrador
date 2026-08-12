'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WavWriter,
  buildWav,
  readWav,
  rms,
  channelRms,
  splitIntoChunks,
  deinterleave,
  downmix,
  HEADER_BYTES,
} = require('../src/main/wav');

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

// The byte offsets are what let a two-channel recording be cut once, on the mix,
// and have both channels sliced to the same boundaries — a cut found where
// neither side was talking.
test('splitIntoChunks reports byte offsets that match the audio it returns', () => {
  const pcm = tone(150);
  const chunks = splitIntoChunks(pcm, RATE, 60);

  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, pcm.length);
  for (const c of chunks) {
    assert.equal(c.end - c.start, c.pcm.length, 'the offsets must span exactly the chunk');
    assert.deepEqual(pcm.subarray(c.start, c.end), c.pcm);
    assert.equal(c.start % 2, 0, 'an offset must never land inside a sample');
  }
});

// ------------------------------------------------------- two-channel recordings

/** Interleaves two equal-length mono buffers into one stereo buffer. */
function interleave(left, right) {
  const frames = left.length / 2;
  const out = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) {
    out.writeInt16LE(left.readInt16LE(f * 2), f * 4);
    out.writeInt16LE(right.readInt16LE(f * 2), f * 4 + 2);
  }
  return out;
}

test('deinterleave pulls the two sides of a recording back apart', () => {
  const mic = tone(0.25, 0.5);
  const system = tone(0.25, 0.1);
  const [left, right] = deinterleave(interleave(mic, system), 2);

  assert.deepEqual(left, mic, 'left is the microphone');
  assert.deepEqual(right, system, 'right is the system audio');
});

test('deinterleave hands a mono buffer straight back', () => {
  const pcm = tone(0.1);
  assert.deepEqual(deinterleave(pcm, 1), [pcm]);
});

test('deinterleave ignores a trailing partial frame rather than reading past it', () => {
  const stereo = interleave(tone(0.05), tone(0.05));
  const truncated = stereo.subarray(0, stereo.length - 3);
  const [left, right] = deinterleave(truncated, 2);
  assert.equal(left.length, right.length);
  assert.doesNotThrow(() => deinterleave(truncated, 2));
});

test('downmix sums the channels rather than halving both voices', () => {
  // One side talking, the other silent — which is what most of a meeting is.
  const speech = tone(0.2, 0.4);
  const quiet = silence(0.2);
  const mono = downmix(interleave(speech, quiet), 2);

  assert.equal(mono.length, speech.length);
  assert.deepEqual(mono, speech, 'a lone speaker must keep their level');
});

test('downmix clamps instead of wrapping when both sides are loud', () => {
  const loud = tone(0.1, 1.0);
  const mono = downmix(interleave(loud, loud), 2);
  for (let i = 0; i < mono.length; i += 2) {
    const s = mono.readInt16LE(i);
    assert.ok(s >= -32768 && s <= 32767);
  }
  // Wrapping would put full-scale positive samples at the negative rail.
  const peak = Math.max(...Array.from({ length: mono.length / 2 }, (_, i) => mono.readInt16LE(i * 2)));
  assert.ok(peak > 0, 'a loud sum must saturate, not invert');
});

test('downmix leaves mono alone', () => {
  const pcm = tone(0.1);
  assert.deepEqual(downmix(pcm, 1), pcm);
});

test('channelRms reads one side without being dragged down by the other', () => {
  const speech = tone(0.2, 0.5);
  const stereo = interleave(speech, silence(0.2));

  assert.ok(Math.abs(channelRms(stereo, 2, 0) - rms(speech)) < 1e-6, 'the talking side reads as itself');
  assert.equal(channelRms(stereo, 2, 1), 0, 'the silent side reads as silence');
  // Measured across both channels the same audio looks 3 dB quieter, which is
  // what would put every utterance nearer the silence gate.
  assert.ok(rms(stereo) < channelRms(stereo, 2, 0));
});

test('channelRms falls back to the whole buffer for mono', () => {
  const pcm = tone(0.1);
  assert.equal(channelRms(pcm, 1, 0), rms(pcm));
});

test('WavWriter writes a stereo header the reader agrees with', () => {
  const file = tmpFile('stereo.wav');
  const writer = new WavWriter(file, { sampleRate: RATE, channels: 2 });
  const stereo = interleave(tone(1), silence(1));
  writer.write(stereo);
  const result = writer.close();

  assert.equal(result.bytes, stereo.length);
  assert.equal(result.seconds.toFixed(2), '1.00', 'a stereo second is twice the bytes, not twice the duration');

  const read = readWav(file);
  assert.equal(read.channels, 2);
  assert.equal(read.seconds.toFixed(2), '1.00');
  assert.deepEqual(read.pcm, stereo);
});

// A full disk fails every write from here on. Throwing would come back out
// through the IPC handler that delivers PCM, where nobody catches it.
test('WavWriter keeps what it has and reports the failure instead of throwing', () => {
  const file = tmpFile('doomed.wav');
  const writer = new WavWriter(file, { sampleRate: RATE, channels: 1 });
  writer.write(tone(0.5));
  const kept = writer.dataBytes;

  // Stand in for the disk filling up: close the descriptor under the writer.
  fs.closeSync(writer.fd);

  assert.doesNotThrow(() => writer.write(tone(0.5)));
  assert.ok(writer.error, 'the caller has to be able to tell that it stopped');
  assert.equal(writer.dataBytes, kept, 'the failed write must not be counted');
  assert.equal(writer.fd, null, 'a writer that cannot write is closed, not left half open');

  // Every later write is a no-op rather than a second failure.
  assert.doesNotThrow(() => writer.write(tone(0.1)));
  assert.equal(writer.close().error, writer.error);
});

test('readWav recovers a recording whose header was never patched after a failure', () => {
  const file = tmpFile('cut-short.wav');
  const writer = new WavWriter(file, { sampleRate: RATE, channels: 1 });
  const pcm = tone(0.75);
  writer.write(pcm);
  fs.closeSync(writer.fd);
  writer.write(tone(0.1)); // fails, and closes without being able to patch

  // The bytes are on disk even though the length field is still zero.
  assert.equal(readWav(file).pcm.length, pcm.length);
});
