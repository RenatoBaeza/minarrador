'use strict';

// Main-process side of audio capture: owns the hidden renderer, writes PCM to
// disk as it arrives, and watches idle levels to spot a meeting starting.

const { BrowserWindow, ipcMain, desktopCapturer, session, webContents } = require('electron');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const log = require('./logger');
const { WavWriter, buildWav } = require('./wav');
const { Ollama } = require('./ollama');

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono

/**
 * How much audio each live-transcript request covers, and therefore the floor
 * on how stale a subtitle line is when it appears.
 *
 * Measured on gemma4:12b, a request costs ~1s almost regardless of window
 * length — the cost is per-request overhead, not audio length — so a short
 * window is nearly free and this sits well inside a 20% duty cycle. Much below
 * ~4s the model starts getting too little context to transcribe well.
 */
const LIVE_WINDOW_SECONDS = 5;
/**
 * Hard ceiling on buffered live audio. Without this the queue grows for the
 * whole meeting whenever the model cannot keep up (~115 MB/hour), so old audio
 * is dropped rather than allowed to accumulate.
 */
const LIVE_MAX_SECONDS = 60;

const RENDERER = path.join(__dirname, '..', 'renderer');

/**
 * webContents ids allowed to open a microphone or screen-audio stream.
 *
 * The permission handlers below are installed on the default session, which
 * every window shares. Gating on an explicit allow-list means only the capture
 * worker can reach a capture device — a future window (or anything loaded into
 * one) cannot silently open the mic.
 */
const mediaClients = new Set();

/**
 * Fires 'speech' when the room has been consistently audible for a while.
 *
 * Levels arrive ~5x/second. We require a clear majority of a rolling window to
 * be above the floor, which ignores a notification chime but catches a
 * conversation within ~15 seconds.
 */
class SpeechDetector extends EventEmitter {
  constructor({ windowSeconds = 15, ratio = 0.55, floorRms = 0.006, cooldownMs = 10 * 60 * 1000 } = {}) {
    super();
    this.size = Math.round((windowSeconds * 1000) / 200);
    this.ratio = ratio;
    this.floorRms = floorRms;
    this.cooldownMs = cooldownMs;
    this.samples = [];
    this.mutedUntil = 0;
  }

  reset() {
    this.samples.length = 0;
  }

  /** Silences suggestions for the cooldown period (or a custom duration). */
  snooze(ms = this.cooldownMs) {
    this.mutedUntil = Date.now() + ms;
    this.reset();
  }

  push({ mic = 0, system = 0 }) {
    // Either source counts: someone talking in the room, or audio from a call.
    const loud = Math.max(mic, system) >= this.floorRms;
    this.samples.push(loud ? 1 : 0);
    if (this.samples.length > this.size) this.samples.shift();
    if (this.samples.length < this.size) return;
    if (Date.now() < this.mutedUntil) return;

    const active = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    if (active >= this.ratio) {
      this.snooze();
      this.emit('speech', { activity: active });
    }
  }
}

/**
 * Buffers recorded PCM and turns it into rough live transcript lines.
 *
 * Deliberately independent of the post-recording pipeline: this is a preview
 * for the person in the meeting, and dropping audio under load is preferable
 * to falling behind. The saved WAV is always transcribed properly afterwards.
 *
 * @fires LiveTranscriber#text
 */
class LiveTranscriber extends EventEmitter {
  /** @param {{ ollama: Ollama }} deps */
  constructor({ ollama }) {
    super();
    this.ollama = ollama;
    this.enabled = false;
    this.model = '';
    this.language = '';
    this.chunks = [];
    this.bytes = 0;
    this.busy = false;
    this.timer = null;
  }

  /** @param {{ enabled?: boolean, model?: string, language?: string }} cfg */
  configure(cfg = {}) {
    if ('enabled' in cfg) this.enabled = Boolean(cfg.enabled);
    if ('model' in cfg) this.model = cfg.model ?? '';
    if ('language' in cfg) this.language = cfg.language ?? '';
    if (!this.enabled) this.stop();
  }

  get active() {
    return this.enabled && Boolean(this.model) && this.timer !== null;
  }

  start() {
    if (!this.enabled || !this.model || this.timer) return;
    this.reset();
    this.timer = setInterval(() => void this.drain(), LIVE_WINDOW_SECONDS * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.reset();
  }

  reset() {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  /** @param {Buffer} buf 16-bit mono PCM at SAMPLE_RATE */
  push(buf) {
    if (!this.timer) return;
    this.chunks.push(buf);
    this.bytes += buf.length;
    // Drop the oldest audio rather than letting a slow model grow the queue.
    while (this.bytes > LIVE_MAX_SECONDS * BYTES_PER_SECOND && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift().length;
    }
  }

  /** Sends everything buffered so far as one request. Driven by the timer. */
  async drain() {
    // One request in flight at a time; audio keeps buffering (bounded) meanwhile.
    if (this.busy || !this.model || this.bytes < BYTES_PER_SECOND) return;
    this.busy = true;
    const pcm = Buffer.concat(this.chunks, this.bytes);
    const seconds = this.bytes / BYTES_PER_SECOND;
    this.reset();

    try {
      const text = await this.ollama.transcribe(this.model, buildWav(pcm, SAMPLE_RATE), {
        language: this.language || undefined,
        seconds,
      });
      if (text) this.emit('text', text);
    } catch (err) {
      // A live preview is best-effort; the recording itself is unaffected.
      log.warn('live transcription failed:', err.message);
    } finally {
      this.busy = false;
    }
  }
}

class CaptureController extends EventEmitter {
  /** @param {{ ollamaHost?: string }} [options] */
  constructor({ ollamaHost } = {}) {
    super();
    this.window = null;
    this.writer = null;
    this.status = { micOk: false, systemOk: false, micError: '', systemError: '', running: false };
    this.levels = { mixed: 0, mic: 0, system: 0 };
    this.detector = new SpeechDetector();
    this.ollama = new Ollama(ollamaHost);
    this.liveTranscriber = new LiveTranscriber({ ollama: this.ollama });
    this.detector.on('speech', (info) => this.emit('speech', info));
    this.liveTranscriber.on('text', (text) => this.emit('transcript', text));
    this.monitoring = false;
    this._quitting = false;
  }

  /** Grants screen-audio loopback without showing a picker. */
  static installMediaHandlers() {
    const ses = session.defaultSession;

    ses.setDisplayMediaRequestHandler(
      async (request, callback) => {
        if (!isMediaClient(request?.frame)) {
          log.warn('denied a display-media request from an unrecognised frame');
          return callback({});
        }
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen'] });
          if (!sources.length) return callback({});
          // 'loopback' mixes everything the system is playing, and keeps
          // playing it through the speakers (unlike 'loopbackWithMute').
          callback({ video: sources[0], audio: 'loopback' });
        } catch (err) {
          log.error('display media request failed', err);
          callback({});
        }
      },
      { useSystemPicker: false },
    );

    const allow = new Set(['media', 'audioCapture', 'display-capture']);
    ses.setPermissionRequestHandler((wc, permission, callback) =>
      callback(allow.has(permission) && mediaClients.has(wc.id)),
    );
    ses.setPermissionCheckHandler((wc, permission) => allow.has(permission) && mediaClients.has(wc?.id));
  }

  async init() {
    ipcMain.on('capture:pcm', (event, arrayBuffer) => {
      // Only the capture worker feeds the recording.
      if (event.sender.id !== this.window?.webContents.id) return;
      const buf = Buffer.from(arrayBuffer);
      if (this.writer) {
        this.writer.write(buf);
        this.liveTranscriber.push(buf);
      }
    });

    ipcMain.on('capture:level', (event, levels) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.levels = levels;
      if (this.monitoring && !this.writer) this.detector.push(levels);
      this.emit('levels', levels);
    });

    ipcMain.on('capture:status', (event, status) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.status = { ...this.status, ...status };
      if (status.fatal) log.error('capture fatal:', status.fatal);
      else if (status.micError || status.systemError) {
        log.warn('capture sources —', `mic: ${status.micError || 'ok'};`, `system: ${status.systemError || 'ok'}`);
      }
      this.emit('status', this.status);
    });

    this.window = new BrowserWindow({
      show: false,
      width: 420,
      height: 320,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(RENDERER, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    mediaClients.add(this.window.webContents.id);

    // Nothing in this window is user-facing; never let it appear.
    this.window.on('close', (e) => {
      if (!this._quitting) e.preventDefault();
    });

    // The audio graph lives in the renderer, so its console is where capture
    // problems surface. Mirror it into the log file.
    this.window.webContents.on('console-message', (e) => {
      const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : null;
      if (level) log[level](`renderer: ${e.message}`);
    });

    await this.window.loadFile(path.join(RENDERER, 'capture.html'));
  }

  /** Opens (or closes) the audio graph. Required before recording. */
  setActive(active, config = {}) {
    this.monitoring = active;
    if (!active) this.detector.reset();
    this.window?.webContents.send('capture:configure', { active, ...config });
  }

  /**
   * Points the live preview at a model, or turns it off.
   * @param {{ enabled?: boolean, model?: string, language?: string }} cfg
   */
  configureLive(cfg) {
    this.liveTranscriber.configure(cfg);
    if (this.isRecording && this.liveTranscriber.enabled) this.liveTranscriber.start();
  }

  get isRecording() {
    return Boolean(this.writer);
  }

  get elapsedSeconds() {
    return this.writer ? this.writer.seconds : 0;
  }

  startRecording(filePath) {
    if (this.writer) return;
    this.writer = new WavWriter(filePath, { sampleRate: SAMPLE_RATE, channels: 1 });
    this.detector.reset();
    this.liveTranscriber.start();
    this.window?.webContents.send('capture:setRecording', true);
    log.info('recording ->', filePath);
  }

  stopRecording() {
    if (!this.writer) return null;
    this.window?.webContents.send('capture:setRecording', false);
    this.liveTranscriber.stop();
    // Let the worklet's final flush land before we patch the header.
    const writer = this.writer;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.writer = null;
        const result = writer.close();
        // Suppress the "audio detected" nudge right after a session ends.
        this.detector.snooze(2 * 60 * 1000);
        log.info(`stopped: ${result.seconds.toFixed(1)}s, ${result.bytes} bytes`);
        resolve(result);
      }, 500);
    });
  }

  destroy() {
    this._quitting = true;
    this.liveTranscriber.stop();
    if (this.writer) {
      this.writer.close();
      this.writer = null;
    }
    if (this.window && !this.window.isDestroyed()) {
      mediaClients.delete(this.window.webContents.id);
      this.window.destroy();
    }
    this.window = null;
  }
}

/** Resolves a display-media request back to a registered capture client. */
function isMediaClient(frame) {
  if (!frame) return false;
  try {
    const wc = webContents.fromFrame(frame);
    return Boolean(wc && mediaClients.has(wc.id));
  } catch {
    return false;
  }
}

module.exports = { CaptureController, SpeechDetector, LiveTranscriber };
