'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractJson,
  normaliseNotes,
  renderMarkdown,
  fallbackHtml,
  fmtDuration,
  transcribe,
  tracksOf,
  transcribeEngineFor,
  transcribeEngineLabel,
} = require('../src/main/pipeline');
const { buildWav } = require('../src/main/wav');
const { FILES } = require('../src/main/paths');

const META = {
  startedAt: '2026-08-11T14:32:05.000Z',
  durationSeconds: 1830,
  models: { transcribe: 'gemma4:12b', summary: 'gemma4:12b' },
};

// ----------------------------------------------------------------- extractJson

test('extractJson reads a plain object', () => {
  assert.deepEqual(extractJson('{"title":"Standup"}'), { title: 'Standup' });
});

test('extractJson survives the wrappers models add', () => {
  assert.deepEqual(extractJson('```json\n{"title":"Standup"}\n```'), { title: 'Standup' });
  assert.deepEqual(extractJson('```\n{"title":"Standup"}\n```'), { title: 'Standup' });
  assert.deepEqual(extractJson('Sure! Here are the notes:\n{"title":"Standup"}\nHope that helps.'), {
    title: 'Standup',
  });
});

test('extractJson handles nesting and braces inside strings', () => {
  const raw = 'noise {"title":"a } brace","decisions":[{"decision":"ship {v2}","context":""}]} trailing';
  assert.deepEqual(extractJson(raw), {
    title: 'a } brace',
    decisions: [{ decision: 'ship {v2}', context: '' }],
  });
});

test('extractJson handles an escaped quote inside a string', () => {
  assert.deepEqual(extractJson('{"title":"the \\"big\\" review"}'), { title: 'the "big" review' });
});

test('extractJson returns null when there is nothing usable', () => {
  assert.equal(extractJson('the model refused to answer'), null);
  assert.equal(extractJson('{"title": unterminated'), null);
  assert.equal(extractJson(''), null);
});

// --------------------------------------------------------------- normaliseNotes

test('normaliseNotes keeps a well-formed reply intact', () => {
  const notes = normaliseNotes(
    {
      title: 'Platform sync',
      summary: ['one', 'two', 'three', 'four', 'five'],
      decisions: [{ decision: 'Ship on Friday', context: 'QA signed off' }],
      action_items: [{ task: 'Update the runbook', owner: 'Ana', due: 'Thursday' }],
    },
    'transcript text',
  );

  assert.equal(notes.title, 'Platform sync');
  assert.equal(notes.summary.length, 5);
  assert.deepEqual(notes.decisions, [{ decision: 'Ship on Friday', context: 'QA signed off' }]);
  assert.deepEqual(notes.action_items, [{ task: 'Update the runbook', owner: 'Ana', due: 'Thursday' }]);
});

test('normaliseNotes caps the summary at five bullets', () => {
  const notes = normaliseNotes({ summary: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, 't');
  assert.equal(notes.summary.length, 5);
});

test('normaliseNotes accepts the alternative shapes models produce', () => {
  const notes = normaliseNotes(
    {
      summary: [{ text: 'from text' }, { bullet: 'from bullet' }, { point: 'from point' }],
      decisions: ['a bare string decision'],
      actionItems: ['a bare string task'],
    },
    't',
  );

  assert.deepEqual(notes.summary, ['from text', 'from bullet', 'from point']);
  assert.deepEqual(notes.decisions, [{ decision: 'a bare string decision', context: '' }]);
  assert.deepEqual(notes.action_items, [{ task: 'a bare string task', owner: 'Unassigned', due: '' }]);
});

test('normaliseNotes maps assignee/deadline aliases and defaults the owner', () => {
  const notes = normaliseNotes(
    { action_items: [{ action: 'Book the room', assignee: 'Sam', deadline: 'Monday' }, { task: 'Nameless' }] },
    't',
  );
  assert.deepEqual(notes.action_items, [
    { task: 'Book the room', owner: 'Sam', due: 'Monday' },
    { task: 'Nameless', owner: 'Unassigned', due: '' },
  ]);
});

test('normaliseNotes drops entries with no substance', () => {
  const notes = normaliseNotes(
    { decisions: [{ context: 'why but no what' }, ''], action_items: [{ owner: 'Ana' }, '  '] },
    't',
  );
  assert.deepEqual(notes.decisions, []);
  assert.deepEqual(notes.action_items, []);
});

test('normaliseNotes explains itself when the model returned nothing usable', () => {
  const withSpeech = normaliseNotes(null, 'there was definitely speech here');
  assert.equal(withSpeech.title, 'Meeting notes');
  assert.match(withSpeech.summary[0], /did not return a usable summary/);

  const silent = normaliseNotes(null, '');
  assert.match(silent.summary[0], /No speech was detected/);
});

test('normaliseNotes tolerates hostile types without throwing', () => {
  for (const input of [undefined, 42, 'a string', [], { summary: 'not an array', decisions: 7 }]) {
    const notes = normaliseNotes(input, 't');
    assert.equal(typeof notes.title, 'string');
    assert.ok(Array.isArray(notes.summary));
    assert.ok(Array.isArray(notes.decisions));
    assert.ok(Array.isArray(notes.action_items));
  }
});

// ----------------------------------------------------------------- fmtDuration

test('fmtDuration reads naturally at each scale', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(45), '45s');
  assert.equal(fmtDuration(90), '1m 30s');
  assert.equal(fmtDuration(3600), '1h 0m');
  assert.equal(fmtDuration(5430), '1h 30m');
  assert.equal(fmtDuration(-5), '0s', 'a negative duration should not render as nonsense');
});

// -------------------------------------------------------------------- rendering

test('renderMarkdown lays out every section', () => {
  const md = renderMarkdown(
    {
      title: 'Platform sync',
      summary: ['first point', 'second point'],
      decisions: [{ decision: 'Ship Friday', context: 'QA signed off' }],
      action_items: [{ task: 'Update runbook', owner: 'Ana', due: 'Thursday' }],
    },
    META,
  );

  assert.match(md, /^# Platform sync/);
  assert.match(md, /## Summary/);
  assert.match(md, /- first point/);
  assert.match(md, /- \*\*Ship Friday\*\* — QA signed off/);
  assert.match(md, /- \[ \] Update runbook — \*\*Ana\*\* \*\(Thursday\)\*/);
  assert.match(md, /30m 30s/);
  assert.match(md, /gemma4:12b/);
});

test('renderMarkdown says so when nothing was decided', () => {
  const md = renderMarkdown({ title: 'T', summary: ['s'], decisions: [], action_items: [] }, META);
  assert.match(md, /No decisions were recorded/);
  assert.match(md, /No action items were recorded/);
});

test('renderMarkdown copes with meta from an older or partial run', () => {
  // Regression: meta.models used to be dereferenced unguarded, so re-running
  // the pipeline over a folder whose meta.json predates it threw here.
  const notes = { title: 'T', summary: ['s'], decisions: [], action_items: [] };
  assert.doesNotThrow(() => renderMarkdown(notes, {}));
  assert.match(renderMarkdown(notes, {}), /date unknown/);
  assert.match(renderMarkdown(notes, { startedAt: 'not a date' }), /date unknown/);
});

test('fallbackHtml produces a standalone document', () => {
  const html = fallbackHtml(
    { title: 'Sync', summary: ['a'], decisions: [], action_items: [{ task: 't', owner: 'o', due: '' }] },
    META,
  );
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>$/);
  assert.doesNotMatch(html, /<script/i, 'the offline brief must not carry script');
  assert.doesNotMatch(html, /https?:\/\//, 'nothing may reference the network');
});

test('fallbackHtml escapes model output instead of interpolating it as markup', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const html = fallbackHtml(
    {
      title: evil,
      summary: [evil],
      decisions: [{ decision: evil, context: evil }],
      action_items: [{ task: evil, owner: evil, due: evil }],
    },
    META,
  );

  assert.doesNotMatch(html.replace(/<title>[\s\S]*?<\/title>/, ''), /<img/i);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('fallbackHtml copes with meta from an older or partial run', () => {
  const notes = { title: 'T', summary: ['s'], decisions: [], action_items: [] };
  assert.doesNotThrow(() => fallbackHtml(notes, {}));
});

// ------------------------------------------------------------------ transcribe

/** A meeting folder holding a WAV of `seconds` of audible 16 kHz mono tone. */
function meetingWithAudio(t, seconds = 3) {
  const dir = tmpMeeting(t);
  const samples = 16000 * seconds;
  const pcm = Buffer.alloc(samples * 2);
  // Loud enough to clear SILENCE_RMS, or every chunk would be skipped as room tone.
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
  fs.writeFileSync(path.join(dir, FILES.audio), buildWav(pcm, 16000));
  return dir;
}

function tmpMeeting(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A two-channel meeting folder: the microphone on the left, the system audio on
 * the right, each audible only during the seconds it is given.
 *
 * `talking` is a list of `[speaker, fromSecond, toSecond]`, so a test can say
 * "you speak for the first minute, they answer in the second" and then assert
 * that the transcript attributes each of them.
 *
 * @param {[('mic'|'system'), number, number][]} talking
 */
function stereoMeeting(t, seconds, talking) {
  const dir = tmpMeeting(t);
  const frames = 16000 * seconds;
  const pcm = Buffer.alloc(frames * 4);
  for (const [speaker, from, to] of talking) {
    const channel = speaker === 'mic' ? 0 : 1;
    for (let f = Math.round(from * 16000); f < Math.round(to * 16000) && f < frames; f++) {
      pcm.writeInt16LE(Math.round(8000 * Math.sin(f / 8)), f * 4 + channel * 2);
    }
  }
  fs.writeFileSync(path.join(dir, FILES.audio), buildWav(pcm, 16000, 2));
  return dir;
}

const fakeWhisper = (available = true) => ({
  available,
  model: '/models/ggml-base.bin',
  calls: [],
  async transcribe(wav, options) {
    this.calls.push(options);
    return `heard ${this.calls.length}`;
  },
});

const fakeOllama = () => ({
  calls: [],
  async transcribe(model, wav, options) {
    this.calls.push({ model, ...options });
    return 'the audio model heard this';
  },
});

test('transcribeEngineFor prefers whisper.cpp, and only when it is really there', () => {
  const whisper = fakeWhisper();
  assert.equal(transcribeEngineFor({ transcribeEngine: 'whisper' }, whisper), 'whisper');
  // Nothing installed, or the setting moved off it: the audio model does the pass.
  assert.equal(transcribeEngineFor({ transcribeEngine: 'whisper' }, fakeWhisper(false)), 'ollama');
  assert.equal(transcribeEngineFor({ transcribeEngine: 'whisper' }, null), 'ollama');
  assert.equal(transcribeEngineFor({ transcribeEngine: 'ollama' }, whisper), 'ollama');
  // An older settings.json has no such key at all; whisper is still the default.
  assert.equal(transcribeEngineFor({}, whisper), 'whisper');
});

test('transcribeEngineLabel names what actually produced a transcript', () => {
  assert.equal(
    transcribeEngineLabel('whisper', { transcribeModel: 'gemma4:12b' }, fakeWhisper()),
    'whisper.cpp (ggml-base.bin)',
  );
  assert.equal(transcribeEngineLabel('ollama', { transcribeModel: 'gemma4:12b' }, null), 'gemma4:12b');
});

test('transcribe sends the saved audio to whisper.cpp when it is available', async (t) => {
  const dir = meetingWithAudio(t, 3);
  const whisper = fakeWhisper();
  const ollama = fakeOllama();

  const out = await transcribe(dir, { transcribeEngine: 'whisper', chunkSeconds: 1 }, { whisper, ollama });

  assert.equal(out.engine, 'whisper');
  assert.equal(ollama.calls.length, 0, 'Ollama is not needed for this stage');
  assert.equal(whisper.calls.length, out.segments.length, 'one request per chunk');
  assert.ok(out.segments.length >= 2, 'a three-second recording at one second a chunk is several');
  // Each chunk is handed the tail of the one before, so a sentence split across
  // a chunk boundary keeps its context.
  assert.equal(whisper.calls[0].prompt, '');
  assert.equal(whisper.calls[1].prompt, 'heard 1');
  // A chunk of the saved audio is a minute, not the few seconds a live window
  // is, so the request may not be held to the live timeout.
  assert.ok(whisper.calls[0].timeoutMs >= 60_000);

  const written = fs.readFileSync(path.join(dir, FILES.transcript), 'utf8');
  assert.equal(written, `${out.segments.map((s) => s.text).join('\n\n')}\n`);
  assert.match(written, /^heard 1\n\nheard 2/);

  const json = JSON.parse(fs.readFileSync(path.join(dir, FILES.transcriptJson), 'utf8'));
  assert.equal(json.engine, 'whisper');
  assert.equal(json.model, 'whisper.cpp (ggml-base.bin)');
  assert.equal(json.segments.length, out.segments.length);
});

test('transcribe falls back to the Ollama audio model when whisper.cpp is not installed', async (t) => {
  const dir = meetingWithAudio(t, 2);
  const whisper = fakeWhisper(false);
  const ollama = fakeOllama();

  const out = await transcribe(dir, { transcribeEngine: 'whisper', transcribeModel: 'gemma4:12b', chunkSeconds: 1 }, { whisper, ollama });

  assert.equal(out.engine, 'ollama');
  assert.equal(out.engineLabel, 'gemma4:12b');
  assert.equal(whisper.calls.length, 0);
  assert.equal(ollama.calls.length, out.segments.length);
  assert.equal(ollama.calls[0].model, 'gemma4:12b');
});

test('transcribe honours a setting that asks for the audio model outright', async (t) => {
  const dir = meetingWithAudio(t, 1);
  const whisper = fakeWhisper();
  const ollama = fakeOllama();

  await transcribe(dir, { transcribeEngine: 'ollama', transcribeModel: 'gemma4:12b', chunkSeconds: 1 }, { whisper, ollama });

  assert.equal(whisper.calls.length, 0, 'an installed whisper must not override the choice');
  assert.ok(ollama.calls.length > 0);
});

test('transcribe stops on an abort rather than working through the rest of the meeting', async (t) => {
  const dir = meetingWithAudio(t, 3);
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(
    () => transcribe(dir, { transcribeEngine: 'whisper', chunkSeconds: 1 }, { whisper: fakeWhisper(), ollama: fakeOllama(), signal: abort.signal }),
    /cancelled/,
  );
});

test('a mono recording is transcribed as one unattributed track', () => {
  const pcm = Buffer.alloc(400);
  const tracks = tracksOf(pcm, 1);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].speaker, '');
  assert.deepEqual(tracks[0].pcm, pcm);
});

test('a two-channel recording is transcribed as the microphone then the room', () => {
  const tracks = tracksOf(Buffer.alloc(400), 2);
  assert.deepEqual(tracks.map((track) => track.speaker), ['mic', 'system']);
  for (const track of tracks) assert.equal(track.pcm.length, 200, 'each side is half the interleaved bytes');
});

// ------------------------------------------------------- two-channel transcripts
//
// The point of recording two channels: each side is transcribed on its own, so
// every line knows who said it. Attribution used to work only when somebody said
// a name out loud.

// 3.5 seconds at a 2-second chunk is exactly two chunks: the second nominal cut
// falls past the end of the audio, so there is no stub third one to reason about.
// The pause at 1.8-2.0 is where splitIntoChunks puts the first.
const TWO_CHUNKS = { seconds: 3.5, chunkSeconds: 2 };

test('transcribe labels each line with the side of the call it came from', async (t) => {
  // You talk through the first chunk, they answer through the second.
  const dir = stereoMeeting(t, TWO_CHUNKS.seconds, [
    ['mic', 0, 1.8],
    ['system', 2, 3.5],
  ]);
  const whisper = fakeWhisper();

  const out = await transcribe(dir, { transcribeEngine: 'whisper', ...TWO_CHUNKS }, { whisper, ollama: fakeOllama() });

  assert.equal(out.channels, 2);
  const said = out.segments.filter((s) => s.text);
  assert.deepEqual(said.map((s) => s.speaker), ['mic', 'system']);

  const written = fs.readFileSync(path.join(dir, FILES.transcript), 'utf8');
  assert.equal(written, 'You: heard 1\n\nOthers: heard 2\n');

  const json = JSON.parse(fs.readFileSync(path.join(dir, FILES.transcriptJson), 'utf8'));
  assert.equal(json.channels, 2);
  assert.deepEqual(json.speakers, { mic: 'You', system: 'Others' });
});

test('transcribe skips the side that was only listening', async (t) => {
  const dir = stereoMeeting(t, TWO_CHUNKS.seconds, [
    ['mic', 0, 1.8],
    ['system', 2, 3.5],
  ]);
  const whisper = fakeWhisper();

  const out = await transcribe(dir, { transcribeEngine: 'whisper', ...TWO_CHUNKS }, { whisper, ollama: fakeOllama() });

  // Every chunk holds a slot for both sides, and only the audible ones are sent.
  // That is what keeps two channels from costing two transcriptions: the side
  // that was listening is silence, and silence is skipped.
  assert.equal(out.segments.length, 4, 'two chunks, two sides');
  assert.equal(whisper.calls.length, 2, 'a silent channel must not be sent to the model');
});

test('transcribe gives each side its own context, not the other side’s last line', async (t) => {
  // Both talking, in both chunks, with the same pause between them.
  const dir = stereoMeeting(t, TWO_CHUNKS.seconds, [
    ['mic', 0, 1.8],
    ['mic', 2, 3.5],
    ['system', 0, 1.8],
    ['system', 2, 3.5],
  ]);
  const whisper = fakeWhisper();

  await transcribe(dir, { transcribeEngine: 'whisper', ...TWO_CHUNKS }, { whisper, ollama: fakeOllama() });

  // Order is mic, system, mic, system — so the second chunk's mic request must
  // be prompted with the first mic line, not with what the other side said.
  assert.equal(whisper.calls.length, 4);
  assert.equal(whisper.calls[0].prompt, '');
  assert.equal(whisper.calls[1].prompt, '');
  assert.equal(whisper.calls[2].prompt, 'heard 1', 'the microphone continues its own sentence');
  assert.equal(whisper.calls[3].prompt, 'heard 2', 'and so does the room');
});

test('transcribe cuts both channels at the same boundaries', async (t) => {
  const dir = stereoMeeting(t, 6, [
    ['mic', 0, 6],
    ['system', 0, 6],
  ]);
  const out = await transcribe(
    dir,
    { transcribeEngine: 'whisper', chunkSeconds: 2 },
    { whisper: fakeWhisper(), ollama: fakeOllama() },
  );

  // Every chunk index has to hold exactly one segment per side, spanning the
  // same seconds — otherwise each line's timestamp is on its own grid.
  const byChunk = new Map();
  for (const s of out.segments) {
    const bucket = byChunk.get(s.chunk) ?? [];
    bucket.push(s);
    byChunk.set(s.chunk, bucket);
  }
  for (const [, bucket] of byChunk) {
    assert.equal(bucket.length, 2);
    assert.equal(bucket[0].startSeconds, bucket[1].startSeconds);
    assert.equal(bucket[0].endSeconds, bucket[1].endSeconds);
  }
});

test('a mono recording still produces an unlabelled transcript', async (t) => {
  const dir = meetingWithAudio(t, 2);
  const out = await transcribe(
    dir,
    { transcribeEngine: 'whisper', chunkSeconds: 1 },
    { whisper: fakeWhisper(), ollama: fakeOllama() },
  );

  assert.equal(out.channels, 1);
  assert.ok(out.segments.every((s) => s.speaker === ''));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, FILES.transcript), 'utf8'), /^You:|^Others:/m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, FILES.transcriptJson), 'utf8')).speakers, {});
});
