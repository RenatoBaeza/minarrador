'use strict';

// Bridge for the dictations window: the archive of everything the voice-input
// hotkey has transcribed. Like quick copy, it is the only window that writes to
// its own store, so every channel checks the sender — the dictations window, or
// nothing.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictations', {
  /** @returns {Promise<{ id: string, text: string, createdAt: string }[]>} */
  list: () => ipcRenderer.invoke('dictations:list'),
  /**
   * Saves an edit to one dictation.
   * @returns {Promise<{ id, text, createdAt }[] | null>} the list after the
   *   change, or null when the id was gone (someone deleted it elsewhere).
   */
  update: (id, text) => ipcRenderer.invoke('dictations:update', { id: String(id ?? ''), text: String(text ?? '') }),
  /** @returns {Promise<{ id, text, createdAt }[] | null>} */
  remove: (id) => ipcRenderer.invoke('dictations:remove', String(id ?? '')),
  copy: (text) => ipcRenderer.send('dictations:copy', String(text ?? '')),
  close: () => ipcRenderer.send('dictations:close'),
  /** A dictation landed while the window was open; re-list. */
  onChanged: (fn) => ipcRenderer.on('dictations:changed', () => fn()),
});
