# Minarrador

Local-only meeting notes app for Windows. Records mic + system audio, transcribes and summarises with Ollama — nothing leaves the machine.

## Tech stack

- **Electron** (tray-only, no visible window) — entry point `src/main/main.js`
- **Node.js** — all backend logic in `src/main/`
- **Ollama** — local LLM inference for transcription and summarisation
- **electron-builder** — packaging and NSIS installer (`npm run dist`)
- No framework, no bundler, no TypeScript — plain CommonJS throughout

## Project layout

```
├── assets/            # App & tray icons (ico, png, @2x variants)
├── scripts/           # Dev/build helpers (icon gen, pipeline runner, capture test)
├── src/
│   ├── main/          # Electron main process
│   │   ├── main.js        # App lifecycle, tray wiring, recording start/stop
│   │   ├── tray.js        # System-tray icon & context menu (pure view)
│   │   ├── capture.js     # Audio capture controller + speech detector
│   │   ├── pipeline.js    # Post-recording chain: transcribe → summarise → PDF
│   │   ├── ollama.js      # Ollama HTTP client (transcription + chat)
│   │   ├── wav.js         # WAV read/write, PCM chunking, RMS
│   │   ├── pdf.js         # HTML → PDF via hidden BrowserWindow
│   │   ├── paths.js       # Meeting folder naming, canonical file names
│   │   ├── settings.js    # JSON settings store (%APPDATA%/Minarrador)
│   │   └── logger.js      # File logger
│   └── renderer/      # Hidden renderer for Web Audio capture
│       ├── capture.html   # Minimal page loaded by the hidden window
│       ├── capture.js     # Web Audio graph (mic + system loopback)
│       ├── pcm-worklet.js # AudioWorklet that ships PCM to main
│       └── preload.js     # contextBridge exposing IPC to renderer
├── dist/              # Build output (gitignored)
└── package.json
```

## Architecture

### Tray-only app

No main window is shown. A hidden `BrowserWindow` exists solely to run the Web Audio API (unavailable in the main process). The system-tray icon and context menu are the only UI.

### Audio capture flow

1. `capture.js` (main) creates the hidden renderer and listens for IPC messages
2. `capture.js` (renderer) opens mic + `getDisplayMedia` with `audio: 'loopback'`
3. `pcm-worklet.js` downmixes to mono 16 kHz and ships PCM buffers over IPC
4. Main process writes PCM to a `WavWriter` during recording
5. `SpeechDetector` watches idle levels and fires `'speech'` when sustained audio is detected

### Post-recording pipeline (`pipeline.js`)

1. **Transcribe** — splits WAV into 60 s chunks, sends each to Ollama via the OpenAI-compatible `/v1/chat/completions` endpoint (audio models like `gemma4:12b`)
2. **Summarise** — sends full transcript (or condensed version for long meetings) to Ollama, outputs structured JSON: title, 5-bullet summary, decisions, action items
3. **Render PDF** — asks Ollama to generate a print-ready HTML brief, converts to PDF via a headless `BrowserWindow`, deletes the intermediate HTML

Each step writes its artefact immediately, so a late failure never loses earlier work.

### Per-meeting output folder

Each recording creates a timestamped folder (e.g. `2026-08-11_14-32-05/`) under the configured notes directory containing:
- `audio.wav` — raw recording
- `transcript.txt` / `transcript.json` — full transcription
- `notes.md` / `notes.json` — structured meeting notes
- `notes.pdf` — formatted brief
- `meta.json` — recording metadata

## Key conventions

- **`'use strict'`** at the top of every file
- **CommonJS** (`require` / `module.exports`) — no ES modules
- **No external runtime dependencies** — only Electron APIs, Node built-ins, and the Ollama HTTP API
- **Dev dependencies only**: `electron`, `electron-builder`
- Settings default to `gemma4:12b` for both transcription and summarisation
- Ollama host defaults to `http://127.0.0.1:11434`
- The app registers as a login item with `--hidden` flag

## npm scripts

| Command | Description |
|---------|-------------|
| `npm start` | Launch the app in dev mode |
| `npm run dist` | Build the NSIS installer for Windows x64 |
| `npm run icons` | Regenerate tray/app icons from source |
| `npm run pipeline -- "path"` | Re-run the transcribe→summarise→PDF pipeline on a folder |
| `npm run capture-test` | Test audio capture in isolation |

## Prerequisites

- **Node.js** ≥ 18
- **Ollama** running locally (`ollama serve`) with an audio-capable model pulled (e.g. `ollama pull gemma4:12b`)
- Windows 10/11 — system audio capture uses Electron's `desktopCapturer` loopback

## Common patterns

### Adding a new setting

1. Add the default in `settings.js` → `defaults()`
2. Wire it into the tray menu in `tray.js` (checkbox or submenu)
3. Handle the change in `main.js` → `setSetting` callback

### Modifying the pipeline

Each stage in `pipeline.js` is a standalone async function (`transcribe`, `summarise`, `renderPdf`). They receive the meeting directory, config, and an options bag with `{ onProgress, signal, ollama }`. Add new stages in `runPipeline()` and write outputs to the meeting folder using `FILES` constants from `paths.js`.

### IPC channels

| Channel | Direction | Payload |
|---------|-----------|---------|
| `capture:configure` | main → renderer | `{ active, captureMic, captureSystem }` |
| `capture:setRecording` | main → renderer | `boolean` |
| `capture:pcm` | renderer → main | `ArrayBuffer` (16 kHz mono PCM) |
| `capture:level` | renderer → main | `{ mixed, mic, system }` RMS floats |
| `capture:status` | renderer → main | `{ micOk, systemOk, micError, systemError }` |

## Important notes

- **No cloud, no telemetry, no accounts.** All data stays local.
- The Ollama transcription uses the **OpenAI-compatible** `/v1/chat/completions` endpoint because the native `/api/chat` route silently drops audio fields.
- Recordings shorter than 1 second are automatically discarded.
- The `collapseRepeats` function in `ollama.js` defends against audio model repetition loops.
- Pipeline retries transient Ollama failures (3 attempts with backoff) so a model swap mid-run doesn't kill a long transcription.
