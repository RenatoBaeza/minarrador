// The things the app runs on — Ollama, the settings, the global shortcut — and
// the one path every settings change is applied through.

import { app, dialog, globalShortcut } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import log from './logger';
import * as settingsStore from './settings';
import { Ollama, launchOllama } from './ollama';
import { errorMessage } from './errors';
import { ctx, delay, state } from './context';
import { notify } from './windows';
import { notifyLibrary, notifySettings, refreshTray } from './ui';
import { applySleepBlocker, checkDisk, toggleRecording } from './recording';
import { applyDictateHotkey } from './ipc/dictation';
import type { Settings } from '../shared/types';

/**
 * How long to keep looking after starting Ollama ourselves, and how often.
 *
 * A cold start is the service coming up, not a model loading, so it is seconds
 * rather than minutes — but the first run after an update can be slower, and
 * giving up early would report a failure that did not happen.
 */
const OLLAMA_START_TIMEOUT_MS = 30_000;
const OLLAMA_START_STEP_MS = 1500;

export async function refreshOllama(): Promise<void> {
  const client = new Ollama(ctx.settings.ollamaHost);
  const up = await client.isUp();
  const changed = up !== state.ollamaUp;
  state.ollamaUp = up;
  if (up && (changed || state.models.length === 0)) {
    state.models = await client.listModels();
    state.audioModels = await client.audioModels();
    // Keep the configured models pointing at something that exists.
    //
    // Tested against the installed list, never against audioModels: the audio
    // capability is probed per model with a request that reports nothing when
    // it fails, so a daemon busy loading something else can make a perfectly
    // good model look unusable. Switching on that weaker signal silently moved
    // a working setup onto whichever model Ollama happened to list first, which
    // in practice meant a smaller variant that returns repetition loops instead
    // of a transcript.
    if (state.models.length && !state.models.includes(ctx.settings.transcribeModel)) {
      const replacement = state.audioModels[0] ?? state.models[0];
      const previous = ctx.settings.transcribeModel;
      ctx.settings = settingsStore.save({ transcribeModel: replacement });
      log.warn(`transcription model ${previous} is not installed; switched to ${replacement}`);
      notify(
        'Transcription model changed',
        `${previous} is no longer installed, so Minarrador switched to ${replacement}. ` +
          'Pick another under Settings → Transcription model.',
      );
    }
    if (state.models.length && !state.models.includes(ctx.settings.summaryModel)) {
      ctx.settings = settingsStore.save({ summaryModel: state.models[0] });
      log.warn('notes model missing; switched to', ctx.settings.summaryModel);
    }
  } else if (!up) {
    state.models = [];
    state.audioModels = [];
  }
  // A model swap above changes what the live preview should be asking for.
  applyLiveConfig();
  refreshTray();
  if (changed || state.models.length) notifySettings();
}

/**
 * Starts Ollama and waits for it to answer.
 *
 * This used to be "try to find Ollama again", which asked the user to go and
 * start a daemon themselves and then come back — for the single most common
 * failure in the app, since a meeting stopped with Ollama down loses its notes.
 * The daemon is a local executable this process can perfectly well launch, so it
 * launches it and then waits, rather than waiting out the 60s poll.
 *
 * Safe to call when Ollama is already up: it becomes a refresh.
 */
export async function openOllama(): Promise<void> {
  if (state.ollamaChecking) return;
  state.ollamaChecking = true;
  refreshTray();
  notifySettings();

  let launched: string | null = null;
  try {
    if (!state.ollamaUp) launched = launchOllama();
    if (launched) log.info('starting Ollama:', launched);

    const deadline = Date.now() + OLLAMA_START_TIMEOUT_MS;
    // Always one pass, so a call with Ollama already up still refreshes the
    // model lists rather than sleeping and reporting stale ones.
    for (;;) {
      await refreshOllama();
      if (state.ollamaUp || !launched || Date.now() >= deadline) break;
      await delay(OLLAMA_START_STEP_MS);
    }
  } catch (err) {
    log.error('could not start Ollama', err);
    notify('Could not start Ollama', errorMessage(err));
    return;
  } finally {
    state.ollamaChecking = false;
    refreshTray();
    notifySettings();
  }

  if (state.ollamaUp) {
    notify('Ollama is running', `${state.models.length} model(s) available at ${ctx.settings.ollamaHost}.`);
  } else {
    notify(
      'Ollama did not answer',
      `${path.basename(launched ?? 'ollama')} was started but nothing is listening at ${ctx.settings.ollamaHost} yet.`,
    );
  }
}

/**
 * Registers the global start/stop shortcut.
 *
 * The point of a global one is the first twenty seconds of a call, where
 * finding a tray icon, right-clicking it and reading a menu is exactly the
 * amount of friction that means the meeting goes unrecorded. Registration can
 * fail without throwing — another application holding the same combination just
 * gets it — so the result is kept for the settings pane to show.
 *
 * Only this accelerator is released and re-registered: the dictation hotkey is
 * the other global shortcut, and an unregisterAll here would take it too.
 */
let meetingHotkey: string | null = null;

export function applyHotkey(): void {
  if (meetingHotkey) globalShortcut.unregister(meetingHotkey);
  meetingHotkey = null;
  state.hotkeyRegistered = false;
  const accelerator = ctx.settings.hotkey;
  if (!accelerator || accelerator === 'off') return;
  try {
    state.hotkeyRegistered = globalShortcut.register(accelerator, toggleRecording);
    if (state.hotkeyRegistered) meetingHotkey = accelerator;
  } catch (err) {
    log.warn(`could not register the hotkey ${accelerator}:`, errorMessage(err));
  }
  log.info(
    state.hotkeyRegistered ? `hotkey ${accelerator} registered` : `hotkey ${accelerator} is held by another application`,
  );
}

/**
 * Writes a settings change and applies whatever it touches.
 *
 * The single path for both surfaces that can change one — the tray, and the
 * library's settings pane — so a setting cannot end up saved but not applied
 * depending on where it was clicked.
 */
export function applySetting(patch: Partial<Settings>): Settings {
  ctx.settings = settingsStore.save(patch);
  if ('startAtLogin' in patch) applyLoginItem();
  if ('hotkey' in patch) applyHotkey();
  if ('dictateHotkey' in patch) applyDictateHotkey();
  if ('preventSleep' in patch) applySleepBlocker();
  if ('silenceStopMinutes' in patch) ctx.capture?.silence.configure({ minutes: ctx.settings.silenceStopMinutes });
  // A different microphone means a different stream, which means the graph is
  // rebuilt around it — there is no way to swap a source under a live one.
  if ('captureMic' in patch || 'captureSystem' in patch || 'micDeviceId' in patch || 'micDeviceLabel' in patch) {
    applyCaptureConfig();
  }
  // Whisper first: which engine the live transcriber can actually use depends on
  // what the server resolved to.
  if ('whisperModel' in patch || 'whisperRoot' in patch || 'whisperThreads' in patch) applyWhisperConfig();
  if ('liveTranscript' in patch || 'transcribeModel' in patch || 'liveEngine' in patch || 'whisperModel' in patch) {
    applyLiveConfig();
  }
  refreshTray();
  notifySettings();
  return ctx.settings;
}

/** Asks for a new notes folder. Everything that reads one is pointed at it. */
export async function chooseNotesFolder(): Promise<boolean> {
  const res = await dialog.showOpenDialog({
    title: 'Choose where meetings are saved',
    defaultPath: ctx.settings.notesDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return false;
  ctx.settings = settingsStore.save({ notesDir: res.filePaths[0] });
  fs.mkdirSync(ctx.settings.notesDir, { recursive: true });
  // A different folder is very likely a different volume, so everything known
  // about the free space — including whether it has been warned about — is now
  // about somewhere else.
  state.disk = { free: null, checkedAt: 0, warned: false };
  checkDisk({ force: true });
  refreshTray();
  notifySettings();
  // An open library is now looking at the wrong folder entirely.
  notifyLibrary();
  return true;
}

export function applyLoginItem(): void {
  app.setLoginItemSettings({
    openAtLogin: ctx.settings.startAtLogin,
    // Tray-only anyway, but be explicit so a future window build stays hidden.
    args: ['--hidden'],
  });
}

export function applyCaptureConfig(): void {
  const { settings } = ctx;
  ctx.capture?.setActive(true, {
    captureMic: settings.captureMic,
    captureSystem: settings.captureSystem,
    micDeviceId: settings.micDeviceId,
    micDeviceLabel: settings.micDeviceLabel,
  });
}

export function applyWhisperConfig(): void {
  const { settings } = ctx;
  ctx.whisper?.configure({
    root: settings.whisperRoot,
    model: settings.whisperModel,
    threads: settings.whisperThreads,
  });
}

export function applyLiveConfig(): void {
  const { settings } = ctx;
  ctx.capture?.configureLive({
    enabled: settings.liveTranscript,
    engine: settings.liveEngine,
    model: settings.transcribeModel,
  });
}
