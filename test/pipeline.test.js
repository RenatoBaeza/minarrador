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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const samples = 16000 * seconds;
  const pcm = Buffer.alloc(samples * 2);
  // Loud enough to clear SILENCE_RMS, or every chunk would be skipped as room tone.
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
  fs.writeFileSync(path.join(dir, FILES.audio), buildWav(pcm, 16000));
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
