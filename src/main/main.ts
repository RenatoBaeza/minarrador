// Minarrador — local-only meeting notes.
// Tray-only app: no main window ever appears. The single hidden renderer exists
// solely to run the Web Audio graph, which is unavailable in the main process.
//
// This file is the app's lifecycle and the wiring between its parts, and
// nothing else. The parts live beside it:
//
//   context.ts     the shared state and settings every module reads
//   windows.ts     every window, and the sender checks on their channels
//   ui.ts          what the windows and the tray are told, and when
//   recording.ts   start, stop, and the pipeline run after it
//   services.ts    Ollama, the global shortcut, applying a setting
//   ipc/*.ts       one module per channel namespace: library, settings,
//                  disk, dictation

import { app, dialog, globalShortcut, powerMonitor, powerSaveBlocker, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import log from './logger';
import * as settingsStore from './settings';
import { CaptureController } from './capture';
import { AppTray } from './tray';
import { Ollama } from './ollama';
import { WhisperServer } from './whisper';
import { DictationController } from './dictation';
import { runPipeline, fmtDuration } from './pipeline';
import type { Speaker } from './paths';
import { errorMessage } from './errors';
import { ctx, hotkeyLabel, state } from './context';
import {
  cancelIndicatorHide,
  notify,
  sendToDictate,
  showLibraryWindow,
} from './windows';
import {
  appendLiveTranscript,
  hear,
  healthTicking,
  notifyLibrary,
  notifyProgress,
  notifySettings,
  refreshTray,
  sendActivity,
  sendHealth,
  sendLiveLine,
  startedHidden,
} from './ui';
import {
  checkRecordingLimits,
  checkDisk,
  applySleepBlocker,
  finalizeRecording,
  freeSpace,
  initRecording,
  startRecording,
  stopRecording,
  writeResumeNote,
} from './recording';
import { applyCaptureConfig, applyHotkey, applyLiveConfig, applyLoginItem, openOllama, refreshOllama } from './services';
import { registerAudioScheme, registerLibraryIpc } from './ipc/library';
import { registerSettingsIpc } from './ipc/settings';
import { registerDiskIpc } from './ipc/disk';
import {
  applyDictateHotkey,
  cancelMicTestTimer,
  registerDictationIpc,
  sendMicTest,
  stopDictation,
  toggleDictation,
} from './ipc/dictation';

const APP_ID = 'com.rntbz.minarrador';

/** How often to look for the Ollama daemon while idle. */
const OLLAMA_POLL_MS = 60_000;

/**
 * A main-process fault is the one failure this app has no way to show.
 *
 * There is no window to put a stack in, and Electron's default handler pops a
 * dialog that says "A JavaScript error occurred in the main process" and never
 * writes to the log file the tray menu offers — so the one artefact a bug report
 * is built from is the one place the error does not appear.
 *
 * Neither handler exits. A recording in progress is worth more than a tidy
 * process: the WAV is written here in the main process, and staying up means the
 * meeting keeps landing on disk and Stop still works.
 */
process.on('uncaughtException', (err) => {
  log.error('uncaught exception in the main process', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection in the main process', reason instanceof Error ? reason : String(reason));
});

/**
 * The identity Windows files this process under.
 *
 * Windows keys an app's taskbar name and icon off the AppUserModelID, resolving
 * it to whichever Start Menu shortcut claims that ID — not off the window icon
 * or the .exe. Showing a toast makes Electron register such a shortcut, so a
 * `npm start` run under the shipped ID plants an "Electron" shortcut pointing at
 * node_modules that outranks the installed one, and the packaged app then wears
 * the Electron logo. Dev keeps its own ID so it can only ever shadow itself.
 */
const USER_MODEL_ID = app.isPackaged ? APP_ID : `${APP_ID}.dev`;

let uiTimer: NodeJS.Timeout | null = null;
let ollamaTimer: NodeJS.Timeout | null = null;

/** Recording's hands on the world: everything it does that is not its own state. */
function wireRecording(): void {
  initRecording({
    notify,
    refreshTray,
    notifyLibrary,
    notifySettings,
    notifyProgress,
    sendActivity,
    showLiveTranscript: () => void showLibraryWindow({ section: 'reader' }),
    errorBox: (title, body) => dialog.showErrorBox(title, body),
    openPath: (target) => void shell.openPath(target),
    openOllama,
    ollamaIsUp: (host) => new Ollama(host).isUp(),
    sleepBlocker: {
      start: () => powerSaveBlocker.start('prevent-app-suspension'),
      stop: (id) => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      },
    },
    runPipeline,
    freeSpace,
  });
}

function registerIpc(): void {
  registerLibraryIpc();
  registerSettingsIpc();
  registerDiskIpc();
  registerDictationIpc();
}

/**
 * Survives the machine going to sleep in the middle of a meeting.
 *
 * Closing a laptop lid suspends the machine whatever a power-save blocker
 * says, and what the Web Audio graph's state is on the other side of that is
 * undefined — in practice it comes back with dead device tracks, so the tray
 * says "Recording" while the WAV stops growing. Nothing notices, which is the
 * same class of failure as a dead capture renderer and gets the same answer:
 * rebuild the graph, re-arm it into the same file, and say how much was lost.
 *
 * The audio between the suspend and the rebuild is gone. Nothing can recover
 * it; the point is that the rest of the meeting is not.
 */
function installPowerHandlers(): void {
  let sleptAt = 0;

  powerMonitor.on('suspend', () => {
    sleptAt = Date.now();
    if (state.phase !== 'recording') return;
    // Nothing useful can be done here — the process is about to stop running
    // — but the log is what makes the gap in the audio explainable later.
    log.warn('the machine is suspending while a meeting is being recorded');
  });

  powerMonitor.on('resume', () => {
    const asleep = sleptAt ? Math.round((Date.now() - sleptAt) / 1000) : 0;
    sleptAt = 0;
    log.info(`the machine resumed${asleep ? ` after ${fmtDuration(asleep)}` : ''}`);
    const wasRecording = state.phase === 'recording';
    ctx.capture?.restart();
    // Sleeping through a meeting is exactly how a recording ends up hours
    // long, so the limits get a look the moment the clock is believable again.
    if (!wasRecording) return;
    state.disk.checkedAt = 0;
    notify(
      'Recording resumed',
      `The machine was asleep${asleep ? ` for ${fmtDuration(asleep)}` : ''}. That part of the meeting was not recorded, but this one continues.`,
    );
    checkRecordingLimits();
  });
}

/**
 * Brings the app up. Everything here has to succeed for there to be a tray
 * icon at all, which is why the caller treats a throw as fatal — see below.
 */
async function startup(): Promise<void> {
  log.init(app.getPath('userData'));
  log.info(`Minarrador ${app.getVersion()} starting (hidden=${startedHidden}, packaged=${app.isPackaged})`);

  // A settings file that does not exist yet is a first run. Checked before
  // the store loads — loading is also what creates the file — and the answer
  // decides what the startup notification says.
  const firstRun = !fs.existsSync(path.join(app.getPath('userData'), 'settings.json'));

  ctx.settings = settingsStore.load();
  const { settings } = ctx;
  fs.mkdirSync(settings.notesDir, { recursive: true });
  applyLoginItem();
  // Read once at startup so the library has something to say about the volume
  // before the first meeting is recorded onto it.
  checkDisk({ force: true });

  CaptureController.installMediaHandlers();
  const server = new WhisperServer({
    root: settings.whisperRoot,
    model: settings.whisperModel,
    threads: settings.whisperThreads,
  });
  ctx.whisper = server;
  log.info(
    server.available
      ? `whisper.cpp found: ${path.basename(server.model)} in ${server.root}`
      : `whisper.cpp not installed in ${server.root} — the live preview falls back to Ollama`,
  );
  // A crash takes the preview with it until the next recording; the meeting
  // itself and the proper transcription afterwards are untouched.
  server.on('exit', refreshTray);
  server.on('ready', refreshTray);

  const cap = new CaptureController({ ollamaHost: settings.ollamaHost, whisper: server });
  ctx.capture = cap;
  cap.on('status', () => {
    refreshTray();
    // Which microphone opened, and whether the chosen one was there to open,
    // are both things the settings pane shows.
    notifySettings();
  });
  cap.on('devices', notifySettings);
  // What each source has heard, for the health strip's first ten seconds.
  cap.on('levels', hear);
  cap.on('transcript', (text: string, speaker: Speaker) => {
    // On disk first: the file is what survives a crash, and what the reader
    // rebuilds the preview from when it is opened mid-meeting.
    appendLiveTranscript(text, speaker);
    sendLiveLine(text, speaker);
  });
  cap.on('speech', () => {
    if (!ctx.settings.suggestOnAudio || state.phase === 'recording') return;
    notify('Sounds like a meeting', 'Minarrador heard sustained audio. Click to start recording.', startRecording);
  });
  // A meeting that ended without anybody saying so. Stopping it writes the
  // notes for what was actually said, which is the point — the alternative is
  // a folder nobody asked for holding hours of an empty room.
  cap.on('silence', ({ minutes }: { minutes: number }) => {
    if (state.phase !== 'recording') return;
    log.info(`stopping the recording after ${minutes} minutes of silence`);
    notify('Recording stopped', `Nothing was audible for ${minutes} minutes, so Minarrador stopped and is writing the notes.`);
    stopRecording().catch((err: unknown) => log.error('stop on silence failed', err));
  });
  // The WAV stopped growing. Everything else still looks like a recording, so
  // this is the only chance to say so before the meeting is over.
  cap.on('writeFailed', ({ error, seconds }: { error: string; seconds: number }) => {
    log.error('the recording could not be written:', error);
    notify('Recording stopped', `Minarrador could not keep writing the audio (${error}). ${fmtDuration(seconds)} was saved.`);
    stopRecording().catch((err: unknown) => log.error('stop after a write failure failed', err));
  });
  // The worker rebuilds itself; this is only about telling the person in the
  // meeting, who otherwise has no way to know the room stopped being recorded.
  cap.on('rendererGone', ({ wasRecording, recovering }: { wasRecording: boolean; recovering: boolean }) => {
    refreshTray();
    if (!recovering) {
      notify(
        'Audio capture has stopped',
        wasRecording
          ? 'The capture worker keeps crashing. Stop the recording to keep what was captured so far.'
          : 'The capture worker keeps crashing. Try Settings → Restart audio capture.',
      );
    } else if (wasRecording) {
      notify('Audio capture restarted', 'A few seconds of the meeting were lost. Recording continues into the same file.');
    }
  });

  const dictate = new DictationController({
    ollamaHost: settings.ollamaHost,
    whisper: server,
    // A transcription that fails keeps its audio here rather than losing it,
    // which is the same "never lose the meeting" rule the WAV path follows.
    errorDir: path.join(app.getPath('userData'), 'dictation-errors'),
  });
  ctx.dictation = dictate;
  // A live caption while dictating, shown on the indicator so the person
  // speaking knows it is being heard.
  dictate.on('live', (text: string) => {
    if (ctx.dictation?.active) sendToDictate({ state: 'listening', text });
  });
  // The hotkey is a toggle, so a session nobody stopped would otherwise run
  // to the controller's hard ceiling and then keep the mic warm forever.
  dictate.on('cap', () => {
    if (!ctx.dictation?.active) return;
    log.warn('stopping the dictation at the length cap');
    notify('Voice input stopped', 'That was a long one — Minarrador cut it off at the five-minute ceiling.');
    stopDictation().catch((err: unknown) => log.error('stop at the dictation cap failed', err));
  });
  // The mic test reuses the same capture; its levels and mic status go to the
  // settings pane, and only when a test is actually running.
  dictate.on('level', (level: number) => {
    if (state.micTesting && Number.isFinite(level)) sendMicTest({ testing: true, level });
  });
  dictate.on('status', (status: { micLabel?: string; micError?: string; fatal?: string } | undefined) => {
    if (!state.micTesting) return;
    sendMicTest({
      testing: true,
      micLabel: status?.micLabel ?? '',
      micError: status?.micError ?? status?.fatal ?? '',
    });
  });

  ctx.tray = new AppTray({
    startRecording,
    stopRecording: () => void stopRecording().catch((err: unknown) => log.error('stop from the tray failed', err)),
    toggleDictation,
    openLibrary: () => void showLibraryWindow(),
    openQuickCopy: () => void showLibraryWindow({ section: 'quickcopy' }),
    // before-quit does the careful part: a meeting mid-recording is closed and
    // left with a resume note rather than lost.
    quit: () => app.quit(),
  });

  await cap.init();
  applyCaptureConfig();
  applyLiveConfig();
  applyHotkey();
  await dictate.init();
  applyDictateHotkey();
  installPowerHandlers();
  // Also finds the newest meeting still owed its notes, so the tray can offer
  // to write them for a run that failed in an earlier session.
  notifyLibrary();

  await refreshOllama();
  // The poll is fire-and-forget, so it swallows its own failures: an
  // unhandled rejection every 60 seconds would bury the log in the one file
  // a bug report is built from.
  ollamaTimer = setInterval(() => {
    refreshOllama().catch((err: unknown) => log.warn('Ollama poll failed:', errorMessage(err)));
  }, OLLAMA_POLL_MS);
  // Keeps the recording clock in the tooltip/menu moving, and is the one
  // heartbeat the duration cap, the long-recording notice, the free-space
  // check and the health strip's first seconds all ride on — none of them is
  // worth a timer of its own.
  uiTimer = setInterval(() => {
    if (state.phase !== 'recording') return;
    refreshTray();
    checkRecordingLimits();
    if (healthTicking()) sendHealth();
  }, 1000);

  if (firstRun) {
    // A tray-only app's real UI is its hotkeys, and nothing has ever told a
    // new user about them. The welcome says both, using the *actual*
    // registered accelerators rather than the defaults.
    const start = settings.hotkey && settings.hotkey !== 'off' ? hotkeyLabel(settings.hotkey) : 'the tray icon';
    const dictateKey =
      settings.dictateHotkey && settings.dictateHotkey !== 'off' ? hotkeyLabel(settings.dictateHotkey) : null;
    notify(
      'Welcome to Minarrador',
      `Record a meeting from anywhere with ${start} — the waveform icon lives in the tray.` +
        (dictateKey ? ` Press ${dictateKey} to speak a sentence into whatever you are typing.` : ''),
    );
  } else if (!startedHidden) {
    notify('Minarrador is running', 'Use the waveform icon in your system tray to start recording.');
  }
}

/** Releases everything the app holds. Runs once, on the way out. */
function shutdown(): void {
  if (uiTimer) clearInterval(uiTimer);
  if (ollamaTimer) clearInterval(ollamaTimer);
  uiTimer = null;
  ollamaTimer = null;
  // A global shortcut outlives the window that registered it, so hand it back
  // rather than leaving the combination dead for the next application.
  globalShortcut.unregisterAll();
  // Same for the sleep block: a process that exits holding one leaves the
  // machine unable to suspend on idle until the next reboot.
  state.phase = 'idle';
  applySleepBlocker();
  // A download in flight has nobody left to report to, and half a model is
  // worse than none — whisper-setup renames into place, so an aborted one
  // leaves no install that later looks real.
  state.setup?.abort.abort();

  // A meeting still being processed is about to lose its pipeline. Stop the
  // model requests rather than leaving them to be cut mid-socket, and leave
  // the folder able to explain itself — every stage that finished has already
  // written its artefact, so this is only ever the tail of the chain.
  for (const [dir, job] of state.jobs) {
    job.abort.abort();
    log.warn('quit requested while processing', dir);
    writeResumeNote(dir, 'Minarrador quit while these notes were still being written.');
  }
  state.jobs.clear();

  ctx.capture?.destroy();

  // A dictation in flight has no file to finalize — the audio lives only in
  // memory — so it is dropped rather than transcribed into a process that is
  // already on its way out.
  ctx.dictation?.cancel();
  ctx.dictation?.destroy();
  cancelMicTestTimer();
  cancelIndicatorHide();

  ctx.tray?.destroy();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // No window to focus; surface the tray menu instead.
    notify('Minarrador is already running', 'Look for the waveform icon in your system tray.');
  });

  app.setAppUserModelId(USER_MODEL_ID);
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

  // Must happen before ready: Electron only accepts scheme privileges then.
  registerAudioScheme();
  wireRecording();

  // A tray-only app that fails to start has nowhere to say so: no window, no
  // icon, just a process sitting in Task Manager. Say it in the one place
  // guaranteed to be visible, then leave rather than pretending to run.
  app
    .whenReady()
    .then(() => {
      // protocol.handle needs a ready app, so the channels are registered here.
      registerIpc();
      return startup();
    })
    .catch((err: unknown) => {
      log.error('startup failed', err);
      dialog.showErrorBox(
        'Minarrador could not start',
        `${errorMessage(err)}\n\n${log.path ? `Details are in ${log.path}` : 'The log file was never created.'}`,
      );
      app.exit(1);
    });

  app.on('before-quit', (e) => {
    // Quitting mid-meeting must not lose the audio, but it must not hang for
    // the several minutes a pipeline run can take either. Close the file, leave
    // a note explaining how to produce the notes later, then quit.
    if (ctx.capture?.isRecording && !state.quitting) {
      e.preventDefault();
      state.quitting = true;
      log.info('quit requested while recording — closing the audio file first');
      finalizeRecording()
        .then((finished) => {
          if (!finished) return;
          writeResumeNote(
            finished.dir,
            'Minarrador quit while this meeting was still recording, so the audio was saved but the notes were never generated.',
          );
          notify('Recording saved', 'Minarrador quit before writing the notes. Click to open the folder.', () =>
            void shell.openPath(finished.dir),
          );
        })
        .catch((err: unknown) => log.error('failed to finalize recording during quit', err))
        .finally(() => app.quit());
      return;
    }

    shutdown();
  });
}
