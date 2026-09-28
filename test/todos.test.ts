import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, LIMITS } from '../src/main/todos';

const task = {
  id: 'a',
  title: 'Send the deck',
  description: 'Slides 3-7\n  - check numbers',
  project: 'Launch',
  priority: 'high',
  due: '2026-10-02',
  done: false,
  createdAt: '2026-09-28T10:00:00.000Z',
  updatedAt: '2026-09-28T11:00:00.000Z',
};

test('normalize keeps a well-formed task as it is', () => {
  assert.deepEqual(normalize([task]), [task]);
});

test('normalize returns an empty list for anything that is not one', () => {
  for (const stored of [null, undefined, '', 0, {}, task]) {
    assert.deepEqual(normalize(stored), []);
  }
});

test('normalize drops entries with no title, and nothing else', () => {
  const out = normalize([null, 'string', ['nested'], { title: '   ' }, { description: 'orphan' }, { title: 'ok' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'ok');
});

test('normalize fills the fields a minimal task leaves out', () => {
  const [out] = normalize([{ title: 'Just a title' }]);
  assert.equal(out.description, '');
  assert.equal(out.project, '');
  assert.equal(out.priority, 'none');
  assert.equal(out.due, '');
  assert.equal(out.done, false);
  assert.ok(out.id);
  assert.ok(!Number.isNaN(Date.parse(out.createdAt)));
  assert.equal(out.updatedAt, out.createdAt);
});

test('normalize rejects an unknown priority and a date the calendar does not have', () => {
  const [out] = normalize([{ title: 't', priority: 'urgent!!', due: '2026-02-31' }]);
  assert.equal(out.priority, 'none');
  assert.equal(out.due, '');
  assert.equal(normalize([{ title: 't', due: 'next friday' }])[0].due, '');
  assert.equal(normalize([{ title: 't', due: '2028-02-29' }])[0].due, '2028-02-29');
});

test('normalize only counts a literal true as done', () => {
  assert.equal(normalize([{ title: 't', done: 'yes' }])[0].done, false);
  assert.equal(normalize([{ title: 't', done: true }])[0].done, true);
});

test('normalize gives duplicate ids a fresh one, so two tasks never become one', () => {
  const out = normalize([
    { id: 'same', title: 'one' },
    { id: 'same', title: 'two' },
  ]);
  assert.equal(out[0].id, 'same');
  assert.notEqual(out[1].id, 'same');
});

test('normalize flattens the title and project but keeps the description verbatim', () => {
  const [out] = normalize([{ title: '  Call\n the  office ', project: ' Q4 \t plan ', description: '\n  indented\n\n' }]);
  assert.equal(out.title, 'Call the office');
  assert.equal(out.project, 'Q4 plan');
  assert.equal(out.description, '\n  indented\n\n');
});

test('normalize caps the list and every text field', () => {
  const many = Array.from({ length: LIMITS.count + 5 }, (_, i) => ({ title: `t${i}` }));
  assert.equal(normalize(many).length, LIMITS.count);
  const [out] = normalize([
    { title: 'x'.repeat(LIMITS.title + 9), project: 'p'.repeat(999), description: 'd'.repeat(LIMITS.description + 9) },
  ]);
  assert.equal(out.title.length, LIMITS.title);
  assert.equal(out.project.length, LIMITS.project);
  assert.equal(out.description.length, LIMITS.description);
});

test('normalize keeps the manual order it was given', () => {
  const out = normalize([{ title: 'c' }, { title: 'a' }, { title: 'b' }]);
  assert.deepEqual(
    out.map((t) => t.title),
    ['c', 'a', 'b'],
  );
});

test('normalize keeps only the fields a task has', () => {
  const [out] = normalize([{ ...task, click: 'rm -rf /', __proto__: { polluted: true } }]);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(task).sort());
});
