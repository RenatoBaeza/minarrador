'use strict';

// Fetches whisper.cpp into vendor/whisper so the live transcriber has an engine.
//
// The downloading itself lives in src/main/whisper-setup.js, because the app
// can now do this from Settings too — a build that was installed rather than
// checked out has no npm to run this with, and until it could, Minarrador
// shipped able to reach a state it could not get out of. This is the
// developer's door onto the same operation: a different variant, a different
// model, and progress on a terminal rather than in a window.
//
//   npm run whisper:setup                    # base model, plain CPU build
//   npm run whisper:setup -- --model small   # a slower, more accurate model
//   npm run whisper:setup -- --model large-v3-turbo-q5_0   # the accurate pick
//   npm run whisper:setup -- --variant cublas-12.4
//   npm run whisper:setup -- --force         # re-download over an existing tree
//
// Models accumulate: a second run with a different --model leaves the first one
// in place and adds to what Settings offers under Whisper model, so switching
// back is a click rather than another download.
//
// It installs into the checkout's vendor/whisper rather than the app's own
// install root, since that is the tree electron-builder packages as
// resources/whisper.

const path = require('node:path');

const { install, MODELS, VARIANTS, RELEASE, human } = require('../src/main/whisper-setup');

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
  // Width follows the longest name so a new entry cannot silently break the
  // column, which is the whole reason this listing is readable.
  const rows = (obj) => {
    const width = Math.max(...Object.keys(obj).map((name) => name.length)) + 2;
    return Object.entries(obj)
      .map(([name, note]) => `    ${name.padEnd(width)}${typeof note === 'string' ? note : ''}`)
      .join('\n');
  };
  console.log(`Usage: npm run whisper:setup -- [--model NAME] [--variant NAME] [--force]

  Models (default: base):
${rows(MODELS)}

  Variants (default: cpu):
${rows(VARIANTS)}
`);
}

/** One rewritten line per file, which is all a download needs to say. */
function report({ phase, label, completed = 0, total = 0, done }) {
  if (phase === 'unpacking') return void process.stdout.write('\r  unpacking…'.padEnd(60));
  if (phase === 'done' || !label) return;
  const pct = total ? ` ${Math.round((completed / total) * 100)}%` : '';
  const tail = done ? ' — done' : pct;
  process.stdout.write(`\r  ${label}: ${human(completed)}${total ? ` / ${human(total)}` : ''}${tail}`.padEnd(60));
  if (done) process.stdout.write('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  console.log(`whisper.cpp ${RELEASE} (${opts.variant}) + ggml-${opts.model} -> ${ROOT}\n`);
  const out = await install({ ...opts, root: ROOT, onProgress: report });

  console.log(`
Done. Minarrador picks this up automatically — Settings → Live transcript
now offers whisper.cpp, and Whisper model lists everything under
${path.join(out.root, 'models')}.`);
}

main().catch((err) => {
  console.error(`\nsetup failed: ${err.message}`);
  process.exitCode = 1;
});
