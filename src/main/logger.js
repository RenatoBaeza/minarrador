'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
let logPath = null;

function init(dir) {
  logPath = path.join(dir, 'minarrador.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.statSync(logPath).size > MAX_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // No log file yet, or it is not rotatable. Either way, carry on.
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  console.log(line);
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      // Logging must never take the app down.
    }
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
};
