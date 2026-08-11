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

/**
 * Owns the tray icon and its menu. All behaviour is injected so this file stays
 * a pure view over app state.
 */
class AppTray {
  constructor(actions) {
    this.actions = actions;
    this.tray = new Tray(icon('idle'));
    this.tray.setToolTip('Minarrador');
    // Left-click is the fastest path to the thing people actually want.
    this.tray.on('click', () => this.tray.popUpContextMenu());
    this.tray.on('double-click', () => this.actions.toggleTranscript());
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
   * @param {string[]} view.models installed Ollama models
   * @param {string[]} view.audioModels models that accept audio
   * @param {object|null} view.whisper WhisperServer.describe(), or null
   * @param {'whisper'|'ollama'} view.liveEngine the engine actually in use
   * @param {string|null} view.lastDir most recent finished meeting folder
   */
  update(view) {
    const { state, elapsed, progress, settings, status, ollamaUp, models, audioModels, whisper, liveEngine, lastDir } =
      view;
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

    const modelItems = (list, current, onPick, empty = 'No models found — is Ollama running?') =>
      list.length
        ? list.map((name) => ({ label: name, type: 'radio', checked: name === current, click: () => onPick(name) }))
        : [{ label: empty, enabled: false }];

    const whisperInstalled = Boolean(whisper?.available);
    // The setting says what was asked for; liveEngine says what is running. They
    // part company when whisper.cpp was picked but never installed, and the menu
    // should show the fallback rather than quietly claim otherwise.
    const engineItems = [
      {
        label: whisperInstalled
          ? `whisper.cpp — ${whisper.model}`
          : 'whisper.cpp — not installed (npm run whisper:setup)',
        type: 'radio',
        checked: settings.liveEngine === 'whisper',
        enabled: whisperInstalled,
        click: () => a.setSetting({ liveEngine: 'whisper' }),
      },
      {
        label: `Ollama — ${settings.transcribeModel}`,
        type: 'radio',
        checked: settings.liveEngine === 'ollama' || !whisperInstalled,
        click: () => a.setSetting({ liveEngine: 'ollama' }),
      },
      ...(settings.liveEngine === 'whisper' && !whisperInstalled
        ? [{ type: 'separator' }, { label: 'Falling back to Ollama until whisper.cpp is set up', enabled: false }]
        : []),
    ];

    const template = [
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
      ...(state === 'processing' && progress ? [{ label: progress, enabled: false }] : []),
      // Ollama still writes the notes even when whisper.cpp handles the preview,
      // so this stays a warning either way.
      ...(!ollamaUp ? [{ label: '⚠ Ollama not reachable', enabled: false }] : []),
      ...(liveEngine === 'whisper' && whisper?.lastError
        ? [{ label: `⚠ whisper.cpp: ${whisper.lastError.slice(0, 60)}`, enabled: false }]
        : []),
      { type: 'separator' },

      state === 'recording'
        ? { label: 'Stop Recording', click: () => a.stopRecording() }
        // Starting a new meeting while the previous one is still processing is fine.
        : { label: 'Start Recording', click: () => a.startRecording() },

      { type: 'separator' },
      { label: 'Show Live Transcript', click: () => a.toggleTranscript() },
      { label: 'Open Notes Folder', click: () => shell.openPath(settings.notesDir) },
      {
        label: 'Open Last Meeting',
        enabled: Boolean(lastDir),
        click: () => a.openLast(),
      },
      { type: 'separator' },
      {
        label: 'Settings',
        submenu: [
          {
            label: 'Suggest recording when audio is detected',
            type: 'checkbox',
            checked: settings.suggestOnAudio,
            click: (item) => a.setSetting({ suggestOnAudio: item.checked }),
          },
          {
            label: 'Start Minarrador at login',
            type: 'checkbox',
            checked: settings.startAtLogin,
            click: (item) => a.setSetting({ startAtLogin: item.checked }),
          },
          {
            label: 'Open live transcript when recording starts',
            type: 'checkbox',
            checked: settings.liveTranscript,
            click: (item) => a.setSetting({ liveTranscript: item.checked }),
          },
          { type: 'separator' },
          {
            label: 'Record microphone',
            type: 'checkbox',
            checked: settings.captureMic,
            enabled: state !== 'recording',
            click: (item) => a.setSetting({ captureMic: item.checked }),
          },
          {
            label: 'Record system audio',
            type: 'checkbox',
            checked: settings.captureSystem,
            enabled: state !== 'recording',
            click: (item) => a.setSetting({ captureSystem: item.checked }),
          },
          { type: 'separator' },
          { label: 'Live transcript engine', submenu: engineItems },
          {
            label: 'Whisper model',
            enabled: whisperInstalled,
            submenu: modelItems(
              whisper?.models ?? [],
              whisper?.model ?? '',
              (name) => a.setSetting({ whisperModel: name }),
              'No GGML models — run npm run whisper:setup',
            ),
          },
          { type: 'separator' },
          {
            label: 'Transcription model',
            submenu: modelItems(audioModels, settings.transcribeModel, (name) => a.setSetting({ transcribeModel: name })),
          },
          {
            label: 'Notes model',
            submenu: modelItems(models, settings.summaryModel, (name) => a.setSetting({ summaryModel: name })),
          },
          { type: 'separator' },
          { label: 'Change Notes Folder…', click: () => a.chooseNotesFolder() },
        ],
      },
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

module.exports = { AppTray, clock };
