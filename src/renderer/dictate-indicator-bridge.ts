// Bridge for the dictation indicator: a read-only window that is never allowed
// to steal focus, so it only ever receives state. It has nothing to ask for.

import { contextBridge, ipcRenderer } from 'electron';

import type { DictateIndicatorBridge } from './bridges';

const api: DictateIndicatorBridge = {
  onState: (fn) => {
    ipcRenderer.on('dictate:state', (_e, payload) => fn(payload ?? {}));
  },
};

contextBridge.exposeInMainWorld('dictateIndicator', api);
