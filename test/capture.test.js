'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { SpeechDetector, SilenceDetector, LiveTranscriber } = require('../src/main/capture');

const BYTES_PER_SECOND = 16000 * 2;
/** Mirrors LIVE_MAX_SECONDS in capture.js. */
const LIVE_MAX_BYTES = 20 * BYTES_PER_SECOND;

/** One second of a 300 Hz tone, comfortably above the live silence gate. */
const TONE_SECOND = (() => {
  const buf = Buffer.alloc(BYTES_PER_SECOND);
  for (let i = 0; i < buf.length; i += 2) {
    buf.writeInt16LE(Math.round(Math.sin(((i / 2) * 2 * Math.PI * 300) / 16000) * 8000), i);
  }
  return buf;
})();

/** `seconds` of audible PCM — silence is deliberately skipped, so tests need sound. */
const pcmSeconds = (seconds) => {
  const out = Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));
  for (let off = 0; off < out.length; off += TONE_SECOND.length) TONE_SECOND.copy(out, off);
  return out;
};

const silentSeconds = (seconds) => Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));

/**
 * `seconds` of two-channel PCM, with each side either audible or silent.
 *
 * The layout the app records when both sources are live: left is the
 * microphone, right is everything the system played.
 */
function stereoSeconds(seconds, { mic = false, system = false } = {}) {
  const frames = Math.round(seconds * 16000);
  const out = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) {
    const sample = Math.round(Math.sin((f * 2 * Math.PI * 300) / 16000) * 8000);
    if (mic) out.writeInt16LE(sample, f * 4);
    if (system) out.writeInt16LE(sample, f * 4 + 2);
  }
  return out;
}

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

// ------------------------------------------------------------ SilenceDetector
//
// The other half of the same machinery: SpeechDetector exists to notice a
// meeting starting, this one to notice one that ended without anybody pressing
// Stop. Nothing else in the app caps a recording at all.

/** Feeds `minutes` of level readings, which arrive five a second. */
const feedMinutes = (detector, minutes, rms) => feed(detector, Math.round(minutes * 60 * 5), rms);

test('SilenceDetector fires once a recording has been quiet for the configured stretch', () => {
  const detector = new SilenceDetector({ minutes: 5 });
  let fired = 0;
  detector.on('silence', () => fired++);

  feedMinutes(detector, 4.9, 0);
  assert.equal(fired, 0, 'a long pause in a real meeting is not the end of it');

  feedMinutes(detector, 0.2, 0);
  assert.equal(fired, 1);
});

test('SilenceDetector restarts its count the moment anybody speaks', () => {
  const detector = new SilenceDetector({ minutes: 5 });
  let fired = 0;
  detector.on('silence', () => fired++);

  feedMinutes(detector, 4.9, 0);
  feed(detector, 1, 0.05); // somebody says something
  feedMinutes(detector, 4.9, 0);

  assert.equal(fired, 0, 'the stretch has to be unbroken');
});

test('SilenceDetector counts either source as the room being audible', () => {
  const detector = new SilenceDetector({ minutes: 1 });
  let fired = 0;
  detector.on('silence', () => fired++);

  // Nobody in the room, but the call is still making noise.
  for (let i = 0; i < 5 * 60 * 2; i++) detector.push({ mic: 0, system: 0.05 });
  assert.equal(fired, 0);
});

test('SilenceDetector fires once, not all the way down', () => {
  const detector = new SilenceDetector({ minutes: 1 });
  let fired = 0;
  detector.on('silence', () => fired++);

  feedMinutes(detector, 5, 0);
  assert.equal(fired, 1, 'the recording is already being stopped; a second event only races the first');
});

test('SilenceDetector does nothing at all when it is turned off', () => {
  const detector = new SilenceDetector({ minutes: 0 });
  let fired = 0;
  detector.on('silence', () => fired++);

  feedMinutes(detector, 600, 0); // ten hours of nothing
  assert.equal(fired, 0);
});

test('SilenceDetector is re-armed by reset, for the next meeting', () => {
  const detector = new SilenceDetector({ minutes: 1 });
  let fired = 0;
  detector.on('silence', () => fired++);

  feedMinutes(detector, 2, 0);
  assert.equal(fired, 1);

  detector.reset();
  feedMinutes(detector, 2, 0);
  assert.equal(fired, 2);
});

// ------------------------------------------------------------ LiveTranscriber

/** A stand-in Ollama that records what it was asked to transcribe. */
function fakeOllama(reply = async () => 'hello') {
  const calls = [];
  const preloaded = [];
  return {
    calls,
    preloaded,
    async preload(model) {
      preloaded.push(model);
      return true;
    },
    async transcribe(model, wav, opts) {
      calls.push({ model, wavBytes: wav.length, opts });
      return reply(calls.length);
    },
  };
}

/** A stand-in whisper.cpp server. `available` decides whether it gets used. */
function fakeWhisper(reply = async () => 'whisper line', { available = true, ready = async () => true } = {}) {
  const calls = [];
  const state = { readied: 0 };
  return {
    calls,
    state,
    available,
    async ensureReady() {
      state.readied++;
      return ready();
    },
    async transcribe(wav, opts) {
      calls.push({ wavBytes: wav.length, opts });
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

test('LiveTranscriber keeps buffering while a request is in flight', async () => {
  // Regression: buffering was gated on the interval handle, which the chained
  // scheduler clears for the duration of a request — everything said while the
  // model was thinking went missing from the preview.
  let release;
  const gate = new Promise((r) => (release = r));
  const ollama = fakeOllama(async () => gate.then(() => 'text'));

  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'm' });
  live.start();

  live.push(pcmSeconds(5));
  const inFlight = live.drain();

  live.push(pcmSeconds(3));
  assert.equal(live.bytes, 3 * BYTES_PER_SECOND, 'audio recorded during a request must be kept');

  release();
  await inFlight;
  live.stop();
});

test('LiveTranscriber warms the model when a recording starts', () => {
  const ollama = fakeOllama();
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'gemma4:12b' });
  live.start();

  assert.deepEqual(ollama.preloaded, ['gemma4:12b'], 'the load should not land on the first window');
  live.stop();
});

test('LiveTranscriber warms a model swapped in mid-recording', () => {
  const ollama = fakeOllama();
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'gemma4:e4b' });
  live.start();
  live.configure({ model: 'gemma4:12b' });

  assert.deepEqual(ollama.preloaded, ['gemma4:e4b', 'gemma4:12b']);
  live.stop();
});

test('LiveTranscriber does not ask the model to transcribe a silent window', async () => {
  const ollama = fakeOllama();
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'm' });
  live.start();

  live.push(silentSeconds(5)); // an empty room
  await live.drain();

  assert.equal(ollama.calls.length, 0, 'silence invites the model to invent a line');
  assert.equal(live.bytes, 0, 'the window is still consumed, not left to pile up');
  live.stop();
});

test('LiveTranscriber survives an Ollama client with no preload support', () => {
  const ollama = fakeOllama();
  delete ollama.preload;
  const live = new LiveTranscriber({ ollama });
  live.configure({ enabled: true, model: 'm' });

  assert.doesNotThrow(() => live.start());
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

// ------------------------------------------------------- engine choice

test('LiveTranscriber uses whisper.cpp when it is installed', async () => {
  const ollama = fakeOllama();
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama, whisper });
  live.configure({ enabled: true, engine: 'whisper', model: 'gemma4:12b', language: 'German' });
  live.start();
  live.push(pcmSeconds(3));
  await live.drain();

  assert.equal(live.engine, 'whisper');
  assert.equal(ollama.calls.length, 0, 'the audio model should not be asked as well');
  assert.equal(whisper.calls.length, 1);
  assert.equal(whisper.calls[0].opts.language, 'German');
  assert.equal(whisper.calls[0].wavBytes, 3 * BYTES_PER_SECOND + 44);

  live.stop();
});

test('LiveTranscriber falls back to Ollama when whisper.cpp is not installed', async () => {
  const ollama = fakeOllama();
  const whisper = fakeWhisper(undefined, { available: false });
  const live = new LiveTranscriber({ ollama, whisper });
  live.configure({ enabled: true, engine: 'whisper', model: 'gemma4:12b' });
  live.start();
  live.push(pcmSeconds(5));
  await live.drain();

  assert.equal(live.engine, 'ollama', 'a missing binary must not take the preview down with it');
  assert.equal(whisper.calls.length, 0);
  assert.equal(ollama.calls.length, 1);

  live.stop();
});

test('LiveTranscriber honours an explicit choice of Ollama', async () => {
  const ollama = fakeOllama();
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama, whisper });
  live.configure({ enabled: true, engine: 'ollama', model: 'gemma4:12b' });
  live.start();
  live.push(pcmSeconds(5));
  await live.drain();

  assert.equal(whisper.calls.length, 0);
  assert.equal(ollama.calls.length, 1);

  live.stop();
});

test('LiveTranscriber runs on whisper.cpp with no Ollama audio model configured', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper() });
  live.configure({ enabled: true, engine: 'whisper', model: '' });
  live.start();

  assert.equal(live.running, true, 'whisper.cpp does not need an Ollama model name');
  live.push(pcmSeconds(2));
  assert.ok(live.bytes > 0);

  live.stop();
});

test('LiveTranscriber starts the whisper server when a recording starts', () => {
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start();

  assert.equal(whisper.state.readied, 1, 'loading the model should not land on the first caption');
  live.stop();
});

test('LiveTranscriber survives a whisper server that will not start', async () => {
  const whisper = fakeWhisper(undefined, {
    ready: async () => {
      throw new Error('port in use');
    },
  });
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });

  assert.doesNotThrow(() => live.start());
  // A rejected warm-up must be handled, not left to crash the main process.
  await new Promise((r) => setImmediate(r));
  assert.equal(live.running, true);

  live.stop();
});

test('LiveTranscriber hands whisper the previous line as context', async () => {
  const whisper = fakeWhisper(async (n) => (n === 1 ? 'we should ship the' : 'release on Friday'));
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start();

  live.push(pcmSeconds(3));
  await live.drain();
  live.push(pcmSeconds(3));
  await live.drain();

  assert.equal(whisper.calls[0].opts.prompt, '', 'nothing precedes the first segment');
  assert.equal(
    whisper.calls[1].opts.prompt,
    'we should ship the',
    'a sentence split across segments should not restart mid-phrase',
  );

  live.stop();
});

test('LiveTranscriber forgets the previous line between recordings', async () => {
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start();
  live.push(pcmSeconds(3));
  await live.drain();
  live.stop();

  live.start();
  live.push(pcmSeconds(3));
  await live.drain();

  assert.equal(whisper.calls[1].opts.prompt, '', 'last week\'s meeting is not context for this one');
  live.stop();
});

// -------------------------------------------------------- segment boundaries

test('LiveTranscriber waits for a pause before sending a segment', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper() });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start();

  live.push(pcmSeconds(3));
  assert.equal(live.segmentReady, false, 'cutting mid-word loses the word');

  live.push(silentSeconds(0.7));
  assert.equal(live.segmentReady, true, 'the speaker stopped, so the line can go out');

  live.stop();
});

test('LiveTranscriber ignores a pause too short to be one', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper() });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start();

  live.push(pcmSeconds(3));
  live.push(silentSeconds(0.25)); // a breath between words
  assert.equal(live.segmentReady, false);

  live.push(pcmSeconds(1)); // and they carry on
  assert.equal(live.segmentReady, false, 'the pause counter must restart when speech resumes');

  live.stop();
});

test('LiveTranscriber needs more than a blip to call it a segment', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper() });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start();

  live.push(pcmSeconds(0.3));
  live.push(silentSeconds(0.7));
  assert.equal(live.segmentReady, false, 'a chair scrape is not an utterance');

  live.stop();
});

test('LiveTranscriber cuts through someone who never pauses', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper() });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start();

  live.push(pcmSeconds(11));
  assert.equal(live.segmentReady, false);

  live.push(pcmSeconds(1.5));
  assert.equal(live.segmentReady, true, 'waiting for a pause that never comes would strand the caption');

  live.stop();
});

// ------------------------------------------------ two-channel live transcription
//
// A two-channel recording is folded back to mono before it is sent: the saved
// transcript transcribes the sides separately, but this is the one place with a
// realtime floor to clear, and doubling the requests would be the wrong trade.
// The speaker is inferred from which channel carried the segment instead.

test('LiveTranscriber sends one mono request for a two-channel recording', async () => {
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start(2);

  live.push(stereoSeconds(3, { mic: true }));
  await live.drain();

  assert.equal(whisper.calls.length, 1, 'one decode, not one per channel');
  // Three seconds of stereo is six seconds of bytes; the WAV that goes out is
  // three seconds of mono.
  assert.equal(whisper.calls[0].wavBytes, 3 * BYTES_PER_SECOND + 44);

  live.stop();
});

test('LiveTranscriber attributes a segment to the side that carried it', async () => {
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start(2);

  live.push(stereoSeconds(3, { mic: true }));
  const mine = once(live, 'text');
  await live.drain();
  assert.deepEqual((await mine).slice(0, 2), ['whisper line', 'mic']);

  live.push(stereoSeconds(3, { system: true }));
  const theirs = once(live, 'text');
  await live.drain();
  assert.deepEqual((await theirs).slice(0, 2), ['whisper line', 'system']);

  live.stop();
});

test('LiveTranscriber declines to guess when both sides talked over each other', async () => {
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start(2);

  live.push(stereoSeconds(3, { mic: true, system: true }));
  const spoken = once(live, 'text');
  await live.drain();

  // Leakage between the channels is normal — the microphone hears the speakers —
  // so a side has to have carried most of the segment before its name goes on it.
  assert.equal((await spoken)[1], '', 'a wrong label is worse than none');
  live.stop();
});

test('LiveTranscriber never labels a mono recording', async () => {
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start(1);

  live.push(pcmSeconds(3));
  const spoken = once(live, 'text');
  await live.drain();

  assert.equal((await spoken)[1], '', 'there is only one channel to have said it');
  live.stop();
});

test('LiveTranscriber measures a two-channel segment in seconds, not in bytes', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper() });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start(2);

  // Six seconds of stereo bytes but only three seconds of meeting, which is
  // under the 12-second ceiling that forces a cut.
  live.push(stereoSeconds(3, { mic: true }));
  assert.equal(live.segmentReady, false, 'a pause has not happened yet');

  live.push(stereoSeconds(0.7, {}));
  assert.equal(live.segmentReady, true);

  live.stop();
});

test('LiveTranscriber caps a two-channel buffer by duration, not by size', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper() });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start(2);

  for (let i = 0; i < 120; i++) live.push(stereoSeconds(1, { mic: true }));

  // The ceiling is 20 seconds of meeting, which in stereo is twice the bytes.
  assert.ok(live.bytes <= LIVE_MAX_BYTES * 2, `expected under ${LIVE_MAX_BYTES * 2} bytes, got ${live.bytes}`);
  assert.ok(live.bytes > LIVE_MAX_BYTES, 'and not half as much audio as a mono recording would keep');
  live.stop();
});

test('LiveTranscriber hears one loud side over a silent one', async () => {
  // Measured across both channels the same speech reads 3 dB quieter, which
  // would push a quiet utterance under the gate and drop the line entirely.
  const whisper = fakeWhisper();
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper });
  live.configure({ enabled: true, engine: 'whisper' });
  live.start(2);

  live.push(stereoSeconds(3, { system: true }));
  assert.equal(live.voicedBytes, live.bytes, 'the whole buffer is voiced, not half of it');
  await live.drain();
  assert.equal(whisper.calls.length, 1);

  live.stop();
});

test('LiveTranscriber gives Ollama longer segments than whisper.cpp', () => {
  const live = new LiveTranscriber({ ollama: fakeOllama(), whisper: fakeWhisper({ available: false }) });
  live.configure({ enabled: true, engine: 'ollama', model: 'gemma4:12b' });
  live.start();

  live.push(pcmSeconds(2));
  live.push(silentSeconds(1));
  assert.equal(live.segmentReady, false, 'an audio model gets too little context from a short clip');

  live.push(pcmSeconds(2));
  live.push(silentSeconds(1));
  assert.equal(live.segmentReady, true);

  live.stop();
});
