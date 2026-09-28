// Serves a meeting's audio to the reader's player, as mono, a byte range at a
// time.
//
// The reader plays audio.wav in place so "did they really say that?" is one
// click on a transcript line rather than opening the file in another app and
// scrubbing. It arrives over the `meeting-audio:` protocol registered in
// ipc/library.ts — never `file:`, which would let the page name any path — and
// the handler resolves only a meeting id, through library.openTarget.
//
// A two-channel recording keeps the microphone on the left and the call on the
// right. That is the right layout for transcription and the wrong one for
// listening: in headphones every speaker comes from one ear. So what is served
// is a mono WAV, downmixed on the fly with the same `downmix` the live preview
// uses, and a Range request is mapped from the mono file the player sees back
// onto the stereo file on disk. Nothing is written; an hour of stereo is never
// read into memory.
//
// Pure fs and streams, no Electron, so it is tested directly.

import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';

import { BYTES_PER_SAMPLE, HEADER_BYTES, buildHeader, downmix } from './wav';

/** The protocol the reader's <audio> element loads a meeting from. */
export const AUDIO_SCHEME = 'meeting-audio';

/** How much of the source is read per step while streaming. */
const STEP_FRAMES = 32 * 1024;

/** Where the samples are in a WAV on disk, and how they are laid out. */
export interface WavLayout {
  dataOffset: number;
  dataBytes: number;
  channels: number;
  sampleRate: number;
}

/**
 * Reads a WAV's header to find its samples.
 *
 * Walks the chunks rather than assuming 44 bytes, so a file some other tool
 * rewrote still plays. A writer that died before patching the header leaves a
 * data size of 0 or one past the end; the file's own length is the truth then.
 *
 * @returns null when the file is not 16-bit PCM WAV
 */
export async function wavLayout(file: string): Promise<WavLayout | null> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, 'r');
    const size = (await handle.stat()).size;
    const buf = Buffer.alloc(Math.min(size, 4096));
    await handle.read(buf, 0, buf.length, 0);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

    let channels = 0;
    let sampleRate = 0;
    let bits = 0;
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const chunk = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ' && body + 16 <= buf.length) {
        channels = buf.readUInt16LE(body + 2);
        sampleRate = buf.readUInt32LE(body + 4);
        bits = buf.readUInt16LE(body + 14);
      } else if (id === 'data') {
        if (bits !== 16 || !channels || !sampleRate) return null;
        const avail = size - body;
        const bytes = chunk > 0 && chunk <= avail ? chunk : avail;
        const frame = channels * BYTES_PER_SAMPLE;
        return { dataOffset: body, dataBytes: bytes - (bytes % frame), channels, sampleRate };
      }
      off = body + chunk + (chunk % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Bytes in the mono file the player is shown: a fresh header and one channel of samples. */
export const monoSize = (layout: WavLayout): number =>
  HEADER_BYTES + (layout.dataBytes / layout.channels / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;

/**
 * An HTTP Range header, resolved against a file of `size` bytes.
 *
 * Only the single-range forms a media element sends: `bytes=a-b`, `bytes=a-`
 * and `bytes=-n`. A multi-range request is served whole rather than refused —
 * a player never sends one, and answering with the full file is always valid.
 *
 * @returns null for "the whole file", 'invalid' for a range that cannot be met
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (!a && !b) return 'invalid';
  let start: number;
  let end: number;
  if (!a) {
    // A suffix: the last n bytes.
    const n = Number(b);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

/**
 * Bytes `start`..`end` (inclusive) of the mono WAV, read from the file on disk.
 *
 * The header is synthesised; the samples are read a step at a time from the
 * source and folded to one channel, then trimmed to the exact bytes asked for
 * — a range can begin or end halfway through a sample.
 */
export function monoStream(file: string, layout: WavLayout, start: number, end: number): Readable {
  const header = buildHeader(monoSize(layout) - HEADER_BYTES, layout.sampleRate, 1);
  const frameBytes = layout.channels * BYTES_PER_SAMPLE;

  async function* chunks(): AsyncGenerator<Buffer> {
    if (start < HEADER_BYTES) yield header.subarray(start, Math.min(end + 1, HEADER_BYTES));
    if (end < HEADER_BYTES) return;

    // Output byte positions within the mono data.
    const from = Math.max(start, HEADER_BYTES) - HEADER_BYTES;
    const to = end - HEADER_BYTES; // inclusive
    const firstFrame = Math.floor(from / BYTES_PER_SAMPLE);
    const lastFrame = Math.floor(to / BYTES_PER_SAMPLE);

    const handle = await fsp.open(file, 'r');
    try {
      for (let frame = firstFrame; frame <= lastFrame; frame += STEP_FRAMES) {
        const count = Math.min(STEP_FRAMES, lastFrame - frame + 1);
        const raw = Buffer.alloc(count * frameBytes);
        const { bytesRead } = await handle.read(raw, 0, raw.length, layout.dataOffset + frame * frameBytes);
        let mono = downmix(raw.subarray(0, bytesRead - (bytesRead % frameBytes)), layout.channels);
        // The first and last steps may start or end mid-sample.
        const lo = frame === firstFrame ? from - firstFrame * BYTES_PER_SAMPLE : 0;
        const hi = frame + count - 1 === lastFrame ? to - frame * BYTES_PER_SAMPLE + 1 : mono.length;
        mono = mono.subarray(lo, Math.min(hi, mono.length));
        if (mono.length) yield mono;
        if (bytesRead < raw.length) return; // the file is shorter than its header said
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return Readable.from(chunks());
}
