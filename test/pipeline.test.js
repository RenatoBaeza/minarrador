'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractJson,
  normaliseNotes,
  renderMarkdown,
  fallbackHtml,
  fmtDuration,
} = require('../src/main/pipeline');

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
