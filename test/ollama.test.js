'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const {
  Ollama,
  OllamaError,
  cleanTranscript,
  collapseRepeats,
  ollamaCandidates,
  findOllama,
  launchOllama,
} = require('../src/main/ollama');
const { buildWav } = require('../src/main/wav');

/**
 * Runs a throwaway Ollama stand-in.
 * @param {(req: http.IncomingMessage, body: any) => { status?: number, json?: any, delayMs?: number }} handler
 */
async function fakeOllama(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ url: req.url, method: req.method, body });

      const { status = 200, json = {}, delayMs = 0 } = handler(req, body) ?? {};
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  return {
    host,
    calls,
    client: new Ollama(host),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const completion = (content) => ({ json: { choices: [{ message: { content } }] } });

// ------------------------------------------------------------------ transcript

test('cleanTranscript strips fences and model preamble', () => {
  assert.equal(cleanTranscript('```\nhello there\n```'), 'hello there');
  assert.equal(cleanTranscript('```text\nhello there\n```'), 'hello there');
  assert.equal(cleanTranscript("Here is the transcript: hello there"), 'hello there');
  assert.equal(cleanTranscript('Transcript: hello there'), 'hello there');
  assert.equal(cleanTranscript('  hello there  '), 'hello there');
});

test('cleanTranscript maps every silence marker to empty', () => {
  for (const marker of ['[no speech]', 'no speech', '[NO SPEECH]', '[silence]', '[inaudible]', '[BLANK_AUDIO]', 'no audio.']) {
    assert.equal(cleanTranscript(marker), '', `${marker} should be treated as silence`);
  }
  assert.equal(cleanTranscript('The audio is silent.'), '');
});

test('cleanTranscript keeps real speech that merely mentions silence', () => {
  const long =
    'We sat in silence for a while before Ana opened the meeting and walked through the migration plan, ' +
    'which she said would take three weeks and needs sign-off from the platform team before the end of the month.';
  assert.equal(cleanTranscript(long), long, 'a long passage is speech, not a silence marker');
});

test('collapseRepeats cuts a decoding loop but keeps normal repetition', () => {
  const looped = `start ${'yes '.repeat(30)}end`;
  const fixed = collapseRepeats(looped);
  assert.ok(fixed.length < looped.length / 3, 'the loop should be collapsed');
  assert.ok(fixed.startsWith('start yes yes'), 'a couple of repetitions are kept');
  assert.ok(fixed.endsWith('end'), 'text after the loop survives');

  const natural = 'no no I meant the other one';
  assert.equal(collapseRepeats(natural), natural);
});

test('collapseRepeats handles a repeated multi-word phrase', () => {
  const looped = `${'thank you very much '.repeat(12)}goodbye`;
  const fixed = collapseRepeats(looped);
  assert.ok(fixed.length < looped.length / 2);
  assert.ok(fixed.endsWith('goodbye'));
});

// ---------------------------------------------------------------------- client

test('isUp reports true only when the daemon answers', async () => {
  const fake = await fakeOllama(() => ({ json: { models: [] } }));
  try {
    assert.equal(await fake.client.isUp(), true);
  } finally {
    await fake.close();
  }
  // Same port, now closed.
  assert.equal(await new Ollama(fake.host).isUp(), false);
});

test('listModels returns names and survives a dead daemon', async () => {
  const fake = await fakeOllama(() => ({ json: { models: [{ name: 'gemma4:12b' }, { name: 'qwen3.5:9b' }] } }));
  try {
    assert.deepEqual(await fake.client.listModels(), ['gemma4:12b', 'qwen3.5:9b']);
  } finally {
    await fake.close();
  }
  assert.deepEqual(await new Ollama(fake.host).listModels(), []);
});

test('audioModels keeps only models reporting the audio capability', async () => {
  const fake = await fakeOllama((req, body) => {
    if (req.url === '/api/tags') return { json: { models: [{ name: 'audio-one' }, { name: 'text-only' }] } };
    return { json: { capabilities: body.model === 'audio-one' ? ['completion', 'audio'] : ['completion'] } };
  });
  try {
    assert.deepEqual(await fake.client.audioModels(), ['audio-one']);
  } finally {
    await fake.close();
  }
});

test('transcribe posts audio to the OpenAI-compatible route', async () => {
  const wav = buildWav(Buffer.alloc(16000 * 2), 16000, 1); // 1 second
  const fake = await fakeOllama(() => completion('the quick brown fox'));
  try {
    const text = await fake.client.transcribe('gemma4:12b', wav, { seconds: 1 });
    assert.equal(text, 'the quick brown fox');

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.url, '/v1/chat/completions', 'must not use /api/chat, which drops audio');
    assert.equal(call.body.model, 'gemma4:12b');
    assert.equal(call.body.temperature, 0);

    const parts = call.body.messages[0].content;
    const audio = parts.find((p) => p.type === 'input_audio');
    assert.ok(audio, 'the request must carry an input_audio part');
    assert.equal(audio.input_audio.format, 'wav');
    assert.equal(Buffer.from(audio.input_audio.data, 'base64').length, wav.length);
  } finally {
    await fake.close();
  }
});

test('transcribe caps output tokens against the clip length', async () => {
  const fake = await fakeOllama(() => completion('ok'));
  try {
    await fake.client.transcribe('m', buildWav(Buffer.alloc(0)), { seconds: 60 });
    const cap = fake.calls[0].body.max_tokens;
    assert.ok(cap > 0 && cap < 5000, `expected a bounded token cap, got ${cap}`);
  } finally {
    await fake.close();
  }
});

test('transcribe turns off model thinking', async () => {
  const fake = await fakeOllama(() => completion('ok'));
  try {
    await fake.client.transcribe('m', buildWav(Buffer.alloc(0)), { seconds: 5 });
    // Reasoning tokens count against max_tokens, so on a short clip a thinking
    // model exhausts the budget before emitting any transcript at all.
    assert.equal(fake.calls[0].body.reasoning_effort, 'none');
  } finally {
    await fake.close();
  }
});

test('transcribe passes the requested language through to the prompt', async () => {
  const fake = await fakeOllama(() => completion('hola'));
  try {
    await fake.client.transcribe('m', buildWav(Buffer.alloc(0)), { language: 'Spanish' });
    const instruction = fake.calls[0].body.messages[0].content.find((p) => p.type === 'text').text;
    assert.match(instruction, /in Spanish/);
  } finally {
    await fake.close();
  }
});

test('a 5xx is retried, because a model swap should not lose the meeting', async () => {
  let attempts = 0;
  const fake = await fakeOllama(() => {
    attempts++;
    return attempts < 3 ? { status: 503, json: { error: 'loading model' } } : completion('recovered');
  });
  try {
    assert.equal(await fake.client.chat('m', [], { retryDelayMs: 1 }), 'recovered');
    assert.equal(attempts, 3);
  } finally {
    await fake.close();
  }
});

test('a 4xx fails immediately rather than retrying a bad request', async () => {
  let attempts = 0;
  const fake = await fakeOllama(() => {
    attempts++;
    return { status: 404, json: { error: 'model not found' } };
  });
  try {
    await assert.rejects(() => fake.client.chat('missing', []), OllamaError);
    assert.equal(attempts, 1, 'a client error is not worth retrying');
  } finally {
    await fake.close();
  }
});

test('an unreachable daemon produces an actionable message, and is retried', async () => {
  const client = new Ollama('http://127.0.0.1:1');
  await assert.rejects(() => client.chat('m', [], { timeoutMs: 2000, attempts: 1 }), /is it running/);
});

test('a timeout is reported as a timeout, not as a dead daemon', async () => {
  // Regression: aborting with a reason makes fetch reject with that reason, so
  // a timeout used to be misreported as "is it running?" — and, because that
  // path is retryable, a 15-minute stall became a 45-minute one.
  const fake = await fakeOllama(() => ({ ...completion('too late'), delayMs: 300 }));
  try {
    await assert.rejects(
      () => fake.client.chat('m', [], { timeoutMs: 40, retryDelayMs: 1 }),
      (err) => {
        assert.match(err.message, /did not respond within/);
        assert.notEqual(err.retryable, true, 'a timeout must not be retried');
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('an aborted request stops rather than retrying', async () => {
  const ctrl = new AbortController();
  const fake = await fakeOllama(() => {
    ctrl.abort();
    return { status: 503, json: {}, delayMs: 10 };
  });
  try {
    await assert.rejects(() => fake.client.chat('m', [], { signal: ctrl.signal }), /Cancelled/);
  } finally {
    await fake.close();
  }
});

test('a signal aborted before the call never reaches the daemon', async () => {
  // An already-aborted signal does not fire 'abort' again, so a listener alone
  // misses it and the request runs to completion — minutes of transcription
  // nobody is waiting for, with the model occupied while the next one queues.
  const fake = await fakeOllama(() => completion('should never be asked for'));
  try {
    await assert.rejects(
      () => fake.client.chat('m', [], { signal: AbortSignal.abort() }),
      (err) => err instanceof OllamaError && /Cancelled/.test(err.message),
    );
    assert.equal(fake.calls.length, 0, 'the daemon should not have been called at all');
  } finally {
    await fake.close();
  }
});

test('the host is normalised so a trailing slash cannot double up', async () => {
  const fake = await fakeOllama(() => completion('ok'));
  try {
    await new Ollama(`${fake.host}///`).chat('m', []);
    assert.equal(fake.calls[0].url, '/v1/chat/completions');
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------------------------ pull
//
// A running Ollama with nothing pulled is half of an install that cannot work,
// and `ollama pull` in a terminal is not an answer for anyone who arrived via
// the installer. The route streams NDJSON, one object per status change.

/**
 * An Ollama stand-in that streams `lines` back as newline-delimited JSON.
 *
 * `chunk` controls how the bytes are cut up, because the interesting failure
 * here is a JSON object split across two network chunks.
 */
async function fakePullServer(lines, { status = 200, chunk = 0 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
      res.writeHead(status, { 'Content-Type': 'application/x-ndjson' });
      const body = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
      if (!chunk) {
        res.end(body);
        return;
      }
      for (let i = 0; i < body.length; i += chunk) {
        res.write(body.slice(i, i + chunk));
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  return { host, calls, client: new Ollama(host), close: () => new Promise((resolve) => server.close(resolve)) };
}

test('pull reports each layer as it lands and returns the final status', async () => {
  const fake = await fakePullServer([
    { status: 'pulling manifest' },
    { status: 'pulling abc', completed: 1000, total: 4000 },
    { status: 'pulling abc', completed: 4000, total: 4000 },
    { status: 'success' },
  ]);
  try {
    const seen = [];
    const last = await fake.client.pull('gemma4:12b', { onProgress: (p) => seen.push(p) });

    assert.equal(last, 'success');
    assert.equal(fake.calls[0].url, '/api/pull');
    assert.deepEqual(fake.calls[0].body, { model: 'gemma4:12b', stream: true });
    assert.equal(seen.length, 4);
    assert.deepEqual(seen[1], { status: 'pulling abc', completed: 1000, total: 4000 });
    // A status line with no byte counts still reports numbers a bar can use.
    assert.deepEqual(seen[0], { status: 'pulling manifest', completed: 0, total: 0 });
  } finally {
    await fake.close();
  }
});

test('pull reassembles an object split across two network chunks', async () => {
  const fake = await fakePullServer(
    [{ status: 'pulling manifest' }, { status: 'pulling abc', completed: 2048, total: 4096 }, { status: 'success' }],
    { chunk: 7 },
  );
  try {
    const seen = [];
    assert.equal(await fake.client.pull('m', { onProgress: (p) => seen.push(p) }), 'success');
    assert.deepEqual(seen.map((p) => p.status), ['pulling manifest', 'pulling abc', 'success']);
    assert.equal(seen[1].completed, 2048);
  } finally {
    await fake.close();
  }
});

// Ollama reports a bad model name in the body with a 200 status, so the stream
// is the only place this surfaces.
test('pull fails on an error in the stream, not just on a bad status', async () => {
  const fake = await fakePullServer([{ status: 'pulling manifest' }, { error: 'model "nope" not found' }]);
  try {
    await assert.rejects(
      () => fake.client.pull('nope'),
      (err) => err instanceof OllamaError && /model "nope" not found/.test(err.message),
    );
  } finally {
    await fake.close();
  }
});

test('pull fails on a bad status too', async () => {
  const fake = await fakePullServer([], { status: 500 });
  try {
    await assert.rejects(() => fake.client.pull('m'), /returned 500/);
  } finally {
    await fake.close();
  }
});

test('pull refuses to ask for nothing', async () => {
  await assert.rejects(() => new Ollama('http://127.0.0.1:1').pull(''), /No model was named/);
});

test('pull reports an unreachable daemon as one', async () => {
  // Port 1 is not something a daemon listens on.
  await assert.rejects(() => new Ollama('http://127.0.0.1:1').pull('m'), /Cannot reach Ollama/);
});

test('pull stops when it is cancelled', async () => {
  const fake = await fakePullServer([{ status: 'pulling manifest' }, { status: 'success' }]);
  try {
    await assert.rejects(
      () => fake.client.pull('m', { signal: AbortSignal.abort() }),
      (err) => err instanceof OllamaError && /Cancelled/.test(err.message),
    );
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------- starting the daemon

const LOCAL = path.join('C:', 'Users', 'someone', 'AppData', 'Local');
const ON_PATH = path.join('C:', 'tools', 'ollama');

test('ollamaCandidates prefers the tray app, then the CLI, wherever it lives', (t) => {
  if (process.platform !== 'win32') return t.skip('the search is Windows-only');
  const candidates = ollamaCandidates({
    LOCALAPPDATA: LOCAL,
    PROGRAMFILES: path.join('C:', 'Program Files'),
    PATH: [ON_PATH, path.join('C:', 'Windows')].join(path.delimiter),
  });

  // Every GUI comes before every CLI: a machine with the CLI early in PATH and
  // the app in its usual place should still get the app, which keeps the daemon
  // alive after Minarrador quits.
  const firstCli = candidates.findIndex((p) => p.endsWith('ollama.exe'));
  const lastApp = candidates.map((p) => p.endsWith('ollama app.exe')).lastIndexOf(true);
  assert.ok(lastApp < firstCli, 'a CLI candidate was ranked above a GUI one');

  assert.equal(candidates[0], path.join(LOCAL, 'Programs', 'Ollama', 'ollama app.exe'));
  assert.ok(candidates.includes(path.join(ON_PATH, 'ollama.exe')), 'PATH should be searched too');
});

test('ollamaCandidates survives an environment with none of the usual variables', (t) => {
  if (process.platform !== 'win32') return t.skip('the search is Windows-only');
  // A stripped environment is not an error, it is a machine with no Ollama on
  // it — findOllama says so by returning null rather than by throwing here.
  assert.deepEqual(ollamaCandidates({}), []);
  assert.equal(findOllama({}), null);
});

test('launchOllama refuses to guess when there is nothing installed', (t) => {
  if (process.platform !== 'win32') return t.skip('off Windows the name resolves through PATH');
  assert.throws(
    () => launchOllama({}),
    (err) => err instanceof OllamaError && /not.*installed/i.test(err.message),
  );
});
