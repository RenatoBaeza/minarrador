'use strict';

// Thin client for a local Ollama daemon.
//
// Audio goes through the OpenAI-compatible endpoint: as of Ollama 0.32 the
// native /api/chat and /api/generate routes silently drop audio fields, while
// /v1/chat/completions accepts `input_audio` parts. Verified against
// gemma4:12b, which transcribes 16 kHz mono WAV accurately; the smaller e4b
// variants return empty or garbled text, so they are a poor default.

const DEFAULT_HOST = 'http://127.0.0.1:11434';

class OllamaError extends Error {}

class Ollama {
  constructor(host = DEFAULT_HOST) {
    this.host = host.replace(/\/+$/, '');
  }

  async #once(route, body, { timeoutMs, signal }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
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
      if (err.name === 'AbortError') {
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
  async #post(route, body, { timeoutMs = 15 * 60 * 1000, signal, attempts = 3 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.#once(route, body, { timeoutMs, signal });
      } catch (err) {
        lastErr = err;
        if (!err.retryable || attempt === attempts || signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
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
  async chat(model, messages, { signal, temperature = 0.2, timeoutMs } = {}) {
    const json = await this.#post('/v1/chat/completions', { model, temperature, messages }, { signal, timeoutMs });
    return json.choices?.[0]?.message?.content ?? '';
  }
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

module.exports = { Ollama, OllamaError, cleanTranscript, collapseRepeats, DEFAULT_HOST };
