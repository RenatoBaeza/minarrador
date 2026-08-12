'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  WhisperServer,
  WhisperError,
  defaultThreads,
  threadChoices,
  resolveInstall,
  listModels,
  cleanWhisperText,
  languageCode,
  SERVER_EXE,
} = require('../src/main/whisper');
const { buildWav } = require('../src/main/wav');

/** Install trees made during the run, removed once it finishes. */
const scratchRoots = [];
test.after(() => {
  for (const root of scratchRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway install tree: the binary is a stub, only its presence matters. */
function fakeInstall({ models = ['ggml-base.bin'], binary = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-whisper-test-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });
  if (binary) fs.writeFileSync(path.join(root, 'bin', SERVER_EXE), '');
  for (const name of models) fs.writeFileSync(path.join(root, 'models', name), '');
  scratchRoots.push(root);
  return root;
}

/**
 * Runs a stand-in whisper-server, recording the requests it was sent.
 * @param {(req: http.IncomingMessage, body: string) => { status?: number, body?: string }} handler
 */
async function withServer(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('binary');
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      const out = handler(req, body) ?? {};
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(out.body ?? JSON.stringify({ text: 'hello' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await run({ port: server.address().port, requests });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/**
 * A WhisperServer pointed at an already-running stand-in, so the tests exercise
 * the HTTP contract without spawning a real binary.
 */
function clientFor(port, root) {
  const whisper = new WhisperServer({ root, model: 'ggml-base.bin' });
  whisper.port = port;
  whisper.ready = true;
  whisper.proc = { fake: true };
  return whisper;
}

const WAV = buildWav(Buffer.alloc(16000 * 2), 16000);

// ---------------------------------------------------------- install discovery

test('resolveInstall finds the binary and the requested model', () => {
  const root = fakeInstall({ models: ['ggml-base.bin', 'ggml-small.bin'] });
  const install = resolveInstall({ root, model: 'ggml-small.bin' });

  assert.equal(install.root, root);
  assert.equal(install.binary, path.join(root, 'bin', SERVER_EXE));
  assert.equal(install.model, path.join(root, 'models', 'ggml-small.bin'));
});

test('resolveInstall falls back to any model when the configured one is gone', () => {
  const root = fakeInstall({ models: ['ggml-tiny.bin'] });
  const install = resolveInstall({ root, model: 'ggml-deleted.bin' });

  assert.equal(install.model, path.join(root, 'models', 'ggml-tiny.bin'), 'a deleted model must not disable the preview');
});

test('resolveInstall reports no model when nothing is installed', () => {
  const root = fakeInstall({ models: [], binary: false });
  const install = resolveInstall({ root, model: 'ggml-base.bin' });

  assert.equal(install.model, '');
  assert.ok(install.binary.length > 0, 'the expected path is still worth reporting in an error');
});

test('resolveInstall takes a model given as an absolute path', () => {
  const root = fakeInstall({ models: ['ggml-base.bin'] });
  const elsewhere = path.join(root, 'models', 'ggml-base.bin');
  assert.equal(resolveInstall({ root: '', model: elsewhere }).model, elsewhere);
});

test('listModels ignores everything that is not a GGML file', () => {
  const root = fakeInstall({ models: ['ggml-base.bin', 'notes.txt'] });
  assert.deepEqual(listModels(path.join(root, 'models')), ['ggml-base.bin']);
  assert.deepEqual(listModels(path.join(root, 'nope')), [], 'a missing folder is not an error');
});

test('WhisperServer reports itself unavailable without an install', () => {
  const root = fakeInstall({ models: [], binary: false });
  const whisper = new WhisperServer({ root });

  assert.equal(whisper.available, false);
  assert.equal(whisper.running, false);
});

test('WhisperServer refuses to start when nothing is installed', async () => {
  const root = fakeInstall({ models: [], binary: false });
  const whisper = new WhisperServer({ root });

  await assert.rejects(() => whisper.ensureReady(), (err) => {
    assert.ok(err instanceof WhisperError);
    assert.match(err.message, /whisper:setup/, 'the error should say how to fix it');
    return true;
  });
});

test('WhisperServer.describe surfaces what the tray needs', () => {
  const root = fakeInstall({ models: ['ggml-base.bin', 'ggml-small.bin'] });
  const view = new WhisperServer({ root, model: 'ggml-small.bin', threads: 4 }).describe();

  assert.equal(view.model, 'ggml-small.bin');
  assert.deepEqual(view.models, ['ggml-base.bin', 'ggml-small.bin']);
  assert.equal(view.threads, 4);
  assert.equal(view.effectiveThreads, 4);
  assert.deepEqual(view.threadChoices, threadChoices(), 'the menu needs the list to build its radio items');
  assert.equal(view.available, true);
  assert.equal(view.running, false);
});

// -------------------------------------------------------------- decode threads

test('defaultThreads asks for more than whisper-server would, without taking the machine', () => {
  const threads = defaultThreads();
  const cores = os.cpus().length;

  assert.ok(Number.isInteger(threads), `expected a whole number of threads, got ${threads}`);
  // Four is whisper-server's own default and too slow for the large models; the
  // ceiling is what keeps the call being recorded responsive.
  assert.ok(threads >= 2 && threads <= 8, `${threads} is outside the useful range on ${cores} cores`);
  assert.ok(threads <= Math.max(2, cores), 'never ask for more threads than the machine has');
});

test('threadChoices offers automatic first and nothing the machine cannot field', () => {
  const choices = threadChoices();
  const cores = os.cpus().length;

  assert.equal(choices[0], 0, '0 is the automatic option the menu labels');
  assert.deepEqual(choices, [...choices].sort((a, b) => a - b), 'the menu shows them in order');
  assert.deepEqual(choices, [...new Set(choices)], 'a duplicated count would be two radio items for one value');
  for (const n of choices.slice(1)) assert.ok(n <= cores, `${n} threads on ${cores} cores`);
});

test('effectiveThreads resolves the automatic setting to a real count', () => {
  const root = fakeInstall({ models: ['ggml-base.bin'] });

  // 0 is what settings.js stores for "let the app decide"; the server can only
  // be told a number, and that number decides whether a large model keeps up.
  assert.equal(new WhisperServer({ root, threads: 0 }).effectiveThreads, defaultThreads());
  assert.equal(new WhisperServer({ root, threads: 12 }).effectiveThreads, 12, 'an explicit count wins');
});

// ------------------------------------------------------------- the /inference

test('transcribe posts the audio to /inference and returns the text', async () => {
  const root = fakeInstall();
  await withServer(
    () => ({ body: JSON.stringify({ text: ' And so my fellow Americans. ' }) }),
    async ({ port, requests }) => {
      const text = await clientFor(port, root).transcribe(WAV, { language: 'Spanish' });

      assert.equal(text, 'And so my fellow Americans.');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/inference');
      assert.equal(requests[0].method, 'POST');
      assert.match(requests[0].headers['content-type'], /^multipart\/form-data; boundary=/);
    },
  );
});

test('transcribe sends the fields whisper-server needs', async () => {
  const root = fakeInstall();
  await withServer(
    () => ({}),
    async ({ port, requests }) => {
      await clientFor(port, root).transcribe(WAV, { language: 'German', prompt: 'the line before' });

      const { body } = requests[0];
      assert.match(body, /name="file"; filename="live.wav"/);
      assert.match(body, /name="response_format"\r\n\r\njson/);
      assert.match(body, /name="language"\r\n\r\nde/, 'the label must become a whisper language code');
      assert.match(body, /name="no_timestamps"\r\n\r\ntrue/);
      assert.match(body, /name="suppress_nst"\r\n\r\ntrue/);
      assert.match(body, /name="prompt"\r\n\r\nthe line before/);
      assert.ok(body.includes('RIFF'), 'the WAV itself should be in the body');
    },
  );
});

test('transcribe asks for auto-detect when no language is set', async () => {
  const root = fakeInstall();
  await withServer(
    () => ({}),
    async ({ port, requests }) => {
      await clientFor(port, root).transcribe(WAV);
      assert.match(requests[0].body, /name="language"\r\n\r\nauto/);
      assert.ok(!requests[0].body.includes('name="prompt"'), 'no prompt on the first segment');
    },
  );
});

test('transcribe flattens a multi-line prompt', async () => {
  const root = fakeInstall();
  await withServer(
    () => ({}),
    async ({ port, requests }) => {
      await clientFor(port, root).transcribe(WAV, { prompt: 'first line\r\nsecond line' });
      assert.match(requests[0].body, /name="prompt"\r\n\r\nfirst line second line\r\n/);
    },
  );
});

test('transcribe raises the server error rather than returning junk', async () => {
  const root = fakeInstall();
  await withServer(
    () => ({ status: 500, body: JSON.stringify({ error: 'failed to process audio' }) }),
    async ({ port }) => {
      await assert.rejects(() => clientFor(port, root).transcribe(WAV), WhisperError);
    },
  );
});

test('transcribe rejects a reply that is not JSON', async () => {
  const root = fakeInstall();
  await withServer(
    () => ({ body: '<html>not this</html>' }),
    async ({ port }) => {
      await assert.rejects(() => clientFor(port, root).transcribe(WAV), /unparseable/);
    },
  );
});

test('transcribe honours a caller abort', async () => {
  const root = fakeInstall();
  await withServer(
    () => ({}),
    async ({ port }) => {
      const ctrl = new AbortController();
      ctrl.abort();
      await assert.rejects(() => clientFor(port, root).transcribe(WAV, { signal: ctrl.signal }), /Cancelled/);
    },
  );
});

// -------------------------------------------------------------- text cleaning

test('cleanWhisperText drops whisper annotations', () => {
  assert.equal(cleanWhisperText('[BLANK_AUDIO]'), '');
  assert.equal(cleanWhisperText(' [Music] Hello there. '), 'Hello there.');
  assert.equal(cleanWhisperText('Hello there. (applause)'), 'Hello there.');
  assert.equal(cleanWhisperText('[ Silence ]\n Right, shall we start?'), 'Right, shall we start?');
});

test('cleanWhisperText keeps parenthesised speech', () => {
  const spoken = 'We shipped it (finally) on Tuesday.';
  assert.equal(cleanWhisperText(spoken), spoken, 'only known annotations should be stripped');
});

test('cleanWhisperText joins the per-segment lines into one caption', () => {
  assert.equal(cleanWhisperText(' First part.\n  Second part.\n'), 'First part. Second part.');
});

test('cleanWhisperText discards the silence hallucinations', () => {
  for (const junk of ['you', 'You.', 'Thank you.', 'Thanks for watching!', 'Subtitles by the Amara.org community']) {
    assert.equal(cleanWhisperText(junk), '', `${junk} is whisper filling a pause`);
  }
  assert.equal(cleanWhisperText('.'), '');
});

test('cleanWhisperText keeps a hallucination phrase used inside real speech', () => {
  const spoken = 'Thank you for the update, can you send the deck over?';
  assert.equal(cleanWhisperText(spoken), spoken);
});

test('cleanWhisperText cuts a decoding loop', () => {
  const looped = `${'so anyway '.repeat(8)}we shipped`;
  assert.ok(cleanWhisperText(looped).length < looped.length);
});

// ------------------------------------------------------------------ languages

test('languageCode maps the transcript window labels', () => {
  assert.equal(languageCode('English'), 'en');
  assert.equal(languageCode('Portuguese'), 'pt');
  assert.equal(languageCode(''), 'auto', 'the empty label is auto-detect');
  assert.equal(languageCode(undefined), 'auto');
});

test('languageCode passes an ISO code through and refuses anything else', () => {
  assert.equal(languageCode('nl'), 'nl');
  assert.equal(languageCode('PL'), 'pl');
  // whisper.cpp rejects an unknown code outright, which would fail the request.
  assert.equal(languageCode('Klingon'), 'auto');
});
