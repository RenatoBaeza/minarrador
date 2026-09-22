'use strict';

// Bridge for the visible live-transcript window. Read-mostly: it receives
// transcript lines and recording state, and can copy what it shows.

const { contextBridge, ipcRenderer } = require('electron');

/** How the two sides of a two-channel recording are named on screen. */
const SPEAKERS = { mic: 'You', system: 'Others' };

contextBridge.exposeInMainWorld('transcript', {
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
  /** The preview's one way text leaves the window. */
  copy: (text) => ipcRenderer.send('transcript:copy', String(text ?? '')),
  close: () => ipcRenderer.send('transcript:close'),
});
