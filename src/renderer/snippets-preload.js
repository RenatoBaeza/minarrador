'use strict';

// Bridge for the quick-copy editor window. The only writable store any renderer
// in this app can reach, so the shape is pinned down here rather than trusted:
// the page sends DOM-derived objects, and only two strings per entry get past.

const { contextBridge, ipcRenderer } = require('electron');

const plain = (items) =>
  (Array.isArray(items) ? items : []).map((item) => ({
    label: String(item?.label ?? ''),
    text: String(item?.text ?? ''),
  }));

contextBridge.exposeInMainWorld('quickCopy', {
  list: () => ipcRenderer.invoke('snippets:list'),
  /** @returns {Promise<{label: string, text: string}[]>} the list as it was actually stored. */
  save: (items) => ipcRenderer.invoke('snippets:save', plain(items)),
  close: () => ipcRenderer.send('snippets:close'),
});
