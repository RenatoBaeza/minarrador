'use strict';

// Main-process side of audio capture: owns the hidden renderer, writes PCM to
// disk as it arrives, and watches idle levels to spot a meeting starting.

const { BrowserWindow, ipcMain, desktopCapturer, session, webContents } = require('electron');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const log = require('./logger');
const { WavWriter, buildWav, rms, channelRms, downmix } = require('./wav');
const { Ollama } = require('./ollama');

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono

/**
 * How the live transcriber cuts the stream into requests, per engine.
 *
 * Segments end at a pause rather than on a fixed clock, so a line arrives as
 * soon as the speaker stops instead of whenever the next window happens to
 * close, and words are not sliced in half at the boundary. `maxSeconds` forces
 * a cut through someone who never pauses.
 *
 * whisper.cpp decodes several seconds of speech in a fraction of a second, so it
 * can afford short segments — that is what makes the preview keep up with the
 * room. An audio LLM costs ~1s per request almost regardless of clip length (the
 * cost is per-request overhead, not audio length), and gets too little context
 * to transcribe well much below ~4s, so it waits for more.
 */
const LIVE_SEGMENT = {
  whisper: { minSeconds: 1, maxSeconds: 12, silenceHoldMs: 600 },
  ollama: { minSeconds: 4, maxSeconds: 20, silenceHoldMs: 900 },
};
/** How often a segment boundary is checked for. Well under human pause length. */
const LIVE_POLL_MS = 250;
/**
 * Hard ceiling on buffered live audio, and so on how far behind the speaker a
 * line can be. Without a ceiling the queue grows for the whole meeting whenever
 * the model cannot keep up (~115 MB/hour); with a loose one it grows until each
 * request covers a minute of audio and the preview trails the room by that long.
 * Old audio is dropped instead — the saved WAV is transcribed in full afterwards.
 */
const LIVE_MAX_SECONDS = 20;
/**
 * Windows quieter than this are room tone. Sending them anyway invites the model
 * to hallucinate a line out of nothing, which is the usual source of junk
 * subtitles during a pause. Matches SILENCE_RMS in pipeline.js.
 */
const LIVE_SILENCE_RMS = 0.004;
/** How much of the previous line whisper is given as decoder context. */
const LIVE_PROMPT_CHARS = 300;

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
 * Fires 'silence' when a recording has heard nothing for a long stretch.
 *
 * SpeechDetector inverted, and for the opposite problem: that one exists to
 * notice a meeting starting, this one to notice one that ended without anybody
 * pressing Stop. Nothing else in the app would — there is no duration cap on
 * the audio graph, so a recording left running on a Friday is still running on
 * Monday, and the pipeline then spends the morning on a multi-hour WAV of an
 * empty room.
 *
 * Fires once per arming: the meeting is being stopped, and a second event on
 * the way down would only race the first.
 */
class SilenceDetector extends EventEmitter {
  /** @param {{ minutes?: number, floorRms?: number }} [options] `minutes` 0 disables it. */
  constructor({ minutes = 0, floorRms = 0.006 } = {}) {
    super();
    this.floorRms = floorRms;
    this.quiet = 0;
    this.fired = false;
    this.configure({ minutes });
  }

  configure({ minutes, floorRms } = {}) {
    if (minutes !== undefined) this.minutes = Math.max(0, Number(minutes) || 0);
    if (floorRms !== undefined) this.floorRms = floorRms;
    return this;
  }

  reset() {
    this.quiet = 0;
    this.fired = false;
  }

  /** Levels arrive ~5x/second, the same cadence SpeechDetector is sized for. */
  push({ mic = 0, system = 0 }) {
    if (!this.minutes || this.fired) return;
    if (Math.max(mic, system) >= this.floorRms) {
      this.quiet = 0;
      return;
    }
    this.quiet += 1;
    if (this.quiet * 200 < this.minutes * 60_000) return;
    this.fired = true;
    this.emit('silence', { minutes: this.minutes });
  }
}

/**
 * Buffers recorded PCM and turns it into rough live transcript lines.
 *
 * Deliberately independent of the post-recording pipeline: this is a preview
 * for the person in the meeting, and dropping audio under load is preferable
 * to falling behind. The saved WAV is always transcribed properly afterwards.
 *
 * Two engines can do the transcribing. whisper.cpp is the one that makes this
 * feel live and is preferred whenever it is installed; the Ollama audio model is
 * the fallback for a machine that has never run `npm run whisper:setup`.
 *
 * A two-channel recording is folded back to mono before it is sent. The saved
 * transcript transcribes the two sides separately, which costs a request per
 * speaker per chunk; here that would double the work in the one place with a
 * realtime floor to clear. The speaker is inferred instead, from which channel
 * carried the segment — near enough whenever one person is talking at a time,
 * which is nearly always, and free.
 *
 * @fires LiveTranscriber#text
 */
class LiveTranscriber extends EventEmitter {
  /** @param {{ ollama: Ollama, whisper?: import('./whisper').WhisperServer }} deps */
  constructor({ ollama, whisper = null }) {
    super();
    this.ollama = ollama;
    this.whisper = whisper;
    this.enabled = false;
    /** What the user asked for; `engine` is what is actually usable. */
    this.preferredEngine = 'whisper';
    this.model = '';
    this.language = '';
    /** Layout of the PCM being pushed: 1 mono, or 2 with mic left, system right. */
    this.channels = 1;
    this.chunks = [];
    this.bytes = 0;
    /** Trailing silence, in bytes — how a segment boundary is spotted. */
    this.quietBytes = 0;
    /** Audible audio in the buffer, which is what decides if there is anything to send. */
    this.voicedBytes = 0;
    /** Voiced bytes per channel, which is how a segment is attributed to a side. */
    this.voicedByChannel = [0, 0];
    /** Tail of the last line, handed to whisper as decoder context. */
    this.tail = '';
    this.busy = false;
    this.running = false;
    this.timer = null;
  }

  /**
   * @param {{ enabled?: boolean, engine?: 'whisper'|'ollama', model?: string, language?: string }} cfg
   *   `model` names the Ollama audio model; the whisper model is chosen by the
   *   WhisperServer itself, since it is a file on disk rather than a daemon tag.
   */
  configure(cfg = {}) {
    const was = this.engine;
    const wasModel = this.model;
    if ('enabled' in cfg) this.enabled = Boolean(cfg.enabled);
    if ('engine' in cfg) this.preferredEngine = cfg.engine === 'ollama' ? 'ollama' : 'whisper';
    if ('model' in cfg) this.model = cfg.model ?? '';
    if ('language' in cfg) this.language = cfg.language ?? '';
    if (!this.enabled) this.stop();
    // Swapping engines or models mid-meeting puts us back on a cold one; warm it
    // now rather than on the next window of audio.
    else if (this.running && (this.engine !== was || this.model !== wasModel)) this.#warm();
  }

  /**
   * The engine that will actually run, which is not always the one configured:
   * whisper.cpp is only there once its binary and weights are on disk, and
   * silently falling back beats a preview that stops working.
   */
  get engine() {
    return this.preferredEngine === 'whisper' && this.whisper?.available ? 'whisper' : 'ollama';
  }

  /** Whether the chosen engine has everything it needs to transcribe. */
  get ready() {
    return this.engine === 'whisper' ? Boolean(this.whisper?.available) : Boolean(this.model);
  }

  get active() {
    return this.enabled && this.ready && this.running;
  }

  /** Bytes of buffered audio one second of meeting costs, at the current layout. */
  get bytesPerSecond() {
    return BYTES_PER_SECOND * this.channels;
  }

  /** @param {1|2} [channels] layout of the PCM about to be pushed. */
  start(channels = 1) {
    if (!this.enabled || !this.ready || this.running) return;
    this.channels = channels === 2 ? 2 : 1;
    this.reset();
    this.tail = '';
    this.running = true;
    this.#warm();
    this.#schedule(LIVE_POLL_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.reset();
  }

  reset() {
    this.chunks.length = 0;
    this.bytes = 0;
    this.quietBytes = 0;
    this.voicedBytes = 0;
    this.voicedByChannel = [0, 0];
  }

  /** Loads the engine so the first segment does not also pay for the load. */
  #warm() {
    if (this.engine === 'whisper') {
      // Spawning the server and loading the weights takes seconds; a failure
      // here is reported when the first segment tries to use it.
      this.whisper?.ensureReady?.().catch((err) => log.warn('whisper warm-up failed:', err.message));
    } else {
      void this.ollama.preload?.(this.model);
    }
  }

  #schedule(ms) {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.#tick(), ms);
  }

  /**
   * True once the buffer holds a segment worth sending: enough actual speech in
   * it, and either followed by a pause or long enough that waiting for one would
   * put the caption behind the room.
   *
   * The minimum counts audible audio rather than buffer length. Measured on the
   * whole buffer, a door closing during a quiet meeting clears it on the silence
   * that follows the bang, and a second of near-silence is precisely what a
   * transcription model answers with an invented line.
   */
  get segmentReady() {
    const shape = LIVE_SEGMENT[this.engine];
    const perSecond = this.bytesPerSecond;
    if (this.bytes >= shape.maxSeconds * perSecond) return true;
    if (this.voicedBytes < shape.minSeconds * perSecond) return false;
    return this.quietBytes >= (shape.silenceHoldMs / 1000) * perSecond;
  }

  /** Sends a segment when one is ready, then looks again shortly. */
  async #tick() {
    this.timer = null;
    if (this.segmentReady) await this.drain();
    this.#schedule(LIVE_POLL_MS);
  }

  /** @param {Buffer} buf 16-bit PCM at SAMPLE_RATE, in `channels` channels */
  push(buf) {
    // Gated on `running`, not on the timer handle: there is no timer pending
    // while a request is in flight, and that is exactly when audio must keep
    // accumulating.
    if (!this.running) return;
    this.chunks.push(buf);
    this.bytes += buf.length;
    // Buffers arrive every ~256 ms, which is fine enough to find a pause with.
    // Measured per channel and taken at its loudest: one side of a stereo
    // recording is silent whenever the other is talking, so a mixed reading
    // would put every utterance 3 dB nearer the gate for no reason.
    const levels =
      this.channels === 2 ? [channelRms(buf, 2, 0), channelRms(buf, 2, 1)] : [rms(buf), 0];
    if (Math.max(...levels) < LIVE_SILENCE_RMS) {
      this.quietBytes += buf.length;
    } else {
      this.quietBytes = 0;
      this.voicedBytes += buf.length;
      // Which side was audible, so the finished line can say who was talking.
      for (const c of [0, 1]) if (levels[c] >= LIVE_SILENCE_RMS) this.voicedByChannel[c] += buf.length;
    }
    // Drop the oldest audio rather than letting a slow model grow the queue.
    while (this.bytes > LIVE_MAX_SECONDS * this.bytesPerSecond && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift().length;
    }
    // Dropped audio may have been the speech that was counted; the buffer is the
    // ceiling either way, and over-counting here would send a segment early.
    this.voicedBytes = Math.min(this.voicedBytes, this.bytes);
  }

  /**
   * Which side of the conversation a segment belongs to, or '' when it is not
   * clear enough to claim.
   *
   * A margin rather than a plain comparison: leakage between the two is normal —
   * the microphone hears the speakers, and echo cancellation only mostly
   * removes them — so a side has to have carried most of the segment before its
   * name goes on the line. Guessing wrong is worse than not guessing.
   */
  get segmentSpeaker() {
    if (this.channels !== 2) return '';
    const [mic, system] = this.voicedByChannel;
    if (mic > system * 2) return 'mic';
    if (system > mic * 2) return 'system';
    return '';
  }

  /** Sends everything buffered so far as one request. Driven by #tick. */
  async drain() {
    // One request in flight at a time; audio keeps buffering (bounded) meanwhile.
    if (this.busy || !this.ready || this.bytes < this.bytesPerSecond) return;
    this.busy = true;
    const raw = Buffer.concat(this.chunks, this.bytes);
    const seconds = this.bytes / this.bytesPerSecond;
    const engine = this.engine;
    const speaker = this.segmentSpeaker;
    this.reset();

    try {
      // Nobody spoke: asking the model anyway costs a request and tends to come
      // back as an invented line.
      if (rms(raw) < LIVE_SILENCE_RMS) return;
      // One request for both sides. The channel that carried it is already
      // known, and a second decode would cost the latency this preview exists
      // to keep.
      const pcm = this.channels === 2 ? downmix(raw, 2) : raw;
      const wav = buildWav(pcm, SAMPLE_RATE);
      const text =
        engine === 'whisper'
          ? // The trailing silence that ended the segment is sent along with it:
            // whisper reads it as the end of an utterance and stops cleanly,
            // where a hard cut on the last syllable tends to lose the word.
            await this.whisper.transcribe(wav, { language: this.language || undefined, prompt: this.tail })
          : await this.ollama.transcribe(this.model, wav, {
              language: this.language || undefined,
              seconds,
            });
      if (text) {
        this.tail = text.slice(-LIVE_PROMPT_CHARS);
        this.emit('text', text, speaker);
      }
    } catch (err) {
      // A live preview is best-effort; the recording itself is unaffected.
      log.warn(`live transcription (${engine}) failed:`, err.message);
    } finally {
      this.busy = false;
    }
  }
}

/** How long to wait before rebuilding a worker whose renderer died. */
const RECOVER_DELAY_MS = 1500;
/**
 * How long a deliberate restart leaves the graph down.
 *
 * Long enough for the renderer's async teardown — closing an AudioContext and
 * stopping the device tracks — to finish before the next build starts, since
 * the two share the same module state and an overlap would tear down the graph
 * that had just come up.
 */
const RESTART_DELAY_MS = 600;
/**
 * Consecutive rebuilds before we stop trying.
 *
 * The count resets the moment a rebuilt graph reports itself running, so this
 * only ever bites a renderer that cannot stay up — where retrying forever would
 * spin for the rest of the meeting instead of saying so once.
 */
const MAX_RECOVERIES = 3;

class CaptureController extends EventEmitter {
  /** @param {{ ollamaHost?: string, whisper?: import('./whisper').WhisperServer }} [options] */
  constructor({ ollamaHost, whisper = null } = {}) {
    super();
    this.window = null;
    this.writer = null;
    this.status = { micOk: false, systemOk: false, micError: '', systemError: '', micLabel: '', running: false };
    this.levels = { mixed: 0, mic: 0, system: 0 };
    /** Audio inputs the worker last reported, for the settings pane's picker. */
    this.devices = [];
    this.detector = new SpeechDetector();
    this.silence = new SilenceDetector();
    this.ollama = new Ollama(ollamaHost);
    this.whisper = whisper;
    this.liveTranscriber = new LiveTranscriber({ ollama: this.ollama, whisper });
    this.detector.on('speech', (info) => this.emit('speech', info));
    this.silence.on('silence', (info) => this.emit('silence', info));
    this.liveTranscriber.on('text', (text, speaker) => this.emit('transcript', text, speaker));
    this.monitoring = false;
    this._quitting = false;
    /** Last configuration sent to the renderer, replayed after a rebuild. */
    this.config = { active: false, captureMic: true, captureSystem: true, micDeviceId: '', micDeviceLabel: '' };
    /**
     * Whether a meeting with both sources live is written as two channels.
     *
     * Read at Start and then fixed for that recording: the WAV header declares
     * a layout once, and the file has to keep it.
     */
    this.separateChannels = true;
    this.recoveries = 0;
    this.recoverTimer = null;
    /** Set once when the file stops being writable, so it is reported once. */
    this.writeFailed = false;
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
        // A full disk stops the WAV growing and everything else carries on
        // looking normal — the tray still says Recording, the captions still
        // arrive. Say so once, and let main decide to end the meeting.
        if (this.writer.error && !this.writeFailed) {
          this.writeFailed = true;
          log.error('recording could not be written:', this.writer.error);
          this.emit('writeFailed', { error: this.writer.error, seconds: this.writer.seconds });
        }
        this.liveTranscriber.push(buf);
      }
    });

    ipcMain.on('capture:level', (event, levels) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.levels = levels;
      if (this.monitoring && !this.writer) this.detector.push(levels);
      if (this.writer) this.silence.push(levels);
      this.emit('levels', levels);
    });

    ipcMain.on('capture:devices', (event, devices) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.devices = (Array.isArray(devices) ? devices : [])
        .filter((d) => d && typeof d.id === 'string' && d.id)
        .map((d) => ({ id: d.id, label: String(d.label ?? '') }));
      this.emit('devices', this.devices);
    });

    ipcMain.on('capture:status', (event, status) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.status = { ...this.status, ...status };
      if (status.fatal) log.error('capture fatal:', status.fatal);
      else if (status.micError || status.systemError) {
        log.warn('capture sources —', `mic: ${status.micError || 'ok'};`, `system: ${status.systemError || 'ok'}`);
      }
      // A graph that came back up is proof the rebuild worked, so the next crash
      // starts from a full budget rather than inheriting this one's.
      if (this.status.running) this.recoveries = 0;
      this.emit('status', this.status);
    });

    await this.#createWindow();
  }

  /**
   * Builds the hidden worker that owns the Web Audio graph.
   *
   * Separate from init() because it runs again after a renderer crash, and the
   * IPC handlers above must not be registered twice — a second set would double
   * every PCM buffer into the WAV.
   */
  async #createWindow() {
    const win = new BrowserWindow({
      show: false,
      width: 420,
      height: 320,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(RENDERER, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window = win;
    mediaClients.add(win.webContents.id);

    // Nothing in this window is user-facing; never let it appear.
    win.on('close', (e) => {
      if (!this._quitting) e.preventDefault();
    });

    // The audio graph lives in the renderer, so its console is where capture
    // problems surface. Mirror it into the log file.
    win.webContents.on('console-message', (e) => {
      const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : null;
      if (level) log[level](`renderer: ${e.message}`);
    });

    // The one failure this app cannot afford to miss. Nothing in the main
    // process notices a dead renderer on its own: the writer stays open, the
    // tray still says "Recording", and the WAV simply stops growing — so a
    // meeting ends as a few minutes of audio and no warning.
    win.webContents.on('render-process-gone', (_e, details) => this.#onRendererGone(win, details));

    await win.loadFile(path.join(RENDERER, 'capture.html'));
  }

  /**
   * Rebuilds the worker after its renderer dies, and re-arms it if a meeting was
   * in progress.
   *
   * The audio between the crash and the new graph opening is gone — nothing can
   * recover that — but the WAV is written in the main process and stays intact,
   * so the recording continues into the same file with a gap in it. That is the
   * whole point: the alternative is a meeting that silently stopped recording.
   *
   * @param {import('electron').BrowserWindow} win the window that died
   * @param {{ reason?: string, exitCode?: number }} details
   */
  #onRendererGone(win, details) {
    // Only the live worker counts. Tearing the old window down during a rebuild
    // can raise this same event on it, and acting on that would schedule another
    // rebuild, which would tear down another window, for as long as the app runs.
    if (this._quitting || this.window !== win) return;
    const wasRecording = this.isRecording;
    log.error(`capture renderer gone (${details?.reason ?? 'unknown'}, exit ${details?.exitCode ?? '?'})`, wasRecording ? '— mid-recording' : '');

    this.status = { ...this.status, micOk: false, systemOk: false, running: false };
    this.emit('status', this.status);

    const recovering = ++this.recoveries <= MAX_RECOVERIES;
    this.emit('rendererGone', { ...details, wasRecording, recovering });
    if (!recovering) {
      log.error(`capture renderer failed ${this.recoveries} times in a row; not rebuilding it again`);
      return;
    }

    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      this.#rebuild(wasRecording).catch((err) => log.error('capture renderer rebuild failed', err));
    }, RECOVER_DELAY_MS);
  }

  async #rebuild(wasRecording) {
    if (this._quitting) return;
    log.info('rebuilding the capture worker');
    const dead = this.window;
    this.window = null;
    if (dead && !dead.isDestroyed()) {
      mediaClients.delete(dead.webContents.id);
      dead.destroy();
    }

    await this.#createWindow();
    // Replay what the renderer was told before it died. Re-arming last means a
    // buffer can never arrive for a graph that has not been configured yet.
    this.window.webContents.send('capture:configure', { ...this.config });
    if (wasRecording && this.isRecording) {
      this.window.webContents.send('capture:setRecording', true, this.writer.channels);
      log.info('capture worker rebuilt; recording continues into the same file');
    }
  }

  /**
   * Tears the audio graph down and builds it again.
   *
   * The way back from a graph in an undefined state that has not actually
   * crashed — the machine came back from sleep, or someone pressed Restart
   * Audio Capture. A recording in progress survives it: the WAV is written here
   * in the main process and stays open, so the meeting continues into the same
   * file with a gap where the graph was down, exactly as a renderer crash does.
   */
  restart() {
    if (!this.window || this.window.isDestroyed()) return;
    const wc = this.window.webContents;
    wc.send('capture:configure', { ...this.config, active: false });
    setTimeout(() => {
      if (this._quitting || this.window?.webContents !== wc) return;
      wc.send('capture:configure', { ...this.config });
      // Re-arming is belt and braces: a graph built while a recording is open
      // asks the worklet for the recording state itself. This covers the graph
      // that was already up when the message arrived.
      if (this.isRecording) wc.send('capture:setRecording', true, this.writer.channels);
    }, RESTART_DELAY_MS);
  }

  /** Opens (or closes) the audio graph. Required before recording. */
  setActive(active, config = {}) {
    this.monitoring = active;
    if (!active) this.detector.reset();
    // Remembered so a rebuilt renderer comes back on the same sources.
    this.config = { ...this.config, ...config, active };
    this.window?.webContents.send('capture:configure', { ...this.config });
  }

  /**
   * Points the live preview at an engine, or turns it off.
   * @param {{ enabled?: boolean, engine?: 'whisper'|'ollama', model?: string, language?: string }} cfg
   */
  configureLive(cfg) {
    this.liveTranscriber.configure(cfg);
    if (this.isRecording && this.liveTranscriber.enabled) this.liveTranscriber.start(this.writer.channels);
  }

  get isRecording() {
    return Boolean(this.writer);
  }

  get elapsedSeconds() {
    return this.writer ? this.writer.seconds : 0;
  }

  /**
   * How many channels the next recording should be written in.
   *
   * Two only when there are genuinely two different signals to keep apart. A
   * stereo file with one dead channel is twice the disk for nothing, and the
   * pipeline would spend a pass transcribing silence.
   */
  get recordingChannels() {
    return this.separateChannels && this.status.micOk && this.status.systemOk ? 2 : 1;
  }

  /**
   * @param {string} filePath
   * @param {{ separateChannels?: boolean, silenceMinutes?: number }} [options]
   */
  startRecording(filePath, { separateChannels = true, silenceMinutes = 0 } = {}) {
    if (this.writer) return;
    this.separateChannels = separateChannels;
    const channels = this.recordingChannels;
    this.writeFailed = false;
    this.writer = new WavWriter(filePath, { sampleRate: SAMPLE_RATE, channels });
    this.detector.reset();
    this.silence.configure({ minutes: silenceMinutes }).reset();
    this.liveTranscriber.start(channels);
    this.window?.webContents.send('capture:setRecording', true, channels);
    log.info(`recording -> ${filePath} (${channels === 2 ? 'mic left, system right' : 'mono'})`);
  }

  stopRecording() {
    if (!this.writer) return null;
    this.window?.webContents.send('capture:setRecording', false, this.writer.channels);
    this.liveTranscriber.stop();
    this.silence.reset();
    // Let the worklet's final flush land before we patch the header.
    const writer = this.writer;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.writer = null;
        const result = { ...writer.close(), channels: writer.channels };
        // Suppress the "audio detected" nudge right after a session ends.
        this.detector.snooze(2 * 60 * 1000);
        log.info(`stopped: ${result.seconds.toFixed(1)}s, ${result.bytes} bytes`);
        resolve(result);
      }, 500);
    });
  }

  destroy() {
    this._quitting = true;
    clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    this.liveTranscriber.stop();
    this.whisper?.stop();
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

module.exports = { CaptureController, SpeechDetector, SilenceDetector, LiveTranscriber };
