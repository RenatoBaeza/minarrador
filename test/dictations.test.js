'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize, LIMITS } = require('../src/main/dictations');

test('normalize keeps a well-formed list as it is', () => {
  const stored = [
    { id: 'a', text: 'Send the deck over.', createdAt: '2026-08-11T10:00:00.000Z' },
    { id: 'b', text: 'Call the office.', createdAt: '2026-08-11T11:00:00.000Z' },
  ];
  assert.deepEqual(normalize(stored), stored);
});

test('normalize returns an empty list for anything that is not one', () => {
  for (const stored of [null, undefined, '', 0, {}, { id: 'a', text: 'x' }]) {
    assert.deepEqual(normalize(stored), []);
  }
});

test('normalize drops entries that could never be a dictation', () => {
  const out = normalize([
    null,
    'just a string',
    ['nested'],
    { id: 'blank', text: '   \n ' },
    { id: 'ok', text: 'remember the milk' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ok');
  assert.equal(out[0].text, 'remember the milk');
});

test('normalize keeps only the three fields the window reads', () => {
  const out = normalize([{ id: 'a', text: 'b', createdAt: 'c', click: 'rm -rf /', __proto__: { polluted: true } }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['createdAt', 'id', 'text']);
});

test('normalize repairs a row missing its identity', () => {
  const out = normalize([{ text: 'no id, no date' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'no id, no date');
  assert.equal(typeof out[0].id, 'string');
  assert.ok(out[0].id.length > 0);
  assert.equal(typeof out[0].createdAt, 'string');
  assert.ok(out[0].createdAt.length > 0);
});

test('normalize trims the text so a hand-edited file stays bounded', () => {
  const out = normalize([{ id: 'a', text: 'x'.repeat(LIMITS.text + 999) }]);
  assert.equal(out[0].text.length, LIMITS.text);
});

test('normalize caps the list so the window stays usable', () => {
  const many = Array.from({ length: LIMITS.count + 20 }, (_, i) => ({ id: `d${i}`, text: 'x' }));
  assert.equal(normalize(many).length, LIMITS.count);
});
