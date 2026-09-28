// Voice input: the dictation hotkey, the mic test that borrows its worker, and
// the dictations archive window's channels.
//
// Press to start the microphone, press again to stop, transcribe locally, paste
// where you were typing, and copy it anyway. The controller owns the audio and
// the text comes back here for everything that touches the outside world — the
// clipboard, the paste, the archive, the indicator.

import { clipboard, globalShortcut, ipcMain, shell } from 'electron';
import path from 'node:path';

import log from '../logger';
import * as dictationsStore from '../dictations';
import { dictationEngineFor, type DictationResult } from '../dictation';
import { pasteClipboardInForeground } from '../paste';
import { findOllama } from '../ollama';
import { errorMessage } from '../errors';
import { clear, ctx, field, state } from '../context';
import {
  fromDictations,
  notify,
  notifyDictations,
  scheduleIndicatorHide,
  sendToDictate,
  sendToLibrary,
  showDictateIndicator,
  showDictationsWindow,
  windows,
} from '../windows';
import { refreshTray } from '../ui';
import type { MicTestUpdate, Outcome } from '../../shared/types';

/**
 * How long the settings pane's mic test may hold the microphone open.
 *
 * The test is opened and closed by the pane, but the pane can be closed over
 * an open one — and an open microphone with nobody listening to it is exactly
 * the resource leak this cap exists to prevent. Long enough to watch a meter,
 * short enough to be safe.
 */
const MIC_TEST_MAX_MS = 15_000;

/**
 * Auto-stop for the settings pane's mic test. The microphone should not stay
 * open because the window that asked for it was closed; the cap is the answer.
 */
let micTestTimer: NodeJS.Timeout | null = null;

/**
 * Registers the voice-input global shortcut.
 *
 * Separate from applyHotkey: the two accelerators are different gestures and
 * must be unregistered independently — an unregisterAll here would take the
 * meeting shortcut with it. Registration fails silently when another
 * application holds the combination, so the result is kept for the settings
 * pane, exactly as the meeting hotkey's is.
 */
export function applyDictateHotkey(): void {
  // Release the combination that is actually registered, not the one being set
  // now — applySetting has already written the new value by the time this runs.
  if (state.dictateHotkeyRegistered && state.dictateHotkeyAcc) {
    globalShortcut.unregister(state.dictateHotkeyAcc);
  }
  state.dictateHotkeyRegistered = false;
  state.dictateHotkeyAcc = null;
  const accelerator = ctx.settings.dictateHotkey;
  if (!accelerator || accelerator === 'off') return;
  try {
    state.dictateHotkeyRegistered = globalShortcut.register(accelerator, toggleDictation);
    if (state.dictateHotkeyRegistered) state.dictateHotkeyAcc = accelerator;
  } catch (err) {
    log.warn(`could not register the dictate hotkey ${accelerator}:`, errorMessage(err));
  }
  log.info(
    state.dictateHotkeyRegistered
      ? `dictate hotkey ${accelerator} registered`
      : `dictate hotkey ${accelerator} is held by another application`,
  );
}

/** One key for both ends of a dictation, exactly as for a meeting. */
export function toggleDictation(): void {
  if (ctx.dictation?.active) {
    stopDictation().catch((err: unknown) => log.error('stop from the dictate hotkey failed', err));
  } else {
    startDictation();
  }
}

function startDictation(): void {
  const { dictation, whisper, settings } = ctx;
  if (!dictation || dictation.active) return;
  // A real dictation and a settings-pane test are the same worker; the test
  // must not be holding the mic when the sentence starts.
  stopMicTest();
  // A dictation that cannot be transcribed later is not worth starting, and
  // saying so on the way in is kinder than after a sentence of audio. This
  // only fires when there is no engine on the machine at all — an Ollama that
  // is merely down can be started, and the stop path keeps the clip if it is not.
  if (!whisper?.available && !findOllama()) {
    notify('Voice input is not ready', 'Neither Ollama nor whisper.cpp is installed, so nothing could transcribe it.');
    return;
  }
  dictation.start({
    micDeviceId: settings.micDeviceId,
    micDeviceLabel: settings.micDeviceLabel,
    transcribeModel: settings.transcribeModel,
    liveEngine: settings.liveEngine,
  });
  showDictateIndicator();
  sendToDictate({ state: 'listening' });
  refreshTray();
}

/**
 * Closes the mic, transcribes what was said, and hands the text to the world.
 *
 * This is the whole feature: the paste and the clipboard and the archive all
 * fan out from the single string that comes back here.
 */
export async function stopDictation(): Promise<void> {
  const { dictation, whisper, settings } = ctx;
  if (!dictation?.active) return;
  sendToDictate({ state: 'transcribing' });
  refreshTray();

  const engine = dictationEngineFor(settings, whisper, state.ollamaUp);
  const model = engine === 'whisper' ? '' : settings.transcribeModel;
  let result: DictationResult;
  try {
    result = await dictation.stop({ engine, model });
  } catch (err) {
    log.error('dictation stop failed', err);
    sendToDictate({ state: 'error', error: errorMessage(err) });
    notify('Voice input failed', errorMessage(err));
    scheduleIndicatorHide();
    refreshTray();
    return;
  }

  refreshTray();

  if (!result.text) {
    if (result.error) {
      // The words are gone but the audio is not — the clip was kept, so the
      // failure is fixable rather than final.
      const saved = result.saved;
      const body = saved
        ? `Could not transcribe: ${result.error}. The audio is kept — open it to check.`
        : `Could not transcribe: ${result.error}.`;
      notify('Voice input failed', body, saved ? () => void shell.openPath(path.dirname(saved)) : undefined);
      sendToDictate({ state: 'error', error: result.error });
    } else {
      notify('Nothing heard', 'No speech was captured. Press the voice-input shortcut and try again.');
      sendToDictate({ state: 'error', error: 'Nothing was heard' });
    }
    scheduleIndicatorHide();
    return;
  }

  // The clipboard always gets the text, whatever happens with the paste.
  clipboard.writeText(result.text);

  // Copying to the clipboard alone would be the fallback the paste is meant to
  // avoid, so the paste runs first and its failure is reported in the same
  // notification that confirms the text.
  let pasted = false;
  if (settings.dictateAutoPaste) {
    pasted = await pasteClipboardInForeground();
    if (!pasted) log.warn('the auto-paste did not land (elevated window?) — the clipboard still holds the text');
  }

  // The archive is the history the user asked for; the paste is transient.
  dictationsStore.add(result.text);
  notifyDictations();

  const preview = result.text.length > 90 ? `${result.text.slice(0, 90)}…` : result.text;
  notify(
    pasted ? 'Dictated and pasted' : settings.dictateAutoPaste ? 'Dictated — copied to clipboard' : 'Dictated',
    `${preview}${settings.dictateAutoPaste && !pasted ? ' (could not paste here; the text is on your clipboard)' : ''}`,
    () => void showDictationsWindow(),
  );
  sendToDictate({ state: 'done' });
  scheduleIndicatorHide();
  log.info('dictation finished:', result.seconds.toFixed(1), 's');
}

/**
 * The settings pane's mic test: opens the chosen microphone and streams levels
 * to the pane, recording nothing and transcribing nothing.
 *
 * It borrows the dictation worker, which already opens the mic on demand and
 * reports an RMS level — a test is a session without the record or the
 * transcribe. The levels ride their own channel so the test can run while a
 * dictation's indicator is doing something else entirely.
 */
export function startMicTest(): Outcome {
  const { dictation, settings } = ctx;
  if (state.micTesting) return { ok: false, reason: 'A microphone test is already running.' };
  if (dictation?.active) return { ok: false, reason: 'A dictation is in progress — finish it first.' };
  state.micTesting = true;
  dictation?.startTest({
    micDeviceId: settings.micDeviceId,
    micDeviceLabel: settings.micDeviceLabel,
  });
  sendMicTest({ testing: true });
  clear(micTestTimer);
  micTestTimer = setTimeout(() => stopMicTest(), MIC_TEST_MAX_MS);
  return { ok: true };
}

/** Closes the mic the settings pane asked to hear. */
export function stopMicTest(): void {
  if (!state.micTesting) return;
  clear(micTestTimer);
  micTestTimer = null;
  state.micTesting = false;
  ctx.dictation?.stopTest();
  sendMicTest({ testing: false, level: 0 });
}

/** A level, a mic status, or the end of the test, on its own channel. */
export function sendMicTest(payload: MicTestUpdate): void {
  sendToLibrary('settings:micTest', payload);
}

/** Drops the mic test's auto-stop, on the way out. */
export function cancelMicTestTimer(): void {
  clear(micTestTimer);
  micTestTimer = null;
}

/**
 * The dictations archive is the other store a renderer can write to, so its
 * channels are sender-checked the same way the quick-copy ones are, and the
 * store normalises the payload regardless.
 */
export function registerDictationIpc(): void {
  ipcMain.handle('dictations:list', (event) => {
    if (!fromDictations(event)) return [];
    return dictationsStore.list();
  });

  ipcMain.handle('dictations:update', (event, req: unknown) => {
    if (!fromDictations(event)) return null;
    return dictationsStore.update(String(field(req, 'id') ?? ''), String(field(req, 'text') ?? ''));
  });

  ipcMain.handle('dictations:remove', (event, id: unknown) => {
    if (!fromDictations(event)) return null;
    return dictationsStore.remove(String(id ?? ''));
  });

  ipcMain.on('dictations:copy', (event, text: unknown) => {
    if (!fromDictations(event)) return;
    clipboard.writeText(String(text ?? ''));
  });

  ipcMain.on('dictations:close', (event) => {
    if (!fromDictations(event)) return;
    windows.dictations?.close();
  });
}
