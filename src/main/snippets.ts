// Quick-copy shorthands: pieces of text the tray menu puts on the clipboard in
// one click, so a phrase typed several times a day costs two clicks instead.
//
// Deliberately its own file rather than a field in settings.json. That store
// coerces every value against a scalar default and drops whatever does not fit,
// which is exactly what stops a hand-edited settings file from crashing the app
// at startup. A list of user-authored records has no place in that shape, and
// widening the coercion to make room would weaken the guarantee for every real
// setting.

import fs from 'node:fs';
import path from 'node:path';

import { electronPath } from './electron-lazy';
import type { Snippet } from '../shared/types';

export type { Snippet };

/**
 * Ceilings, so neither a runaway paste nor a hand-edited file can produce a
 * tray menu that is unusable — or one that takes a visible moment to build.
 */
export const LIMITS = { count: 40, label: 60, text: 20_000 } as const;

let cache: Snippet[] | null = null;
let file = '';

/**
 * Coerces whatever was stored — or sent over IPC — into the list the tray can
 * render. Anything unrecognisable is dropped rather than repaired: a snippet is
 * only ever two strings, so there is nothing to salvage from a broken one.
 */
export function normalize(stored: unknown): Snippet[] {
  if (!Array.isArray(stored)) return [];

  const out: Snippet[] = [];
  for (const item of stored as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;

    // The text is copied verbatim, so only the length is touched — leading
    // indentation and trailing newlines are often the point of the snippet.
    const text = typeof record.text === 'string' ? record.text.slice(0, LIMITS.text) : '';
    // A shorthand with nothing to copy is a dead menu row; the editor keeps
    // showing the half-written card, but the tray never grows an item for it.
    if (!text.trim()) continue;

    const label = typeof record.label === 'string' ? record.label.trim().slice(0, LIMITS.label) : '';
    out.push({ label, text });
    if (out.length >= LIMITS.count) break;
  }
  return out;
}

/** The stored shorthands, in menu order. */
export function load(): Snippet[] {
  if (cache) return cache;
  file = path.join(electronPath('userData'), 'snippets.json');
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
 * Replaces the whole list — the editor always sends every card it has, so a
 * delete is just an absence.
 *
 * @returns what was actually written
 */
export function save(list: unknown): Snippet[] {
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
