# Minarrador

Local-only meeting notes for Windows. Records mic + system audio, transcribes and summarises with [Ollama](https://ollama.com) — nothing leaves your machine.

---

## How it works

1. **Start recording** from the system-tray icon — Minarrador captures your microphone and system audio simultaneously.
2. **Stop recording** when the meeting ends. The app automatically:
   - Transcribes the audio locally using an Ollama model
   - Generates structured notes: a 5-bullet summary, decisions made, and action items with owners
   - Produces a polished PDF brief
3. **Everything stays local.** No accounts, no cloud, no telemetry. Audio, transcripts and notes live in a folder on your machine.

While you record, a **live transcript** window shows what is being said, a second or so behind the room. That preview is produced by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running as a local process — it transcribes several seconds of speech in a fraction of that, which is what lets captions keep up. The transcript that actually gets saved is a separate, more careful pass over the recorded audio once you stop.

The app also listens for sustained audio in the background and can suggest starting a recording when it sounds like a meeting is happening.

## Prerequisites

| Requirement     | Details                                                       |
| --------------- | ------------------------------------------------------------- |
| **Windows**     | 10 or 11 (x64)                                                |
| **Node.js**     | v18 or later — [download](https://nodejs.org)                 |
| **Ollama**      | Latest release — [download](https://ollama.com/download)      |
| **whisper.cpp** | Optional, for live captions — `npm run whisper:setup`         |

### whisper.cpp (live transcript)

One command fetches the prebuilt binaries and a model into `vendor/whisper/`:

```bash
npm run whisper:setup
```

That downloads whisper.cpp v1.9.2 (8 MB) and the multilingual `base` model (142 MB). It is the only step in Minarrador that touches the network, and it is deliberately something you run rather than something the app does on its own — afterwards everything is on disk and stays there.

```bash
npm run whisper:setup -- --model small      # slower, more accurate
npm run whisper:setup -- --variant cublas-12.4   # NVIDIA GPU build
npm run whisper:setup -- --help             # all models and variants
```

Pick the model from the tray under **Settings → Whisper model**. Skip this step and the live preview falls back to your Ollama audio model, which works but lags noticeably — an audio LLM costs about a second per request no matter how short the clip.

### Ollama model

You need at least one model that supports audio input. The default is **gemma4:12b**, which handles both transcription and summarisation:

```bash
ollama pull gemma4:12b
```

> **Tip:** You can use different models for transcription and summarisation. Pick them from the tray menu under **Settings → Transcription model / Notes model**. Any model Ollama reports as audio-capable will appear in the transcription list.

## Installation

### From source (development)

```bash
# Clone the repo
git clone https://github.com/rntbz/minarrador.git
cd minarrador

# Install dependencies
npm install

# Start the app
npm start
```

### Build the installer

```bash
npm run dist
```

This produces a Windows NSIS installer at `dist/Minarrador-Setup-1.0.0.exe`. Run it to install Minarrador like any other app.

## Permissions

Minarrador needs access to your **microphone** and **system audio**. Here's what to check:

### Microphone

1. Open **Windows Settings → Privacy & security → Microphone**
2. Make sure **Microphone access** is turned on
3. Under "Let desktop apps access your microphone", ensure the toggle is **On**

### System audio

System audio capture uses Electron's built-in screen-capture loopback. No extra permissions are needed — Windows does not gate audio-only loopback behind a privacy toggle.

> **Note:** If you run into issues with system audio, right-click the tray icon → **Troubleshooting → Restart Audio Capture**.

### Firewall

Ollama runs a local HTTP server on `127.0.0.1:11434`. If a firewall prompt appears when you start Ollama, allow it — this is strictly localhost traffic, nothing goes to the internet.

## Usage

### Starting & stopping

- **Right-click** the waveform icon in the system tray
- Click **Start Recording** to begin, **Stop Recording** to finish
- When processing completes, you'll get a notification — click it to open the PDF

### Meeting output

Each recording creates a timestamped folder (e.g. `2026-08-11_14-32-05/`) in your notes directory containing:

| File              | Contents                                                         |
| ----------------- | ---------------------------------------------------------------- |
| `audio.wav`       | Raw recording                                                    |
| `transcript.txt`  | Plain-text transcription                                         |
| `transcript.json` | Timestamped segments with model metadata                         |
| `notes.md`        | Structured notes in Markdown                                     |
| `notes.json`      | Machine-readable notes (title, summary, decisions, action items) |
| `notes.pdf`       | Formatted one-page brief                                         |
| `meta.json`       | Recording metadata (timestamps, duration, sources, models used)  |

By default, notes are saved to `Documents\Minarrador`. Change this from the tray menu: **Settings → Change Notes Folder…**

### Auto-detect meetings

When **"Suggest recording when audio is detected"** is enabled (on by default), Minarrador watches audio levels in the background. If it hears sustained speech for ~15 seconds, it sends a notification offering to start recording.

### Re-process a recording

If processing fails (e.g. Ollama wasn't running), the audio is still saved. Fix the issue and re-run:

```bash
npm run pipeline -- "C:\Users\you\Documents\Minarrador\2026-08-11_14-32-05"
```

### Settings

All settings are accessible from the tray menu under **Settings**:

| Setting                    | Default                | Description                                 |
| -------------------------- | ---------------------- | ------------------------------------------- |
| Suggest recording on audio | ✓                      | Notify when sustained speech is detected    |
| Start at login             | ✓                      | Launch minimised to tray on Windows startup |
| Record microphone          | ✓                      | Capture mic input                           |
| Record system audio        | ✓                      | Capture system audio (calls, videos, etc.)  |
| Live transcript engine     | whisper.cpp            | What produces the live preview; falls back to Ollama when whisper.cpp is not installed |
| Whisper model              | `ggml-base.bin`        | GGML weights under `vendor/whisper/models`  |
| Transcription model        | `gemma4:12b`           | Audio-capable model used for the saved transcript |
| Notes model                | `gemma4:12b`           | Model used for summarisation and PDF layout |
| Notes folder               | `Documents\Minarrador` | Where meeting folders are created           |

## Troubleshooting

| Problem                                 | Solution                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| **"Ollama not reachable"** in tray menu | Start Ollama with `ollama serve`, or check it's on `http://127.0.0.1:11434`                |
| **No audio-capable models found**       | Pull one: `ollama pull gemma4:12b`                                                         |
| **whisper.cpp greyed out in the menu**  | Run `npm run whisper:setup`; the tray shows the path it looked in                          |
| **Live captions lag far behind**        | You are on the Ollama fallback, or a large whisper model — try `--model base` or `tiny`    |
| **Mic not detected**                    | Check Windows mic permissions (see [Permissions](#permissions) above)                      |
| **System audio not working**            | Try **Troubleshooting → Restart Audio Capture** from the tray menu                         |
| **Processing failed notification**      | Open the meeting folder — `ERROR.txt` has details. Usually: start Ollama or pull the model |
| **App doesn't appear at login**         | Re-enable via **Settings → Start at login** in the tray menu                               |

### Log file

The log file is at `%APPDATA%\Minarrador\minarrador.log` (auto-rotated at 2 MB). Open it from the tray: **Troubleshooting → Open Log File**.

You can also copy full diagnostics to your clipboard: **Troubleshooting → Copy Diagnostics**.

## npm scripts

| Command                      | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `npm start`                  | Launch the app                                           |
| `npm run dist`               | Build the NSIS installer for Windows x64                 |
| `npm run icons`              | Regenerate app and tray icons                            |
| `npm run whisper:setup`      | Download whisper.cpp and a model into `vendor/whisper`   |
| `npm run pipeline -- "path"` | Re-run transcription + summarisation on a meeting folder |
| `npm run capture-test`       | Test audio capture in isolation                          |

## Privacy

Minarrador is **completely local**:

- Audio is recorded to your filesystem and never uploaded
- Transcription and summarisation run on your own machine, via whisper.cpp and Ollama
- The PDF renderer blocks all network requests — even model-generated HTML cannot phone home
- No analytics, no crash reporting, no accounts
- The running app makes zero network requests beyond `127.0.0.1` (Ollama, and the whisper.cpp server it starts itself)
- `npm run whisper:setup` is the one command that downloads anything, and only whisper.cpp itself

## License

[MIT](LICENSE)
