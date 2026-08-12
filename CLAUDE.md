# Minarrador

Local-only meeting notes app for Windows. Records mic + system audio, transcribes and summarises with Ollama — nothing leaves the machine.

## Tech stack

- **Electron** (tray-only, no visible window) — entry point `src/main/main.js`
- **Node.js** — all backend logic in `src/main/`
- **Ollama** — local LLM inference for the saved transcript and summarisation
- **whisper.cpp** — local ASR binary driving the real-time live transcript (`npm run whisper:setup`)
- **electron-builder** — packaging and NSIS installer (`npm run dist`)
- No framework, no bundler, no TypeScript — plain CommonJS throughout

## Project layout

```
├── assets/            # App & tray icons (ico, png, @2x variants)
├── scripts/           # Dev/build helpers (icon gen, pipeline runner, capture test, whisper setup)
├── src/
│   ├── main/          # Electron main process
│   │   ├── main.js        # App lifecycle, tray wiring, recording start/stop
│   │   ├── tray.js        # System-tray icon & context menu (pure view)
│   │   ├── capture.js     # Audio capture controller + speech detector
│   │   ├── pipeline.js    # Post-recording chain: transcribe → summarise → PDF
│   │   ├── ollama.js      # Ollama HTTP client (transcription + chat)
│   │   ├── whisper.js     # whisper.cpp server supervisor + /inference client
│   │   ├── wav.js         # WAV read/write, PCM chunking, RMS
│   │   ├── pdf.js         # HTML → PDF via hidden BrowserWindow
│   │   ├── paths.js       # Meeting folder naming, canonical file names
│   │   ├── library.js     # Read-only view over the notes folder (list, read, search)
│   │   ├── settings.js    # JSON settings store (%APPDATA%/Minarrador)
│   │   ├── snippets.js    # Quick-copy shorthand store (%APPDATA%/Minarrador)
│   │   └── logger.js      # File logger
│   └── renderer/      # Hidden renderer for Web Audio capture
│       ├── capture.html   # Minimal page loaded by the hidden window
│       ├── capture.js     # Web Audio graph (mic + system loopback)
│       ├── pcm-worklet.js # AudioWorklet that ships PCM to main
│       ├── preload.js     # contextBridge exposing IPC to renderer
│       ├── transcript.*   # Live transcript window (page, styles, view, preload)
│       ├── library.*      # Meeting library window (page, styles, view, preload)
│       └── snippets.*     # Quick-copy editor window (page, styles, view, preload)
├── vendor/whisper/    # whisper.cpp binaries + GGML models (gitignored, see setup)
├── dist/              # Build output (gitignored)
└── package.json
```

## Architecture

### Tray-only app

No main window is shown at startup. A hidden `BrowserWindow` exists solely to run the Web Audio API (unavailable in the main process). The tray icon is the app: **left-click opens the meeting library, right-click opens the menu.** Nothing is bound to double-click — Windows sends a plain click first, so a second action there would always arrive with the library already opening. Every other window (library, live transcript, quick-copy editor) is opened on demand, frameless, dark, and single-instance.

The menu is deliberately short: the quick-copy list, what is happening now,
Start/Stop, the four things to open, and Troubleshooting. Everything that is
*configured* rather than *done* lives in the library window — a menu is a poor
place to be told that a model is not installed.

### Audio capture flow

1. `capture.js` (main) creates the hidden renderer and listens for IPC messages
2. `capture.js` (renderer) opens mic + `getDisplayMedia` with `audio: 'loopback'`
3. `pcm-worklet.js` downmixes to mono 16 kHz and ships PCM buffers over IPC
4. Main process writes PCM to a `WavWriter` during recording
5. `SpeechDetector` watches idle levels and fires `'speech'` when sustained audio is detected

The worker is sandboxed like every other renderer here. Its preload needs nothing
beyond `contextBridge`/`ipcRenderer`, and `audioWorklet.addModule` still resolves
`pcm-worklet.js` as a sibling file — verified with `npm run capture-test`, which
is the fastest way to re-check it after touching the graph.

**A dead capture renderer is the one failure that must not pass unnoticed.**
Nothing in the main process notices on its own: the `WavWriter` stays open, the
tray still says *Recording*, and the WAV simply stops growing — so a meeting ends
as a few minutes of audio and no warning. `CaptureController` therefore watches
`render-process-gone`, rebuilds the window, replays the configuration it last
sent and re-arms recording into the *same* file. The seconds between the crash
and the new graph are gone, but the meeting continues. Rebuilds are capped at
`MAX_RECOVERIES` in a row, and the count resets as soon as a rebuilt graph
reports itself running, so a renderer that cannot stay up is reported once
instead of being retried for the rest of the meeting. This is also why the IPC
handlers are registered in `init()` and the window is built in `#createWindow()`:
a second set of handlers would write every PCM buffer to the WAV twice.

### Live transcript (`whisper.js` + `LiveTranscriber` in `capture.js`)

Independent of the post-recording pipeline — a rough preview for the person in the
meeting, always superseded by the full pass over the saved WAV.

1. `LiveTranscriber` buffers recorded PCM and cuts it into **segments at natural
   pauses** (trailing silence ≥ `silenceHoldMs`), not on a fixed clock, with a
   `maxSeconds` ceiling for someone who never pauses. The minimum measures
   *voiced* bytes, so a door slam plus silence is not an utterance.
2. Each segment is POSTed as a WAV to a `whisper-server` child process
   (`/inference`, multipart). The previous line is passed as `prompt` so a
   sentence split across segments keeps its context.
3. whisper.cpp runs ~7-8x realtime on CPU with `ggml-base`, so a caption lands
   about a second after the speaker stops.

`LIVE_SEGMENT` in `capture.js` holds the per-engine timing, tuned for `ggml-base`.
A heavier model decodes slower, so captions trail further behind and
`LIVE_MAX_SECONDS` drops the oldest buffered audio during a long unbroken stretch
— by design, since the saved transcript comes from a separate pass. If whisper.cpp
is not installed, `LiveTranscriber.engine` silently falls back to the Ollama audio
model, which uses longer segments because a request costs ~1s regardless of clip
length.

**Decode threads decide whether a large model is usable at all.** whisper-server's
own default is 4 threads, which is ample for `ggml-base` but leaves
`ggml-large-v3-turbo-q5_0` (the accurate option `whisper:setup` offers) at ~0.7x
realtime — below 1x the transcriber can never catch up and spends the meeting
discarding audio. `defaultThreads()` in `whisper.js` therefore resolves the
"automatic" setting to half the logical cores capped at 8 (~1.2x realtime on a
24-thread i9) instead of deferring to the server, and `whisperThreads` overrides it
from **Settings → Whisper decode threads**.

### Meeting library (`library.js` + the library window)

The archive: a rail of every recording on the left, the notes and the full
transcript on the right, and a search box that reads across both. Left-clicking
the tray icon lands here, which makes it the app's front door and the only
window opened without a meeting in progress — so it also carries the two things
a front door needs: the green **+ New recording** button in the header, and the
settings pane behind the button beside it.

**The folder on disk is the source of truth, and the window only reads it.**
There is no index and no database — `listMeetings()` walks the notes folder on
every call, and a meeting is recognised by its artefacts (`audio.wav`,
`notes.json`, `meta.json`) rather than by its name, so a folder renamed by hand
still appears and the user's unrelated folders never do. Nothing in
`library.js` writes, renames or deletes; re-running `npm run pipeline` over a
folder is still how a meeting changes.

A card knows why it has no notes — `pending`, `unprocessed` (quit mid-run),
`failed` (`ERROR.txt`) — and `main.js` adds what only it can know, which
folder is recording and which are mid-pipeline, from `state.jobs`. The reader
renders `notes.json` directly rather than re-parsing `notes.md`, since the JSON
is the structured form the pipeline actually produced.

**The id is a folder name, never a path.** Every entry point runs it through
`meetingDir()`, which requires a bare name whose parent resolves to the notes
folder, and "open this" names a target from a fixed table (`OPEN_TARGETS`)
rather than a file. The notes folder is full of user files and the window is
one `shell.openPath` away from all of them, so the renderer is never given the
vocabulary to ask for one.

Search reads each `transcript.txt` in full, so it is debounced in the renderer
and its responses are sequenced — a query over a large folder can outlive the
one typed after it, and the rail must not end up showing results for a query
that has left the box. Previews avoid the same cost by reading only the first
4 KB of a transcript, and only when there are no notes to quote.

The window refreshes itself on `library:changed`, which main sends at the four
moments the folder actually changes (recording start, recording end, pipeline
start, pipeline end) — never from `refreshTray`, which ticks once a second
while recording and would have the window re-reading every transcript for a
clock.

**The record button has no state of its own.** Recording lives in the main
process, so the button reads `activity.recordingId` from the same list payload
the rail is built from — which is why a meeting started from the tray shows up
here as a Stop button without the window being told anything special. A click
sends `library:record` and waits for the folder list to confirm it; neither call
is awaited in main, since stopping runs the whole pipeline and no click should
hang on minutes of work.

### Settings (the settings pane, `settings:*`)

The second thing the library window is: everything the tray's Settings submenu
used to hold, in the reading column, with the archive's rail still beside it.
The move is not cosmetic — **a submenu could only ever show the list it had.** A
model that was never pulled and a model that is loaded look identical as radio
items, whisper.cpp falling back to Ollama had to be spelled out in a disabled
label, and the difference in both cases is a whole meeting's notes. The pane
therefore renders a value *and* whether the thing it names is installed, and
marks the gap in red with what to do about it (`.row.missing`).

`settingsState()` in `main.js` is what makes that possible: the values, the
defaults, and the installed model lists, whisper's `describe()`, whether the
notes folder still exists and whether Ollama answers — assembled in one place
because the pane is only useful when it can compare the two halves.

The window is still a renderer, so writing a setting is gated twice: the preload
casts a fixed vocabulary of keys to the types the store expects, and
`LIBRARY_SETTINGS` in main filters again on arrival. **Nothing that names a
place is in that set.** The notes folder, the Ollama host and the whisper root
are paths, and a page that could set one could point this app's reading and
writing anywhere on the machine; the folder is changed through a dialog, where
the path comes from the user. The two model names that survive are checked
against what is actually installed, since `whisperModel` is otherwise a
free-form string resolved inside a folder of weights.

`settings:changed` is a separate signal from `library:changed` because the two
go stale for different reasons: the folder changes four times a meeting, while
the pane has to catch the 60s Ollama poll finding the daemon someone started a
moment ago.

**Ollama is started, not looked for.** The tray item behind an unreachable
daemon used to say "try to find Ollama again", which asked the user to go and
run `ollama serve` and come back — for the most common failure in the app, since
a meeting stopped with Ollama down keeps its audio and loses its notes.
`launchOllama()` in `ollama.js` finds the Windows install (the tray app first,
so the daemon outlives this process; the CLI as fallback) and `openOllama()` in
main waits for it to answer before saying anything.

### Quick copy (`snippets.js` + the editor window)

The top section of the tray menu is a list of user-authored shorthands; clicking
one puts its text on the clipboard, so a phrase typed several times a day costs
two clicks. It sits above the recording controls deliberately — it is the one
item here reached mid-meeting, and a row that never moves can be clicked without
reading. The **list** is the part that has to be there; the editor behind it is
configuration, so it opens from the library's settings pane
(`settings:editQuickCopy`) with everything else that is set rather than used.

Stored in `snippets.json` rather than `settings.json`: the settings store coerces
every value against a scalar default and drops the rest, which is what keeps a
hand-edited file from crashing startup, and a list of records does not fit that
shape. `normalize()` is the single gate — it runs on both the file and the IPC
payload, keeps only `{ label, text }`, and drops any entry with an empty body
since that could only ever be a dead menu row.

The editor (`src/renderer/snippets.*`) is the only renderer in the app that
writes anything, so all three IPC channels check `event.sender.id` against the
editor window. Saving refreshes the tray immediately, and closing saves first —
the window is never a way to discard work.

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

### Never lose the meeting

The audio is the only irreplaceable artefact — notes can always be regenerated
from it with `npm run pipeline`. Everything below exists to make sure a folder
either holds finished notes or explains itself:

- **Startup is all-or-nothing.** `whenReady` is guarded: a tray-only app that
  throws during init has nowhere to say so and would otherwise sit in Task
  Manager with no icon and no window. It reports the failure and exits instead.
- **A main-process fault is logged, not fatal.** `uncaughtException` and
  `unhandledRejection` write to the log file, and deliberately do not exit —
  Electron's default dialog never reaches the log the tray menu offers, and a
  recording in progress is worth more than a tidy process.
- **Quitting mid-recording** closes the WAV, leaves `UNPROCESSED.txt`, and quits
  without waiting for a pipeline run that could take minutes.
- **Quitting mid-pipeline** aborts that run's model requests (`state.jobs` maps
  each meeting folder to its `AbortController`) and leaves the same note. Stages
  that had already finished keep their artefacts.

### Packaging (`build` in package.json)

`electronFuses` burns out the developer conveniences that otherwise survive
packaging. They matter more here than in most apps: `ELECTRON_RUN_AS_NODE=1
Minarrador.exe -e '<code>'` turns the shipped binary into a bare Node process
wearing this app's name, and `NODE_OPTIONS` / `--inspect` reach into the real
one — poor footing for something whose whole promise is that meeting audio never
leaves the machine. `onlyLoadAppFromAsar` and `enableEmbeddedAsarIntegrityValidation`
close the other half: the executable refuses an `app.asar` whose hash does not
match the one recorded at build time, so the pipeline cannot be swapped for a
copy that also uploads the transcript.

`grantFileProtocolExtraPrivileges` is deliberately left at its default. Every
page is loaded from disk with `loadFile` and the capture worker fetches
`pcm-worklet.js` as a sibling file, so revoking it would break the audio graph —
and those pages ship with a CSP already. **JSON has no comments and
electron-builder rejects unknown keys**, which is why this rationale lives here
rather than next to the config.

## Key conventions

- **`'use strict'`** at the top of every file
- **CommonJS** (`require` / `module.exports`) — no ES modules
- **No external runtime dependencies** — only Electron APIs, Node built-ins, and two local HTTP APIs (Ollama, whisper-server). whisper.cpp is a downloaded binary, not an npm package
- **Network access lives in `ollama.js` and `whisper.js`** — eslint blocks bare `fetch` elsewhere in `src/main/`
- **Renderer files are linted by naming convention**, not by a list: `*preload.js` gets the preload environment, `*worklet.js` the audio-thread one, and everything else under `src/renderer/` is a browser page with no Node. A new window needs no eslint change — and a page reaches its bridge through `window.<name>`, never as a bare global
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
| `npm run whisper:setup` | Download whisper.cpp + a GGML model into `vendor/whisper` |
| `npm run pipeline -- "path"` | Re-run the transcribe→summarise→PDF pipeline on a folder |
| `npm run capture-test` | Test audio capture in isolation |

## Prerequisites

- **Node.js** ≥ 18
- **Ollama** running locally (`ollama serve`) with an audio-capable model pulled (e.g. `ollama pull gemma4:12b`)
- **whisper.cpp** for live captions: `npm run whisper:setup` (optional — the preview falls back to Ollama without it)
- Windows 10/11 — system audio capture uses Electron's `desktopCapturer` loopback

## Common patterns

### Adding a new setting

1. Add the default in `settings.js` → `defaults()`
2. Add the key to `LIBRARY_SETTINGS` in `main.js` and to `FIELDS` in
   `library-preload.js` — unless it names a path or a host, which the window is
   deliberately not given the vocabulary to set
3. Render a row for it in `src/renderer/library.js` (`toggleRow`, `selectRow` or
   `buttonRow`), in whichever section it belongs to, and mark it `missing` when
   the thing it names is not installed
4. Apply it in `main.js` → `applySetting`, the single path both the tray and the
   pane write through

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
| `snippets:list` | editor → main (invoke) | → `{ label, text }[]` |
| `snippets:save` | editor → main (invoke) | `{ label, text }[]` → the list as stored |
| `snippets:close` | editor → main | — |
| `library:list` | library → main (invoke) | `query` → `{ meetings, activity }` |
| `library:read` | library → main (invoke) | `id` → the meeting, or `null` |
| `library:open` | library → main (invoke) | `{ id, target }` → opened? |
| `library:openNotesFolder` | library → main (invoke) | → opened? |
| `library:copy` | library → main | `string` for the clipboard |
| `library:record` | library → main (invoke) | `boolean` — start or stop; the result arrives as `library:changed` |
| `library:changed` | main → library | — (the folder changed; re-list) |
| `library:showSettings` | main → library | — (the tray's Settings… item) |
| `library:minimize` / `library:close` | library → main | — |
| `settings:get` | library → main (invoke) | → `settingsState()` |
| `settings:set` | library → main (invoke) | patch → `settingsState()` |
| `settings:chooseNotesFolder` | library → main (invoke) | → `settingsState()` |
| `settings:openOllama` | library → main (invoke) | → `settingsState()`, after the daemon answers or times out |
| `settings:editQuickCopy` | library → main | — (opens the shorthand editor) |
| `settings:changed` | main → library | — (a setting, a model list or Ollama changed) |

## Important notes

- **No cloud, no telemetry, no accounts.** All data stays local.
- The Ollama transcription uses the **OpenAI-compatible** `/v1/chat/completions` endpoint because the native `/api/chat` route silently drops audio fields.
- Recordings shorter than 1 second are automatically discarded.
- The `collapseRepeats` function in `ollama.js` defends against audio model repetition loops.
- `cleanWhisperText` in `whisper.js` strips whisper's bracketed annotations and the phrases it invents on near-silence (`"you"`, `"Thanks for watching"`), which is the usual source of phantom captions during a pause.
- `npm run whisper:setup` is the only code in the repo that makes a non-localhost request, and it never runs from the app.
- Pipeline retries transient Ollama failures (3 attempts with backoff) so a model swap mid-run doesn't kill a long transcription.
