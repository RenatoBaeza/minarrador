// Starting a meeting, ending it, and turning it into notes.
//
// This is the part of the app with the most callers and the least room for
// error. Seven things can end a meeting — the tray, the shortcut, the library,
// the silence watcher, the duration cap, a full disk, a quit — and the audio is
// the one artefact nothing can regenerate. Everything that has to be true about
// that lives here, in one module, and is reached from the rest of main through
// the functions it exports.
//
// Electron is never imported. Everything this module does to the outside world
// — a notification, a dialog, a window, a power-save block, the pipeline itself
// — arrives through the RecordingDeps handed to initRecording, so the invariants
// can be tested under plain Node with fakes standing in for all of it.

import fs from 'node:fs';
import path from 'node:path';

import log from './logger';
import * as library from './library';
import { transcribeEngineFor, fmtDuration, type MeetingMeta, type PipelineProgress, type RunResult, type runPipeline } from './pipeline';
import { createMeetingDir, FILES } from './paths';
import { errorMessage } from './errors';
import { DISK_WARN_BYTES, ctx, hotkeyLabel, human, state, type Job } from './context';
import type { Outcome } from '../shared/types';

/**
 * How little room the notes volume may have before a meeting is refused, and
 * before one in progress is ended.
 *
 * The floor matters more than the numbers: a disk that fills mid-meeting stops
 * the WAV growing while every other part of the app carries on saying
 * "Recording", which is the failure this app exists not to have.
 */
const DISK_REFUSE_BYTES = 300 * 1024 ** 2;
const DISK_STOP_BYTES = 150 * 1024 ** 2;
/** How often the free space is re-read while recording. */
const DISK_CHECK_MS = 30_000;

/**
 * When a long recording says so, and how often it repeats itself.
 *
 * Separate from the hard cap: the cap is for the recording nobody is watching,
 * this is for the person who is and has simply forgotten. Three hours is past
 * every real meeting and well short of the four-hour default ceiling.
 */
const LONG_RECORDING_SECONDS = 3 * 3600;
const LONG_RECORDING_REPEAT_SECONDS = 3600;

/** Everything recording does that reaches past the main process's own state. */
export interface RecordingDeps {
  notify(title: string, body: string, onClick?: (() => void) | null): void;
  refreshTray(): void;
  notifyLibrary(): void;
  notifySettings(): void;
  notifyProgress(): void;
  showTranscriptWindow(): void;
  sendToTranscript(channel: string, payload?: unknown): void;
  /** A modal error: the one way to refuse a Start with a sentence. */
  errorBox(title: string, body: string): void;
  openPath(target: string): void;
  openOllama(): Promise<void>;
  ollamaIsUp(host: string): Promise<boolean>;
  /** powerSaveBlocker, or a fake: start returns a handle, stop releases it. */
  sleepBlocker: { start(): number; stop(id: number): void };
  runPipeline: typeof runPipeline;
  /** Free bytes on the volume holding `dir`, or null when it cannot be read. */
  freeSpace(dir: string): number | null;
}

let deps: RecordingDeps | null = null;

/** Wires recording to the world. Called once from startup, and by each test. */
export function initRecording(d: RecordingDeps): void {
  deps = d;
}

const use = (): RecordingDeps => {
  if (!deps) throw new Error('recording used before initRecording');
  return deps;
};

/**
 * Free bytes on the volume the notes folder is on.
 *
 * @returns null when it cannot be read, which is treated throughout as "no
 *   reason to stop" — a filesystem that will not report its size is not a
 *   filesystem that is known to be full.
 */
export function freeSpace(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch (err) {
    log.warn('could not read the free space on', dir, errorMessage(err));
    return null;
  }
}

/**
 * Re-reads the free space, at most every DISK_CHECK_MS, and acts on it.
 *
 * Nothing else notices a disk filling up. The WavWriter reports the write that
 * finally fails, but by then the meeting has already stopped being recorded;
 * this is what makes the difference between a truncated file and a warning in
 * time to do something about it.
 */
export function checkDisk({ force = false }: { force?: boolean } = {}): number | null {
  const d = use();
  const now = Date.now();
  if (!force && now - state.disk.checkedAt < DISK_CHECK_MS) return state.disk.free;
  state.disk.checkedAt = now;
  state.disk.free = d.freeSpace(ctx.settings.notesDir);
  const free = state.disk.free;
  if (free === null) return null;

  if (state.phase === 'recording' && free < DISK_STOP_BYTES) {
    log.error(`stopping the recording: only ${human(free)} left on the notes volume`);
    d.notify('Out of disk space', `Minarrador stopped recording with ${human(free)} left. The audio so far is saved.`);
    stopRecording().catch((err: unknown) => log.error('stop on a full disk failed', err));
    return free;
  }
  if (free < DISK_WARN_BYTES && !state.disk.warned) {
    state.disk.warned = true;
    d.notify('Running out of space', `${human(free)} left where meetings are saved. An hour of recording needs about 230 MB.`);
    d.notifySettings();
  } else if (free >= DISK_WARN_BYTES && state.disk.warned) {
    state.disk.warned = false;
    d.notifySettings();
  }
  return free;
}

/**
 * Holds off system sleep for as long as a meeting is being recorded.
 *
 * `prevent-app-suspension` stops Windows suspending on idle, which is the case
 * that actually happens: a call where nobody touches the keyboard for an hour.
 * It does not — cannot — stop a lid close or an explicit sleep, so it is half
 * the answer; the other half is rebuilding the audio graph on resume, since
 * what the graph's state is after a suspend is nobody's guess.
 */
export function applySleepBlocker(): void {
  const wanted = ctx.settings.preventSleep && state.phase === 'recording';
  if (wanted === (state.sleepBlocker !== null)) return;
  const { sleepBlocker } = use();
  if (wanted) {
    state.sleepBlocker = sleepBlocker.start();
    log.info('holding off system sleep for the duration of the recording');
    return;
  }
  if (state.sleepBlocker !== null) sleepBlocker.stop(state.sleepBlocker);
  state.sleepBlocker = null;
}

export function startRecording(): void {
  if (state.phase === 'recording') return;
  const d = use();
  const { settings, capture } = ctx;
  try {
    if (!capture) throw new Error('audio capture has not started yet');
    fs.mkdirSync(settings.notesDir, { recursive: true });

    // Checked before the folder is made rather than after: a meeting that
    // cannot be written is better refused with a sentence than started and
    // silently truncated twenty minutes in.
    const free = checkDisk({ force: true });
    if (free !== null && free < DISK_REFUSE_BYTES) {
      d.errorBox(
        'Minarrador',
        `There is only ${human(free)} free where meetings are saved.\n\n` +
          'Free up some space, or choose another folder under Settings → Meetings folder.',
      );
      return;
    }

    const dir = createMeetingDir(settings.notesDir);
    state.currentDir = dir;
    state.liveDir = dir;
    state.recordingStartedAt = new Date();
    state.warnedLongAt = 0;
    state.heard = { mic: 0, system: 0 };
    capture.startRecording(path.join(dir, FILES.audio), {
      separateChannels: settings.separateChannels,
      silenceMinutes: settings.silenceStopMinutes,
    });
    state.phase = 'recording';
    applySleepBlocker();
    if (settings.liveTranscript) d.showTranscriptWindow();
    d.sendToTranscript('transcript:clear');
    d.refreshTray();
    d.notifyLibrary();
    // A recording started from a shortcut has no other confirmation at all, and
    // a tray icon changing colour is not one anywhere: this is the difference
    // between knowing the meeting is being captured and hoping it is.
    d.notify(
      'Recording',
      state.hotkeyRegistered
        ? `Minarrador is capturing this meeting. Press ${hotkeyLabel(settings.hotkey)} again to stop.`
        : 'Minarrador is capturing this meeting. Stop it from the tray icon.',
    );
  } catch (err) {
    log.error('startRecording failed', err);
    d.errorBox('Minarrador', `Could not start recording:\n\n${errorMessage(err)}`);
    state.phase = 'idle';
    applySleepBlocker();
    d.refreshTray();
  }
}

/** What the shortcut does: one key for both ends of a meeting. */
export function toggleRecording(): void {
  if (state.phase === 'recording') {
    stopRecording().catch((err: unknown) => log.error('stop from the hotkey failed', err));
  } else {
    startRecording();
  }
}

/**
 * Ends a recording nobody is going to end themselves.
 *
 * Nothing in the app used to cap a recording at all: a meeting left running on
 * a Friday was still running on Monday, and the pipeline then spent the morning
 * on a WAV of an empty office. Both limits are settings, and both default to
 * something no real meeting reaches.
 */
export function checkRecordingLimits(): void {
  if (state.phase !== 'recording') return;
  const d = use();
  const { settings, capture } = ctx;
  const elapsed = capture?.elapsedSeconds ?? 0;

  const cap = settings.maxRecordingMinutes * 60;
  if (cap && elapsed >= cap) {
    log.warn(`stopping the recording at the ${settings.maxRecordingMinutes}-minute ceiling`);
    d.notify('Recording stopped', `This meeting reached the ${fmtDuration(cap)} limit. The notes are being written now.`);
    stopRecording().catch((err: unknown) => log.error('stop at the duration cap failed', err));
    return;
  }

  // Not a cap, a reminder — for the person who is still there and has simply
  // forgotten. It repeats, because one notification three hours ago is not
  // something anybody is still looking at.
  if (elapsed >= LONG_RECORDING_SECONDS && elapsed - state.warnedLongAt >= LONG_RECORDING_REPEAT_SECONDS) {
    state.warnedLongAt = elapsed;
    d.notify(
      'Still recording',
      `Minarrador has been recording for ${fmtDuration(elapsed)}. Click to stop and write the notes.`,
      () => void stopRecording().catch((err: unknown) => log.error('stop from the long-recording notice failed', err)),
    );
  }

  checkDisk();
}

/**
 * Closes the WAV and writes meta.json, without running the pipeline.
 *
 * Split out from stopRecording so shutdown can secure the irreplaceable part —
 * the audio — without waiting on a transcription that may take minutes.
 *
 * There are now several things that can decide a meeting is over — the tray, the
 * shortcut, the library, the silence watcher, the duration cap, a full disk, a
 * quit — and two of them arriving together used to mean two pipeline runs over
 * one folder, or worse: the second call finding the writer already closed,
 * reading that as "nothing was recorded", and deleting the meeting. `stopping`
 * is what makes the first caller the only one.
 *
 * @returns null when nothing was kept
 */
export async function finalizeRecording(): Promise<{ dir: string; meta: MeetingMeta } | null> {
  const { capture } = ctx;
  if (state.phase !== 'recording' || state.stopping || !capture || !state.currentDir) return null;
  const d = use();
  state.stopping = true;
  const dir = state.currentDir;
  const startedAt = state.recordingStartedAt;
  const sources = { mic: capture.status.micOk, system: capture.status.systemOk };

  let result;
  try {
    result = await capture.stopRecording();
  } finally {
    // Released once the file is closed, not when the pipeline finishes — the
    // next meeting must not have to wait for minutes of transcription.
    state.stopping = false;
  }
  state.phase = 'idle';
  state.currentDir = null;
  applySleepBlocker();
  d.refreshTray();

  if (!result || result.seconds < 1) {
    log.warn('discarding recording shorter than a second:', dir);
    // Nothing may be written back into a folder that is about to stop existing.
    state.liveDir = null;
    fs.rmSync(dir, { recursive: true, force: true });
    d.notify('Nothing recorded', 'The recording was too short to keep.');
    d.notifyLibrary(); // The folder the library was showing as recording is gone.
    return null;
  }

  const meta: MeetingMeta = {
    startedAt: (startedAt ?? new Date()).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: result.seconds,
    sources,
    /** 2 means the file keeps the microphone and the room on separate channels. */
    channels: result.channels ?? 1,
  };
  fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta, null, 2));
  // The folder is now a meeting the library can list, notes or no notes.
  d.notifyLibrary();
  return { dir, meta };
}

/**
 * How a folder tells someone how to finish the job.
 *
 * Both notes used to say only `npm run pipeline -- "<dir>"`, which assumes a
 * repository, a checkout and npm — none of which exist for anyone who installed
 * the build. The app can now do it itself, so that is what these say first.
 */
const HOW_TO_FINISH =
  'Open Minarrador (left-click the tray icon), pick this recording, and press Generate notes.\n' +
  'From a source checkout you can also run:\n\n  npm run pipeline -- "%DIR%"\n';

const howToFinish = (dir: string): string => HOW_TO_FINISH.replace('%DIR%', dir);

/**
 * Leaves a folder able to explain itself.
 *
 * A meeting folder with audio in it and no notes looks identical whether the app
 * quit mid-recording, quit mid-pipeline, or never ran the pipeline at all. This
 * is what tells the three apart, and it carries the way to finish the job — the
 * audio is the irreplaceable part, and it is already safe on disk.
 *
 * Synchronous on purpose: both callers are on the quit path, where nothing waits
 * for a promise.
 */
export function writeResumeNote(dir: string, reason: string): void {
  try {
    fs.writeFileSync(
      path.join(dir, 'UNPROCESSED.txt'),
      `${reason}\n\nThe audio is still in ${FILES.audio}.\n\n${howToFinish(dir)}`,
    );
  } catch (err) {
    log.warn('could not write the resume note in', dir, errorMessage(err));
  }
}

export async function stopRecording(): Promise<void> {
  const finished = await finalizeRecording();
  if (!finished) return;
  const d = use();
  const { settings, whisper } = ctx;

  // The pipeline is minutes of work and the notification at the end of it is
  // the next thing anybody hears, so say the audio is safe now — for a stop
  // from the shortcut this is the only acknowledgement there is — and what
  // happens next, since "Writing the notes now…" under-describes the run.
  //
  // An unreachable daemon is the one failure worth warning about *now* rather
  // than at the end of the run: with whisper doing the transcription the run
  // spends its whole length with Ollama still missing before the notes stage
  // fails, and with Ollama transcribing it fails on the first request. Starting
  // the daemon here, from the notification, means the notes are written when
  // the run gets to them — the difference between a folder that needs a second
  // click and a meeting that just finished. The fast path (the 60s poll already
  // knows it is up) costs nothing; the check only runs a request when that says
  // it is down.
  let plan = 'Transcribing, then the notes and the PDF brief.';
  let onClick: (() => void) | null = null;
  if (!state.ollamaUp && !(await d.ollamaIsUp(settings.ollamaHost))) {
    plan =
      transcribeEngineFor(settings, whisper) === 'whisper'
        ? 'Ollama is not running, so the notes cannot be written yet. Click to start it — the transcription carries on either way.'
        : 'Ollama is not running, so the notes cannot be written. Click to start it and generate them again.';
    onClick = () => void d.openOllama().catch((err: unknown) => log.error('openOllama from the stop notification failed', err));
  }
  d.notify('Recording saved', `${fmtDuration(finished.meta.durationSeconds ?? 0)} captured. ${plan}`, onClick);

  // The folder is never opened on its own: the completion notification is the
  // "your notes are ready" signal, and clicking it is what opens the folder.
  await processMeeting(finished.dir, finished.meta);
}

/**
 * Runs the pipeline over a finished recording.
 *
 * @returns the pipeline result, or null if it failed — callers use that to tell
 *   a complete folder from a half-written one.
 */
export async function processMeeting(dir: string, meta: MeetingMeta): Promise<RunResult | null> {
  const d = use();
  // The rough live preview is superseded by the proper pass that follows, so
  // clear it — but never force a window open on someone who closed it. The
  // preview's own file stays on disk until the pipeline writes a real
  // transcript over the top of it.
  d.sendToTranscript('transcript:clear');

  // A folder carries one explanation at a time, and both of these are now out
  // of date. Left in place, a successful re-run would keep the meeting marked
  // as failed in the library for ever.
  for (const name of ['ERROR.txt', 'UNPROCESSED.txt']) {
    fs.rmSync(path.join(dir, name), { force: true });
  }

  const abort = new AbortController();
  const job: Job = { abort, progress: { phase: 'preparing', done: 0, total: 0, label: 'Preparing…' } };
  state.jobs.set(dir, job);
  if (state.phase === 'idle') state.phase = 'processing';
  state.progress = job.progress.label;
  d.refreshTray();
  d.notifyLibrary();

  const onProgress = (p: PipelineProgress): void => {
    if (p.phase === 'transcribing') {
      state.progress = `Transcribing ${p.done}/${p.total}…`;
      if (p.text) d.sendToTranscript('transcript:line', { text: p.text, speaker: p.speaker });
    } else if (p.phase === 'summarising') {
      state.progress = p.total ? `Condensing ${p.done}/${p.total}…` : 'Writing notes…';
    } else if (p.phase === 'designing') {
      state.progress = 'Designing the brief…';
    } else if (p.phase === 'rendering') {
      state.progress = 'Exporting PDF…';
    }
    // Kept per meeting as well as on the tray: two runs can overlap — stopping
    // one meeting while the previous is still processing is allowed — and a
    // single progress string cannot say which card it belongs to.
    job.progress = { phase: p.phase, done: p.done ?? 0, total: p.total ?? 0, label: state.progress };
    d.refreshTray();
    d.notifyProgress();
  };

  try {
    // whisper.cpp transcribes the saved audio too when it is installed, which
    // is what leaves Ollama needed only for the notes.
    const out = await d.runPipeline(dir, ctx.settings, { onProgress, meta, signal: abort.signal, whisper: ctx.whisper });
    state.lastDir = dir;
    log.info('pipeline complete:', dir);
    d.notify(
      out.notes.title,
      `${fmtDuration(meta.durationSeconds ?? 0)} · ${out.notes.action_items.length} action item(s). Click to open the folder.`,
      () => d.openPath(dir),
    );
    return out;
  } catch (err) {
    // A run cancelled by quit is not a failure to report: shutdown has already
    // left its own note in the folder, and there is nobody left to notify.
    if (abort.signal.aborted) {
      log.warn('pipeline cancelled for', dir);
      return null;
    }
    log.error('pipeline failed for', dir, err);
    const message = errorMessage(err);
    try {
      fs.writeFileSync(
        path.join(dir, 'ERROR.txt'),
        `Processing failed at ${new Date().toISOString()}\n\n${(err instanceof Error && err.stack) || message}\n\n` +
          `The audio is still in ${FILES.audio}. Fix the problem (usually: start Ollama, or pull the model),\n` +
          `then generate the notes again.\n\n${howToFinish(dir)}`,
      );
    } catch {}
    d.notify('Notes failed', `${message.slice(0, 180)} — audio was saved. Click to open the folder.`, () =>
      d.openPath(dir),
    );
    return null;
  } finally {
    state.jobs.delete(dir);
    if (state.jobs.size === 0) {
      if (state.phase === 'processing') state.phase = 'idle';
      state.progress = '';
    }
    d.refreshTray();
    // Whichever way the run ended, the folder now holds something new to read.
    d.notifyLibrary();
    // The transcript window stays open; closing it is the user's call.
  }
}

/**
 * Runs the pipeline again over a meeting that already has its audio.
 *
 * The most likely failure in the app is Ollama not running at the moment
 * someone hits Stop, and until this existed the only way out of it was a
 * checkout, npm, and a command line — so for anyone who installed the build,
 * every meeting recorded before starting the daemon was a dead folder. The
 * chain is re-runnable and each stage overwrites its own artefact, so this is
 * simply {@link processMeeting} again.
 *
 * Not awaited by its callers: a run is minutes of work, and both the tray and
 * the library find out it finished from `library:changed` like everything else.
 *
 * @param id meeting folder name, as the library names one
 */
export function reprocessMeeting(id: string): Outcome {
  const dir = library.meetingDir(ctx.settings.notesDir, id);
  if (!dir) return { ok: false, reason: 'That recording is not in the meetings folder any more.' };
  if (!fs.existsSync(path.join(dir, FILES.audio))) {
    return { ok: false, reason: 'There is no audio in that folder to work from.' };
  }
  if (state.jobs.has(dir)) return { ok: false, reason: 'Those notes are already being written.' };
  if (state.phase === 'recording' && state.currentDir === dir) {
    return { ok: false, reason: 'That meeting is still recording.' };
  }

  // meta.json is written when the audio file closes, so it is normally there
  // even for a meeting that never got its notes. A folder missing it still has
  // its audio, and the pipeline fills the duration in from the WAV itself.
  let meta: MeetingMeta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, FILES.meta), 'utf8')) as MeetingMeta;
  } catch {
    meta = { startedAt: fs.statSync(path.join(dir, FILES.audio)).mtime.toISOString(), durationSeconds: 0 };
  }

  log.info('generating notes again for', dir);
  processMeeting(dir, meta).catch((err: unknown) => log.error('re-running the pipeline failed for', dir, err));
  return { ok: true };
}

/**
 * Whether `dir` is the meeting being recorded or one whose notes are being
 * written — the two states in which nothing may delete, rename or re-run it.
 */
export function meetingBusy(dir: string): string {
  if (state.phase === 'recording' && state.currentDir === dir) return 'That meeting is still recording.';
  if (state.jobs.has(dir)) return 'Those notes are still being written.';
  return '';
}
