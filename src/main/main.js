'use strict';

// Minarrador — local-only meeting notes.
// Tray-only app: no main window ever appears. The single hidden renderer exists
// solely to run the Web Audio graph, which is unavailable in the main process.

const { app, Notification, dialog, shell, nativeImage, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');
const settingsStore = require('./settings');
const { CaptureController } = require('./capture');
const { AppTray } = require('./tray');
const { Ollama } = require('./ollama');
const { runPipeline, fmtDuration } = require('./pipeline');
const { createMeetingDir, FILES } = require('./paths');

const APP_ID = 'com.rntbz.minarrador';

/** Launched by the login item, or otherwise asked to stay out of the way. */
const startedHidden = process.argv.includes('--hidden');

const state = {
  /** 'idle' | 'recording' | 'processing' */
  phase: 'idle',
  progress: '',
  currentDir: null,
  recordingStartedAt: null,
  lastDir: null,
  ollamaUp: false,
  models: [],
  audioModels: [],
  jobs: 0,
};

let tray = null;
let capture = null;
let settings = null;
let uiTimer = null;
let transcriptionWindow = null;

// ------------------------------------------------------------------------ UI

function createTranscriptionWindow() {
  if (transcriptionWindow && !transcriptionWindow.isDestroyed()) {
    transcriptionWindow.focus();
    return transcriptionWindow;
  }
  transcriptionWindow = new BrowserWindow({
    width: 600,
    height: 800,
    title: 'Live Transcription',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  transcriptionWindow.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));
  transcriptionWindow.on('closed', () => {
    transcriptionWindow = null;
  });
  return transcriptionWindow;
}

function refreshTray() {
  if (!tray) return;
  tray.update({
    state: state.phase,
    elapsed: capture?.elapsedSeconds ?? 0,
    progress: state.progress,
    settings,
    status: capture?.status ?? {},
    ollamaUp: state.ollamaUp,
    models: state.models,
    audioModels: state.audioModels,
    lastDir: state.lastDir,
  });
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) {
    log.info(`notification: ${title} — ${body}`);
    return;
  }
  const n = new Notification({
    title,
    body,
    icon: nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png')),
    silent: false,
  });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ------------------------------------------------------------------ recording

function startRecording() {
  if (state.phase === 'recording') return;
  try {
    fs.mkdirSync(settings.notesDir, { recursive: true });
    const dir = createMeetingDir(settings.notesDir);
    state.currentDir = dir;
    state.recordingStartedAt = new Date();
    capture.startRecording(path.join(dir, FILES.audio));
    // Open transcription window for live view
    if (!transcriptionWindow || transcriptionWindow.isDestroyed()) {
      transcriptionWindow = createTranscriptionWindow();
      transcriptionWindow.webContents.send('clear');
    }
    state.phase = 'recording';
    refreshTray();
  } catch (err) {
    log.error('startRecording failed', err);
    dialog.showErrorBox('Minarrador', `Could not start recording:\n\n${err.message}`);
    state.phase = 'idle';
    refreshTray();
  }
}

async function stopRecording() {
  if (state.phase !== 'recording') return;
  const dir = state.currentDir;
  const startedAt = state.recordingStartedAt;
  const sources = { mic: capture.status.micOk, system: capture.status.systemOk };

  const result = await capture.stopRecording();
  state.phase = 'idle';
  state.currentDir = null;
  refreshTray();

  if (!result || result.seconds < 1) {
    log.warn('discarding recording shorter than a second:', dir);
    fs.rmSync(dir, { recursive: true, force: true });
    notify('Nothing recorded', 'The recording was too short to keep.');
    return;
  }

  const meta = {
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: result.seconds,
    sources,
  };
  fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta, null, 2));

  await processMeeting(dir, meta);
  shell.showItemInFolder(dir);
}

// --------------------------------------------------------------- post-process

async function processMeeting(dir, meta) {
  // Use the live transcription window (created at recording start)
  if (!transcriptionWindow || transcriptionWindow.isDestroyed()) {
    transcriptionWindow = createTranscriptionWindow();
  }
  const win = transcriptionWindow;
  win.webContents.send('clear');

  state.jobs++;
  if (state.phase === 'idle') state.phase = 'processing';
  state.progress = 'Preparing…';
  refreshTray();

  const onProgress = (p) => {
    if (p.phase === 'transcribing') {
      state.progress = `Transcribing ${p.done}/${p.total}…`;
      if (p.text) win.webContents.send('update', p.text);
    } else if (p.phase === 'summarising') {
      state.progress = p.total ? `Condensing ${p.done}/${p.total}…` : 'Writing notes…';
    } else if (p.phase === 'designing') {
      state.progress = 'Designing the brief…';
    } else if (p.phase === 'rendering') {
      state.progress = 'Exporting PDF…';
    }
    refreshTray();
  };

  try {
    const out = await runPipeline(dir, settings, { onProgress, meta });
    state.lastDir = dir;
    log.info('pipeline complete:', dir);
    notify(
      out.notes.title,
      `${fmtDuration(meta.durationSeconds)} · ${out.notes.action_items.length} action item(s). Click to open the notes.`,
      () => shell.openPath(path.join(dir, FILES.pdf)),
    );
  } catch (err) {
    log.error('pipeline failed for', dir, err);
    try {
      fs.writeFileSync(
        path.join(dir, 'ERROR.txt'),
        `Processing failed at ${new Date().toISOString()}\n\n${err.stack ?? err.message}\n\n` +
          `The audio is still in ${FILES.audio}. Fix the problem (usually: start Ollama, or pull the model)\n` +
          `and re-run notes for this folder with:\n\n  npm run pipeline -- \"${dir}\"\n`,
      );
    } catch {}
    notify('Notes failed', `${err.message.slice(0,180)} — audio was saved. Click to open the folder.`, () => shell.openPath(dir));
  } finally {
    state.jobs--;
    if (state.jobs === 0 && state.phase === 'processing') state.phase = 'idle';
    if (state.jobs === 0) state.progress = '';
    refreshTray();
    // Keep the transcription window open for the user to view live content; do not close here.
  }
}

// ------------------------------------------------------------------- services

async function refreshOllama() {
  const client = new Ollama(settings.ollamaHost);
  const up = await client.isUp();
  const changed = up !== state.ollamaUp;
  state.ollamaUp = up;
  if (up && (changed || state.models.length === 0)) {
    state.models = await client.listModels();
    state.audioModels = await client.audioModels();
    // Keep the configured models pointing at something that exists.
    if (state.audioModels.length && !state.audioModels.includes(settings.transcribeModel)) {
      settings = settingsStore.save({ transcribeModel: state.audioModels[0] });
      log.warn('transcription model missing; switched to', settings.transcribeModel);
    }
    if (state.models.length && !state.models.includes(settings.summaryModel)) {
      settings = settingsStore.save({ summaryModel: state.models[0] });
      log.warn('notes model missing; switched to', settings.summaryModel);
    }
  } else if (!up) {
    state.models = [];
    state.audioModels = [];
  }
  refreshTray();
}

function applyLoginItem() {
  app.setLoginItemSettings({
    openAtLogin: settings.startAtLogin,
    // Tray-only anyway, but be explicit so a future window build stays hidden.
    args: ['--hidden'],
  });
}

function applyCaptureConfig() {
  capture.setActive(true, { captureMic: settings.captureMic, captureSystem: settings.captureSystem });
}

function diagnostics() {
  return JSON.stringify(
    {
      version: app.getVersion(),
      // electron version omitted
      platform: `${process.platform} ${process.arch}`,
      packaged: app.isPackaged,
      startedHidden,
      phase: state.phase,
      ollamaUp: state.ollamaUp,
      models: state.models,
      audioModels: state.audioModels,
      captureStatus: capture?.status,
      levels: capture?.levels,
      settings,
      logPath: log.path,
    },
    null,
    2,
  );
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // No window to focus; surface the tray menu instead.
    notify('Minarrador is already running', 'Look for the waveform icon in your system tray.');
  });

  app.setAppUserModelId(APP_ID);
  // Tray-only app. Merely having a listener here stops Electron's default
  // "quit when the last window closes" behaviour.
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    log.init(app.getPath('userData'));
    log.info(`Minarrador ${app.getVersion()} starting (hidden=${startedHidden}, packaged=${app.isPackaged})`);

    settings = settingsStore.load();
    fs.mkdirSync(settings.notesDir, { recursive: true });
    applyLoginItem();

    CaptureController.installMediaHandlers();
    capture = new CaptureController();
    capture.on('status', refreshTray);
    capture.on('speech', () => {
      if (!settings.suggestOnAudio || state.phase === 'recording') return;
      notify('Sounds like a meeting', 'Minarrador heard sustained audio. Click to start recording.', startRecording);
    });

    tray = new AppTray({
      startRecording,
      stopRecording,
      openLast: () => {
        if (!state.lastDir) return;
        const pdf = path.join(state.lastDir, FILES.pdf);
        shell.openPath(fs.existsSync(pdf) ? pdf : state.lastDir);
      },
      openLog: () => shell.openPath(log.path),
      diagnostics,
      restartCapture: () => {
        capture.setActive(false);
        setTimeout(applyCaptureConfig, 600);
      },
      chooseNotesFolder: async () => {
        const res = await dialog.showOpenDialog({
          title: 'Choose where meetings are saved',
          defaultPath: settings.notesDir,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (res.canceled || !res.filePaths[0]) return;
        settings = settingsStore.save({ notesDir: res.filePaths[0] });
        fs.mkdirSync(settings.notesDir, { recursive: true });
        refreshTray();
      },
      setSetting: (patch) => {
        settings = settingsStore.save(patch);
        if ('startAtLogin' in patch) applyLoginItem();
        if ('captureMic' in patch || 'captureSystem' in patch) applyCaptureConfig();
        refreshTray();
      },
      quit: () => {
        state.quitting = true;
        app.quit();
      },
    });

    await capture.init();
    applyCaptureConfig();
    refreshTray();

    await refreshOllama();
    setInterval(refreshOllama, 60_000);
    // Keeps the recording clock in the tooltip/menu moving.
    uiTimer = setInterval(() => {
      if (state.phase === 'recording') refreshTray();
    }, 1000);

    if (!startedHidden) {
      notify('Minarrador is running', 'Use the waveform icon in your system tray to start recording.');
    }
  });

  app.on('before-quit', async (e) => {
    if (capture?.isRecording) {
      e.preventDefault();
      log.info('quit requested while recording — finishing the file first');
      await stopRecording();
      app.quit();
      return;
    }
    clearInterval(uiTimer);
    capture?.destroy();
    tray?.destroy();
  });
}
