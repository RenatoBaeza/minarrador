'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize, LIMITS } = require('../src/main/snippets');
const { snippetLabel } = require('../src/main/tray');

test('normalize keeps a well-formed list as it is', () => {
  const stored = [
    { label: 'Standup link', text: 'https://meet.example/standup' },
    { label: '', text: 'Thanks — sending that over now.' },
  ];
  assert.deepEqual(normalize(stored), stored);
});

test('normalize returns an empty list for anything that is not one', () => {
  for (const stored of [null, undefined, '', 0, {}, { label: 'x', text: 'y' }]) {
    assert.deepEqual(normalize(stored), []);
  }
});

test('normalize skips entries that could never produce a menu item', () => {
  const out = normalize([
    null,
    'just a string',
    ['nested'],
    { label: 'no body' },
    { label: 'blank body', text: '   \n ' },
    { label: 'ok', text: 'copy me' },
  ]);
  assert.deepEqual(out, [{ label: 'ok', text: 'copy me' }]);
});

test('normalize drops fields of the wrong type rather than passing them on', () => {
  const out = normalize([
    { label: 42, text: 'still copyable' },
    { label: 'lost', text: { nope: true } },
  ]);
  assert.deepEqual(out, [{ label: '', text: 'still copyable' }]);
});

test('normalize copies the text verbatim, whitespace included', () => {
  // Indentation and trailing newlines are often the whole point of a shorthand.
  const text = '  - item one\n  - item two\n';
  assert.equal(normalize([{ label: 'list', text }])[0].text, text);
});

test('normalize trims the label, which only ever has to fit one menu row', () => {
  assert.equal(normalize([{ label: '  Standup  ', text: 'x' }])[0].label, 'Standup');
  assert.equal(normalize([{ label: 'L'.repeat(500), text: 'x' }])[0].label.length, LIMITS.label);
});

test('normalize caps the list and the text so the menu stays usable', () => {
  const many = Array.from({ length: LIMITS.count + 20 }, (_, i) => ({ label: `s${i}`, text: 'x' }));
  assert.equal(normalize(many).length, LIMITS.count);
  assert.equal(normalize([{ label: 'huge', text: 'x'.repeat(LIMITS.text + 999) }])[0].text.length, LIMITS.text);
});

test('normalize keeps only the two fields the tray reads', () => {
  const out = normalize([{ label: 'a', text: 'b', click: 'rm -rf /', __proto__: { polluted: true } }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['label', 'text']);
});

test('snippetLabel falls back to the text for an unnamed shorthand', () => {
  assert.equal(snippetLabel({ label: '', text: 'Sending that over now.' }), 'Sending that over now.');
  assert.equal(snippetLabel({ label: 'Reply', text: 'Sending that over now.' }), 'Reply');
});

test('snippetLabel flattens a multi-line body onto one row', () => {
  assert.equal(snippetLabel({ label: '', text: '  line one\n\nline two  ' }), 'line one line two');
});

test('snippetLabel truncates rather than stretching the menu', () => {
  const label = snippetLabel({ label: 'x'.repeat(200), text: '' });
  assert.ok(label.length <= 44, label);
  assert.ok(label.endsWith('…'));
});

test('snippetLabel escapes the ampersand Windows would eat as a mnemonic', () => {
  assert.equal(snippetLabel({ label: 'R&D sync', text: 'x' }), 'R&&D sync');
});
