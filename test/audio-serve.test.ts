import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { monoSize, monoStream, parseRange, wavLayout } from '../src/main/audio-serve';
import { buildWav, downmix, readWav } from '../src/main/wav';

// The reader's player reads a meeting's audio a byte range at a time, as mono,
// from a file that is stereo on disk. Every range a media element can ask for
// has to map back onto the right samples, or seeking lands in the wrong place.

function tmpFile(t: test.TestContext, name: string, data: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

/** Interleaved stereo with a distinct value in every sample, so any misalignment shows. */
function stereo(frames: number): Buffer {
  const pcm = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) {
    pcm.writeInt16LE((f % 1000) - 500, f * 4);
    pcm.writeInt16LE(((f * 7) % 1000) - 500, f * 4 + 2);
  }
  return pcm;
}

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

test('parseRange handles the forms a media element sends', () => {
  assert.equal(parseRange(null, 1000), null);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'an end past the file is clamped');
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=500-100', 1000), 'invalid');
  assert.equal(parseRange('bytes=-', 1000), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null, 'a multi-range is answered with the whole file');
});

test('a stereo recording is served as the mono WAV its downmix would be', async (t) => {
  const pcm = stereo(40_000); // more than one read step
  const file = tmpFile(t, 'audio.wav', buildWav(pcm, 16000, 2));
  const layout = await wavLayout(file);
  assert.deepEqual(layout, { dataOffset: 44, dataBytes: pcm.length, channels: 2, sampleRate: 16000 });
  assert.ok(layout);

  const size = monoSize(layout);
  const whole = await read(monoStream(file, layout, 0, size - 1));
  assert.equal(whole.length, size);
  assert.deepEqual(whole, buildWav(downmix(pcm, 2), 16000, 1), 'byte for byte the downmixed file');

  const back = tmpFile(t, 'mono.wav', whole);
  assert.equal(readWav(back).channels, 1);
});

test('every range, including ones that split a sample, is the matching slice', async (t) => {
  const pcm = stereo(40_000);
  const file = tmpFile(t, 'audio.wav', buildWav(pcm, 16000, 2));
  const layout = await wavLayout(file);
  assert.ok(layout);
  const whole = buildWav(downmix(pcm, 2), 16000, 1);

  const ranges: [number, number][] = [
    [0, 10],
    [20, 60],
    [44, 45],
    [45, 46],
    [1001, 70_003],
    [65_579, 65_580],
    [whole.length - 3, whole.length - 1],
  ];
  for (const [start, end] of ranges) {
    const got = await read(monoStream(file, layout, start, end));
    assert.deepEqual(got, whole.subarray(start, end + 1), `bytes ${start}-${end}`);
  }
});

test('a file whose header was never patched still plays', async (t) => {
  const pcm = stereo(1000);
  const wav = buildWav(pcm, 16000, 2);
  wav.writeUInt32LE(0, 40); // a writer that died before closing
  const file = tmpFile(t, 'audio.wav', wav);
  const layout = await wavLayout(file);
  assert.equal(layout?.dataBytes, pcm.length, 'the file length stands in for the missing size');
});

test('a mono recording passes straight through', async (t) => {
  const pcm = stereo(500); // any bytes will do as mono samples
  const file = tmpFile(t, 'audio.wav', buildWav(pcm, 16000, 1));
  const layout = await wavLayout(file);
  assert.ok(layout);
  const got = await read(monoStream(file, layout, 0, monoSize(layout) - 1));
  assert.deepEqual(got, buildWav(pcm, 16000, 1));
});

test('something that is not a WAV is refused', async (t) => {
  assert.equal(await wavLayout(tmpFile(t, 'audio.wav', Buffer.from('RIFF'))), null);
  assert.equal(await wavLayout(tmpFile(t, 'audio.wav', Buffer.from('not audio at all, just text'))), null);
});
