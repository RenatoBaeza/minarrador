import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DESKTOP_MAX_TASKS,
  backgroundColor,
  backgroundCss,
  desktopHtml,
  desktopTasks,
  dueText,
} from '../src/main/wallpaper';
import type { Todo } from '../src/shared/types';

const now = new Date(2026, 9, 13, 15, 0); // 13 Oct 2026, local time

const todo = (title: string, extra: Partial<Todo> = {}): Todo => ({
  id: title,
  title,
  description: '',
  project: '',
  priority: 'none',
  due: '',
  done: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

test('desktopTasks shows open tasks in manual order and leaves done ones off', () => {
  const { tasks, more } = desktopTasks([todo('a'), todo('b', { done: true }), todo('c')], now);
  assert.deepEqual(
    tasks.map((t) => t.title),
    ['a', 'c'],
  );
  assert.equal(more, 0);
});

test('desktopTasks caps the list and counts the rest', () => {
  const list = Array.from({ length: DESKTOP_MAX_TASKS + 3 }, (_, i) => todo(`t${i}`));
  const { tasks, more } = desktopTasks(list, now);
  assert.equal(tasks.length, DESKTOP_MAX_TASKS);
  assert.equal(more, 3);
});

test('dueText labels a due day relative to today', () => {
  assert.equal(dueText('2026-10-13', now).text, 'Today');
  assert.equal(dueText('2026-10-14', now).text, 'Tomorrow');
  assert.equal(dueText('2026-10-01', now).urgency, 'overdue');
  assert.match(dueText('2026-10-01', now).text, /^Overdue · /);
  assert.deepEqual(dueText('', now), { text: '', urgency: '' });
});

test('backgroundCss follows the Windows wallpaper style', () => {
  assert.match(backgroundCss('original.png', { style: '10', tile: '0' }, null), /cover no-repeat$/);
  assert.match(backgroundCss('original.png', { style: '6', tile: '0' }, null), /contain no-repeat$/);
  assert.match(backgroundCss('original.png', { style: '2', tile: '0' }, null), /100% 100% no-repeat$/);
  assert.match(backgroundCss('original.png', { style: '0', tile: '1' }, { width: 64, height: 32 }), /64px 32px repeat$/);
  assert.match(backgroundCss('original.png', { style: '0', tile: '0' }, { width: 64, height: 32 }), /center \/ 64px 32px/);
});

test('backgroundCss cannot be broken out of its url()', () => {
  assert.ok(!backgroundCss('a"); color: red; ("', { style: '10', tile: '0' }, null).includes('"); color'));
});

test('backgroundColor reads "R G B" and falls back to black', () => {
  assert.equal(backgroundColor('10 20 30'), 'rgb(10, 20, 30)');
  assert.equal(backgroundColor('nonsense'), 'rgb(0, 0, 0)');
  assert.equal(backgroundColor('300 0 0'), 'rgb(0, 0, 0)');
});

test('desktopHtml escapes task text', () => {
  const { tasks, more } = desktopTasks([todo('<img src=x onerror=alert(1)>', { project: 'A & B' })], now);
  const html = desktopHtml({ tasks, more, background: 'black', insets: { top: 0, right: 0, bottom: 48, left: 0 } });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('A &amp; B'));
});

test('desktopHtml says so when the list is empty', () => {
  const html = desktopHtml({ tasks: [], more: 0, background: 'black', insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  assert.ok(html.includes('Nothing on the list.'));
});
