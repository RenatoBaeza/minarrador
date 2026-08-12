'use strict';

// Bridge for the hidden capture worker. It has no UI and no transcript view —
// it only moves audio and status out to the main process.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  /** Raw 16-bit PCM for the file being recorded. */
  sendPcm: (arrayBuffer) => ipcRenderer.send('capture:pcm', arrayBuffer),
  /** Mixed/mic/system levels, ~5 per second. */
  sendLevel: (levels) => ipcRenderer.send('capture:level', levels),
  /** Which sources actually opened, plus any error text. */
  sendStatus: (status) => ipcRenderer.send('capture:status', status),
  /** Audio inputs this machine has, so the settings pane can offer a choice. */
  sendDevices: (devices) => ipcRenderer.send('capture:devices', devices),

  onConfigure: (fn) => ipcRenderer.on('capture:configure', (_e, cfg) => fn(cfg)),
  /** `channels` is the WAV layout main is writing: 1 summed, or 2 kept apart. */
  onSetRecording: (fn) => ipcRenderer.on('capture:setRecording', (_e, value, channels) => fn(value, channels)),
});
