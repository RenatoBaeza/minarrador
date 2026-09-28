import test from 'node:test';
import assert from 'node:assert/strict';

import { HEALTH_WINDOW_SECONDS, health, hear } from '../src/main/ui';
import { ctx, state } from '../src/main/context';
import type { CaptureController } from '../src/main/capture';
import type { WhisperServer } from '../src/main/whisper';
import type { HealthItem, Settings } from '../src/shared/types';

// The strip under the record button exists for one failure above all: a system
// channel that is open and hearing nothing, because the call is playing through
// a device the loopback is not on. It must say "listening" while that is still
// normal, and turn amber once it is not.

function setup(t: test.TestContext, { elapsed = 0, recording = false } = {}): void {
  ctx.settings = { captureMic: true, captureSystem: true, summaryModel: 'gemma4:12b' } as Settings;
  ctx.capture = {
    status: { micOk: true, systemOk: true, micError: '', systemError: '', micLabel: 'Headset', running: true },
    elapsedSeconds: elapsed,
  } as unknown as CaptureController;
  ctx.whisper = { available: true, model: 'C:/w/ggml-base.bin' } as unknown as WhisperServer;
  Object.assign(state, {
    phase: recording ? 'recording' : 'idle',
    heard: { mic: 0, system: 0 },
    ollamaUp: true,
    models: ['gemma4:12b'],
  });
  t.after(() => {
    ctx.capture = null;
    ctx.whisper = null;
    state.phase = 'idle';
  });
}

const byKey = (items: HealthItem[]): Record<string, string> => Object.fromEntries(items.map((i) => [i.key, i.state]));

test('idle, with everything open and installed, is four green lights on screen', (t) => {
  setup(t);
  const h = health();
  assert.deepEqual(byKey(h.items), { mic: 'ok', system: 'ok', whisper: 'ok', ollama: 'ok' });
  assert.equal(h.show, true);
  assert.match(h.items[0].detail, /Headset/, 'the microphone is named, not just said to be open');
});

test('the first seconds of a silent recording are "listening", not a warning', (t) => {
  setup(t, { recording: true, elapsed: 4 });
  const h = health();
  assert.deepEqual(byKey(h.items), { mic: 'wait', system: 'wait', whisper: 'ok', ollama: 'ok' });
  assert.equal(h.show, true);
});

test('a source still silent after the window turns amber, and keeps the strip up', (t) => {
  setup(t, { recording: true, elapsed: 2 });
  hear({ mic: 0.05, system: 0.0001 }); // someone spoke; the call made no sound
  ctx.capture = { ...ctx.capture, elapsedSeconds: HEALTH_WINDOW_SECONDS + 5 } as unknown as CaptureController;

  const h = health();
  assert.deepEqual(byKey(h.items), { mic: 'ok', system: 'warn', whisper: 'ok', ollama: 'ok' });
  assert.match(h.items[1].detail, /different output device/);
  assert.equal(h.show, true, 'a problem that can still be fixed stays on screen');
});

test('a recording where both sides were heard hides the strip once the window has passed', (t) => {
  setup(t, { recording: true, elapsed: 1 });
  hear({ mic: 0.05, system: 0.03 });
  ctx.capture = { ...ctx.capture, elapsedSeconds: HEALTH_WINDOW_SECONDS + 1 } as unknown as CaptureController;
  const h = health();
  assert.deepEqual(byKey(h.items), { mic: 'ok', system: 'ok', whisper: 'ok', ollama: 'ok' });
  assert.equal(h.show, false);
});

test('a source that failed to open, or was turned off, says which', (t) => {
  setup(t);
  ctx.capture = {
    status: { micOk: false, systemOk: true, micError: 'Permission denied', systemError: '', micLabel: '', running: true },
    elapsedSeconds: 0,
  } as unknown as CaptureController;
  ctx.settings = { ...ctx.settings, captureSystem: false };
  const h = health();
  assert.equal(h.items[0].state, 'warn');
  assert.equal(h.items[0].detail, 'Permission denied');
  assert.equal(h.items[1].state, 'off');
});

test('Ollama down, or up without the notes model, is a warning', (t) => {
  setup(t);
  state.ollamaUp = false;
  assert.equal(health().items[3].state, 'warn');
  state.ollamaUp = true;
  state.models = ['something-else'];
  assert.match(health().items[3].detail, /gemma4:12b is not installed/);
});

test('levels only count while a meeting is recording', (t) => {
  setup(t);
  hear({ mic: 0.5, system: 0.5 });
  assert.deepEqual(state.heard, { mic: 0, system: 0 });
});
