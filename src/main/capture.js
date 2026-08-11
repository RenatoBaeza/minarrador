'use strict';

// Main-process side of audio capture: owns the hidden renderer, writes PCM to
// disk as it arrives, and watches idle levels to spot a meeting starting.

const { BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const log = require('./logger');
const { WavWriter } = require('./wav');

const RENDERER = path.join(__dirname, '..', 'renderer');

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

class CaptureController extends EventEmitter {
  constructor() {
    super();
    this.window = null;
    this.writer = null;
    this.status = { micOk: false, systemOk: false, micError: '', systemError: '', running: false };
    this.levels = { mixed: 0, mic: 0, system: 0 };
    this.detector = new SpeechDetector();
    this.detector.on('speech', (info) => this.emit('speech', info));
    this.monitoring = false;
  }

  /** Grants screen-audio loopback without showing a picker. */
  static installMediaHandlers() {
    const ses = session.defaultSession;

    ses.setDisplayMediaRequestHandler(
      async (_request, callback) => {
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
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allow.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allow.has(permission));
  }

  async init() {
    ipcMain.on('capture:pcm', (_e, arrayBuffer) => {
      if (this.writer) this.writer.write(Buffer.from(arrayBuffer));
    });

    ipcMain.on('capture:level', (_e, levels) => {
      this.levels = levels;
      if (this.monitoring && !this.writer) this.detector.push(levels);
      this.emit('levels', levels);
    });

    ipcMain.on('capture:status', (_e, status) => {
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

  get isRecording() {
    return Boolean(this.writer);
  }

  get elapsedSeconds() {
    return this.writer ? this.writer.seconds : 0;
  }

  startRecording(filePath) {
    if (this.writer) return;
    this.writer = new WavWriter(filePath, { sampleRate: 16000, channels: 1 });
    this.detector.reset();
    this.window?.webContents.send('capture:setRecording', true);
    log.info('recording ->', filePath);
  }

  stopRecording() {
    if (!this.writer) return null;
    this.window?.webContents.send('capture:setRecording', false);
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
    if (this.writer) {
      this.writer.close();
      this.writer = null;
    }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { CaptureController, SpeechDetector };
