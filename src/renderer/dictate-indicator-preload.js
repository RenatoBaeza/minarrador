'use strict';

// Bridge for the dictation indicator: a read-only window that is never allowed
// to steal focus, so it only ever receives state. It has nothing to ask for.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictateIndicator', {
  onState: (fn) => ipcRenderer.on('dictate:state', (_e, payload) => fn(payload ?? {})),
});
