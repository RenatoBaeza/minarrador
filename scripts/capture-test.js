'use strict';

// Records a few seconds through the real capture graph and reports what it got.
// Use this when the tray says a source is missing and you want to know why.
//
//   npm run capture-test            (5 seconds)
//   npm run capture-test -- 10      (10 seconds)

const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const log = require('../src/main/logger');
const { CaptureController } = require('../src/main/capture');
const { readWav, rms } = require('../src/main/wav');

const seconds = Number(process.argv.find((a) => /^\d+$/.test(a))) || 5;

app.whenReady().then(async () => {
  log.init(app.getPath('userData'));

  CaptureController.installMediaHandlers();
  const capture = new CaptureController();
  await capture.init();

  const peak = { mixed: 0, mic: 0, system: 0 };
  capture.on('levels', (l) => {
    for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], l[k] ?? 0);
  });

  capture.setActive(true, { captureMic: true, captureSystem: true });
  await new Promise((r) => setTimeout(r, 3000)); // let getUserMedia settle

  console.log('Sources:');
  console.log(`  microphone   : ${capture.status.micOk ? 'OK' : `unavailable — ${capture.status.micError}`}`);
  console.log(`  system audio : ${capture.status.systemOk ? 'OK' : `unavailable — ${capture.status.systemError}`}`);

  if (!capture.status.micOk && !capture.status.systemOk) {
    console.error('\nNo capture source available.');
    capture.destroy();
    app.exit(1);
    return;
  }

  const out = path.join(os.tmpdir(), `minarrador-capture-test-${Date.now()}.wav`);
  console.log(`\nRecording ${seconds}s to ${out} …`);
  capture.startRecording(out);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const result = await capture.stopRecording();

  const { pcm, sampleRate, seconds: dur } = readWav(out);
  const level = rms(pcm);
  console.log(`\nWrote ${result.bytes} bytes — ${dur.toFixed(2)}s @ ${sampleRate} Hz`);
  console.log(`Peak levels  : mixed ${peak.mixed.toFixed(4)}  mic ${peak.mic.toFixed(4)}  system ${peak.system.toFixed(4)}`);
  console.log(`File RMS     : ${level.toFixed(5)} ${level < 0.0005 ? '(silent — nothing was playing?)' : '(signal present)'}`);

  if (process.argv.includes('--keep')) console.log(`Kept: ${out}`);
  else fs.rmSync(out, { force: true });

  capture.destroy();
  app.exit(0);
});

app.on('window-all-closed', () => {});
