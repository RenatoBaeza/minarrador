// Bridge for the hidden dictation worker. It has no UI — it only opens the mic
// when told to, streams PCM out while it does, and closes when told to stop.

import { contextBridge, ipcRenderer } from 'electron';

import type { DictateBridge } from './bridges';

const api: DictateBridge = {
  /** Raw 16-bit PCM while the capture is running. */
  sendPcm: (arrayBuffer) => ipcRenderer.send('dictate:pcm', arrayBuffer),
  /** An RMS level, so the indicator can show that the mic is hearing something. */
  sendLevel: (level) => ipcRenderer.send('dictate:level', level),
  /** Which sources opened, plus any error text. */
  sendStatus: (status) => ipcRenderer.send('dictate:status', status),

  /** `cfg` carries the chosen microphone, like capture:configure does for meetings. */
  onStart: (fn) => {
    ipcRenderer.on('dictate:start', (_e, cfg) => fn(cfg));
  },
  onStop: (fn) => {
    ipcRenderer.on('dictate:stop', () => fn());
  },
};

contextBridge.exposeInMainWorld('dictate', api);
