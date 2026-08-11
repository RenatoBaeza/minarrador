'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { SpeechDetector, LiveTranscriber } = require('../src/main/capture');

const BYTES_PER_SECOND = 16000 * 2;
/** Mirrors LIVE_MAX_SECONDS in capture.js. */
const LIVE_MAX_BYTES = 60 * BYTES_PER_SECOND;

const pcmSeconds = (seconds) => Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));

/** Feeds `count` level readings at the given loudness. */
function feed(detector, count, rms) {
  for (let i = 0; i < count; i++) detector.push({ mic: rms, system: 0 });
}

// ------------------------------------------------------------- SpeechDetector

test('SpeechDetector fires once the room has been audible for the whole window', () => {
  const detector = new SpeechDetector({ windowSeconds: 15, ratio: 0.55, floorRms: 0.006 });
  let fired = 0;
  detector.on('speech', () => fired++);

  feed(detector, 74, 0.05); // one short of a full window
  assert.equal(fired, 0, 'should not fire before the window is full');

  feed(detector, 1, 0.05);
  assert.equal(fired, 1);
});

test('SpeechDetector ignores a notification chime', () => {
  const detector = new SpeechDetector();
  let fired = 0;
  detector.on('speech', () => fired++);

  feed(detector, 70, 0.0); // quiet room
  feed(detector, 5, 0.4); // a brief loud blip
  feed(detector, 30, 0.0);

  assert.equal(fired, 0);
});

test('SpeechDetector ignores audio below the floor', () => {
  const detector = new SpeechDetector({ floorRms: 0.006 });
  let fired = 0;
  detector.on('speech', () => fired++);
  feed(detector, 200, 0.005); // fan noise, just under the floor
  assert.equal(fired, 0);
});

test('SpeechDetector counts either source', () => {
  const detector = new SpeechDetector();
  let fired = 0;
  detector.on('speech', () => fired++);
  for (let i = 0; i < 75; i++) detector.push({ mic: 0, system: 0.05 });
  assert.equal(fired, 1, 'call audio alone should be enough');
});

test('SpeechDetector stays quiet during its cooldown, then works again', () => {
  const detector = new SpeechDetector({ cooldownMs: 50 });
  let fired = 0;
  detector.on('speech', () => fired++);

  feed(detector, 75, 0.05);
  assert.equal(fired, 1);

  feed(detector, 200, 0.05);
  assert.equal(fired, 1, 'the cooldown should suppress a second nudge');
});

test('SpeechDetector snooze mutes an in-progress conversation', () => {
  const detector = new SpeechDetector();
  let fired = 0;
  detector.on('speech', () => fired++);

  detector.snooze(60_000);
  feed(detector, 300, 0.05);
  assert.equal(fired, 0);
});

// ------------------------------------------------------------ LiveTranscriber

/** A stand-in Ollama that records what it was asked to transcribe. */
function fakeOllama(reply = async () => 'hello') {
  const calls = [];
  return {
    calls,
    async transcribe(model, wav, opts) {
      calls.push({ model, wavBytes: wav.length, opts });
      return reply(calls.length);
    },
  };
}

test('LiveTranscriber buffers nothing until it is started', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama() });
  live.configure({ enabled: true, model: 'gemma4:12b' });

  live.push(pcmSeconds(10));
  assert.equal(live.bytes, 0, 'audio outside a recording must not accumulate');
});

test('LiveTranscriber does not start without a model', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama() });
  live.configure({ enabled: true, model: '' });
  live.start();

  live.push(pcmSeconds(5));
  assert.equal(live.bytes, 0);
  live.stop();
});

test('LiveTranscriber caps its buffer instead of growing for the whole meeting', () => {
  // Regression: recorded PCM used to be appended to an array that was only
  // drained when a language had been chosen, so the default configuration grew
  // by ~115 MB an hour and never released it.
  const live = new LiveTranscriber({ ollama: fakeOllama() });
  live.configure({ enabled: true, model: 'gemma4:12b' });
  live.start();

  for (let i = 0; i < 60 * 60; i++) live.push(pcmSeconds(1)); // an hour of audio

  assert.ok(
    live.bytes <= LIVE_MAX_BYTES,
    `buffer should stay under ${LIVE_MAX_BYTES} bytes, got ${live.bytes}`,
  );
  live.stop();
});

test('LiveTranscriber releases its buffer on stop', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama() });
  live.configure({ enabled: true, model: 'gemma4:12b' });
  live.start();
  live.push(pcmSeconds(5));
  assert.ok(live.bytes > 0);

  live.stop();
  assert.equal(live.bytes, 0);
  assert.equal(live.chunks.length, 0);
});

test('LiveTranscriber emits transcribed text and drains what it sent', async () => {
  const ollama = fakeOllama();
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'gemma4:12b', language: 'Spanish' });
  live.start();
  live.push(pcmSeconds(5));

  const textPromise = once(live, 'text');
  await live.drain();
  const [text] = await textPromise;

  assert.equal(text, 'hello');
  assert.equal(ollama.calls.length, 1);
  assert.equal(ollama.calls[0].model, 'gemma4:12b');
  assert.equal(ollama.calls[0].opts.language, 'Spanish');
  // 5 seconds of PCM plus a 44-byte WAV header.
  assert.equal(ollama.calls[0].wavBytes, 5 * BYTES_PER_SECOND + 44);
  assert.equal(live.bytes, 0, 'audio already sent must not be sent again');

  live.stop();
});

test('LiveTranscriber never sends the same audio twice', async () => {
  const ollama = fakeOllama();
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'm' });
  live.start();

  live.push(pcmSeconds(3));
  await live.drain();
  live.push(pcmSeconds(2));
  await live.drain();

  assert.equal(ollama.calls.length, 2);
  assert.equal(ollama.calls[0].wavBytes, 3 * BYTES_PER_SECOND + 44);
  assert.equal(ollama.calls[1].wavBytes, 2 * BYTES_PER_SECOND + 44, 'the second request covers only new audio');

  live.stop();
});

test('LiveTranscriber keeps one request in flight at a time', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const ollama = fakeOllama(async (n) => (n === 1 ? gate.then(() => 'first') : 'second'));

  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'm' });
  live.start();

  live.push(pcmSeconds(3));
  const first = live.drain();

  live.push(pcmSeconds(3));
  await live.drain();
  assert.equal(ollama.calls.length, 1, 'a second request must not overlap the first');

  release();
  await first;
  assert.equal(live.busy, false);

  live.stop();
});

test('LiveTranscriber skips a drain with too little audio to be worth sending', async () => {
  const ollama = fakeOllama();
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'm' });
  live.start();

  live.push(Buffer.alloc(200)); // a few milliseconds
  await live.drain();
  assert.equal(ollama.calls.length, 0);

  live.stop();
});

test('LiveTranscriber survives a failing model without disturbing the recording', async () => {
  const ollama = fakeOllama(async () => {
    throw new Error('model exploded');
  });
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'm' });
  live.start();
  live.push(pcmSeconds(3));

  await assert.doesNotReject(() => live.drain());
  assert.equal(live.busy, false, 'a failure must not wedge the transcriber');

  live.stop();
});

test('LiveTranscriber stops buffering when disabled mid-recording', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama() });
  live.configure({ enabled: true, model: 'm' });
  live.start();
  live.push(pcmSeconds(2));

  live.configure({ enabled: false });
  assert.equal(live.bytes, 0);

  live.push(pcmSeconds(2));
  assert.equal(live.bytes, 0, 'a disabled transcriber must not accumulate audio');
});
