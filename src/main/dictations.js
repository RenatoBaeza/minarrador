'use strict';

// The voice-input archive: everything the dictation hotkey has transcribed, in
// order, kept so a dictated sentence is never lost to a paste that went
// somewhere it should not have.
//
// Its own file rather than a field in settings.json for the same reason as
// snippets.json: that store coerces every value against a scalar default, and a
// list of records does not fit the shape. It is also separate from the meeting
// library on purpose — these are scraps of text, not recordings, and the two
// archives have nothing else in common but being local.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Ceilings, so a hand-edited file — or a user holding the hotkey for a very
 * long time — cannot grow an unbounded JSON blob. 20k characters is a few
 * minutes of continuous dictation; past that the text is truncated rather than
 * the window left thinking it saved what it showed.
 */
const LIMITS = { count: 200, text: 20_000 };

let cache = null;
let file = null;

/** Required lazily so this module stays importable outside Electron (tests). */
const electronPath = (name) => require('electron').app.getPath(name);

/**
 * Coerces whatever was stored — or sent over IPC — into the list the window can
 * render. Anything unrecognisable is dropped rather than repaired: a dictation
 * is three fields, and a broken one has nothing to salvage.
 *
 * @param {unknown} stored
 * @returns {{ id: string, text: string, createdAt: string }[]}
 */
function normalize(stored) {
  if (!Array.isArray(stored)) return [];

  const out = [];
  for (const item of stored) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    // The text is kept verbatim apart from the length — a dictated paragraph is
    // meant to be pasted whole, leading and trailing whitespace included.
    const text = typeof item.text === 'string' ? item.text.slice(0, LIMITS.text) : '';
    // A dictation with no text is a dead row; it can only ever be a failed
    // transcription, which never saved anything.
    if (!text.trim()) continue;

    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : randomUUID();
    const createdAt = typeof item.createdAt === 'string' && item.createdAt ? item.createdAt : new Date().toISOString();

    out.push({ id, text, createdAt });
    if (out.length >= LIMITS.count) break;
  }
  return out;
}

/** @returns {{ id: string, text: string, createdAt: string }[]} newest first. */
function load() {
  if (cache) return cache;
  file = path.join(electronPath('userData'), 'dictations.json');
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First run, or a corrupt file we can safely discard.
  }
  cache = normalize(stored);
  return cache;
}

/** Write-then-rename so a crash mid-write cannot leave a truncated file behind. */
function write(list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
  return list;
}

/** A fresh read for anything that opened the window, rather than a cached view. */
function list() {
  return load().slice();
}

/**
 * Adds a dictation to the front of the archive.
 *
 * @param {string} text
 * @returns {{ id: string, text: string, createdAt: string } | null} null when
 *   the text was empty, which is a failed transcription, not a dictation
 */
function add(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const item = { id: randomUUID(), text: clean.slice(0, LIMITS.text), createdAt: new Date().toISOString() };
  cache = [item, ...load()].slice(0, LIMITS.count);
  write(cache);
  return item;
}

/**
 * Replaces one dictation's text. The timestamp and id are the row's identity,
 * so editing only ever touches the body.
 *
 * @returns {{ id: string, text: string, createdAt: string }[] | null} null when
 *   the id is unknown or the text was emptied (which is a delete, not an edit)
 */
function update(id, text) {
  load();
  const clean = String(text ?? '');
  if (!clean.trim()) return null;
  const index = cache.findIndex((item) => item.id === id);
  if (index === -1) return null;
  cache[index] = { ...cache[index], text: clean.slice(0, LIMITS.text) };
  return write(cache);
}

/**
 * Removes one dictation.
 *
 * @returns {{ id: string, text: string, createdAt: string }[] | null} null when
 *   the id did not exist
 */
function remove(id) {
  load();
  if (!cache.some((item) => item.id === id)) return null;
  cache = cache.filter((item) => item.id !== id);
  return write(cache);
}

module.exports = { normalize, load, list, add, update, remove, LIMITS };
