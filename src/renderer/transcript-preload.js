'use strict';

// Bridge for the visible live-transcript window. Read-mostly: it receives
// transcript lines and recording state, and can set the spoken language.

const { contextBridge, ipcRenderer } = require('electron');

/** Languages the transcription prompt understands; '' means auto-detect. */
const LANGUAGES = ['', 'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch'];

contextBridge.exposeInMainWorld('transcript', {
  languages: LANGUAGES,
  onClear: (fn) => ipcRenderer.on('transcript:clear', () => fn()),
  onLine: (fn) => ipcRenderer.on('transcript:line', (_e, text) => fn(String(text ?? ''))),
  onState: (fn) => ipcRenderer.on('transcript:state', (_e, state) => fn(state ?? {})),
  setLanguage: (lang) => {
    // Only ever forward a value the main process already knows about.
    if (LANGUAGES.includes(lang)) ipcRenderer.send('transcript:setLanguage', lang);
  },
});
