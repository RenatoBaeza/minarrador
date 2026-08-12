'use strict';

// Bridge for the visible live-transcript window. Read-mostly: it receives
// transcript lines and recording state, and can set the spoken language.

const { contextBridge, ipcRenderer } = require('electron');

/** Languages the transcription prompt understands; '' means auto-detect. */
const LANGUAGES = ['', 'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch'];

/** How the two sides of a two-channel recording are named on screen. */
const SPEAKERS = { mic: 'You', system: 'Others' };

contextBridge.exposeInMainWorld('transcript', {
  languages: LANGUAGES,
  speakers: SPEAKERS,
  onClear: (fn) => ipcRenderer.on('transcript:clear', () => fn()),
  onLine: (fn) =>
    ipcRenderer.on('transcript:line', (_e, line) =>
      fn({
        text: String(line?.text ?? ''),
        // Only ever one of the two names above reaches the page; anything else
        // is an unlabelled line, which is what a mono recording produces.
        speaker: SPEAKERS[line?.speaker] ? String(line.speaker) : '',
      }),
    ),
  onState: (fn) => ipcRenderer.on('transcript:state', (_e, state) => fn(state ?? {})),
  setLanguage: (lang) => {
    // Only ever forward a value the main process already knows about.
    if (LANGUAGES.includes(lang)) ipcRenderer.send('transcript:setLanguage', lang);
  },
  /** The preview's one way text leaves the window. */
  copy: (text) => ipcRenderer.send('transcript:copy', String(text ?? '')),
  close: () => ipcRenderer.send('transcript:close'),
});
