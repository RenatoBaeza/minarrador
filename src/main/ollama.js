'use strict';

// Thin client for a local Ollama daemon.
//
// Audio goes through the OpenAI-compatible endpoint: as of Ollama 0.32 the
// native /api/chat and /api/generate routes silently drop audio fields, while
// /v1/chat/completions accepts `input_audio` parts. Verified against
// gemma4:12b, which transcribes 16 kHz mono WAV accurately; the smaller e4b
// variants return empty or garbled text, so they are a poor default.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');

const DEFAULT_HOST = 'http://127.0.0.1:11434';

class OllamaError extends Error {}

class Ollama {
  constructor(host = DEFAULT_HOST) {
    this.host = host.replace(/\/+$/, '');
  }

  async #once(route, body, { timeoutMs, signal }) {
    // A signal that is already aborted will never fire 'abort' again, so the
    // listener below would not catch it and a cancelled request would run to
    // completion anyway — for transcription, minutes of work nobody is waiting
    // for, with the model still occupied while the next attempt queues behind it.
    if (signal?.aborted) throw new OllamaError('Cancelled');
    const ctrl = new AbortController();
    // Tracked explicitly rather than inferred from the rejection: aborting with
    // a reason makes fetch reject with that reason, so the error arrives as a
    // plain Error and never as an AbortError.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${this.host}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new OllamaError(`Ollama ${route} returned ${res.status}: ${text.slice(0, 300)}`);
        // 5xx usually means the daemon is reloading a model; worth another go.
        err.retryable = res.status >= 500;
        throw err;
      }
      return JSON.parse(text);
    } catch (err) {
      if (signal?.aborted) throw new OllamaError('Cancelled');
      if (err instanceof OllamaError) throw err;
      if (timedOut) {
        // Deliberately not retryable: the timeout is already generous, and
        // three more attempts would triple an already long stall.
        throw new OllamaError(`Ollama did not respond within ${Math.round(timeoutMs / 1000)}s (${route})`);
      }
      const wrapped = new OllamaError(`Cannot reach Ollama at ${this.host} — is it running? (${err.message})`);
      wrapped.retryable = true;
      throw wrapped;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * A meeting can be dozens of sequential requests over many minutes. A single
   * blip — the daemon swapping models, a momentary refused connection — should
   * not throw away everything transcribed so far, so transient faults retry.
   */
  async #post(route, body, { timeoutMs = 15 * 60 * 1000, signal, attempts = 3, retryDelayMs = 2000 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.#once(route, body, { timeoutMs, signal });
      } catch (err) {
        lastErr = err;
        if (!err.retryable || attempt === attempts || signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    }
    throw lastErr;
  }

  /** True when the daemon answers. */
  async isUp() {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels() {
    const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!res || !res.ok) return [];
    const json = await res.json();
    return (json.models ?? []).map((m) => m.name);
  }

  /** Capability strings Ollama reports for a model, e.g. ['completion','vision','audio']. */
  async capabilities(model) {
    try {
      const json = await this.#post('/api/show', { model }, { timeoutMs: 30000 });
      return json.capabilities ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Loads a model into memory without asking it for anything.
   *
   * The first request after a cold start pays the load: measured at 5s against
   * gemma4:12b with the weights still in the page cache, and 10-20s from disk.
   * That cost used to land on the first live subtitle, which is most of why one
   * took so long to appear. Calling this when a recording starts moves it off
   * that path — the load and the first window of audio overlap.
   *
   * Best-effort by design: if it fails the next real request loads the model.
   */
  async preload(model, { keepAlive = '30m', timeoutMs = 2 * 60 * 1000 } = {}) {
    if (!model) return false;
    try {
      // An /api/generate with no prompt loads the model and returns immediately.
      // The OpenAI-compatible route has no equivalent — and no keep_alive field.
      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: keepAlive }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Models that can accept audio input. */
  async audioModels() {
    const names = await this.listModels();
    const out = [];
    for (const name of names) {
      if ((await this.capabilities(name)).includes('audio')) out.push(name);
    }
    return out;
  }

  /**
   * Transcribes one WAV buffer. Returns plain text, or '' when the clip holds
   * no intelligible speech.
   */
  async transcribe(model, wavBuffer, { signal, language, seconds } = {}) {
    const instruction =
      'You are a speech-to-text engine. Transcribe the following audio verbatim' +
      (language ? ` in ${language}` : ' in the language actually spoken') +
      '. Output ONLY the transcript text. Do not translate. Do not summarise. ' +
      'Do not add timestamps, speaker labels, headings, quotation marks or any commentary. ' +
      'If the audio contains no intelligible speech, reply with exactly: [no speech]';

    // Audio models can fall into a repetition loop on silence or noise and then
    // generate until they hit the context limit, stalling a run for minutes.
    // Fast speech is ~6 tokens/second, so this cap is generous for real speech
    // while bounding the damage from a degenerate chunk.
    const maxTokens = Math.round(120 + (seconds ?? estimateWavSeconds(wavBuffer)) * 25);

    const json = await this.#post('/v1/chat/completions', {
      model,
      temperature: 0,
      max_tokens: maxTokens,
      // Thinking models deliberate before answering, which is worthless for a
      // verbatim transcript and actively harmful here: gemma4:12b spends ~265
      // tokens reasoning, and those count against max_tokens. On a short clip
      // the budget is gone before a single word of transcript is emitted, so
      // the reply comes back empty (finish_reason 'length') and the chunk is
      // silently lost. Turning it off is ~3x faster and makes short windows work.
      reasoning_effort: 'none',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'input_audio', input_audio: { data: wavBuffer.toString('base64'), format: 'wav' } },
          ],
        },
      ],
    }, { signal });

    const raw = json.choices?.[0]?.message?.content ?? '';
    return cleanTranscript(raw);
  }

  /** Text-only chat. Returns the assistant message content. */
  async chat(model, messages, { signal, temperature = 0.2, timeoutMs, attempts, retryDelayMs } = {}) {
    const json = await this.#post(
      '/v1/chat/completions',
      { model, temperature, messages },
      { signal, timeoutMs, attempts, retryDelayMs },
    );
    return json.choices?.[0]?.message?.content ?? '';
  }
}

// ------------------------------------------------------------ starting Ollama
//
// Everything above assumes a daemon is already listening. It usually is — the
// Windows installer registers Ollama as a login item — but the one failure this
// app actually hits is hitting Stop with nothing on the other end, which costs
// the notes for that meeting. Starting it is a click's worth of work, so the app
// offers the click rather than a sentence about `ollama serve`.

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Places a Windows install of Ollama might be, GUI first.
 *
 * "ollama app.exe" is the tray application: it starts the daemon and then keeps
 * it alive after this process is gone, which is what "open Ollama" means to the
 * person clicking it. "ollama.exe serve" is the same daemon without a minder,
 * so it is the fallback rather than the first pick.
 *
 * PATH is searched after the known install roots because the installer adds its
 * own directory to it anyway — it only adds anything for a copy unpacked
 * somewhere unusual.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function ollamaCandidates(env = process.env) {
  const roots = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Ollama'),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Ollama'),
    env.ProgramW6432 && path.join(env.ProgramW6432, 'Ollama'),
    ...String(env.PATH ?? '').split(path.delimiter),
  ].filter(Boolean);
  // Every GUI before any CLI, rather than both per directory: a machine with the
  // CLI early in PATH and the app in its usual place should still get the app.
  return [
    ...roots.map((dir) => path.join(dir, 'ollama app.exe')),
    ...roots.map((dir) => path.join(dir, 'ollama.exe')),
  ];
}

/**
 * The Ollama executable on this machine, or null when there is none.
 *
 * Off Windows the name is enough — spawn resolves it through PATH — and this app
 * only ships for Windows anyway, so the search above is not worth generalising.
 *
 * @returns {string|null}
 */
function findOllama(env = process.env) {
  if (process.platform !== 'win32') return 'ollama';
  return ollamaCandidates(env).find(isFile) ?? null;
}

/**
 * Starts Ollama and leaves it running.
 *
 * Detached and unref'd on purpose: the daemon has to outlive whichever menu
 * click asked for it, and a meeting recorded after Minarrador quits still wants
 * something to transcribe it.
 *
 * @returns {string} the executable that was launched
 * @throws {OllamaError} when Ollama is not installed
 */
function launchOllama(env = process.env) {
  const exe = findOllama(env);
  if (!exe) {
    throw new OllamaError('Ollama does not appear to be installed. Get it from https://ollama.com/download');
  }
  const cli = path.basename(exe).toLowerCase() !== 'ollama app.exe';
  const child = spawn(exe, cli ? ['serve'] : [], { detached: true, windowsHide: true, stdio: 'ignore' });
  // A spawn failure arrives asynchronously, long after this returns; without a
  // listener it would surface as an uncaught exception in the main process.
  child.once('error', (err) => log.warn('could not start Ollama:', err.message));
  child.unref();
  return exe;
}

/** Duration of a 16-bit PCM WAV buffer, read straight from the header. */
function estimateWavSeconds(buf) {
  try {
    const rate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    return (buf.length - 44) / (rate * channels * 2);
  } catch {
    return 60;
  }
}

/**
 * Cuts a stuck model loose: when a phrase repeats back to back more than a few
 * times it is a decoding artefact, not speech.
 */
function collapseRepeats(text, maxRun = 4) {
  const words = text.split(/\s+/);
  for (let len = 1; len <= 6; len++) {
    for (let i = 0; i + len * maxRun <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(' ').toLowerCase();
      if (!phrase) continue;
      let runs = 1;
      while (
        i + len * (runs + 1) <= words.length &&
        words.slice(i + len * runs, i + len * (runs + 1)).join(' ').toLowerCase() === phrase
      ) {
        runs++;
      }
      if (runs > maxRun) {
        // Keep a couple of repetitions, drop the rest of the loop.
        return `${words.slice(0, i + len * 2).join(' ')} ${words.slice(i + len * runs).join(' ')}`.trim();
      }
    }
  }
  return text;
}

/** Strips the boilerplate small models like to wrap around a transcript. */
function cleanTranscript(raw) {
  let t = String(raw).trim();
  t = t.replace(/^```(?:text|txt)?\s*/i, '').replace(/```$/i, '').trim();
  t = t.replace(/^(?:here (?:is|'s)|this is)\b[^:\n]{0,60}:\s*/i, '');
  t = t.replace(/^transcript(?:ion)?\s*:\s*/i, '');
  t = t.trim();
  // Models emit a bare marker (or a sentence about one) for silence.
  if (/^\[?\s*no speech\s*\]?\.?$/i.test(t)) return '';
  if (/^\[?\s*(silence|inaudible|no audio|blank_audio)\s*\]?\.?$/i.test(t)) return '';
  if (t.length < 220 && /\b(no intelligible speech|contains no speech|audio is silent|there is no speech)\b/i.test(t)) {
    return '';
  }
  return collapseRepeats(t);
}

module.exports = {
  Ollama,
  OllamaError,
  cleanTranscript,
  collapseRepeats,
  ollamaCandidates,
  findOllama,
  launchOllama,
  DEFAULT_HOST,
};
