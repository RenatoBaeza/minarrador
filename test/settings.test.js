'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { coerce, HOTKEY_CHOICES } = require('../src/main/settings');

/** The shape defaults() produces, without needing Electron's path lookups. */
const BASE = Object.freeze({
  notesDir: 'C:\\Users\\me\\Documents\\Minarrador',
  ollamaHost: 'http://127.0.0.1:11434',
  transcribeModel: 'gemma4:12b',
  summaryModel: 'gemma4:12b',
  captureMic: true,
  captureSystem: true,
  micDeviceId: '',
  micDeviceLabel: '',
  separateChannels: true,
  suggestOnAudio: true,
  silenceStopMinutes: 15,
  maxRecordingMinutes: 240,
  preventSleep: true,
  startAtLogin: true,
  liveTranscript: true,
  liveEngine: 'whisper',
  transcribeEngine: 'whisper',
  whisperModel: 'ggml-base.bin',
  whisperRoot: '',
  whisperThreads: 0,
  chunkSeconds: 60,
  hotkey: 'CommandOrControl+Shift+R',
});

test('coerce returns the defaults when there is nothing stored', () => {
  for (const stored of [null, undefined, '', 0]) {
    assert.deepEqual(coerce(stored, BASE), BASE);
  }
});

test('coerce accepts a valid stored file', () => {
  const stored = { ...BASE, captureMic: false, chunkSeconds: 30, summaryModel: 'qwen3.5:9b' };
  const out = coerce(stored, BASE);

  assert.equal(out.captureMic, false);
  assert.equal(out.chunkSeconds, 30);
  assert.equal(out.summaryModel, 'qwen3.5:9b');
});

test('coerce rejects values of the wrong type rather than passing them on', () => {
  const out = coerce(
    {
      notesDir: 42,
      captureMic: 'yes',
      chunkSeconds: '60',
      suggestOnAudio: null,
      summaryModel: { name: 'nope' },
    },
    BASE,
  );

  assert.equal(out.notesDir, BASE.notesDir, 'a numeric path would crash path.join at Start');
  assert.equal(out.captureMic, true);
  assert.equal(out.chunkSeconds, 60, 'a string here would make a NaN-length chunk mid-pipeline');
  assert.equal(out.suggestOnAudio, true);
  assert.equal(out.summaryModel, BASE.summaryModel);
});

test('coerce rejects a non-finite number', () => {
  assert.equal(coerce({ chunkSeconds: NaN }, BASE).chunkSeconds, 60);
  assert.equal(coerce({ chunkSeconds: Infinity }, BASE).chunkSeconds, 60);
});

test('coerce clamps chunkSeconds into a workable range', () => {
  assert.equal(coerce({ chunkSeconds: 0 }, BASE).chunkSeconds, 5);
  assert.equal(coerce({ chunkSeconds: -30 }, BASE).chunkSeconds, 5);
  assert.equal(coerce({ chunkSeconds: 99999 }, BASE).chunkSeconds, 300);
  assert.equal(coerce({ chunkSeconds: 45.7 }, BASE).chunkSeconds, 46);
});

// Both limits use 0 for "never", so the clamp must not lift them off it — a
// floor of 1 would turn "no ceiling" into "stop after a minute".
test('coerce keeps 0 as the value that turns a recording limit off', () => {
  assert.equal(coerce({ silenceStopMinutes: 0 }, BASE).silenceStopMinutes, 0);
  assert.equal(coerce({ maxRecordingMinutes: 0 }, BASE).maxRecordingMinutes, 0);
  assert.equal(coerce({ silenceStopMinutes: -5 }, BASE).silenceStopMinutes, 0);
});

test('coerce clamps a hand-edited recording limit to something that is one', () => {
  assert.equal(coerce({ silenceStopMinutes: 99999 }, BASE).silenceStopMinutes, 240);
  assert.equal(coerce({ maxRecordingMinutes: 99999 }, BASE).maxRecordingMinutes, 1440);
  assert.equal(coerce({ silenceStopMinutes: 12.6 }, BASE).silenceStopMinutes, 13);
});

test('coerce ignores blank strings, which would blank out a model name', () => {
  const out = coerce({ transcribeModel: '   ', ollamaHost: '' }, BASE);
  assert.equal(out.transcribeModel, BASE.transcribeModel);
  assert.equal(out.ollamaHost, BASE.ollamaHost);
});

// The chosen microphone defaults to '' meaning "whatever Windows picks", which
// is the one string field where empty is a real value rather than a mistake.
test('coerce lets the microphone choice fall back to the system default', () => {
  assert.equal(coerce({ micDeviceId: '   ' }, BASE).micDeviceId, '');
  assert.equal(coerce({ micDeviceId: 'abc123' }, BASE).micDeviceId, 'abc123');
  assert.equal(coerce({ micDeviceId: 42 }, BASE).micDeviceId, '', 'a non-string is not a device');
});

test('coerce trims incidental whitespace', () => {
  assert.equal(coerce({ transcribeModel: '  gemma4:12b \n' }, BASE).transcribeModel, 'gemma4:12b');
});

test('coerce drops unknown keys instead of carrying them forward', () => {
  const out = coerce({ ...BASE, injected: 'surprise', __proto__: { polluted: true } }, BASE);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(BASE).sort());
  assert.equal(out.injected, undefined);
});

test('coerce is not confused by an array', () => {
  assert.deepEqual(coerce(['not', 'a', 'settings', 'object'], BASE), BASE);
});

test('coerce does not mutate the defaults it is given', () => {
  const base = { ...BASE };
  coerce({ captureMic: false, chunkSeconds: 5 }, base);
  assert.deepEqual(base, BASE);
});

test('coerce keeps liveEngine to the engines that exist', () => {
  assert.equal(coerce({ liveEngine: 'ollama' }, BASE).liveEngine, 'ollama');
  // A typo here would otherwise reach a switch that silently picks a branch.
  assert.equal(coerce({ liveEngine: 'whispr' }, BASE).liveEngine, 'whisper');
  assert.equal(coerce({ liveEngine: 42 }, BASE).liveEngine, 'whisper');
});

test('coerce keeps transcribeEngine to the engines that exist', () => {
  assert.equal(coerce({ transcribeEngine: 'ollama' }, BASE).transcribeEngine, 'ollama');
  assert.equal(coerce({ transcribeEngine: 'whisper.cpp' }, BASE).transcribeEngine, 'whisper');
});

test('coerce accepts only shortcuts the app is willing to register', () => {
  for (const choice of HOTKEY_CHOICES) {
    assert.equal(coerce({ hotkey: choice }, BASE).hotkey, choice);
  }
  // A global shortcut is claimed against the whole desktop, so a made-up one is
  // either dead or steals a combination from another application.
  assert.equal(coerce({ hotkey: 'Ctrl+Shift+R' }, BASE).hotkey, BASE.hotkey);
  assert.equal(coerce({ hotkey: '' }, BASE).hotkey, BASE.hotkey);
  assert.equal(coerce({ hotkey: false }, BASE).hotkey, BASE.hotkey);
  // 'off' is a value rather than an empty string precisely so it survives this.
  assert.equal(coerce({ hotkey: 'off' }, BASE).hotkey, 'off');
});

test('coerce clamps whisperThreads to something a machine can run', () => {
  assert.equal(coerce({ whisperThreads: 8 }, BASE).whisperThreads, 8);
  assert.equal(coerce({ whisperThreads: -4 }, BASE).whisperThreads, 0);
  assert.equal(coerce({ whisperThreads: 5000 }, BASE).whisperThreads, 64);
  assert.equal(coerce({ whisperThreads: 6.7 }, BASE).whisperThreads, 7);
});

test('coerce leaves a partial base partial', () => {
  // defaults() is not the only caller: writing a key the base never had would
  // invent a setting rather than clamp one.
  const partial = { captureMic: true };
  assert.deepEqual(Object.keys(coerce({ liveEngine: 'ollama', whisperThreads: 4 }, partial)), ['captureMic']);
});
