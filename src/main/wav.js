'use strict';

// 16-bit PCM WAV helpers. The app records mono 16 kHz because that is what the
// Ollama audio models want, and it keeps an hour of meeting under ~115 MB.

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
    this.fd = fs.openSync(filePath, 'w');
    fs.writeSync(this.fd, buildHeader(0, sampleRate, channels));
  }

  write(buf) {
    if (this.fd === null || !buf || buf.length === 0) return;
    fs.writeSync(this.fd, buf);
    this.dataBytes += buf.length;
  }

  get seconds() {
    return this.dataBytes / (this.sampleRate * this.channels * BYTES_PER_SAMPLE);
  }

  close() {
    if (this.fd === null) return { bytes: this.dataBytes, seconds: this.seconds };
    // Patch the two length fields now that the total is known.
    const header = buildHeader(this.dataBytes, this.sampleRate, this.channels);
    fs.writeSync(this.fd, header, 0, HEADER_BYTES, 0);
    fs.closeSync(this.fd);
    this.fd = null;
    return { bytes: this.dataBytes, seconds: this.seconds };
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
 * Splits PCM into ~targetSeconds pieces, nudging each cut to the quietest spot
 * within searchSeconds so we rarely slice a word in half.
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
      startSeconds: start / bytesPerSec,
      endSeconds: end / bytesPerSec,
    });
    start = end;
  }
  return chunks;
}

module.exports = { WavWriter, buildWav, readWav, rms, splitIntoChunks, HEADER_BYTES };
