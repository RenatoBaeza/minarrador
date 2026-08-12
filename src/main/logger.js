'use strict';

// File logger. The tray menu's "Open Log File" points here, so this is the one
// artefact a bug report is built from — which is precisely why it must never be
// the thing that breaks. Every path below fails soft.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
let logPath = null;
/**
 * Bytes in the current file, tracked rather than stat'ed.
 *
 * The size used to be checked only at init, which is fine for a tool that runs
 * for a minute and wrong for a login item that stays up for weeks: the file
 * simply grew until the next restart. Counting appends costs nothing and keeps
 * the cap meaningful during the session it was written for.
 */
let bytes = 0;

/** Moves the current file aside, keeping exactly one generation. */
function rotate() {
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Nothing to rotate, or the old copy is locked. Either way, keep appending.
  }
  bytes = 0;
}

function init(dir) {
  logPath = path.join(dir, 'minarrador.log');
  bytes = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    bytes = fs.statSync(logPath).size;
    if (bytes > MAX_BYTES) rotate();
  } catch {
    // No log file yet, or it is not rotatable. Either way, carry on.
  }
}

/**
 * Renders one logged argument.
 *
 * Errors keep their stack, strings pass through, and everything else is
 * serialised — including the shapes JSON.stringify refuses: a circular object
 * or a BigInt makes it throw, and this used to be outside the try below, so a
 * bad log call took down whatever was being logged about.
 */
function format(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args.map(format).join(' ')}`;
  console.log(line);
  if (!logPath) return;
  try {
    if (bytes > MAX_BYTES) rotate();
    fs.appendFileSync(logPath, `${line}\n`);
    bytes += Buffer.byteLength(line) + 1;
  } catch {
    // Logging must never take the app down.
  }
}

module.exports = {
  init,
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  get path() {
    return logPath;
  },
  MAX_BYTES,
};
