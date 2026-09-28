// The settings pane's channels, and the two first-run downloads behind it.
//
// The library is the only surface that changes a setting, and it is still a
// renderer: every patch goes through gateLibraryPatch, and everything that
// names a place on disk is set from a dialog in main rather than from the page.

import { clipboard, ipcMain, shell } from 'electron';

import log from '../logger';
import { Ollama } from '../ollama';
import { installRoot } from '../whisper';
import * as whisperSetup from '../whisper-setup';
import { errorMessage } from '../errors';
import { gateLibraryPatch } from '../settings-gate';
import { PROGRESS_MIN_MS, ctx, state } from '../context';
import { fromLibrary, notify, onLibraryClosed, showDictationsWindow } from '../windows';
import { diagnostics, notifySettings, settingsState } from '../ui';
import { checkDisk } from '../recording';
import { applySetting, chooseNotesFolder, openOllama, refreshOllama } from '../services';
import { startMicTest, stopMicTest } from './dictation';
import type { Outcome, SetupState } from '../../shared/types';

// ------------------------------------------------------------------- first run
//
// Everything below exists because the app can be installed into a state where
// it cannot do its job — Ollama with nothing pulled, no whisper.cpp — and the
// only instructions for getting out of it used to be terminal commands, which
// is nobody's idea of a first run when the app arrived as an installer.

type SetupPatch = Partial<Pick<SetupState, 'status' | 'completed' | 'total'>> & { done?: boolean };

let lastSetupAt = 0;

/** Records where a download has got to and lets the settings pane redraw. */
function setupProgress(patch: SetupPatch): void {
  if (!state.setup) return;
  const { done, ...fields } = patch;
  Object.assign(state.setup, fields);
  const now = Date.now();
  if (now - lastSetupAt < PROGRESS_MIN_MS && !done) return;
  lastSetupAt = now;
  notifySettings();
}

/** Runs one download to completion, with the pane able to watch and cancel it. */
async function runSetup(
  what: Pick<SetupState, 'kind' | 'label'>,
  run: (ctx: { signal: AbortSignal; onProgress: (p: SetupPatch) => void }) => Promise<unknown>,
): Promise<Outcome> {
  if (state.setup) return { ok: false, reason: `${state.setup.label} is already downloading.` };
  const abort = new AbortController();
  state.setup = { ...what, status: 'starting', completed: 0, total: 0, abort };
  notifySettings();
  try {
    await run({
      signal: abort.signal,
      onProgress: (p) => setupProgress(p),
    });
    return { ok: true };
  } catch (err) {
    if (abort.signal.aborted) {
      log.info(`${what.label}: cancelled`);
      return { ok: false, reason: '' };
    }
    log.error(`${what.label} failed`, err);
    return { ok: false, reason: errorMessage(err) };
  } finally {
    state.setup = null;
    notifySettings();
  }
}

/**
 * Pulls one of the models this app is configured to use.
 *
 * Only those two: a model tag is free text, and the point of restricting it is
 * that nothing a page can invent reaches `ollama pull`. Both of these came out
 * of the settings store, which is where the offer to pull them comes from too.
 */
async function pullModel(name: string): Promise<Outcome> {
  const { settings } = ctx;
  if (!state.ollamaUp) return { ok: false, reason: `Nothing is listening at ${settings.ollamaHost}.` };
  if (![settings.transcribeModel, settings.summaryModel].includes(name)) {
    return { ok: false, reason: 'Minarrador only downloads the models it is set to use.' };
  }

  const ollama = new Ollama(settings.ollamaHost);
  const result = await runSetup({ kind: 'model', label: name }, ({ signal, onProgress }) =>
    ollama.pull(name, {
      signal,
      onProgress: (p) => onProgress({ status: p.status, completed: p.completed, total: p.total }),
    }),
  );
  if (result.ok) {
    await refreshOllama();
    notify('Model ready', `${name} is installed. Minarrador can transcribe and write notes now.`);
  } else if (result.reason) {
    notify('Could not download the model', result.reason);
  }
  return result;
}

/**
 * Fetches whisper.cpp — the binary and one set of weights — into the app's own
 * install root, and points the settings at what arrived.
 */
async function installWhisper(model: string): Promise<Outcome> {
  if (!Object.hasOwn(whisperSetup.MODELS, model)) {
    return { ok: false, reason: 'That is not a model Minarrador knows how to fetch.' };
  }
  const root = ctx.settings.whisperRoot || installRoot();
  if (!root) return { ok: false, reason: 'There is nowhere to install whisper.cpp on this machine.' };

  const result = await runSetup({ kind: 'whisper', label: `whisper.cpp · ggml-${model}` }, ({ signal, onProgress }) =>
    whisperSetup.install({
      root,
      model,
      signal,
      onProgress: (p) =>
        onProgress({
          status: p.phase === 'unpacking' ? 'unpacking' : p.label || p.phase,
          completed: p.completed ?? 0,
          total: p.total ?? 0,
        }),
    }),
  );

  if (!result.ok) {
    if (result.reason) notify('Could not install whisper.cpp', result.reason);
    return result;
  }

  // Naming the weights that arrived is what turns a finished download into a
  // live engine: applySetting re-resolves the install and re-points the live
  // transcriber, so nothing has to be restarted.
  applySetting({ whisperModel: `ggml-${model}.bin` });
  log.info('whisper.cpp installed into', root);
  notify('whisper.cpp is ready', `ggml-${model} is installed. Transcription runs locally and several times faster now.`);
  return result;
}

export function registerSettingsIpc(): void {
  // The pane that asked for the mic is gone; the test must not keep it open.
  onLibraryClosed(stopMicTest);

  ipcMain.handle('settings:get', (event) => {
    if (!fromLibrary(event)) return null;
    // Opening the pane is the one moment the free space is worth a syscall
    // outside a recording — otherwise the storage row would have nothing to say
    // until the first meeting had been recorded. checkDisk throttles itself.
    checkDisk();
    return settingsState();
  });

  ipcMain.handle('settings:set', (event, patch: unknown) => {
    if (!fromLibrary(event)) return null;
    const clean = gateLibraryPatch(patch, {
      whisperModels: ctx.whisper?.models ?? [],
      models: state.models,
      devices: ctx.capture?.devices ?? [],
    });
    if (Object.keys(clean).length) {
      applySetting(clean);
      log.info('settings changed:', Object.keys(clean).join(', '));
    }
    return settingsState();
  });

  ipcMain.handle('settings:chooseNotesFolder', async (event) => {
    if (!fromLibrary(event)) return null;
    await chooseNotesFolder();
    return settingsState();
  });

  ipcMain.handle('settings:openOllama', async (event) => {
    if (!fromLibrary(event)) return null;
    await openOllama();
    return settingsState();
  });

  // The dictations archive lives in the tray too; the settings pane is just
  // another way to find it.
  ipcMain.on('settings:openDictations', (event) => {
    if (!fromLibrary(event)) return;
    showDictationsWindow();
  });

  // Troubleshooting. None of the three takes anything from the page: the log
  // path, the diagnostics and the capture worker are all main's own.
  ipcMain.handle('settings:openLog', async (event) => {
    if (!fromLibrary(event) || !log.path) return false;
    return (await shell.openPath(log.path)) === '';
  });
  ipcMain.handle('settings:copyDiagnostics', (event) => {
    if (!fromLibrary(event)) return false;
    clipboard.writeText(diagnostics());
    return true;
  });
  // Rebuilding is the controller's job, because a recording in progress has to
  // be re-armed into the same file afterwards — this and the wake-from-sleep
  // handler both want exactly that.
  ipcMain.handle('settings:restartCapture', (event) => {
    if (!fromLibrary(event)) return false;
    ctx.capture?.restart();
    return true;
  });

  // The way out of an install that cannot transcribe anything. Both take
  // minutes, so both report progress through settings:changed rather than
  // leaving the pane on a spinner, and both can be called off.
  ipcMain.handle('settings:pullModel', async (event, name: unknown) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return pullModel(String(name ?? ''));
  });

  ipcMain.handle('settings:installWhisper', async (event, model: unknown) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return installWhisper(String(model ?? ''));
  });

  ipcMain.handle('settings:cancelSetup', (event) => {
    if (!fromLibrary(event)) return null;
    state.setup?.abort.abort();
    return settingsState();
  });

  // The mic test borrows the dictation worker's microphone; the pane is the
  // only caller, and the levels come back on settings:micTest.
  ipcMain.handle('settings:testMic', (event) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return startMicTest();
  });

  ipcMain.handle('settings:testMicStop', (event) => {
    if (!fromLibrary(event)) return null;
    stopMicTest();
    return settingsState();
  });
}
