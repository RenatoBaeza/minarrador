// Bridge for the dictations window: the archive of everything the voice-input
// hotkey has transcribed. Like quick copy, it is the only window that writes to
// its own store, so every channel checks the sender — the dictations window, or
// nothing.

import { contextBridge, ipcRenderer } from 'electron';

import type { DictationsBridge } from './bridges';

const api: DictationsBridge = {
  list: () => ipcRenderer.invoke('dictations:list'),
  /**
   * Saves an edit to one dictation. Resolves to the list after the change, or
   * null when the id was gone (someone deleted it elsewhere).
   */
  update: (id, text) => ipcRenderer.invoke('dictations:update', { id: String(id ?? ''), text: String(text ?? '') }),
  remove: (id) => ipcRenderer.invoke('dictations:remove', String(id ?? '')),
  copy: (text) => ipcRenderer.send('dictations:copy', String(text ?? '')),
  close: () => ipcRenderer.send('dictations:close'),
  /** A dictation landed while the window was open; re-list. */
  onChanged: (fn) => {
    ipcRenderer.on('dictations:changed', () => fn());
  },
};

contextBridge.exposeInMainWorld('dictations', api);
