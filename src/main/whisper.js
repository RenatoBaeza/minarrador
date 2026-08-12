'use strict';

// whisper.cpp as the live-transcription engine.
//
// Runs ggml-org/whisper.cpp's HTTP server as a child process and posts short
// windows of recorded audio to it. This is what makes the preview feel live: an
// audio LLM costs roughly a second per request no matter how short the clip,
// while whisper.cpp decodes a few seconds of speech in a fraction of that, so
// segments can be cut at natural pauses and still land while the speaker is
// drawing breath.
//
// The binary and GGML weights are deliberately not in the repository — see
// `npm run whisper:setup`, which fetches them into vendor/whisper (packaged
// builds ship the same tree as resources/whisper). Nothing leaves the machine
// at runtime: the server binds 127.0.0.1 on a port we know is free.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const log = require('./logger');
const { collapseRepeats } = require('./ollama');

const SERVER_EXE = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';

/** Model load is the slow part of a cold start; from disk a large model can crawl. */
const READY_TIMEOUT_MS = 120_000;
/** A live window is seconds of audio. Anything near this means something is wrong. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Nothing well-known lives here, and we verify the port is free before binding. */
const FIRST_PORT = 8178;
const PORT_ATTEMPTS = 20;

class WhisperError extends Error {}

/**
 * How many threads to decode with when the setting says "let whisper decide".
 *
 * whisper-server's own default is four, which is plenty for ggml-base — it clears
 * realtime a dozen times over. It is not enough for the large models, and the
 * difference decides whether the live preview works at all: measured on a
 * 24-thread i9 with the CPU build, large-v3-turbo-q5_0 transcribes 8.7 s of
 * speech at 0.7x realtime on four threads and 1.2x on eight. Below 1x the
 * transcriber can never catch up with the room, so it spends the meeting
 * discarding audio at the LIVE_MAX_SECONDS ceiling.
 *
 * Half the logical cores, capped at eight: enough for the heavy model, while
 * leaving most of the machine to the call being recorded. Someone who wants to
 * trade more of it sets whisperThreads explicitly.
 */
function defaultThreads() {
  const cores = os.cpus()?.length || 4;
  return Math.max(2, Math.min(8, Math.floor(cores / 2)));
}

/**
 * Thread counts worth offering in the menu: the automatic choice, then powers of
 * two the machine can actually field. A 4-core laptop should not be invited to
 * ask for 16 threads.
 */
function threadChoices() {
  const cores = os.cpus()?.length || 4;
  return [0, ...[2, 4, 6, 8, 12, 16, 24, 32].filter((n) => n <= cores)];
}

/**
 * The labels the transcript window offers, mapped to whisper language codes.
 * Anything else falls back to auto-detect rather than failing the request —
 * whisper.cpp rejects an unknown code outright.
 */
const LANGUAGE_CODES = {
  English: 'en',
  Spanish: 'es',
  French: 'fr',
  German: 'de',
  Portuguese: 'pt',
  Italian: 'it',
  Dutch: 'nl',
};

function languageCode(label) {
  const key = String(label ?? '').trim();
  if (!key) return 'auto';
  if (LANGUAGE_CODES[key]) return LANGUAGE_CODES[key];
  return /^[a-z]{2}$/i.test(key) ? key.toLowerCase() : 'auto';
}

/**
 * Where a whisper.cpp install may live, most specific first.
 *
 * `resourcesPath` only exists inside Electron, and only points somewhere real in
 * a packaged build; the vendor directory is what `npm run whisper:setup` fills
 * during development.
 */
function defaultRoots() {
  const roots = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'whisper'));
  roots.push(path.join(__dirname, '..', '..', 'vendor', 'whisper'));
  return roots;
}

/** GGML weights sitting in an install, newest-looking name last. */
function listModels(modelsDir) {
  try {
    return fs
      .readdirSync(modelsDir)
      .filter((name) => name.endsWith('.bin'))
      .sort();
  } catch {
    // No install yet, or no models pulled into it.
    return [];
  }
}

/**
 * Works out which binary and weights to use.
 *
 * @param {{ root?: string, model?: string }} [cfg] `root` replaces discovery
 *   entirely — someone who names an install means that one, and quietly running
 *   a different copy would be the worst way to report a typo. `model` is either
 *   an absolute path or a file name inside the models folder.
 * @returns {{ root: string, binary: string, modelsDir: string, model: string }}
 *   `model` is '' when nothing usable was found — callers report that as "not
 *   installed" rather than spawning a server that would exit immediately.
 */
function resolveInstall({ root = '', model = '' } = {}) {
  const roots = root ? [root] : defaultRoots();
  // Fall back to the last candidate so an uninstalled setup still reports the
  // path it expected, which is the only useful thing to put in an error.
  const chosen = roots.find((dir) => fs.existsSync(path.join(dir, 'bin', SERVER_EXE))) ?? roots.at(-1);
  const modelsDir = path.join(chosen, 'models');

  let resolved;
  const wanted = String(model ?? '').trim();
  if (wanted && path.isAbsolute(wanted) && fs.existsSync(wanted)) {
    resolved = wanted;
  } else if (wanted && fs.existsSync(path.join(modelsDir, path.basename(wanted)))) {
    resolved = path.join(modelsDir, path.basename(wanted));
  } else {
    // A configured model that has since been deleted should still leave the
    // preview working, so take whatever else was pulled.
    const [first] = listModels(modelsDir);
    resolved = first ? path.join(modelsDir, first) : '';
  }

  return { root: chosen, binary: path.join(chosen, 'bin', SERVER_EXE), modelsDir, model: resolved };
}

/** First loopback port from `start` that nothing is holding. */
async function freePort(start = FIRST_PORT, attempts = PORT_ATTEMPTS) {
  for (let port = start; port < start + attempts; port++) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.unref();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new WhisperError(`no free port in ${start}-${start + attempts - 1} for whisper-server`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Servers with a live child process, so a normal quit cannot leave one behind
 * holding a port and a few hundred MB of weights.
 *
 * One hook for the module rather than one per instance: a listener per
 * constructed server trips Node's leak warning once a handful exist, and there
 * is nothing for it to do on a server that never started.
 */
const withChild = new Set();
process.once('exit', () => {
  for (const server of withChild) server.stop();
});

/**
 * Supervises one whisper-server child process and talks to its /inference route.
 *
 * The process is started lazily on the first transcription (or an explicit
 * `ensureReady`, which recording start uses to move the model load off the first
 * caption) and reused for the rest of the session. whisper-server serialises
 * requests behind its own mutex, which matches the one-in-flight discipline the
 * live transcriber already keeps.
 */
class WhisperServer extends EventEmitter {
  /** @param {{ root?: string, model?: string, threads?: number }} [config] */
  constructor(config = {}) {
    super();
    this.threads = 0;
    this.proc = null;
    this.port = 0;
    this.ready = false;
    this.wanted = false;
    this.starting = null;
    this.lastError = '';
    /** Tail of the child's stderr, so a failed start can say why. */
    this.stderrTail = [];
    this.configure(config);
  }

  /**
   * Points at an install and a model. Swapping either drops the running server;
   * the next request brings one back on the new configuration.
   *
   * @param {{ root?: string, model?: string, threads?: number }} [cfg]
   */
  configure(cfg = {}) {
    const install = resolveInstall({
      root: 'root' in cfg ? cfg.root : this.root,
      model: 'model' in cfg ? cfg.model : this.model,
    });
    const threads = 'threads' in cfg ? Math.max(0, Math.round(Number(cfg.threads) || 0)) : this.threads;
    const changed = install.binary !== this.binary || install.model !== this.model || threads !== this.threads;

    this.root = install.root;
    this.binary = install.binary;
    this.modelsDir = install.modelsDir;
    this.model = install.model;
    this.threads = threads;

    if (changed && this.proc) {
      log.info('whisper: configuration changed, restarting the server');
      this.stop();
    }
    return this;
  }

  /** True when there is something to run. Cheap enough to ask per request. */
  get available() {
    return Boolean(this.model) && fs.existsSync(this.binary) && fs.existsSync(this.model);
  }

  get running() {
    return Boolean(this.proc) && this.ready;
  }

  get models() {
    return listModels(this.modelsDir);
  }

  /** The thread count actually handed to the server, resolving 0 to a real one. */
  get effectiveThreads() {
    return this.threads > 0 ? this.threads : defaultThreads();
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Compact view of the engine for the tray and the diagnostics dump. */
  describe() {
    return {
      root: this.root,
      binary: this.binary,
      model: this.model ? path.basename(this.model) : '',
      models: this.models,
      /** 0 means automatic; effectiveThreads is what the server was actually told. */
      threads: this.threads,
      effectiveThreads: this.effectiveThreads,
      threadChoices: threadChoices(),
      available: this.available,
      running: this.running,
      port: this.port || null,
      lastError: this.lastError,
    };
  }

  /**
   * Brings the server up if it is not already, and returns once it answers.
   * Concurrent callers share one start rather than racing to spawn twice.
   */
  async ensureReady() {
    if (this.running) return true;
    if (!this.starting) {
      this.starting = this.#start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async #start() {
    if (!this.available) {
      throw new WhisperError(
        `whisper.cpp is not installed — run "npm run whisper:setup" (looked in ${this.root})`,
      );
    }

    const port = await freePort();
    const args = [
      '--model', this.model,
      '--host', '127.0.0.1',
      '--port', String(port),
      // Live captions are prose, not subtitles: timestamps and non-speech
      // tokens would both have to be stripped back out again.
      '--no-timestamps',
      '--suppress-nst',
      '--language', 'auto',
    ];
    // 0 means "decide for me", which is not the same as letting whisper-server
    // decide — its four-thread default cannot run the large models in realtime.
    args.push('--threads', String(this.effectiveThreads));

    log.info(`whisper: starting ${path.basename(this.binary)} on ${path.basename(this.model)} (port ${port})`);
    const startedAt = Date.now();
    this.stderrTail = [];
    this.wanted = true;

    const proc = spawn(this.binary, args, {
      cwd: path.dirname(this.binary),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.port = port;
    this.ready = false;
    withChild.add(this);

    // Both pipes must be drained or the child blocks once its buffers fill.
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (!line) return;
      this.stderrTail.push(line);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.on('error', (err) => {
      this.lastError = err.message;
      log.error('whisper: could not spawn the server', err);
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return; // already replaced by a restart
      this.proc = null;
      this.ready = false;
      withChild.delete(this);
      if (this.wanted) {
        this.lastError = `whisper-server exited (${signal ?? code})`;
        log.warn(`whisper: ${this.lastError}: ${this.stderrTail.slice(-3).join(' | ')}`);
        this.emit('exit', { code, signal });
      }
    });

    try {
      await this.#waitForServer(proc, port);
    } catch (err) {
      this.lastError = err.message;
      this.stop();
      throw err;
    }

    this.ready = true;
    this.lastError = '';
    log.info(`whisper: ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    this.emit('ready', { port });
    return true;
  }

  /**
   * Polls until the child answers on the port.
   *
   * Any HTTP reply counts, including a 404: the release build ships no static
   * public folder, so the root route need not exist. What matters is that the
   * socket is being served — whisper-server loads the model before it listens,
   * so a reply also means the weights are in memory.
   */
  async #waitForServer(proc, port) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new WhisperError(
          `whisper-server exited during startup: ${this.stderrTail.slice(-3).join(' | ') || 'no output'}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        await res.arrayBuffer(); // release the socket
        return;
      } catch {
        // Not listening yet.
      }
      await delay(250);
    }
    throw new WhisperError(`whisper-server did not start within ${READY_TIMEOUT_MS / 1000}s`);
  }

  /**
   * Transcribes one WAV buffer. Returns plain text, or '' for a window that held
   * no speech.
   *
   * @param {Buffer} wavBuffer 16-bit PCM WAV, ideally 16 kHz mono
   * @param {{ language?: string, prompt?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
   *   `prompt` is the tail of what was said just before this window; whisper
   *   uses it as decoder context so a phrase split across two segments does not
   *   restart mid-sentence.
   */
  async transcribe(wavBuffer, { language, prompt, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    // A window cancelled before it was sent should not start a server, and
    // should not leave an aborted request unwinding in the background.
    if (signal?.aborted) throw new WhisperError('Cancelled');
    await this.ensureReady();

    const form = new FormData();
    form.set('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'live.wav');
    form.set('response_format', 'json');
    form.set('temperature', '0.0');
    // Fallback decoding rescues a window the greedy pass gives up on, which on a
    // noisy meeting is the difference between a line and a gap.
    form.set('temperature_inc', '0.2');
    form.set('no_timestamps', 'true');
    form.set('suppress_nst', 'true');
    form.set('language', languageCode(language));
    if (prompt) form.set('prompt', prompt.replace(/[\r\n]+/g, ' ').slice(-400));

    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res;
    try {
      res = await fetch(`${this.url}/inference`, { method: 'POST', body: form, signal: composed });
    } catch (err) {
      if (signal?.aborted) throw new WhisperError('Cancelled');
      if (timeout.aborted) throw new WhisperError(`whisper-server did not answer within ${timeoutMs / 1000}s`);
      throw new WhisperError(`whisper-server request failed: ${err.message}`);
    }

    const body = await res.text();
    if (!res.ok) throw new WhisperError(`whisper-server returned ${res.status}: ${body.slice(0, 300)}`);
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new WhisperError(`whisper-server returned unparseable JSON: ${body.slice(0, 200)}`);
    }
    if (json.error) throw new WhisperError(String(json.error));
    return cleanWhisperText(json.text ?? '');
  }

  stop() {
    this.wanted = false;
    this.ready = false;
    const proc = this.proc;
    this.proc = null;
    this.port = 0;
    withChild.delete(this);
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Whole-segment outputs that are whisper talking to itself rather than
 * transcribing.
 *
 * Trained on subtitled video, whisper answers near-silence with the things that
 * fill the quiet end of a clip: a stray "you", a sign-off, the credits from the
 * subtitle corpora. Segments here always end on the pause that closed them, so
 * this is the common failure, not an exotic one.
 *
 * A few of these — "thank you", "bye" — are also real things people say. The
 * trade is deliberate: a phantom line at every pause ruins a live caption, while
 * a dropped pleasantry costs nothing, since the transcript that actually gets
 * kept is the full pass over the saved WAV. Only an entire segment matching is
 * discarded; the same words inside a real sentence are untouched.
 */
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thank you very much',
  'thanks for watching',
  'thanks for watching my video',
  'please subscribe',
  'please subscribe to my channel',
  'subscribe',
  'bye',
  'bye bye',
  'goodbye',
  'the end',
  'subtitles by the amara.org community',
  'amara.org',
  'transcription by castingwords',
]);

/**
 * Turns a whisper.cpp segment dump into a caption line.
 *
 * Even with non-speech tokens suppressed, whisper narrates what it hears in
 * brackets — `[BLANK_AUDIO]`, `(upbeat music)` — and those are not things
 * anybody said. Square brackets are safe to drop wholesale because whisper never
 * puts speech in them; parentheses are only dropped when the content is one of
 * the annotations it actually writes, since real speech does use them.
 */
function cleanWhisperText(raw) {
  let text = String(raw ?? '');
  text = text.replace(/\[[^\]\n]{0,60}\]/g, ' ');
  text = text.replace(
    /\((?:music|applause|laughter|laughs?|laughing|silence|inaudible|noise|sighs?|coughs?|clears throat|speaking [^)\n]{0,20})[^)\n]{0,20}\)/gi,
    ' ',
  );
  // Segments arrive one per line; a caption reads better as a paragraph.
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || /^[.,!?¿¡'"\-–—…]+$/.test(text)) return '';
  if (HALLUCINATIONS.has(text.toLowerCase().replace(/[.!?…,]+$/, '').trim())) return '';
  return collapseRepeats(text);
}

module.exports = {
  WhisperServer,
  WhisperError,
  defaultThreads,
  threadChoices,
  resolveInstall,
  listModels,
  cleanWhisperText,
  languageCode,
  HALLUCINATIONS,
  LANGUAGE_CODES,
  SERVER_EXE,
};
