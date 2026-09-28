// The to-do list: tasks with a title, a longer description, a project, a
// priority and a due date, edited in the library window's To-do feature.
//
// Its own file rather than a field in settings.json for the same reason as
// snippets.json and dictations.json: that store coerces every value against a
// scalar default, and a list of records does not fit the shape.
//
// Saved as a whole list, like quick copy. The array order is the manual order
// someone dragged the tasks into; every other ordering is a view the page
// computes, so sorting by due date never throws that order away.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { electronPath } from './electron-lazy';
import type { Todo, TodoPriority } from '../shared/types';

export type { Todo, TodoPriority };

/** Lowest to highest. Mirrors PRIORITIES in the library page. */
export const PRIORITIES: readonly TodoPriority[] = ['none', 'low', 'medium', 'high'];

/** Ceilings, so a runaway paste or a hand-edited file cannot grow without bound. */
export const LIMITS = { count: 1000, title: 200, project: 60, description: 50_000 } as const;

let cache: Todo[] | null = null;
let file = '';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day as `<input type="date">` writes it, or '' for none. */
function dueDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value)) return '';
  // Reject 2026-02-31 and friends: a date the calendar does not have would sort
  // somewhere and show as something else.
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? value : '';
}

const timestamp = (value: unknown, fallback: string): string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;

/**
 * Coerces whatever was stored — or sent over IPC — into the list the page can
 * render. A task needs only a title; every other field falls back to empty
 * rather than taking the task down with it.
 */
export function normalize(stored: unknown): Todo[] {
  if (!Array.isArray(stored)) return [];

  const now = new Date().toISOString();
  const seen = new Set<string>();
  const out: Todo[] = [];
  for (const item of stored as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;

    const title = typeof record.title === 'string' ? record.title.replace(/\s+/g, ' ').trim().slice(0, LIMITS.title) : '';
    // A task with no title is a row nobody can recognise; the page keeps the
    // half-typed one on screen and flags it, but the store never keeps it.
    if (!title) continue;

    // Ids are the page's handle on a row; a duplicate would make two tasks one.
    let id = typeof record.id === 'string' ? record.id.trim().slice(0, 64) : '';
    if (!id || seen.has(id)) id = randomUUID();
    seen.add(id);

    const priority = PRIORITIES.includes(record.priority as TodoPriority) ? (record.priority as TodoPriority) : 'none';
    const createdAt = timestamp(record.createdAt, now);

    out.push({
      id,
      title,
      // Kept verbatim apart from the length: indentation and blank lines are
      // how a description is laid out.
      description: typeof record.description === 'string' ? record.description.slice(0, LIMITS.description) : '',
      project: typeof record.project === 'string' ? record.project.replace(/\s+/g, ' ').trim().slice(0, LIMITS.project) : '',
      priority,
      due: dueDate(record.due),
      done: record.done === true,
      createdAt,
      updatedAt: timestamp(record.updatedAt, createdAt),
    });
    if (out.length >= LIMITS.count) break;
  }
  return out;
}

/** Every task, in manual order. */
export function load(): Todo[] {
  if (cache) return cache;
  file = path.join(electronPath('userData'), 'todos.json');
  let stored: unknown = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First run, or a corrupt file we can safely discard.
  }
  cache = normalize(stored);
  return cache;
}

/**
 * Replaces the whole list — the page always sends every task it has, so a
 * delete is just an absence.
 *
 * @returns what was actually written
 */
export function save(list: unknown): Todo[] {
  load(); // Resolves `file` on the first call, whichever way in we came.
  const next = normalize(list);
  cache = next;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated file behind.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}
