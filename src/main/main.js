'use strict';

// Minarrador — local-only meeting notes.
// Tray-only app: no main window ever appears. The single hidden renderer exists
// solely to run the Web Audio graph, which is unavailable in the main process.

const { app, Notification, dialog, shell, nativeImage, BrowserWindow, ipcMain } = require('electron');
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
  /** Guards the shutdown sequence against re-entering before-quit. */
  quitting: false,
};

let tray = null;
let capture = null;
let settings = null;
let uiTimer = null;
let transcriptionWindow = null;

// ------------------------------------------------------------------------ UI

const RENDERER = path.join(__dirname, '..', 'renderer');

/**
 * The live transcript window: a read-only preview of what the model is hearing.
 *
 * It loads transcript.html, never capture.html — the latter is the hidden audio
 * worker, and opening a second copy of it would build a second Web Audio graph
 * competing for the same microphone and loopback stream.
 */
function showTranscriptWindow() {
  if (transcriptionWindow && !transcriptionWindow.isDestroyed()) {
    if (transcriptionWindow.isMinimized()) transcriptionWindow.restore();
    transcriptionWindow.show();
    transcriptionWindow.focus();
    return transcriptionWindow;
  }

  transcriptionWindow = new BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    title: 'Live Transcription',
    backgroundColor: '#16161a',
    icon: nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png')),
    webPreferences: {
      preload: path.join(RENDERER, 'transcript-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  transcriptionWindow.setMenuBarVisibility(false);
  transcriptionWindow.once('ready-to-show', () => transcriptionWindow?.show());
  transcriptionWindow.on('closed', () => {
    transcriptionWindow = null;
  });
  transcriptionWindow.loadFile(path.join(RENDERER, 'transcript.html')).catch((err) => {
    log.error('transcript window failed to load', err);
  });
  return transcriptionWindow;
}

function toggleTranscriptWindow() {
  if (transcriptionWindow && !transcriptionWindow.isDestroyed() && transcriptionWindow.isVisible()) {
    transcriptionWindow.close();
    return;
  }
  showTranscriptWindow();
  sendToTranscript('transcript:state', transcriptState());
}

/** Posts to the transcript window when one is open; a no-op otherwise. */
function sendToTranscript(channel, payload) {
  if (transcriptionWindow && !transcriptionWindow.isDestroyed()) {
    transcriptionWindow.webContents.send(channel, payload);
  }
}

function transcriptState() {
  return {
    recording: state.phase === 'recording',
    label: state.phase === 'recording' ? 'Recording' : state.phase === 'processing' ? state.progress || 'Processing…' : 'Idle',
  };
}

function refreshTray() {
  sendToTranscript('transcript:state', transcriptState());
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
    state.phase = 'recording';
    if (settings.liveTranscript) showTranscriptWindow();
    sendToTranscript('transcript:clear');
    refreshTray();
  } catch (err) {
    log.error('startRecording failed', err);
    dialog.showErrorBox('Minarrador', `Could not start recording:\n\n${err.message}`);
    state.phase = 'idle';
    refreshTray();
  }
}

/**
 * Closes the WAV and writes meta.json, without running the pipeline.
 *
 * Split out from stopRecording so shutdown can secure the irreplaceable part —
 * the audio — without waiting on a transcription that may take minutes.
 *
 * @returns {{ dir: string, meta: object } | null} null when nothing was kept
 */
async function finalizeRecording() {
  if (state.phase !== 'recording') return null;
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
    return null;
  }

  const meta = {
    startedAt: (startedAt ?? new Date()).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: result.seconds,
    sources,
  };
  fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta, null, 2));
  return { dir, meta };
}

async function stopRecording() {
  const finished = await finalizeRecording();
  if (!finished) return;
  await processMeeting(finished.dir, finished.meta);
  shell.showItemInFolder(finished.dir);
}

// --------------------------------------------------------------- post-process

async function processMeeting(dir, meta) {
  // The rough live preview is superseded by the proper pass that follows, so
  // clear it — but never force a window open on someone who closed it.
  sendToTranscript('transcript:clear');

  state.jobs++;
  if (state.phase === 'idle') state.phase = 'processing';
  state.progress = 'Preparing…';
  refreshTray();

  const onProgress = (p) => {
    if (p.phase === 'transcribing') {
      state.progress = `Transcribing ${p.done}/${p.total}…`;
      if (p.text) sendToTranscript('transcript:line', p.text);
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
      `${fmtDuration(meta.durationSeconds)} · ${out.notes.action_items.length} action item(s). Click to open the folder.`,
      () => shell.openPath(dir),
    );
  } catch (err) {
    log.error('pipeline failed for', dir, err);
    try {
      fs.writeFileSync(
        path.join(dir, 'ERROR.txt'),
        `Processing failed at ${new Date().toISOString()}\n\n${err.stack ?? err.message}\n\n` +
          `The audio is still in ${FILES.audio}. Fix the problem (usually: start Ollama, or pull the model)\n` +
          `and re-run notes for this folder with:\n\n  npm run pipeline -- "${dir}"\n`,
      );
    } catch {}
    notify('Notes failed', `${err.message.slice(0,180)} — audio was saved. Click to open the folder.`, () => shell.openPath(dir));
  } finally {
    state.jobs--;
    if (state.jobs === 0 && state.phase === 'processing') state.phase = 'idle';
    if (state.jobs === 0) state.progress = '';
    refreshTray();
    // The transcript window stays open; closing it is the user's call.
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
  // A model swap above changes what the live preview should be asking for.
  applyLiveConfig();
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

function applyLiveConfig() {
  capture?.configureLive({ enabled: settings.liveTranscript, model: settings.transcribeModel });
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

  // Every page this app loads is a local file it ships. Nothing should ever
  // navigate elsewhere or spawn a window, so refuse both outright rather than
  // relying on the pages themselves to behave — model-authored HTML reaches
  // one of these renderers.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log.warn('blocked window.open to', url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) {
        log.warn('blocked navigation to', url);
        event.preventDefault();
      }
    });
    contents.on('will-attach-webview', (event) => {
      log.warn('blocked a webview attach');
      event.preventDefault();
    });
  });

  // The transcript window is the only renderer allowed to change this, and the
  // preload restricts it to a known list before it ever reaches here.
  ipcMain.on('transcript:setLanguage', (event, lang) => {
    if (event.sender.id !== transcriptionWindow?.webContents.id) return;
    capture?.configureLive({ language: typeof lang === 'string' ? lang : '' });
    log.info('live transcript language ->', lang || 'auto');
  });

  app.whenReady().then(async () => {
    log.init(app.getPath('userData'));
    log.info(`Minarrador ${app.getVersion()} starting (hidden=${startedHidden}, packaged=${app.isPackaged})`);

    settings = settingsStore.load();
    fs.mkdirSync(settings.notesDir, { recursive: true });
    applyLoginItem();

    CaptureController.installMediaHandlers();
    capture = new CaptureController({ ollamaHost: settings.ollamaHost });
    capture.on('status', refreshTray);
    capture.on('transcript', (text) => sendToTranscript('transcript:line', text));
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
      toggleTranscript: toggleTranscriptWindow,
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
        if ('liveTranscript' in patch || 'transcribeModel' in patch) applyLiveConfig();
        refreshTray();
      },
      // before-quit owns the shutdown sequence, including its re-entrancy guard.
      quit: () => app.quit(),
    });

    await capture.init();
    applyCaptureConfig();
    applyLiveConfig();
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

  app.on('before-quit', (e) => {
    // Quitting mid-meeting must not lose the audio, but it must not hang for
    // the several minutes a pipeline run can take either. Close the file, leave
    // a note explaining how to produce the notes later, then quit.
    if (capture?.isRecording && !state.quitting) {
      e.preventDefault();
      state.quitting = true;
      log.info('quit requested while recording — closing the audio file first');
      finalizeRecording()
        .then((finished) => {
          if (!finished) return;
          const resume = path.join(finished.dir, 'UNPROCESSED.txt');
          fs.writeFileSync(
            resume,
            `Minarrador quit while this meeting was still recording, so the audio was saved\n` +
              `but the notes were never generated.\n\nProduce them with:\n\n  npm run pipeline -- "${finished.dir}"\n`,
          );
          notify('Recording saved', 'Minarrador quit before writing the notes. Click to open the folder.', () =>
            shell.openPath(finished.dir),
          );
        })
        .catch((err) => log.error('failed to finalize recording during quit', err))
        .finally(() => app.quit());
      return;
    }

    clearInterval(uiTimer);
    capture?.destroy();
    tray?.destroy();
  });
}
