// What the windows and the tray are told, and when.
//
// Every surface here is a view over the same state in context.ts, so the code
// that assembles each view — the settings pane's state, the library's activity,
// the tray, the health strip — lives together, beside the signals that tell a
// window its view is stale. The rule the signals follow is in their names: a
// `notify*` tells a window to re-read, a `send*` hands it the payload itself.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import log from './logger';
import * as settingsStore from './settings';
import * as snippetsStore from './snippets';
import * as library from './library';
import * as whisperSetup from './whisper-setup';
import { findOllama } from './ollama';
import { FILES, speakerLine, type Speaker } from './paths';
import { errorMessage } from './errors';
import { DISK_WARN_BYTES, PROGRESS_MIN_MS, ctx, hotkeyLabel, state, type AppState } from './context';
import { alive, sendToLibrary, sendToTranscript, windows } from './windows';
import type {
  Health,
  HealthItem,
  LibraryActivity,
  SettingsState,
  SetupState,
  TranscriptWindowState,
} from '../shared/types';

/** Launched by the login item, or otherwise asked to stay out of the way. */
export const startedHidden = process.argv.includes('--hidden');

/**
 * How long a new recording keeps the health strip up, in seconds of audio.
 *
 * Long enough for somebody on a call to have said something — the first thing
 * the strip is for is a system channel that is open and hearing nothing,
 * because the meeting is playing through a headset the loopback is not on.
 */
export const HEALTH_WINDOW_SECONDS = 10;

/**
 * The RMS a source has to reach to count as having heard something.
 *
 * The same floor the speech and silence detectors use: below it is room tone,
 * a fan, or a line with nothing on it.
 */
const HEARD_RMS = 0.006;

let lastProgressAt = 0;

/**
 * Everything the settings pane renders: the values themselves, the defaults to
 * fall back to, and what is actually installed to back them.
 *
 * The last part is the point. A model name in settings.json says nothing about
 * whether it is pulled, and the tray's radio lists could only ever show what was
 * there — the pane needs both so it can mark a setting pointing at something
 * missing rather than letting it look configured.
 */
export function settingsState(): SettingsState {
  const { settings, capture, whisper, dictation } = ctx;
  return {
    version: app.getVersion(),
    settings,
    defaults: settingsStore.defaults(),
    models: state.models,
    audioModels: state.audioModels,
    whisper: whisper?.describe() ?? null,
    ollama: {
      host: settings.ollamaHost,
      up: state.ollamaUp,
      checking: state.ollamaChecking,
      // Whether there is anything to start, which is the difference between
      // "click here" and "install it first".
      installed: Boolean(findOllama()),
    },
    liveEngine: capture?.liveTranscriber.engine ?? settings.liveEngine,
    /**
     * The microphones on this machine, and the one actually open.
     *
     * `active` is the point of the pair: a capture status of micOk: true says
     * a microphone opened, not that it is the one being talked into, and a
     * meeting recorded off the laptop lid instead of the headset looks
     * identical to a good one until it is played back.
     */
    mic: {
      devices: capture?.devices ?? [],
      active: capture?.status.micLabel ?? '',
      chosen: settings.micDeviceId,
      chosenLabel: settings.micDeviceLabel,
    },
    /** Whether a recording is being written as two channels right now. */
    recordingChannels: capture?.recordingChannels ?? 1,
    /** Free space where meetings are saved, so the pane can say before it matters. */
    disk: { free: state.disk.free, low: state.disk.free !== null && state.disk.free < DISK_WARN_BYTES },
    setup: setupState(),
    /**
     * GGML weights the app can fetch, for a machine with no whisper.cpp at all.
     *
     * Name first, then what it costs: the size and the speed are the whole basis
     * for choosing, and a dropdown of bare descriptions would not say which
     * model is being picked.
     */
    whisperModels: Object.entries(whisperSetup.MODELS).map(([value, note]) => ({
      value,
      label: `${value} — ${note}`,
    })),
    /**
     * Models named by the settings but missing from Ollama, which is precisely
     * the state a fresh install is in. Nothing else may be pulled: a tag is
     * free text, and these two came from the store rather than from a page.
     */
    pullable: [...new Set([settings.transcribeModel, settings.summaryModel])].filter(
      (name) => name && !state.models.includes(name),
    ),
    /**
     * The shortcut, the ones on offer, and whether the desktop actually gave us
     * this one — a global shortcut another application already holds registers
     * as a silent no-op, which is precisely the kind of gap this pane exists to
     * show.
     */
    hotkey: {
      value: settings.hotkey,
      registered: state.hotkeyRegistered,
      choices: settingsStore.HOTKEY_CHOICES.map((value) => ({ value, label: hotkeyLabel(value) })),
    },
    dictateHotkey: {
      value: settings.dictateHotkey,
      registered: state.dictateHotkeyRegistered,
      choices: settingsStore.DICTATE_HOTKEY_CHOICES.map((value) => ({ value, label: hotkeyLabel(value) })),
    },
    /** What the voice-input controller is doing, for the tray and the settings pane. */
    dictation: {
      active: Boolean(dictation?.active),
      transcribing: Boolean(dictation?.transcribing),
    },
    notesDirExists: fs.existsSync(settings.notesDir),
    snippetCount: snippetsStore.load().length,
    /** Capture sources cannot be changed mid-meeting; the pane says so. */
    recording: state.phase === 'recording',
  };
}

/** What the settings pane renders for a download in flight, or null. */
export function setupState(): SetupState | null {
  if (!state.setup) return null;
  const { kind, label, status, completed, total } = state.setup;
  return { kind, label, status, completed, total };
}

/** What the library shows on folders the app is still busy with. */
export function libraryActivity(): LibraryActivity {
  return {
    recordingId: state.phase === 'recording' && state.currentDir ? path.basename(state.currentDir) : null,
    processingIds: [...state.jobs.keys()].map((dir) => path.basename(dir)),
    /**
     * Where each run has got to. The tray has said "Transcribing 12/60…" since
     * the pipeline existed while the library card said only "Working…", and the
     * numbers were already being produced — they just never left this process.
     */
    processing: [...state.jobs].map(([dir, job]) => ({ id: path.basename(dir), ...job.progress })),
  };
}

// --------------------------------------------------------------------- health

/**
 * Whether the next meeting — or the one that has just started — is going to
 * produce notes, as four lights on the record button.
 *
 * Every one of these failures used to surface only after the meeting: a system
 * channel that heard nothing because the call played through a headset the
 * loopback was not on, a microphone that opened but was muted, an Ollama that
 * was not running at Stop. The first two can only be told apart from a working
 * setup by listening, which is why the strip stays up for the first ten seconds
 * of a recording and changes from "listening" to a warning if nothing arrives.
 */
export function health(): Health {
  const { settings, capture, whisper } = ctx;
  const status = capture?.status;
  const recording = state.phase === 'recording';
  const elapsed = recording ? (capture?.elapsedSeconds ?? 0) : 0;
  const early = recording && elapsed < HEALTH_WINDOW_SECONDS;

  const source = (
    key: 'mic' | 'system',
    label: string,
    enabled: boolean,
    open: boolean,
    error: string,
    heard: number,
  ): HealthItem => {
    const item = (s: HealthItem['state'], detail: string): HealthItem => ({ key, label, state: s, detail });
    if (!enabled) return item('off', 'Not recorded — turned off in Settings.');
    if (!open) return item('warn', error || (key === 'mic' ? 'The microphone did not open.' : 'System audio did not open.'));
    if (!recording) {
      return item('ok', key === 'mic' ? `Open${status?.micLabel ? `: ${status.micLabel}` : ''}.` : 'Open, ready to hear the call.');
    }
    if (heard >= HEARD_RMS) return item('ok', 'Hearing sound.');
    if (early) return item('wait', 'Listening… nothing heard yet.');
    return item(
      'warn',
      key === 'mic'
        ? 'Open, but silent so far. Is the microphone muted?'
        : 'Silent so far. Is the call playing through a different output device?',
    );
  };

  const mic = source('mic', 'Mic', settings.captureMic, Boolean(status?.micOk), status?.micError ?? '', state.heard.mic);
  const system = source(
    'system',
    'System',
    settings.captureSystem,
    Boolean(status?.systemOk),
    status?.systemError ?? '',
    state.heard.system,
  );

  const whisperItem: HealthItem = whisper?.available
    ? { key: 'whisper', label: 'Whisper', state: 'ok', detail: `Installed: ${path.basename(whisper.model)}.` }
    : {
        key: 'whisper',
        label: 'Whisper',
        state: 'warn',
        detail: 'Not installed. The Ollama audio model transcribes instead, which takes about as long as the meeting.',
      };

  const notesModel = settings.summaryModel;
  const ollamaItem: HealthItem = !state.ollamaUp
    ? { key: 'ollama', label: 'Ollama', state: 'warn', detail: 'Not running. The audio is kept, but no notes until it is.' }
    : !state.models.includes(notesModel)
      ? { key: 'ollama', label: 'Ollama', state: 'warn', detail: `Running, but ${notesModel} is not installed.` }
      : { key: 'ollama', label: 'Ollama', state: 'ok', detail: `Running, with ${notesModel}.` };

  // While recording, the strip is about what can still be fixed in this
  // meeting: the two sources. Whisper and Ollama do not change mid-call, and a
  // light that stayed amber for an hour would be noise.
  const show = !recording || early || [mic, system].some((i) => i.state === 'warn');
  return { items: [mic, system, whisperItem, ollamaItem], recording, elapsed, show };
}

/** Pushes the health strip to an open library; a no-op otherwise. */
export function sendHealth(): void {
  if (!alive(windows.library)) return;
  sendToLibrary('library:health', health());
}

/**
 * Whether the tray tick should push the health strip again: during the window
 * where a silent source turns from "listening" into a warning, and a beat
 * past it so the strip is told to go away.
 */
export const healthTicking = (): boolean =>
  state.phase === 'recording' && (ctx.capture?.elapsedSeconds ?? 0) <= HEALTH_WINDOW_SECONDS + 2;

/** Folds a level report into what each source has heard this recording. */
export function hear(levels: { mic?: number; system?: number }): void {
  if (state.phase !== 'recording') return;
  state.heard.mic = Math.max(state.heard.mic, Number(levels.mic) || 0);
  state.heard.system = Math.max(state.heard.system, Number(levels.system) || 0);
}

// ------------------------------------------------------------------- signals

/**
 * Tells an open library its list is stale.
 *
 * Sent at the four moments the folder actually changes — a recording starting
 * or ending, a pipeline run starting or finishing — rather than from
 * refreshTray, which ticks once a second while recording and would have the
 * window re-reading every transcript on disk for a clock.
 */
export function notifyLibrary(): void {
  sendToLibrary('library:changed');
  sendHealth();
  refreshTray();
  // The same four moments decide which meeting the tray offers to retry, so the
  // one walk of the folder answers both. Reading it here rather than in
  // refreshTray is the whole point: this fires four times a meeting, that fires
  // once a second.
  void findRetryCandidate().then((retry) => {
    state.retry = retry;
  });
}

/**
 * The newest meeting that has audio and no notes, which is what "Retry Notes"
 * in the tray means.
 *
 * Anything the app is currently busy with is excluded: the folder being
 * recorded into has no audio to work from yet, and one already in state.jobs is
 * having its notes written right now.
 */
async function findRetryCandidate(): Promise<AppState['retry']> {
  try {
    const recordingId = state.phase === 'recording' && state.currentDir ? path.basename(state.currentDir) : null;
    const busy = new Set([...state.jobs.keys()].map((dir) => path.basename(dir)));
    const found = (await library.listMeetings(ctx.settings.notesDir)).find(
      (m) => m.files.audio && m.status !== 'ready' && m.id !== recordingId && !busy.has(m.id),
    );
    if (!found) return null;
    const at = new Date(found.startedAt);
    const label = Number.isNaN(at.getTime())
      ? found.id
      : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return { id: found.id, label };
  } catch (err) {
    log.warn('could not look for a meeting to retry:', errorMessage(err));
    return null;
  }
}

/**
 * Tells an open library that a setting, a model list or the Ollama daemon
 * changed under it.
 *
 * Separate from {@link notifyLibrary} because the two go stale for different
 * reasons and at wildly different rates: the folder changes four times a
 * meeting, while the settings pane has to catch an Ollama poll finding the
 * daemon sixty seconds after someone clicked Open Ollama.
 */
export function notifySettings(): void {
  sendToLibrary('settings:changed');
  // Every one of these is also something the health strip reports on.
  sendHealth();
}

/**
 * Tells an open library how far a pipeline run has got.
 *
 * Its own channel because it fires on a completely different budget from
 * `library:changed`: that one means "the folder changed, re-read it", which
 * costs a walk of the notes directory, and it is sent four times a meeting.
 * This is a number moving, several times a minute, and the window updates a
 * card in place from it without touching the disk.
 */
export function notifyProgress(): void {
  const now = Date.now();
  if (now - lastProgressAt < PROGRESS_MIN_MS) return;
  lastProgressAt = now;
  sendToLibrary('library:progress', libraryActivity());
}

/**
 * Keeps the live preview on disk as it is produced.
 *
 * The preview used to exist only in a window, and was cleared the moment
 * processing started — so a pipeline that then failed left the user with audio
 * and nothing else, having thrown away text that already existed. Appended line
 * by line rather than written at the end, because the case this is for is the
 * one where there is no end: a crash, a power cut, a quit mid-meeting.
 *
 * Best-effort by design. A preview that cannot be written must never interrupt
 * the recording, which is the artefact that actually matters.
 *
 * @param speaker which channel carried the line, when the recording kept the
 *   two apart and one of them clearly did
 */
export function appendLiveTranscript(text: string, speaker: Speaker): void {
  const line = String(text ?? '').trim();
  if (!state.liveDir || !line) return;
  try {
    fs.appendFileSync(path.join(state.liveDir, FILES.liveTranscript), `${speakerLine(speaker, line)}\n`);
  } catch (err) {
    log.warn('could not append to the live transcript:', errorMessage(err));
  }
}

export function transcriptState(): TranscriptWindowState {
  const { settings, capture } = ctx;
  const engine = capture?.liveTranscriber.engine === 'whisper' ? 'whisper.cpp' : settings?.transcribeModel;
  return {
    recording: state.phase === 'recording',
    label:
      state.phase === 'recording' ? 'Recording' : state.phase === 'processing' ? state.progress || 'Processing…' : 'Idle',
    // Which engine is producing these lines. Worth showing: the two differ
    // enough in speed and phrasing that "why is this slow" has a real answer.
    engine: state.phase === 'recording' && settings?.liveTranscript ? engine : '',
  };
}

export function refreshTray(): void {
  sendToTranscript('transcript:state', transcriptState());
  const { tray, settings, capture, dictation } = ctx;
  if (!tray) return;
  tray.update({
    state: state.phase,
    elapsed: capture?.elapsedSeconds ?? 0,
    progress: state.progress,
    // The target folder, so a hover over the tray can name the meeting being
    // captured rather than only count its minutes.
    currentDir: state.phase === 'recording' && state.currentDir ? path.basename(state.currentDir) : '',
    snippets: snippetsStore.load(),
    hotkey: settings.hotkey === 'off' ? '' : hotkeyLabel(settings.hotkey),
    dictation: {
      active: Boolean(dictation?.active),
      transcribing: Boolean(dictation?.transcribing),
      hotkey: settings.dictateHotkey === 'off' ? '' : hotkeyLabel(settings.dictateHotkey),
    },
  });
}

export function diagnostics(): string {
  const { settings, capture, whisper, dictation } = ctx;
  return JSON.stringify(
    {
      version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      packaged: app.isPackaged,
      startedHidden,
      phase: state.phase,
      ollamaUp: state.ollamaUp,
      models: state.models,
      audioModels: state.audioModels,
      whisper: whisper?.describe(),
      liveEngine: capture?.liveTranscriber.engine,
      hotkeyRegistered: state.hotkeyRegistered,
      dictateActive: Boolean(dictation?.active),
      dictateHotkeyRegistered: state.dictateHotkeyRegistered,
      retry: state.retry,
      captureStatus: capture?.status,
      // Which microphones exist and which one is open — the first thing to ask
      // about "it recorded nothing" or "it recorded the wrong room".
      micDevices: capture?.devices,
      recordingChannels: capture?.recordingChannels,
      levels: capture?.levels,
      health: health().items.map(({ key, state: s, detail }) => ({ key, state: s, detail })),
      diskFreeBytes: state.disk.free,
      sleepBlocked: state.sleepBlocker !== null,
      settings,
      logPath: log.path,
    },
    null,
    2,
  );
}
