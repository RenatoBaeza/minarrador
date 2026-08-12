'use strict';

// Pasting dictated text into the window the user was typing in.
//
// Electron cannot type into another application's window: a renderer can only
// `sendInputEvent` into its own web contents, and there is no global keyboard
// injection API. The one dependency-free way is to let Windows do it — the
// clipboard already holds the text, and powershell.exe (which ships with every
// Windows install) calls SendKeys to press Ctrl+V in the foreground
// application. That is a silent no-op in elevated (admin) windows, so this is
// best-effort by design: the clipboard always holds the text either way, and
// the caller tells the user when the paste could not land.

const { spawn } = require('node:child_process');

const log = require('./logger');

const POWERSHELL = 'powershell.exe';

// Fixed command, no user input interpolated anywhere near it.
const SEND_KEYS =
  "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v'); " +
  '[System.Windows.Forms.Application]::DoEvents()';

/**
 * Presses Ctrl+V in whatever window is in the foreground, via built-in
 * PowerShell. Resolves `true` when the process ran at all — a SendKeys call
 * cannot be confirmed — and `false` when it could not even be launched.
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
function pasteClipboardInForeground({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    let child;
    try {
      child = spawn(
        POWERSHELL,
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-WindowStyle',
          'Hidden',
          '-Command',
          SEND_KEYS,
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch (err) {
      log.warn('could not launch powershell for the paste:', err.message);
      settle(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      settle(false);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      settle(false);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      settle(true);
    });
  });
}

module.exports = { pasteClipboardInForeground };
