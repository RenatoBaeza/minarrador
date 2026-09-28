import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CaptureController, type CapturePlatform, type IpcSender, type WorkerWindow } from '../src/main/capture';

// A dead capture renderer is the one failure that must not pass unnoticed:
// nothing else in the main process notices it, the tray still says Recording,
// and the WAV simply stops growing. The controller rebuilds the worker and
// re-arms it into the *same* file. These drive that path with a fake window
// and a fake IPC bus, under plain Node.

/** A worker window that records what it was told, and can be made to crash. */
class FakeWindow implements WorkerWindow {
  static nextId = 100;
  readonly sent: [string, ...unknown[]][] = [];
  readonly events = new EventEmitter();
  destroyed = false;
  readonly webContents = {
    id: FakeWindow.nextId++,
    send: (channel: string, ...args: unknown[]) => void this.sent.push([channel, ...args]),
    on: (event: 'render-process-gone', fn: (e: unknown, details: { reason?: string; exitCode?: number }) => void) =>
      void this.events.on(event, fn),
  };
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
  crash(): void {
    this.events.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  }
}

function harness(t: test.TestContext) {
  const bus = new EventEmitter();
  const windows: FakeWindow[] = [];
  const platform: CapturePlatform = {
    on: (channel, listener) => void bus.on(channel, listener as (...args: unknown[]) => void),
    createWindow: () => {
      const win = new FakeWindow();
      windows.push(win);
      return { win, loaded: Promise.resolve() };
    },
  };
  const capture = new CaptureController({ platform, recoverDelayMs: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-capture-'));
  t.after(() => {
    capture.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** A message from a window, as the renderer would send it. */
  const from = (win: FakeWindow, channel: string, ...args: unknown[]): void => {
    const event: IpcSender = { sender: { id: win.webContents.id } };
    bus.emit(channel, event, ...args);
  };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
  return { capture, windows, from, settle, file: path.join(dir, 'audio.wav') };
}

const pcm = (bytes: number): ArrayBuffer => new ArrayBuffer(bytes);

test('a crashed worker is rebuilt and keeps writing the same file', async (t) => {
  const { capture, windows, from, settle, file } = harness(t);
  await capture.init();
  from(windows[0], 'capture:status', { micOk: true, systemOk: false, running: true });
  capture.startRecording(file, { separateChannels: false });
  const writer = capture.writer;
  from(windows[0], 'capture:pcm', pcm(3200));
  assert.equal(writer?.dataBytes, 3200);

  const gone: unknown[] = [];
  capture.on('rendererGone', (info) => gone.push(info));
  windows[0].crash();
  assert.deepEqual(gone, [{ reason: 'crashed', exitCode: 1, wasRecording: true, recovering: true }]);
  await settle();

  assert.equal(windows.length, 2, 'a new worker was built');
  assert.equal(windows[0].destroyed, true, 'and the dead one torn down');
  assert.equal(capture.writer, writer, 'the same WavWriter is still open');
  assert.deepEqual(
    windows[1].sent.map(([channel]) => channel),
    ['capture:configure', 'capture:setRecording'],
    'the new worker is configured, then re-armed into the recording',
  );
  assert.deepEqual(windows[1].sent[1], ['capture:setRecording', true, 1]);

  // Audio from the new worker lands in the same file; the dead one's is ignored.
  from(windows[1], 'capture:pcm', pcm(1600));
  from(windows[0], 'capture:pcm', pcm(9999));
  assert.equal(writer?.dataBytes, 4800);

  const result = await capture.stopRecording();
  assert.equal(result?.bytes, 4800);
  assert.equal(fs.statSync(file).size, 44 + 4800, 'one file, with both halves of the meeting in it');
});

test('the rebuild budget resets once a rebuilt graph reports itself running', async (t) => {
  const { capture, windows, from, settle } = harness(t);
  await capture.init();

  // Three crashes in a row are each rebuilt…
  for (let i = 0; i < 3; i++) {
    windows[windows.length - 1].crash();
    await settle();
  }
  assert.equal(capture.recoveries, 3);
  assert.equal(windows.length, 4);

  // …but a graph that comes up healthy wipes the slate clean.
  from(windows[3], 'capture:status', { running: true, micOk: true });
  assert.equal(capture.recoveries, 0);
  windows[3].crash();
  await settle();
  assert.equal(windows.length, 5, 'so the next crash is rebuilt too');
});

test('a worker that cannot stay up is reported once, not retried for ever', async (t) => {
  const { capture, windows, settle } = harness(t);
  await capture.init();
  const gone: { recovering: boolean }[] = [];
  capture.on('rendererGone', (info) => gone.push(info));

  for (let i = 0; i < 4; i++) {
    windows[windows.length - 1].crash();
    await settle();
  }
  assert.deepEqual(
    gone.map((g) => g.recovering),
    [true, true, true, false],
  );
  assert.equal(windows.length, 4, 'the fourth crash is not rebuilt');
});

test('a crash of a window already being replaced does not start another rebuild', async (t) => {
  const { capture, windows, settle } = harness(t);
  await capture.init();
  windows[0].crash();
  await settle();
  // The old window's teardown can raise the same event after it was replaced.
  windows[0].crash();
  await settle();
  assert.equal(windows.length, 2);
  assert.equal(capture.recoveries, 1);
});
