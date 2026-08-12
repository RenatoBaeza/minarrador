'use strict';

// Bridge for the meeting library window. Read-only over the notes folder: the
// page can list, open and quote meetings, and cannot write, rename or delete
// one. Every call names a meeting by its folder name and the main process
// resolves it — no path ever crosses this boundary in the other direction.

const { contextBridge, ipcRenderer } = require('electron');

/** Things the window may ask the shell to open. Mirrors OPEN_TARGETS in library.js. */
const TARGETS = ['folder', 'pdf', 'notes', 'transcript', 'audio'];

contextBridge.exposeInMainWorld('library', {
  /** @param {string} query filters by title and transcript text; '' lists everything. */
  list: (query) => ipcRenderer.invoke('library:list', String(query ?? '')),
  read: (id) => ipcRenderer.invoke('library:read', String(id ?? '')),
  /** @returns {Promise<boolean>} false when the file is not there to open. */
  open: (id, target) =>
    TARGETS.includes(target)
      ? ipcRenderer.invoke('library:open', { id: String(id ?? ''), target })
      : Promise.resolve(false),
  openNotesFolder: () => ipcRenderer.invoke('library:openNotesFolder'),
  copy: (text) => ipcRenderer.send('library:copy', String(text ?? '')),
  /** Fires when a recording starts or a pipeline run finishes, so the list can catch up. */
  onChanged: (fn) => ipcRenderer.on('library:changed', () => fn()),
  minimize: () => ipcRenderer.send('library:minimize'),
  close: () => ipcRenderer.send('library:close'),
});
