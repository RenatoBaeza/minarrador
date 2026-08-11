'use strict';

// Fetches whisper.cpp into vendor/whisper so the live transcriber has an engine.
//
// Two downloads, both one-off: the prebuilt Windows binaries from the
// ggml-org/whisper.cpp release, and a GGML model from Hugging Face. Nothing here
// runs while the app does — this is the only step in Minarrador that touches the
// network, and it is deliberately something you type rather than something the
// app decides to do on its own.
//
//   npm run whisper:setup                    # base model, plain CPU build
//   npm run whisper:setup -- --model small   # a slower, more accurate model
//   npm run whisper:setup -- --variant cublas-12.4
//   npm run whisper:setup -- --force         # re-download over an existing tree
//
// Layout it produces:
//   vendor/whisper/bin/whisper-server.exe (+ the ggml/whisper DLLs beside it)
//   vendor/whisper/models/ggml-<name>.bin
//   vendor/whisper/INSTALL.json

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

/** Pinned so a rebuild is reproducible; bump deliberately. */
const RELEASE = 'v1.9.2';

/**
 * Release assets worth offering. The plain CPU build already dispatches between
 * per-microarchitecture DLLs at runtime, so it is a sound default; the others
 * are for machines with the matching hardware and drivers.
 */
const VARIANTS = {
  cpu: 'whisper-bin-x64.zip',
  blas: 'whisper-blas-bin-x64.zip',
  'cublas-11.8': 'whisper-cublas-11.8.0-bin-x64.zip',
  'cublas-12.4': 'whisper-cublas-12.4.0-bin-x64.zip',
};

/**
 * Models, with the rough cost of each. Live captions are superseded by the
 * post-recording pass, so the trade is latency against how readable the preview
 * is while the meeting is happening.
 */
const MODELS = {
  tiny: '75 MB · fastest, visibly more errors',
  'tiny.en': '75 MB · English only',
  base: '142 MB · the default; comfortably realtime on CPU',
  'base.en': '142 MB · English only',
  small: '466 MB · noticeably more accurate, ~3x realtime',
  'small.en': '466 MB · English only',
  medium: '1.5 GB · accurate, needs a strong CPU or GPU build',
  'large-v3-turbo': '1.6 GB · best quality, GPU build recommended',
};

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const RELEASE_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`;

const ROOT = path.join(__dirname, '..', 'vendor', 'whisper');

function parseArgs(argv) {
  const opts = { model: 'base', variant: 'cpu', force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--model' || arg === '-m') opts.model = argv[++i];
    else if (arg === '--variant' || arg === '-v') opts.variant = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function usage() {
  const rows = (obj) =>
    Object.entries(obj)
      .map(([name, note]) => `    ${name.padEnd(16)}${note}`)
      .join('\n');
  console.log(`Usage: npm run whisper:setup -- [--model NAME] [--variant NAME] [--force]

  Models (default: base):
${rows(MODELS)}

  Variants (default: cpu):
${rows(VARIANTS)}
`);
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Streams a URL to disk, reporting progress on one rewritten line.
 *
 * Downloads to a temporary name and renames on success, so an interrupted run
 * never leaves a half-file that later looks like a working install.
 */
async function download(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${label}: ${url} returned ${res.status}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastTick = 0;
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    seen += chunk.length;
    const now = Date.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    const pct = total ? ` ${Math.round((seen / total) * 100)}%` : '';
    process.stdout.write(`\r  ${label}: ${human(seen)}${total ? ` / ${human(total)}` : ''}${pct}   `);
  });

  try {
    await pipeline(body, fs.createWriteStream(tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.renameSync(tmp, dest);
  process.stdout.write(`\r  ${label}: ${human(seen)} — done${' '.repeat(20)}\n`);
}

/**
 * Unpacks a zip using what Windows already has.
 *
 * The app ships no runtime dependencies and Node has no zip reader, so this
 * borrows Expand-Archive rather than pulling in a package for one call.
 */
function unzip(zipPath, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  if (process.platform !== 'win32') {
    execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'inherit' });
    return;
  }
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { stdio: 'inherit' },
  );
}

/**
 * Flattens the release layout into vendor/whisper/bin.
 *
 * The Windows zips put everything in a single `Release/` directory, but that is
 * an artefact of how they are built rather than a promise, so find the folder
 * holding the server binary instead of assuming the name.
 */
function installBinaries(unpackedDir, binDir) {
  const stack = [unpackedDir];
  let source = null;
  while (stack.length && !source) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.name === 'whisper-server.exe' || entry.name === 'whisper-server') source = dir;
    }
  }
  if (!source) throw new Error('the release archive contained no whisper-server binary');

  fs.rmSync(binDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // The server plus the libraries it loads. The rest of the archive is other
    // examples and their test binaries, which would triple the install for
    // nothing — dropping them also keeps SDL2 and the talk-llama demo out.
    const keep =
      /^(whisper-server|whisper-cli)(\.exe)?$/.test(entry.name) || /\.(dll|so|dylib)$/i.test(entry.name);
    // SDL2 is only there for the microphone-capturing examples, which this app
    // has no use for — Minarrador does its own capture and posts WAVs.
    if (!keep || /^SDL2\./i.test(entry.name)) continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(binDir, entry.name));
    copied++;
  }
  return copied;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  if (!MODELS[opts.model]) {
    throw new Error(`unknown model "${opts.model}" — one of: ${Object.keys(MODELS).join(', ')}`);
  }
  if (!VARIANTS[opts.variant]) {
    throw new Error(`unknown variant "${opts.variant}" — one of: ${Object.keys(VARIANTS).join(', ')}`);
  }
  if (process.platform !== 'win32' && opts.variant !== 'cpu') {
    throw new Error('the prebuilt variants are Windows x64 only; build whisper.cpp yourself elsewhere');
  }

  const binDir = path.join(ROOT, 'bin');
  const modelsDir = path.join(ROOT, 'models');
  const modelFile = path.join(modelsDir, `ggml-${opts.model}.bin`);
  const serverExe = path.join(binDir, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');

  console.log(`whisper.cpp ${RELEASE} (${opts.variant}) + ggml-${opts.model} -> ${ROOT}\n`);

  if (fs.existsSync(serverExe) && !opts.force) {
    console.log(`  binaries: already present (--force to replace)`);
  } else {
    const asset = VARIANTS[opts.variant];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-whisper-'));
    try {
      const zip = path.join(work, asset);
      await download(`${RELEASE_BASE_URL}/${asset}`, zip, 'binaries');
      unzip(zip, path.join(work, 'unpacked'));
      const copied = installBinaries(path.join(work, 'unpacked'), binDir);
      console.log(`  binaries: ${copied} files -> ${binDir}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  if (fs.existsSync(modelFile) && !opts.force) {
    console.log(`  model:    already present (--force to replace)`);
  } else {
    await download(`${MODEL_BASE_URL}/ggml-${opts.model}.bin`, modelFile, `ggml-${opts.model}`);
  }

  fs.writeFileSync(
    path.join(ROOT, 'INSTALL.json'),
    `${JSON.stringify(
      {
        release: RELEASE,
        variant: opts.variant,
        model: `ggml-${opts.model}.bin`,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`
Done. Minarrador picks this up automatically — the tray menu's
Settings -> Live transcript engine now offers whisper.cpp, and
Settings -> Whisper model lists everything under ${modelsDir}.`);
}

main().catch((err) => {
  console.error(`\nsetup failed: ${err.message}`);
  process.exitCode = 1;
});
