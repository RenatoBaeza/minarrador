'use strict';

// Re-runs transcription + notes + PDF for a meeting folder that already holds
// audio.wav. The app can do this itself now — the library's Generate notes
// button, and the tray item beside Start Recording — so this is the developer's
// door onto the same chain: a different model, a different engine, and the
// output on a terminal rather than in a notification.
//
//   npm run pipeline -- "C:\Users\me\Documents\Minarrador\2026-08-11_14-32-05"
//   npm run pipeline -- <folder> --transcribe gemma4:12b --summary qwen3.5:9b
//   npm run pipeline -- <folder> --engine ollama
//
// Runs under Electron because the PDF step needs a renderer.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const settingsStore = require('../src/main/settings');
const { runPipeline, transcribeEngineFor } = require('../src/main/pipeline');
const { WhisperServer } = require('../src/main/whisper');
const { FILES } = require('../src/main/paths');
const log = require('../src/main/logger');

function parseArgs(argv) {
  // argv is [electron.exe, run-pipeline.js, ...user args]; npm may also inject '--'.
  const args = argv
    .slice(1)
    .filter((a) => a !== '--' && a !== '.' && !a.endsWith('run-pipeline.js'));
  const out = { dir: null, overrides: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transcribe') out.overrides.transcribeModel = args[++i];
    else if (args[i] === '--summary') out.overrides.summaryModel = args[++i];
    // Which engine reads the audio. Overrides skip the settings store, so the
    // two values it accepts are pinned here rather than trusted from the shell.
    else if (args[i] === '--engine') out.overrides.transcribeEngine = args[++i] === 'ollama' ? 'ollama' : 'whisper';
    else if (!args[i].startsWith('--') && !out.dir) out.dir = args[i];
  }
  return out;
}

app.whenReady().then(async () => {
  log.init(app.getPath('userData'));
  const { dir, overrides } = parseArgs(process.argv);

  if (!dir) {
    console.error('Usage: npm run pipeline -- "<meeting folder>" [--transcribe MODEL] [--summary MODEL]');
    app.exit(2);
    return;
  }
  const folder = path.resolve(dir);
  const audio = path.join(folder, FILES.audio);
  if (!fs.existsSync(audio)) {
    console.error(`No ${FILES.audio} in ${folder}`);
    app.exit(2);
    return;
  }

  const config = { ...settingsStore.load(), ...overrides };
  // The same engine the app would use, resolved the same way: whisper.cpp when
  // it is installed and asked for, the audio model otherwise.
  const whisper = new WhisperServer({
    root: config.whisperRoot,
    model: config.whisperModel,
    threads: config.whisperThreads,
  });
  const engine = transcribeEngineFor(config, whisper);

  console.log(`Folder     : ${folder}`);
  console.log(
    `Transcribe : ${engine === 'whisper' ? `whisper.cpp (${path.basename(whisper.model)})` : config.transcribeModel}`,
  );
  console.log(`Notes      : ${config.summaryModel}\n`);

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(folder, FILES.meta), 'utf8'));
  } catch {
    meta = { startedAt: fs.statSync(audio).mtime.toISOString() };
  }

  const started = Date.now();
  try {
    const out = await runPipeline(folder, config, {
      meta,
      whisper,
      onProgress: (p) => {
        const detail = p.total ? ` ${p.done}/${p.total}` : '';
        process.stdout.write(`\r  ${p.phase}${detail}${' '.repeat(20)}`);
      },
    });
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    console.log(`Title        : ${out.notes.title}`);
    console.log(`Summary      : ${out.notes.summary.length} bullets`);
    console.log(`Decisions    : ${out.notes.decisions.length}`);
    console.log(`Action items : ${out.notes.action_items.length}`);
    console.log(`PDF          : ${out.pdfPath}`);
    app.exit(0);
  } catch (err) {
    process.stdout.write('\n');
    console.error(`FAILED: ${err.stack ?? err.message}`);
    app.exit(1);
  } finally {
    // app.exit is immediate, so the module's process-exit hook may never run:
    // hand back the port and the several hundred MB of weights explicitly.
    whisper.stop();
  }
});

app.on('window-all-closed', () => {});
