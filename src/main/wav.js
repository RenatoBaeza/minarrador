'use strict';

// 16-bit PCM WAV helpers. The app records at 16 kHz because that is what the
// Ollama audio models want, and it keeps an hour of mono meeting under ~115 MB.
//
// A meeting with both sources live is recorded as two channels — left is the
// microphone, right is everything the system played — which is what lets the
// pipeline transcribe each side separately and attribute a line to a speaker.
// Everything here is therefore channel-aware: `deinterleave` pulls the two
// sides apart for transcription, and `downmix` puts them back together for the
// jobs that only want to know whether anyone was talking.

const fs = require('node:fs');

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

function buildHeader(dataBytes, sampleRate, channels) {
  const h = Buffer.alloc(HEADER_BYTES);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM fmt chunk size
  h.writeUInt16LE(1, 20); // format: PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Wraps a raw PCM buffer into a self-contained WAV file buffer. */
function buildWav(pcm, sampleRate = 16000, channels = 1) {
  return Buffer.concat([buildHeader(pcm.length, sampleRate, channels), pcm]);
}

/**
 * Streams PCM to disk as it arrives, so a crash mid-meeting still leaves a
 * playable file once the header is patched (and mostly-playable even if not).
 */
class WavWriter {
  constructor(filePath, { sampleRate = 16000, channels = 1 } = {}) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.dataBytes = 0;
    /** What stopped the file being written, or '' while it still is. */
    this.error = '';
    this.fd = fs.openSync(filePath, 'w');
    fs.writeSync(this.fd, buildHeader(0, sampleRate, channels));
  }

  /**
   * Appends PCM, and gives up on the file rather than throwing if it cannot.
   *
   * A full disk fails this write and every one after it. Throwing would come
   * back out through the IPC handler that delivers PCM, where there is nobody
   * to catch it — so instead the minutes already on disk are sealed with a
   * correct header and `error` is left for the caller to notice and report. A
   * truncated meeting that plays is worth more than a longer one that does not.
   */
  write(buf) {
    if (this.fd === null || !buf || buf.length === 0) return;
    try {
      fs.writeSync(this.fd, buf);
      this.dataBytes += buf.length;
    } catch (err) {
      this.error = err.message;
      this.close();
    }
  }

  get seconds() {
    return this.dataBytes / (this.sampleRate * this.channels * BYTES_PER_SAMPLE);
  }

  close() {
    if (this.fd === null) return { bytes: this.dataBytes, seconds: this.seconds, error: this.error };
    try {
      // Patch the two length fields now that the total is known.
      const header = buildHeader(this.dataBytes, this.sampleRate, this.channels);
      fs.writeSync(this.fd, header, 0, HEADER_BYTES, 0);
    } catch (err) {
      // Whatever broke the body will usually break this too. readWav already
      // recovers a file whose header was never patched, so the audio survives.
      this.error = this.error || err.message;
    }
    try {
      fs.closeSync(this.fd);
    } catch {
      /* the descriptor is going away with the process either way */
    }
    this.fd = null;
    return { bytes: this.dataBytes, seconds: this.seconds, error: this.error };
  }
}

/** Reads a PCM WAV, walking the chunk list rather than assuming a 44-byte header. */
function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a RIFF/WAVE file: ${filePath}`);
  }
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let pcm = Buffer.alloc(0);

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // A writer that died before patching the header leaves size 0 or bogus.
      const avail = buf.length - body;
      pcm = buf.subarray(body, body + (size > 0 && size <= avail ? size : avail));
      break;
    }
    off = body + size + (size % 2);
  }
  if (bits !== 16) throw new Error(`Expected 16-bit PCM, got ${bits}-bit`);
  return { pcm, sampleRate, channels, seconds: pcm.length / (sampleRate * channels * BYTES_PER_SAMPLE) };
}

/** Whole frames in an interleaved buffer, ignoring a truncated tail frame. */
const frameCount = (pcm, channels) => Math.floor(pcm.length / (channels * BYTES_PER_SAMPLE));

/**
 * Pulls interleaved PCM apart into one mono buffer per channel.
 *
 * This is what makes a two-channel recording worth having: the microphone track
 * and the system-audio track are transcribed separately, so every line already
 * knows who said it without anyone having to say a name out loud.
 *
 * @returns {Buffer[]} one buffer per channel, all the same length
 */
function deinterleave(pcm, channels) {
  if (channels <= 1) return [pcm];
  const frames = frameCount(pcm, channels);
  const out = Array.from({ length: channels }, () => Buffer.alloc(frames * BYTES_PER_SAMPLE));
  for (let f = 0; f < frames; f++) {
    const from = f * channels * BYTES_PER_SAMPLE;
    for (let c = 0; c < channels; c++) {
      out[c].writeInt16LE(pcm.readInt16LE(from + c * BYTES_PER_SAMPLE), f * BYTES_PER_SAMPLE);
    }
  }
  return out;
}

/**
 * Folds interleaved PCM down to one channel.
 *
 * Summed rather than averaged, and clamped: each channel holds one side of the
 * conversation with near-silence where the other side is talking, so averaging
 * would halve every voice to protect against an overlap that is mostly rare.
 */
function downmix(pcm, channels) {
  if (channels <= 1) return pcm;
  const frames = frameCount(pcm, channels);
  const out = Buffer.alloc(frames * BYTES_PER_SAMPLE);
  for (let f = 0; f < frames; f++) {
    const from = f * channels * BYTES_PER_SAMPLE;
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE(from + c * BYTES_PER_SAMPLE);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), f * BYTES_PER_SAMPLE);
  }
  return out;
}

/** Root-mean-square of a PCM slice, normalised to 0..1. */
function rms(pcm, from = 0, to = pcm.length) {
  const start = from - (from % 2);
  const end = Math.min(to - (to % 2), pcm.length - (pcm.length % 2));
  const n = (end - start) / 2;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 2) {
    const s = pcm.readInt16LE(i) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Root-mean-square of one channel of interleaved PCM, without pulling the whole
 * buffer apart first.
 *
 * Which of the two sides of a conversation is talking is asked once per 256 ms
 * buffer while a meeting runs, so it is worth not allocating for.
 */
function channelRms(pcm, channels, channel) {
  if (channels <= 1) return rms(pcm);
  const frames = frameCount(pcm, channels);
  if (frames <= 0) return 0;
  const stride = channels * BYTES_PER_SAMPLE;
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    const s = pcm.readInt16LE(f * stride + channel * BYTES_PER_SAMPLE) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / frames);
}

/**
 * Splits mono PCM into ~targetSeconds pieces, nudging each cut to the quietest
 * spot within searchSeconds so we rarely slice a word in half.
 *
 * Each chunk carries its byte offsets as well as its audio. A stereo recording
 * is chunked once, on the downmix — so both channels are cut in the same place,
 * at a moment when *nobody* was talking — and the offsets are what let each
 * channel be sliced to the boundaries that decision produced.
 */
function splitIntoChunks(pcm, sampleRate, targetSeconds = 60, searchSeconds = 4) {
  const bytesPerSec = sampleRate * BYTES_PER_SAMPLE;
  const target = Math.max(1, Math.round(targetSeconds * bytesPerSec));
  const search = Math.round(searchSeconds * bytesPerSec);
  const window = Math.round(0.1 * bytesPerSec); // energy probe width

  const chunks = [];
  let start = 0;
  while (start < pcm.length) {
    let end = start + target;
    if (end >= pcm.length) {
      end = pcm.length;
    } else {
      // Probe a window either side of the nominal cut for the quietest moment.
      const lo = Math.max(start + Math.round(target * 0.5), end - search);
      const hi = Math.min(pcm.length, end + search);
      let best = end;
      let bestEnergy = Infinity;
      for (let p = lo; p + window <= hi; p += window) {
        const e = rms(pcm, p, p + window);
        if (e < bestEnergy) {
          bestEnergy = e;
          best = p + Math.floor(window / 2);
        }
      }
      end = best - (best % 2);
    }
    chunks.push({
      pcm: pcm.subarray(start, end),
      start,
      end,
      startSeconds: start / bytesPerSec,
      endSeconds: end / bytesPerSec,
    });
    start = end;
  }
  return chunks;
}

module.exports = {
  WavWriter,
  buildWav,
  readWav,
  rms,
  channelRms,
  splitIntoChunks,
  deinterleave,
  downmix,
  HEADER_BYTES,
  BYTES_PER_SAMPLE,
};
