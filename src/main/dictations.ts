// The voice-input archive: everything the dictation hotkey has transcribed, in
// order, kept so a dictated sentence is never lost to a paste that went
// somewhere it should not have.
//
// Its own file rather than a field in settings.json for the same reason as
// snippets.json: that store coerces every value against a scalar default, and a
// list of records does not fit the shape. It is also separate from the meeting
// library on purpose — these are scraps of text, not recordings, and the two
// archives have nothing else in common but being local.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { electronPath } from './electron-lazy';
import type { Dictation } from '../shared/types';

export type { Dictation };

/**
 * Ceilings, so a hand-edited file — or a user holding the hotkey for a very
 * long time — cannot grow an unbounded JSON blob. 20k characters is a few
 * minutes of continuous dictation; past that the text is truncated rather than
 * the window left thinking it saved what it showed.
 */
export const LIMITS = { count: 200, text: 20_000 } as const;

let cache: Dictation[] | null = null;
let file = '';

/**
 * Coerces whatever was stored — or sent over IPC — into the list the window can
 * render. Anything unrecognisable is dropped rather than repaired: a dictation
 * is three fields, and a broken one has nothing to salvage.
 */
export function normalize(stored: unknown): Dictation[] {
  if (!Array.isArray(stored)) return [];

  const out: Dictation[] = [];
  for (const item of stored as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;

    // The text is kept verbatim apart from the length — a dictated paragraph is
    // meant to be pasted whole, leading and trailing whitespace included.
    const text = typeof record.text === 'string' ? record.text.slice(0, LIMITS.text) : '';
    // A dictation with no text is a dead row; it can only ever be a failed
    // transcription, which never saved anything.
    if (!text.trim()) continue;

    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : randomUUID();
    const createdAt =
      typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : new Date().toISOString();

    out.push({ id, text, createdAt });
    if (out.length >= LIMITS.count) break;
  }
  return out;
}

/** The archive, newest first. */
export function load(): Dictation[] {
  if (cache) return cache;
  file = path.join(electronPath('userData'), 'dictations.json');
  let stored: unknown = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First run, or a corrupt file we can safely discard.
  }
  cache = normalize(stored);
  return cache;
}

/** Write-then-rename so a crash mid-write cannot leave a truncated file behind. */
function write(list: Dictation[]): Dictation[] {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
  return list;
}

/** A fresh read for anything that opened the window, rather than a cached view. */
export function list(): Dictation[] {
  return load().slice();
}

/**
 * Adds a dictation to the front of the archive.
 *
 * @returns null when the text was empty, which is a failed transcription, not
 *   a dictation
 */
export function add(text: unknown): Dictation | null {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const item: Dictation = { id: randomUUID(), text: clean.slice(0, LIMITS.text), createdAt: new Date().toISOString() };
  cache = [item, ...load()].slice(0, LIMITS.count);
  write(cache);
  return item;
}

/**
 * Replaces one dictation's text. The timestamp and id are the row's identity,
 * so editing only ever touches the body.
 *
 * @returns null when the id is unknown or the text was emptied (which is a
 *   delete, not an edit)
 */
export function update(id: unknown, text: unknown): Dictation[] | null {
  const current = load();
  const clean = String(text ?? '');
  if (!clean.trim()) return null;
  const index = current.findIndex((item) => item.id === id);
  if (index === -1) return null;
  current[index] = { ...current[index], text: clean.slice(0, LIMITS.text) };
  return write(current);
}

/**
 * Removes one dictation.
 *
 * @returns null when the id did not exist
 */
export function remove(id: unknown): Dictation[] | null {
  const current = load();
  if (!current.some((item) => item.id === id)) return null;
  cache = current.filter((item) => item.id !== id);
  return write(cache);
}
