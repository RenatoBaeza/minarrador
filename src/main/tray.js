'use strict';

const { Tray, Menu, nativeImage, shell, app, clipboard } = require('electron');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

function icon(state) {
  const img = nativeImage.createFromPath(path.join(ASSETS, `tray-${state}.png`));
  img.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(path.join(ASSETS, `tray-${state}@2x.png`)).toPNG(),
  });
  return img;
}

function clock(seconds) {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** How much of a shorthand fits on one menu row before it starts crowding the menu. */
const SNIPPET_LABEL_CHARS = 44;

/**
 * The one-line name a shorthand wears in the menu.
 *
 * Falls back to the text itself, flattened, for anyone who could not be
 * bothered to name it — which is most of them.
 *
 * @param {{ label: string, text: string }} snippet
 */
function snippetLabel(snippet) {
  const raw = (snippet.label || snippet.text).replace(/\s+/g, ' ').trim();
  const short = raw.length > SNIPPET_LABEL_CHARS ? `${raw.slice(0, SNIPPET_LABEL_CHARS - 1)}…` : raw;
  // Windows reads '&' in a menu label as a mnemonic and eats it, so "R&D" would
  // show up as "RD" with a underlined D.
  return short.replace(/&/g, '&&');
}

/**
 * Owns the tray icon and its menu. All behaviour is injected so this file stays
 * a pure view over app state.
 */
class AppTray {
  constructor(actions) {
    this.actions = actions;
    this.tray = new Tray(icon('idle'));
    this.tray.setToolTip('Minarrador');
    // Left-click opens the meeting library — the app's front door, and the one
    // surface with somewhere to go. Right-click keeps the menu, which is where
    // recording lives, so the two clicks stay meaningfully different.
    //
    // Nothing is bound to double-click: Windows sends a plain click first, so a
    // second action here would always arrive with the library already opening.
    this.tray.on('click', () => this.actions.openLibrary());
    this.lastIconState = 'idle';
  }

  /**
   * @param {object} view
   * @param {'idle'|'recording'|'processing'} view.state
   * @param {number} view.elapsed seconds recorded so far
   * @param {string} view.progress human-readable pipeline progress
   * @param {object} view.settings
   * @param {object} view.status capture source status
   * @param {boolean} view.ollamaUp
   * @param {boolean} view.ollamaChecking Ollama is being started or looked for
   * @param {object|null} view.whisper WhisperServer.describe(), or null
   * @param {'whisper'|'ollama'} view.liveEngine the engine actually in use
   * @param {string|null} view.lastDir most recent finished meeting folder
   * @param {{ id: string, label: string }|null} view.retry newest meeting still
   *   owed its notes, which the Retry item would run
   * @param {{ label: string, text: string }[]} view.snippets quick-copy shorthands
   * @param {{ active: boolean, transcribing: boolean, hotkey: string }} view.dictation
   *   voice-input state for the section below the recording controls
   */
  update(view) {
    const {
      state,
      elapsed,
      progress,
      settings,
      status,
      ollamaUp,
      ollamaChecking,
      whisper,
      liveEngine,
      lastDir,
      retry = null,
      snippets = [],
      dictation = { active: false, transcribing: false, hotkey: '' },
    } = view;
    const a = this.actions;

    const iconState = state === 'recording' ? 'recording' : state === 'processing' ? 'processing' : 'idle';
    if (iconState !== this.lastIconState) {
      this.tray.setImage(icon(iconState));
      this.lastIconState = iconState;
    }

    const headline =
      state === 'recording'
        ? `Recording — ${clock(elapsed)}`
        : state === 'processing'
          ? progress || 'Processing…'
          : 'Idle';
    this.tray.setToolTip(`Minarrador — ${headline}`);

    const sources = [
      status.micOk ? 'Mic ✓' : settings.captureMic ? 'Mic ✗' : 'Mic off',
      status.systemOk ? 'System audio ✓' : settings.captureSystem ? 'System audio ✗' : 'System audio off',
    ].join('   ');

    // Quick copy sits above everything, including the recording controls: it is
    // the one thing here reached mid-sentence in a meeting, and a menu item that
    // never moves is one that can be clicked without reading.
    const template = [
      { label: 'Quick copy', enabled: false },
      // The list stays here — it is the whole point of the section — but the
      // editor behind it lives in the library's Settings, with everything else
      // that is configured rather than used.
      ...(snippets.length
        ? snippets.map((snippet) => ({
            label: snippetLabel(snippet),
            click: () => clipboard.writeText(snippet.text),
          }))
        : [{ label: 'No shorthands yet — add them in Settings', enabled: false }]),
      { type: 'separator' },

      { label: headline, enabled: false },
      { label: sources, enabled: false },
      ...(state === 'recording' && settings.liveTranscript
        ? [
            {
              label: `Live: ${
                liveEngine === 'whisper' && whisper ? `whisper.cpp (${whisper.model})` : settings.transcribeModel
              }`,
              enabled: false,
            },
          ]
        : []),
      // No separate progress line: the headline above is already the progress
      // string while processing.
      // Ollama still writes the notes even when whisper.cpp handles the preview,
      // so this stays a warning either way. The fix is to start the daemon, so
      // the menu does that rather than offering to look again and leaving the
      // starting to the user.
      ...(!ollamaUp
        ? [
            { label: '⚠ Ollama not reachable', enabled: false },
            {
              label: ollamaChecking ? 'Starting Ollama…' : 'Open Ollama',
              enabled: !ollamaChecking,
              click: () => a.openOllama(),
            },
          ]
        : []),
      ...(liveEngine === 'whisper' && whisper?.lastError
        ? [{ label: `⚠ whisper.cpp: ${whisper.lastError.slice(0, 60)}`, enabled: false }]
        : []),
      { type: 'separator' },

      state === 'recording'
        ? { label: 'Stop Recording', click: () => a.stopRecording() }
        // Starting a new meeting while the previous one is still processing is fine.
        : { label: 'Start Recording', click: () => a.startRecording() },
      // A meeting whose notes never got written — almost always because Ollama
      // was down at Stop — is one click from being finished. It sits with the
      // recording controls rather than with the things to open because it is
      // the same kind of item: something the app does, not somewhere to go.
      {
        label: retry ? `Generate Notes for ${retry.label}` : 'Generate Missing Notes',
        enabled: Boolean(retry),
        click: () => a.retryNotes(),
      },

      { type: 'separator' },
      // Voice input is the other thing this app can do, and it is reached
      // mid-sentence: a global shortcut, or this. The hotkey name rides along
      // so the menu doubles as a reminder of it.
      { label: 'Voice input', enabled: false },
      dictation.active || dictation.transcribing
        ? {
            label: dictation.transcribing
              ? 'Voice input — transcribing…'
              : 'Voice input — recording. Press again to stop',
            click: () => a.toggleDictation(),
          }
        : {
            label: dictation.hotkey ? `Dictate (${dictation.hotkey})` : 'Dictate',
            click: () => a.toggleDictation(),
          },
      { label: 'Dictations…', click: () => a.openDictations() },

      { type: 'separator' },
      // Also what a left-click on the icon does; listed anyway, because a
      // shortcut nobody is told about is one nobody uses.
      { label: 'Meetings…', click: () => a.openLibrary() },
      { label: 'Show Live Transcript', click: () => a.toggleTranscript() },
      { label: 'Open Notes Folder', click: () => shell.openPath(settings.notesDir) },
      {
        label: 'Open Last Meeting',
        enabled: Boolean(lastDir),
        click: () => a.openLast(),
      },
      { type: 'separator' },
      // Every setting lives in the library window now. A submenu of radio lists
      // could never say which model is missing or which engine is silently
      // falling back, and those are the two things worth knowing about a setup
      // that is not working.
      { label: 'Settings…', click: () => a.openSettings() },
      {
        label: 'Troubleshooting',
        submenu: [
          { label: 'Open Log File', click: () => a.openLog() },
          { label: 'Copy Diagnostics', click: () => clipboard.writeText(a.diagnostics()) },
          { label: 'Restart Audio Capture', click: () => a.restartCapture() },
          { type: 'separator' },
          { label: `Version ${app.getVersion()}`, enabled: false },
        ],
      },
      { type: 'separator' },
      { label: 'Quit Minarrador', click: () => a.quit() },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}

module.exports = { AppTray, clock, snippetLabel };
