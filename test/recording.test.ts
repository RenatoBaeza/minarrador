import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  finalizeRecording,
  initRecording,
  meetingBusy,
  reprocessMeeting,
  setRecordingPaused,
  startRecording,
  stopRecording,
  type RecordingDeps,
} from '../src/main/recording';
import { ctx, state } from '../src/main/context';
import { FILES } from '../src/main/paths';
import type { CaptureController } from '../src/main/capture';
import type { RunResult } from '../src/main/pipeline';
import type { Settings } from '../src/shared/types';

// Seven things can end a meeting — the tray, the shortcut, the library, the
// silence watcher, the duration cap, a full disk, a quit — and two of them
// arriving together used to mean two pipeline runs over one folder, or a second
// caller finding the writer closed, reading that as "nothing was recorded", and
// deleting the meeting. These drive recording.ts with fakes for everything it
// touches outside the main process, and hold it to that.

function tmpDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-recording-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A capture controller that closes its file after a beat, like the real one waiting for the worklet. */
function fakeCapture(seconds: number) {
  let writing = false;
  let stops = 0;
  const capture = {
    status: { micOk: true, systemOk: true, micError: '', systemError: '', micLabel: '', running: true },
    elapsedSeconds: 0,
    paused: false,
    setPaused(on: boolean) {
      if (writing) capture.paused = on;
    },
    get stops() {
      return stops;
    },
    startRecording(file: string) {
      fs.writeFileSync(file, 'RIFF');
      writing = true;
    },
    stopRecording() {
      if (!writing) return null;
      stops++;
      capture.paused = false;
      return new Promise((resolve) =>
        setTimeout(() => {
          writing = false;
          resolve({ seconds, bytes: seconds * 32000, error: '', channels: 2 });
        }, 20),
      );
    },
  };
  return capture;
}

interface Harness {
  root: string;
  runs: string[];
  notes: string[];
  capture: ReturnType<typeof fakeCapture>;
  /** Resolves the pipeline run in flight, if the test is holding it open. */
  release: () => void;
  /** Whether the next pipeline run throws. */
  failing: (on: boolean) => void;
}

function setup(t: test.TestContext, { seconds = 5, holdPipeline = false, fail = false } = {}): Harness {
  const root = tmpDir(t);
  const runs: string[] = [];
  const notes: string[] = [];
  let release = (): void => {};
  let failNext = fail;

  const deps: RecordingDeps = {
    notify: (title) => void notes.push(title),
    refreshTray: () => {},
    notifyLibrary: () => {},
    notifySettings: () => {},
    notifyProgress: () => {},
    sendActivity: () => {},
    showLiveTranscript: () => {},
    errorBox: (title, body) => void notes.push(`${title}: ${body}`),
    openPath: () => {},
    openOllama: async () => {},
    ollamaIsUp: async () => true,
    sleepBlocker: { start: () => 1, stop: () => {} },
    freeSpace: () => 100 * 1024 ** 3,
    runPipeline: async (dir) => {
      runs.push(dir);
      if (failNext) throw new Error('Ollama is not reachable at http://127.0.0.1:11434');
      if (holdPipeline) await new Promise<void>((resolve) => (release = resolve));
      return { notes: { title: 'Done', summary: [], decisions: [], action_items: [] } } as unknown as RunResult;
    },
  };
  initRecording(deps);

  const capture = fakeCapture(seconds);
  ctx.settings = {
    notesDir: root,
    ollamaHost: 'http://127.0.0.1:1',
    liveTranscript: false,
    preventSleep: false,
    separateChannels: true,
    silenceStopMinutes: 0,
    maxRecordingMinutes: 0,
    hotkey: 'off',
    transcribeEngine: 'whisper',
  } as Settings;
  ctx.capture = capture as unknown as CaptureController;
  ctx.whisper = null;
  Object.assign(state, {
    phase: 'idle',
    currentDir: null,
    liveDir: null,
    stopping: false,
    ollamaUp: true,
    jobs: new Map(),
    disk: { free: null, checkedAt: 0, warned: false },
    sleepBlocker: null,
  });
  t.after(() => {
    ctx.capture = null;
    state.jobs.clear();
  });
  return {
    root,
    runs,
    notes,
    capture,
    release: () => release(),
    failing: (on) => {
      failNext = on;
    },
  };
}

const meetings = (root: string): string[] => fs.readdirSync(root);

test('two stops at once run the pipeline once and keep the meeting', async (t) => {
  const h = setup(t);
  startRecording();
  assert.equal(state.phase, 'recording');
  const [dir] = meetings(h.root);

  // The tray and the silence watcher, in the same tick.
  await Promise.all([stopRecording(), stopRecording(), stopRecording()]);

  assert.equal(h.capture.stops, 1, 'the file is closed once');
  assert.deepEqual(h.runs, [path.join(h.root, dir)], 'one pipeline run over the one folder');
  assert.ok(fs.existsSync(path.join(h.root, dir, FILES.audio)), 'the audio is still there');
  assert.ok(fs.existsSync(path.join(h.root, dir, FILES.meta)), 'and it was finalised');
  assert.equal(state.phase, 'idle');
  assert.equal(state.stopping, false, 'the guard is released for the next meeting');
});

test('a stop that arrives after the first has finished finds nothing to stop', async (t) => {
  const h = setup(t);
  startRecording();
  const [dir] = meetings(h.root);

  await stopRecording();
  // The duration cap firing a beat late, for a meeting already over.
  await stopRecording();
  assert.equal(await finalizeRecording(), null);

  assert.equal(h.runs.length, 1);
  assert.ok(fs.existsSync(path.join(h.root, dir, FILES.audio)), 'the late caller did not read "closed" as "empty"');
});

test('a recording under a second is discarded — once', async (t) => {
  const h = setup(t, { seconds: 0.4 });
  startRecording();
  await Promise.all([stopRecording(), stopRecording()]);
  assert.deepEqual(meetings(h.root), [], 'too short to keep');
  assert.equal(h.runs.length, 0);
  assert.equal(h.notes.filter((n) => n === 'Nothing recorded').length, 1, 'said once, not twice');
});

test('the next meeting can start while the last one is still being processed', async (t) => {
  const h = setup(t, { holdPipeline: true });
  startRecording();
  const stopping = stopRecording();
  // Let the file close and the pipeline begin.
  while (!h.runs.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(state.phase, 'processing');

  startRecording();
  assert.equal(state.phase, 'recording', 'a pipeline run does not hold up the next meeting');
  assert.equal(meetings(h.root).length, 2);

  h.release();
  await stopping;
  assert.equal(state.phase, 'recording', 'finishing the old run does not end the new recording');
});

test('a meeting mid-recording or mid-pipeline is busy: no re-run, and meetingBusy blocks a delete', async (t) => {
  const h = setup(t, { holdPipeline: true });
  startRecording();
  const [first] = meetings(h.root);
  const firstDir = path.join(h.root, first);
  assert.match(meetingBusy(firstDir), /still recording/);
  assert.equal(reprocessMeeting(first).ok, false);

  const stopping = stopRecording();
  while (!h.runs.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(meetingBusy(firstDir), /still being written/);
  assert.deepEqual(reprocessMeeting(first), { ok: false, reason: 'Those notes are already being written.' });

  h.release();
  await stopping;
  assert.equal(meetingBusy(firstDir), '');
  assert.equal(reprocessMeeting(first).ok, true, 'and once it is done, it can be');
  // Let that second run settle before the folder is removed.
  h.release();
  while (state.jobs.size) await new Promise((resolve) => setTimeout(resolve, 5));
});

test('a folder the pipeline failed on explains itself, and a re-run clears it', async (t) => {
  const h = setup(t, { fail: true });
  startRecording();
  const [id] = meetings(h.root);
  const dir = path.join(h.root, id);
  await stopRecording();

  const error = fs.readFileSync(path.join(dir, 'ERROR.txt'), 'utf8');
  assert.match(error, /Ollama is not reachable/);
  assert.match(error, /Generate notes/, 'it says how to finish the job from inside the app');
  assert.ok(fs.existsSync(path.join(dir, FILES.audio)), 'the audio is kept');

  h.failing(false);
  assert.equal(reprocessMeeting(id).ok, true);
  while (state.jobs.size) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(path.join(dir, 'ERROR.txt')), false, 'a folder never carries an explanation that stopped being true');
});

test('a pause holds the recording open, and only a recording can be paused', async (t) => {
  const h = setup(t);
  assert.equal(setRecordingPaused(true), false, 'nothing to pause while idle');

  startRecording();
  assert.equal(setRecordingPaused(true), true);
  assert.equal(h.capture.paused, true);
  assert.equal(state.phase, 'recording', 'paused is still recording, not stopped');

  assert.equal(setRecordingPaused(false), true);
  assert.equal(h.capture.paused, false);

  // A meeting stopped while paused is kept and processed like any other.
  setRecordingPaused(true);
  await stopRecording();
  assert.equal(h.runs.length, 1);
  assert.equal(setRecordingPaused(false), false, 'and there is nothing left to resume');
});
