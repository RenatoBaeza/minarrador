# Minarrador

Local-only meeting notes for Windows. Records mic + system audio, transcribes and summarises with [Ollama](https://ollama.com), and can dictate a spoken sentence straight into whatever you're typing — nothing leaves your machine.

---

## How it works

1. **Start recording** with `Ctrl+Shift+R` from anywhere, or from the system-tray icon — Minarrador captures your microphone and system audio simultaneously, and tells you it has started.
2. **Stop recording** when the meeting ends, with the same shortcut. The app automatically:
   - Transcribes the audio locally with whisper.cpp (or an Ollama audio model if whisper.cpp is not installed)
   - Generates structured notes with Ollama: a 5-bullet summary, decisions made, and action items with owners
   - Produces a polished PDF brief
3. **Read it back later.** Left-click the tray icon to open your meetings: every recording you have made, its notes, and the full transcript — with a search box that reads across all of them.
4. **Everything stays local.** No accounts, no cloud, no telemetry. Audio, transcripts and notes live in a folder on your machine.

While you record, a **live transcript** window shows what is being said, a second or so behind the room. That preview is produced by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running as a local process — it transcribes several seconds of speech in a fraction of that, which is what lets captions keep up. Every line is also written to `live-transcript.txt` as it appears, so even a meeting whose processing never ran leaves you a rough transcript rather than a WAV. The transcript that actually gets saved is a separate, more careful pass over the recorded audio once you stop.

If something goes wrong after a meeting — the usual culprit is Ollama not running when you hit Stop — **the audio is always kept and the notes can be written later**: open the recording in the meetings window and press **Generate notes**, or use **Generate Notes for …** in the tray menu.

The app also listens for sustained audio in the background and can suggest starting a recording when it sounds like a meeting is happening.

**Voice input** is the same speech-to-text machinery for a different job: press **`Win+Shift+X`** anywhere, say what you want to type, and press it again. Minarrador transcribes it locally, pastes it into the window that had the cursor, copies it to your clipboard, and files it in the **Dictations** history. It is a toggle — press the key once to start, again to stop — because a global shortcut only fires when a key goes down, and the app deliberately installs no keyboard hooks.

## Prerequisites

| Requirement     | Details                                                       |
| --------------- | ------------------------------------------------------------- |
| **Windows**     | 10 or 11 (x64)                                                |
| **WebView2**    | Built into Windows 11; the installer fetches it on Windows 10 if missing |
| **Ollama**      | Latest release — [download](https://ollama.com/download)      |
| **whisper.cpp** | Optional, for live captions and a far faster saved transcript — **Settings → Install whisper.cpp** |

### whisper.cpp (live captions and the saved transcript)

**Settings → Install whisper.cpp** fetches the prebuilt CPU binaries and the model you pick into `%APPDATA%\Minarrador\whisper`. That downloads whisper.cpp v1.9.2 (8 MB) and, by default, the multilingual `base` model (142 MB). It is the only thing in Minarrador that touches the network, and it only happens when you press the button — afterwards everything is on disk and stays there.

For development, a `vendor/whisper/` folder in the checkout (`bin/whisper-server.exe` plus `models/*.bin`) is picked up as well.

For fewer mistakes in the preview, use `--model large-v3-turbo-q5_0`. It is `large-v3-turbo` quantised to 5 bits — close to the accuracy of the full 2.9 GB `large-v3` at a fifth of the size, because turbo's decoder is distilled to 4 layers from 32.

It is also far slower than `base`, and on the CPU build that matters more than the accuracy does. Measured on a 24-thread i9 against the same 8.7 s of speech: `base` decodes at about 20x realtime, this model at 1.2x. Above 1x it keeps up, but a caption lands a few seconds after the speaker stops rather than about one, and a long stretch with no pause in it can lose words from the preview. Two things buy that back — **Settings → Whisper decode threads** (about 1.8x with all 24) and a `--variant cublas-*` GPU build. On a 4-core laptop this model is below realtime whatever you do, so stay on `base` or `small` there.

The saved transcript is a separate pass over the recorded audio once you stop, using the same weights — and it has no clock to keep up with, so a slower model there costs you minutes rather than words. At the throughput above, an hour of meeting is about three minutes of transcription on `base`, against roughly fifty on `large-v3-turbo-q5_0` — or thirty-odd with all 24 threads. The audio model, for comparison, takes about as long as the meeting itself.

Models accumulate rather than replace, so installing a second model leaves the first in place. Pick between them in **Settings → Whisper model**, in the meetings window. Skip this step and both passes fall back to your Ollama audio model: the live preview works but lags noticeably, and the saved transcript takes about as long as the meeting did, since an audio LLM costs roughly a second per request no matter how short the clip. It is also the difference between Ollama being needed for the notes alone and being needed for everything.

### Ollama model

You need at least one model that supports audio input. The default is **gemma4:12b**, which handles both transcription and summarisation:

```bash
ollama pull gemma4:12b
```

> **Tip:** You can use different models for transcription and summarisation. Pick them in **Settings → Transcription model / Notes model**, in the meetings window. Any model Ollama reports as audio-capable will appear in the transcription list.

## Installation

### From source (development)

You need [Rust](https://rustup.rs) (stable, MSVC toolchain, with the Visual Studio C++ build tools) and Node.js 20.11+ for the TypeScript pages.

```bash
git clone https://github.com/rntbz/minarrador.git
cd minarrador
npm install
npm start          # tauri dev: builds the pages and the Rust core, then launches
```

`npm start -- -- --library` opens the meetings window straight away. Set
`MINARRADOR_DATA_DIR` to a scratch folder to run against throwaway settings
instead of your real `%APPDATA%\Minarrador`.

### Build the installer

```bash
npm run dist
```

This produces a Windows NSIS installer under `src-tauri/target/release/bundle/nsis/`. Run it to install Minarrador like any other app.

## Permissions

Minarrador needs access to your **microphone** and **system audio**. Here's what to check:

### Microphone

1. Open **Windows Settings → Privacy & security → Microphone**
2. Make sure **Microphone access** is turned on
3. Under "Let desktop apps access your microphone", ensure the toggle is **On**

### System audio

System audio is captured with WASAPI loopback on the default output device — whatever your speakers or headphones play. No extra permissions are needed: Windows does not gate audio loopback behind a privacy toggle. If you switch output devices mid-meeting, Minarrador follows the new default within a few seconds.

> **Note:** If you run into issues with system audio, right-click the tray icon → **Troubleshooting → Restart Audio Capture**.

### Firewall

Ollama runs a local HTTP server on `127.0.0.1:11434`. If a firewall prompt appears when you start Ollama, allow it — this is strictly localhost traffic, nothing goes to the internet.

## Usage

### Starting & stopping

- Press **`Ctrl+Shift+R`** anywhere in Windows. The same shortcut stops the
  recording, and both ends raise a notification, so you never have to guess
  whether the room is being captured. Pick a different combination — or turn it
  off — under **Settings → Start and stop shortcut**
- Or **left-click** the waveform icon in the system tray to open the meetings
  window, then hit the green **+ New recording** at the top of the meetings
  list. The same button stops it.
- Or **right-click** the icon and use **Start Recording** / **Stop Recording**
- When processing completes, you'll get a notification — click it to open the PDF

### Your meetings

**Left-click** the tray icon (or **Meetings…** in the menu) to open the app
window. A sidebar down its left edge picks the feature — **Recording**, **Quick
copy**, and **Settings** pinned at the bottom (`Ctrl+1`, `Ctrl+2`, `Ctrl+,`).
Recording is the library: every recording down the left, grouped by day, and whichever one you pick opened
on the right. **Notes** shows the summary, the decisions and the action items;
**Transcript** shows everything that was said, timestamped by the minute.

The search box reads titles *and* transcripts, so "what did we say about
pricing" is one search rather than a trawl through folders — matches are
highlighted and counted per meeting. From an open meeting you can jump to the
PDF brief, the folder itself, or the audio, and copy the whole transcript in one
click. `Ctrl+F` focuses the search, the arrow keys walk the list, and `Esc`
clears the search before it closes the window.

The library only ever reads. A meeting still recording or still being written up
says so on its card, and one whose notes never got written explains why — the
audio is always safe in the folder either way.

### Quick copy

The top of the tray menu holds your shorthands — snippets of text you paste
often. Click one and it goes straight to the clipboard, so it's two clicks from
anywhere: tray icon, then the shorthand.

The list stays in the tray; you edit it from **Quick copy** in the app window's
sidebar: give each one an optional name (that's the label the tray shows —
without one, it shows the start of the text) and the text to copy. It saves
itself as you type and appears in the menu straight away. Everything lives in `snippets.json` next to
your settings.

### Disk usage

**Disk usage** in the app window's sidebar (`Ctrl+3`) shows what is taking the
space in a folder — handy when a year of meeting audio has quietly filled a
drive. Choose a folder, and it is measured once and shown largest first; open
any subfolder to go a level deeper, with loose files gathered into one line so
they compete with the folders beside them. Hover a line to show it in Explorer
or move it to the Recycle Bin (you're asked first, and a meeting that is still
recording or being written up can't be deleted from here).

### Voice input (dictation)

Press **`Win+Shift+X`** anywhere in Windows to open the microphone, say what you
want to type, and press it again to stop. Minarrador then:

- transcribes it locally — the Ollama audio model by default, whisper.cpp if you
  switch the engine,
- pastes it into the window that had the cursor (Windows itself does the typing;
  the clipboard always gets a copy too),
- saves it to the **Dictations** archive, where every entry can be edited,
  copied or deleted.

A small floating pill shows that the mic is live and captions what it hears.
When it cannot paste — usually because the other window is running elevated —
you still get the confirmation notification and the text stays on your
clipboard. The shortcut, the engine and the auto-paste are all under
**Settings → Voice input**; the history is also one click away from the tray via
**Dictations…**. Everything lives locally in `dictations.json`.

### Meeting output

Each recording creates a timestamped folder (e.g. `2026-08-11_14-32-05/`) in your notes directory containing:

| File              | Contents                                                         |
| ----------------- | ---------------------------------------------------------------- |
| `audio.wav`       | Raw recording                                                    |
| `transcript.txt`  | Plain-text transcription                                         |
| `transcript.json` | Timestamped segments, with the engine that produced them         |
| `live-transcript.txt` | The rough live preview, written line by line while you recorded |
| `notes.md`        | Structured notes in Markdown                                     |
| `notes.json`      | Machine-readable notes (title, summary, decisions, action items) |
| `notes.pdf`       | Formatted one-page brief                                         |
| `meta.json`       | Recording metadata (timestamps, duration, sources, models used)  |

By default, notes are saved to `Documents\Minarrador`. Change this in **Settings → Meetings folder → Change…**

### Auto-detect meetings

When **"Suggest recording when audio is detected"** is enabled (on by default), Minarrador watches audio levels in the background. If it hears sustained speech for ~15 seconds, it sends a notification offering to start recording.

### Re-process a recording

If processing fails — most often because Ollama wasn't running when you stopped
— the audio is still saved, and so is whatever the live transcript heard. Fix
the problem (**Settings → Ollama → Open Ollama** starts the daemon for you) and
write the notes from inside the app:

- Open the meetings window, pick the recording, and press **Generate notes**.
  A failed run says what went wrong right above the button.

### Settings

Settings live in the meetings window: open it with a left-click on the tray icon
and hit **Settings** in the header, or go straight there with **Settings…** in
the tray menu.

Anything set to something that is not on the machine — a model that was never
pulled, whisper.cpp with no weights, a meetings folder that has been moved — is
**marked in red**, with what to do about it. That is the point of the pane: a
model name in a settings file says nothing about whether it is installed, and
the difference is a meeting's notes.

| Setting                    | Default                | Description                                 |
| -------------------------- | ---------------------- | ------------------------------------------- |
| Start and stop shortcut    | `Ctrl+Shift+R`         | Global shortcut that toggles recording; marked red if another app already holds it |
| Dictate shortcut           | `Win+Shift+X`          | Global shortcut that starts/stops a voice capture; marked red if another app already holds it |
| Transcribe with (voice)    | Ollama                 | Engine for the finished dictated text — whisper.cpp is the faster alternative |
| Paste where you were typing | ✓                     | Pastes the dictated text into the foreground window with a simulated Ctrl+V; the clipboard always gets a copy |
| Suggest recording on audio | ✓                      | Notify when sustained speech is detected    |
| Start at login             | ✓                      | Launch minimised to tray on Windows startup |
| Open the live transcript   | ✓                      | Shows the preview window when a recording starts |
| Record microphone          | ✓                      | Capture mic input                           |
| Record system audio        | ✓                      | Capture system audio (calls, videos, etc.)  |
| Live transcript engine     | whisper.cpp            | What produces the live preview; falls back to Ollama when whisper.cpp is not installed |
| Whisper model              | `ggml-base.bin`        | GGML weights under `vendor/whisper/models`  |
| Whisper decode threads     | Automatic              | Automatic is half the logical cores, capped at 8; raise it if a large model cannot keep up |
| Saved transcript engine    | whisper.cpp            | What reads the recorded audio after a meeting; falls back to the audio model when whisper.cpp is not installed |
| Transcription model        | `gemma4:12b`           | The audio-capable Ollama model, used whenever whisper.cpp is not |
| Notes model                | `gemma4:12b`           | Model used for summarisation and PDF layout |
| Meetings folder            | `Documents\Minarrador` | Where meeting folders are created           |
| Quick copy                 | —                      | Opens the shorthand editor; the list itself stays in the tray menu |

## Troubleshooting

| Problem                                 | Solution                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| **"Ollama not reachable"** in tray menu | Click **Open Ollama** — in the tray menu, or in **Settings**. It starts the daemon and waits for it |
| **No audio-capable models found**       | Pull one: `ollama pull gemma4:12b`                                                         |
| **whisper.cpp marked red in Settings**  | Use **Settings → Install whisper.cpp**; the live preview falls back to Ollama until it is installed |
| **Live captions lag far behind**        | You are on the Ollama fallback, or a large whisper model — try `--model base` or `tiny`    |
| **Mic not detected**                    | Check Windows mic permissions (see [Permissions](#permissions) above)                      |
| **System audio not working**            | Try **Troubleshooting → Restart Audio Capture** from the tray menu                         |
| **Processing failed notification**      | Open the recording in the meetings window: it says what failed, and **Generate notes** re-runs it once you have fixed it |
| **Dictation didn't paste**              | The text is always on your clipboard — paste it with Ctrl+V. An elevated (admin) window will not accept simulated keystrokes, which is the one case this cannot get around |
| **App doesn't appear at login**         | Re-enable via **Settings → Start Minarrador at login**                                     |

### Log file

The log file is at `%APPDATA%\Minarrador\minarrador.log` (auto-rotated at 2 MB). Open it from the tray: **Troubleshooting → Open Log File**.

You can also copy full diagnostics to your clipboard: **Troubleshooting → Copy Diagnostics**.

## npm scripts

| Command             | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `npm start`         | `tauri dev` — build the pages and the Rust core, launch the app    |
| `npm run build:ui`  | Compile the window pages into `out/renderer`                       |
| `npm test`          | Run the Rust test suite (`cargo test`)                             |
| `npm run lint`      | ESLint over the pages, clippy over the Rust                        |
| `npm run check`     | Type-check, lint and test                                          |
| `npm run dist`      | Build the NSIS installer for Windows x64                           |

## Privacy

Minarrador is **completely local**:

- Audio is recorded to your filesystem and never uploaded
- Transcription and summarisation run on your own machine, via whisper.cpp and Ollama
- The PDF renderer blocks all network requests — even model-generated HTML cannot phone home
- No analytics, no crash reporting, no accounts
- The running app makes zero network requests beyond `127.0.0.1` (Ollama, and the whisper.cpp server it starts itself)
- The dictation auto-paste presses Ctrl+V with the Windows `SendInput` call — the text never leaves your clipboard and the foreground app, and nothing is sent anywhere
- **Settings → Install whisper.cpp** is the one thing that downloads anything, and only whisper.cpp itself

## License

[MIT](LICENSE)
