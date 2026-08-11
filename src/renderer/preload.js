'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  /** Raw 16-bit PCM for the file being recorded. */
  sendPcm: (arrayBuffer) => ipcRenderer.send('capture:pcm', arrayBuffer),
  /** Mixed/mic/system levels, ~10 per second. */
  sendLevel: (levels) => ipcRenderer.send('capture:level', levels),
  /** Which sources actually opened, plus any error text. */
  sendStatus: (status) => ipcRenderer.send('capture:status', status),

  onConfigure: (fn) => ipcRenderer.on('capture:configure', (_e, cfg) => fn(cfg)),
  onSetRecording: (fn) => ipcRenderer.on('capture:setRecording', (_e, value) => fn(value)),
});
