'use strict';

// Quick-copy shorthands: pieces of text the tray menu puts on the clipboard in
// one click, so a phrase typed several times a day costs two clicks instead.
//
// Deliberately its own file rather than a field in settings.json. That store
// coerces every value against a scalar default and drops whatever does not fit,
// which is exactly what stops a hand-edited settings file from crashing the app
// at startup. A list of user-authored records has no place in that shape, and
// widening the coercion to make room would weaken the guarantee for every real
// setting.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Ceilings, so neither a runaway paste nor a hand-edited file can produce a
 * tray menu that is unusable — or one that takes a visible moment to build.
 */
const LIMITS = { count: 40, label: 60, text: 20_000 };

let cache = null;
let file = null;

/** Required lazily so this module stays importable outside Electron (tests, tools). */
const electronPath = (name) => require('electron').app.getPath(name);

/**
 * Coerces whatever was stored — or sent over IPC — into the list the tray can
 * render. Anything unrecognisable is dropped rather than repaired: a snippet is
 * only ever two strings, so there is nothing to salvage from a broken one.
 *
 * @param {unknown} stored
 * @returns {{ label: string, text: string }[]}
 */
function normalize(stored) {
  if (!Array.isArray(stored)) return [];

  const out = [];
  for (const item of stored) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    // The text is copied verbatim, so only the length is touched — leading
    // indentation and trailing newlines are often the point of the snippet.
    const text = typeof item.text === 'string' ? item.text.slice(0, LIMITS.text) : '';
    // A shorthand with nothing to copy is a dead menu row; the editor keeps
    // showing the half-written card, but the tray never grows an item for it.
    if (!text.trim()) continue;

    const label = typeof item.label === 'string' ? item.label.trim().slice(0, LIMITS.label) : '';
    out.push({ label, text });
    if (out.length >= LIMITS.count) break;
  }
  return out;
}

/** @returns {{ label: string, text: string }[]} the stored shorthands, in menu order. */
function load() {
  if (cache) return cache;
  file = path.join(electronPath('userData'), 'snippets.json');
  let stored = null;
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
 * @param {unknown} list
 * @returns {{ label: string, text: string }[]} what was actually written
 */
function save(list) {
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

module.exports = { load, save, normalize, LIMITS };
