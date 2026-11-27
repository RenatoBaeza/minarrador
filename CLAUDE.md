# Minarrador

Local-only meeting notes app for Windows. Records mic + system audio, transcribes and summarises with whisper.cpp and Ollama, and can dictate a spoken sentence straight into whatever you're typing — no meeting data leaves the machine. Optionally, signing in with Google syncs the light data (portable settings, quick copy, to-dos, dictation text) through a small server into MongoDB.

## Tech stack

- **Rust** — the whole app: capture, WAV, the engine clients, the pipeline, the stores, the tray, hotkeys, paste, wallpaper. Crate in `src-tauri/`, entry `src-tauri/src/lib.rs` (`run()`)
- **Tauri 2** — tray icon, frameless WebView2 windows, global shortcuts, dialogs, clipboard (plugins: dialog, global-shortcut, single-instance, clipboard-manager, opener)
- **cpal (WASAPI)** — microphone and **loopback** capture of the default output device, natively; no hidden browser window
- **Ollama** — local LLM for the notes, and for the transcript when whisper.cpp is not installed
- **whisper.cpp** — `whisper-server.exe` child process; the live transcript and, by default, the saved one
- **WebView2** — renders the pages, and prints the PDF brief (`PrintToPdf`)
- **Google sign-in + MongoDB** (opt-in) — installed-app OAuth with PKCE in Rust (`oauth.rs`), sync in `cloud.rs`, and a Vercel function in `server/` that verifies the ID token and talks to Atlas
- **TypeScript** (strict) for the window pages only, compiled by plain `tsc` into `out/renderer` — no framework, no bundler

## Project layout

```
├── assets/            # App & tray icons (ico, png, @2x variants) — embedded/bundled by the crate
├── scripts/copy-static.mjs  # Copies pages, styles and icon.png next to the compiled pages
├── src/
│   ├── shared/types.d.ts    # Every payload a page receives — mirrored by src-tauri/src/types.rs
│   └── renderer/            # The window pages (TypeScript, browser only)
│       ├── bridge-common.ts     # invoke/listen over window.__TAURI__, and title-bar dragging
│       ├── *-bridge.ts          # One per window: installs window.library / .dictations / .dictateIndicator
│       ├── bridges.d.ts         # The window.<name> API each bridge implements
│       ├── library.*, library-*.ts   # The app window: sidebar + Recording, Quick copy, Disk usage, To-do, Settings
│       ├── dictate-indicator.*  # Floating "listening" pill
│       └── dictations.*         # Dictation history window
├── src-tauri/
│   ├── tauri.conf.json    # Window-less app, CSP, NSIS bundle
│   ├── capabilities/      # What the three app windows may call in Tauri core (events, dragging)
│   └── src/
│       ├── lib.rs           # Builder: plugins, commands, the meeting-audio protocol, run loop
│       ├── app.rs           # Startup, event dispatch, timers, resume detection, quit/shutdown
│       ├── core.rs          # Core: settings store, AppState, controllers, stores — `core()` from anywhere
│       ├── windowing.rs     # Every window, toasts (notify), native confirm/error dialogs
│       ├── ui.rs            # settings_state, library_activity, health, tray refresh, notify_* signals
│       ├── recording.rs     # Start/stop/finalize, state.stopping, disk + duration guards, pipeline runs
│       ├── services.rs      # Ollama refresh/launch, hotkeys, apply_setting, notes folder, login item
│       ├── voice.rs         # Dictation start/stop/paste flow, mic test
│       ├── commands/        # #[tauri::command]s, one module per namespace: library, settings, disk, dictation, sync
│       ├── capture.rs       # Capture worker thread (owns the streams, mixes, levels) + CaptureController
│       ├── audio.rs         # cpal sources, FIR resampler → 16 kHz, timeline SampleQueue
│       ├── live.rs          # LiveTranscriber (segmenting + engines), SpeechDetector, SilenceDetector
│       ├── dictation.rs     # Dictation worker (mic only) + controller, trim_silence
│       ├── pipeline.rs      # transcribe → summarise → PDF; engines injected as closures
│       ├── ollama.rs        # Ollama HTTP client (transcribe, chat, pull), clean_transcript, collapse_repeats
│       ├── whisper.rs       # whisper-server supervisor + /inference client, clean_whisper_text
│       ├── whisper_setup.rs # Downloads whisper.cpp
│       ├── oauth.rs         # Google sign-in: loopback redirect + PKCE, token refresh, Credential Manager
│       ├── cloud.rs         # Opt-in sync of settings/snippets/todos/dictations; first-link merge, LWW
│       ├── pdf.rs           # HTML → PDF in a hidden, IPC-less WebView2 window
│       ├── library.rs       # Read-only view over the notes folder (list, read, search, cache)
│       ├── audio_serve.rs   # meeting-audio: a meeting's WAV as mono, by byte range (pure)
│       ├── diskusage.rs     # Disk usage walk: folder totals, entries by opaque id
│       ├── stores.rs        # snippets.json, todos.json, dictations.json (one normalize gate each)
│       ├── settings.rs      # settings.json store, defaults, coerce, hotkey choices
│       ├── settings_gate.rs # What a settings patch from the window may change (pure)
│       ├── wallpaper.rs     # Registry read/set + native rendering of the to-do panel
│       ├── desktop_todos.rs # When to redraw the wallpaper, adopting/restoring the original
│       ├── tray.rs          # Tray icon & menu (rebuilt only when it changes)
│       ├── paths.rs         # Meeting folder naming, file names, speaker labels, meeting_dir()
│       ├── wav.rs           # WAV read/write, chunking, channel split, RMS
│       ├── win.rs           # Win32: job object, free space, sleep blocker, SendInput paste, monitors
│       ├── types.rs         # Serde payloads matching src/shared/types.d.ts field for field
│       └── logger.rs        # File logger (log_info!/log_warn!/log_error!)
├── server/            # Sync server: one Vercel function (api/sync.js) + MongoDB; see server/README.md
├── vendor/whisper/    # Optional dev copy of whisper.cpp (bin/, models/) — gitignored
└── out/               # Compiled pages Tauri serves (gitignored)
```

## Architecture

### Tray-only app

No window at startup. The tray icon is the app: **left-click opens the meeting library, right-click opens the menu** (quick-copy list, *Record meeting*, *Start dictation*, *Quit*). The recording clock and pipeline progress are in the tooltip; the menu is rebuilt only when its contents change, not on the one-second tick. `RunEvent::ExitRequested` with no code is prevented, so closing the last window never quits. `--library` opens the library at launch, or raises it from a second launch (single-instance plugin).

**Two independent global shortcuts**, both from fixed choice lists in `settings.rs` (`HOTKEY_CHOICES`, `DICTATE_HOTKEY_CHOICES`) and never free text: a global accelerator is claimed against the whole desktop. Each is unregistered and re-registered on its own (`services::register`), and a combination someone else holds is kept as `hotkey_registered = false` for the settings pane to mark in red. Starting and stopping a recording both raise a notification.

### Windows and the bridge

Every window is a Tauri `WebviewWindow` built **from an async task** (building one on the main thread from a tray handler can deadlock WebView2) — `windowing::show_library/show_dictations/show_indicator`, single-instance each. Pages load `<bridge>.js` then `<page>.js` as ES modules; the bridge installs the same `window.<name>` API the Electron preload used to, implemented with `window.__TAURI__.core.invoke` and `event.listen` (`withGlobalTauri`). ESLint forbids `window.__TAURI__` outside the bridges.

**Every command checks its sender** (`commands::from_library`, window label), like the old `fromLibrary` checks. Payloads are typed twice on purpose — `types.rs` serialises to exactly the names in `src/shared/types.d.ts`; change both together. The CSP lives in `tauri.conf.json` (not in the pages); `media-src` allows only `http://meeting-audio.localhost`.

Frameless windows drag via `enableDrag(selector)` in `bridge-common.ts` (`startDragging` on mousedown in the title bar, interactive elements excluded), because WebView2 under Tauri ignores `-webkit-app-region`. The section a window should open onto is handed over by `library_initial_section` once the page is listening — an event sent while it loads would be lost.

The indicator pill is `focusable(false)` plus `WS_EX_NOACTIVATE`, and is shown with `SW_SHOWNOACTIVATE`: a window that took focus would move the very caret the text is about to be pasted at.

### Audio capture flow (`capture.rs`, `audio.rs`)

1. A **capture worker thread** owns the cpal streams (they cannot leave the thread that opened them) — it plays the part the hidden Chromium window played before. Commands arrive over a channel: `Configure`, `Record(on, channels, ack)`, `Restart`, `Shutdown`.
2. `audio::open_mic` opens the chosen input (by id, then label, then the default, saying so in `mic_error`); `audio::open_loopback` opens WASAPI loopback on the default **output** device (`build_input_stream` on a render device).
3. Each callback averages to mono, runs a 47-tap windowed-sinc low-pass + linear interpolation to 16 kHz (`Resampler`), and pushes into a `SampleQueue`.
4. **Sources are aligned on a timeline, not by counting samples.** Loopback delivers nothing while nothing plays, and the two devices run on different clocks. Each queue knows the timeline frame of its head (anchored to arrival time, re-anchored past 100 ms of drift); the mixer runs 250 ms behind the wall clock (`LATENCY`) and takes `[emitted, target)` from each queue, silence where a queue has nothing.
5. Mic left, system right: interleaved when `channels == 2`, summed to mono otherwise; batches of 4096 frames go to `Shared::on_pcm` (WAV + live transcriber), levels every 200 ms to `on_levels` (detectors + health).

The layout is decided by the side that owns the file: `recording_channels()` is 2 only when both sources opened and `separateChannels` is on. Stop sends `Record(false)` with an ack: the worker mixes the last quarter second still inside the jitter cushion, flushes, and only then is the WAV sealed.

**A dead worker must not pass unnoticed** — the WAV would just stop growing. `worker_loop` runs under `catch_unwind`; on a panic the thread rebuilds it from `shared.config` and re-arms recording into the *same* writer, up to `MAX_RECOVERIES` in a row (reset once a rebuilt graph reports running), emitting `WorkerGone`. A failed device (stream error callback) restarts the sources after 1.5 s; a changed default output device is followed within the 5 s poll.

There is **no echo cancellation** on the mic (Chromium's getUserMedia had it). The 2:1 margin in `Segmenter::speaker` and per-channel transcription are what keep labels honest; headphones remain the reliable setup.

### Live transcript (`live.rs`)

`LiveTranscriber` cuts recorded PCM into segments at natural pauses (`shape()`: whisper 1–12 s with 0.6 s of trailing silence; the Ollama audio model 4–20 s / 0.9 s), measured in seconds of meeting so two channels count right, with `MAX_SECONDS` (20) dropping the oldest audio if an engine falls behind. A tokio task ticks every 250 ms; the previous line is the next segment's `prompt`. Two channels are folded to mono for the request and the speaker inferred by `Segmenter::speaker` (2:1 margin). Engine falls back to Ollama on its own when whisper.cpp is not installed.

Captions go to `live-transcript.txt` **before** the window (`ui::append_live_transcript`, into `state.live_dir` so a segment decoding at Stop lands in its own meeting) and then to the reader as `library:liveLine`. While recording, the reader shows the live panel: clock, Pause/Resume, Stop (native confirmation in `library_stop`). Pause keeps the file and the streams open and drops PCM before the writer.

**Decode threads**: `whisper::default_threads()` is half the logical cores, 2..=8, because whisper-server's own default of 4 leaves `large-v3-turbo-q5_0` below realtime. `whisperThreads` overrides it.

whisper-server is started on first use on the first free port from 8178, is put in a **job object with kill-on-close** (`win::tie_child_to_us`) so even a crashed app takes it down, and is restarted when the model or threads change.

### Meeting library (`library.rs`, `commands/library.rs`)

The folder on disk is the source of truth; nothing in `library.rs` writes. A meeting is recognised by its artefacts (`audio.wav`, `notes.json`, `meta.json`), not its name. Reads run under `spawn_blocking` and go through `LibraryCache`: cards keyed by size+mtime of `CARD_FILES`, transcript search text by size+mtime, capped at `MAX_CACHED_CHARS`, pruned when folders vanish. Search strips speaker prefixes first (`spoken()`), so "you" does not match every labelled line.

The four changes the window can make live in `commands/library.rs` and `recording.rs`, each naming a meeting by **folder name only** (`paths::meeting_dir` rejects separators, `..` and anything whose parent is not the notes folder): `library_reprocess`, `library_record`, `library_rename` (writes `title.txt`, which no pipeline run rewrites; empty restores the model's title) and `library_delete` (native confirmation, `trash::delete`). "Open" names a target from a fixed table (`open_target`), never a path.

`library:changed` fires at the four moments the folder changes (record start/end, pipeline start/end), never from the tray tick. Progress rides `library:progress`, throttled to `PROGRESS_MIN_MS`, and is applied in place. The health strip (Mic, System, Whisper, Ollama) comes from `ui::health()`, pushed on `library:health`, ticking only during the first `HEALTH_WINDOW_SECONDS` of a recording; `state.heard` keeps the loudest level per source.

**The reader plays the meeting** over the `meeting-audio` URI scheme (`http://meeting-audio.localhost/<id>` on Windows): `serve_audio` resolves the id through `open_target`, refuses the meeting being recorded (409), downmixes stereo to mono on the fly (`audio_serve.rs`) and answers byte ranges, capping each response at 2 MB so an hour of audio is never read into memory for one request.

### Settings (`commands/settings.rs`, `settings_gate.rs`)

`settings_state()` assembles values, defaults, installed model lists, whisper's `describe()`, the mic devices, disk and Ollama state — the pane marks in red whatever names something not installed. A patch from the window is cast by the bridge (`FIELDS` in `library-bridge.ts`) and filtered again by `gate_library_patch`: only `LIBRARY_SETTINGS` keys, **never a path** (`notesDir`, `ollamaHost`, `whisperRoot` — the folder is changed through a native dialog), models checked against what is installed, `micDeviceId` against the devices the worker reported. `settings.rs` coerces every value against its default, enforces the enums and ranges, and writes via replace-then-rename.

One download at a time (`state.setup`), cancellable: `settings_pull_model` accepts only the two model names the settings already use; `settings_install_whisper` only a key of `whisper_setup::MODELS`, and installs into `%APPDATA%\Minarrador\whisper` (zip unpacked with the `zip` crate). `open_ollama` launches the installed Ollama (`ollama app.exe` first, `ollama.exe serve` as fallback, detached) and waits up to 30 s for it to answer.

### Quick copy, Disk usage, To-do

- **Quick copy**: `snippets.json`, `stores::snippets::normalize` (keep `{label,text}`, drop empty bodies, 40 max). The tray lists them; a click copies.
- **Disk usage**: `disk_choose` takes the folder from a native dialog, walks it once on a blocking thread (`DiskScan` records every directory's total; links counted, never followed), and hands the page opaque ids. `disk_trash` refuses the root and any folder holding a recording or mid-pipeline meeting, asks natively, uses the Recycle Bin and subtracts the weight itself.
- **To-do**: `todos.json`, array order is the manual order; every other sort is computed in the page. **Desktop to-dos** (`desktopTodos`, off by default) draw the first `DESKTOP_MAX_TASKS` open tasks onto the wallpaper — a picture, not a window, so it survives Win+D. `desktop_todos.rs` copies the current wallpaper into `desktop-todos/original.*` (Windows overwrites its own TranscodedWallpaper), `wallpaper::render` composes it in its Fill/Fit/Stretch/Center/Tile style at the primary monitor's physical size with a blurred, darkened card drawn natively (`image` + `fontdue`, Segoe UI), saves `wallpaper-a/b.png` and sets it with `SystemParametersInfoW`. A 5 s poll notices a new user wallpaper (adopted as the new original), a display change, and midnight. Turning it off restores the original and deletes the folder.

### Voice input (`voice.rs`, `dictation.rs`)

A second worker thread with its own mic stream, so dictation can run mid-meeting. Toggle (shortcuts fire on key-down only): start opens the mic and a `LiveTranscriber` whose captions go to the pill; stop waits for the worker's last batch, trims room tone (`trim_silence`, 50 ms RMS gate), and transcribes with `dictation_engine_for(dictateEngine)` — the Ollama audio model by default, falling back to whichever engine can run. The text goes to the clipboard, then `win::paste_clipboard` waits for the hotkey's modifiers to be released and sends Ctrl+V with `SendInput` (an elevated window silently refuses; the clipboard has it either way), then the archive (`dictations.json`, newest first, 200 max). A failed transcription keeps the clip under `%APPDATA%\Minarrador\dictation-errors`. Five minutes is the ceiling. The settings pane's **Test** opens the same worker in test mode and streams levels on `settings:micTest` for up to 15 s.

### Account and sync (`oauth.rs`, `cloud.rs`, `server/`)

Off until someone presses **Sign in with Google** in Settings, and absent from a build made without `MINARRADOR_SYNC_URL`, `MINARRADOR_GOOGLE_CLIENT_ID` and `MINARRADOR_GOOGLE_CLIENT_SECRET` (compiled in with `option_env!`; also read at run time; https only outside debug). Sign-in opens the system browser and receives the code on a one-shot `127.0.0.1:<random>` listener (PKCE, `state` checked). The refresh token goes to **Windows Credential Manager** (`keyring`, one entry per data folder); `sync.json` holds only the account's display info and per-kind progress.

**What syncs**: `SYNCED_SETTINGS` (a subset of `LIBRARY_SETTINGS`: no paths, mic device, thread count, installed weights, login item or wallpaper), `snippets.json`, `todos.json`, `dictations.json`. Never audio, transcripts, notes or PDFs. The local files stay the source of truth; offline and signed out behave as before.

**Protocol**: one server document per user per kind (`_id = sub:kind`), each with an `updatedAt`. Local writes call `cloud::changed(kind)` (from `apply_setting`, `snippets_save`, `todos_save`, the dictation store's add/update/remove), which marks the kind dirty and kicks a debounced (3 s) sync; the loop also pulls every 5 minutes and at startup. A push lands only if newer (atomic filter on the server); a losing push adopts the server's copy. The **first sync after signing in merges** instead (todos by id + `updatedAt`, dictations by id, snippets by label+text; the account's settings win), so linking a second machine loses nothing. Everything arriving goes through the same gates as window input: `gate_library_patch` for settings (applied with `services::apply_patch`, which does not mark dirty), `normalize` for lists; `library:synced` tells the page to reload a list that is not mid-edit. Sign-out revokes the token and leaves local data untouched.

### Post-recording pipeline (`pipeline.rs`)

1. **Transcribe** — reads the WAV, chunks the downmix once at quiet moments (`split_into_chunks`, `chunkSeconds`), and for a two-channel recording reads each side separately with its own prompt tail (`tracks_of`), skipping silent chunks (`SILENCE_RMS`). Writes `transcript.txt` (speaker-prefixed) and `transcript.json` (segments with `speaker`, `startSeconds`).
2. **Summarise** — condenses past `CONDENSE_THRESHOLD`, adds `speaker_rules()` only when the transcript is labelled, `extract_json` + `normalise_notes` → `notes.json`.
3. **PDF** — asks the model for a designed HTML brief (falls back to `fallback_html`), appends the transcript built in code (`transcript_html`), injects an offline CSP (`finish_html`), and prints it with WebView2 `PrintToPdf` in a hidden window that has no IPC capability and may not navigate (`pdf.rs`).

Engines are closures in `Engines` (built by `recording::engines`), so the stages are tested without models. `transcribe_engine_for` prefers whisper.cpp whenever installed; Ollama is required up front only when it is also the transcriber, and again before the notes — so Ollama down after Stop is a partial failure with a full transcript, finished later with **Generate notes**. A typed title (`title.txt`) wins in `notes.md` and the PDF but is never written into `notes.json`. Ollama requests retry transient failures (3 attempts, growing pause) and are cancellable (`CancellationToken`).

### Per-meeting output folder

`YYYY-MM-DD_HH-MM-SS/` under the notes folder: `audio.wav`, `transcript.txt`/`.json`, `live-transcript.txt`, `notes.md`/`.json`, `notes.pdf`, `meta.json`, and `title.txt` only if renamed; `ERROR.txt` / `UNPROCESSED.txt` explain a folder without notes and are deleted when a run starts.

### Never lose the meeting

- **Startup is all-or-nothing**: a failing `app::setup` logs, shows a message box and exits.
- **A panic is logged** (panic hook) and the capture worker is rebuilt rather than the app dying silently.
- **Quitting mid-recording** (`app::quit`) seals the WAV, writes `UNPROCESSED.txt`, then exits. **Mid-pipeline**, `shutdown` cancels each job's token and leaves the same note.
- **A recording that cannot be written stops**: `WavWriter::write` seals what is on disk and sets `error`; the controller emits `WriteFailed` once and the meeting ends. `check_disk` refuses to start under 300 MB and stops under 150 MB.
- **Nothing runs for ever**: silence stop (`silenceStopMinutes`), hard cap (`maxRecordingMinutes`), and a reminder from three hours in — all on the one-second tick.
- **Sleep**: a `SleepBlocker` thread holds `ES_SYSTEM_REQUIRED` while recording; a lid close is detected by the resume watcher (a wall-clock jump of more than 30 s across a 5 s sleep) and rebuilds the sources into the same file.
- **Only one caller ends a meeting**: `state.stopping` in `finalize_recording`.
- Recordings shorter than one second are discarded.

### Packaging

`npm run dist` → `tauri build` → NSIS installer (current-user install) under `src-tauri/target/release/bundle/nsis/`. Release profile: LTO, `opt-level = "s"`, stripped. The release binary is a GUI-subsystem exe (no console). User data stays in `%APPDATA%\Minarrador` (the Electron build's folder, so settings and lists carry over); `MINARRADOR_DATA_DIR` overrides it for development. Release builds set the AppUserModelID to the bundle identifier for toasts; debug builds borrow PowerShell's so toasts show without an installed shortcut. Login-at-start writes `HKCU\…\Run\Minarrador` with `--hidden` (never in debug builds).

## Key conventions

- **Rust 2021, clippy clean** (`cargo clippy --all-targets -- -D warnings`). Errors that cross into a window are `String` messages; nothing panics on bad input from disk or a page — files and payloads arrive as `serde_json::Value` and are coerced.
- **Lock discipline**: `core().state()` is a std `Mutex`; never hold it across an `.await` or while calling into the capture/dictation controllers.
- **Blocking work off the async runtime**: filesystem walks, WAV reads, zip extraction, wallpaper rendering run in `spawn_blocking`.
- **Network access lives in `ollama.rs`, `whisper.rs`, `whisper_setup.rs`, `oauth.rs` and `cloud.rs`.** The first two only reach `127.0.0.1`; `whisper_setup.rs` fetches whisper.cpp and nothing else; `oauth.rs` talks to Google's OAuth endpoints and `cloud.rs` to the configured sync server, both only once signed in, and never with meeting data.
- **Pages** are TypeScript, browser only, ES modules with `.js` import specifiers, no bundler; they reach the core only through their bridge.
- **No external runtime processes** beyond Ollama and whisper-server: paste is `SendInput`, the wallpaper is the registry + `SystemParametersInfoW` — no PowerShell anywhere.
- Settings default to `gemma4:12b` for both transcription and summarisation; Ollama host `http://127.0.0.1:11434`.

## npm scripts

| Command | Description |
|---------|-------------|
| `npm start` | `tauri dev`: build the pages, build and launch the Rust app (`npm start -- -- --library` opens the window) |
| `npm run build:ui` | Compile the pages into `out/renderer` and copy HTML/CSS/icon beside them |
| `npm run typecheck` | Type-check the pages |
| `npm test` | `cargo test` (pure modules; one `#[ignore]` test renders a wallpaper preview to `MINARRADOR_RENDER_OUT`) |
| `npm run lint` | ESLint over the pages + clippy over the crate |
| `npm run check` | Type-check, lint and test |
| `npm run dist` | Build the NSIS installer |

## Prerequisites

- **Rust** stable (MSVC) with the Visual Studio C++ build tools; **Node.js** ≥ 20.11 for the pages
- **Ollama** (`ollama pull gemma4:12b` or any audio-capable model)
- **whisper.cpp** — optional; **Settings → Install whisper.cpp**, or put a copy in `vendor/whisper/` for development
- Windows 10/11 with WebView2

## Common patterns

### Adding a new setting

1. Add the field to `Settings` and its default in `defaults()` (`src-tauri/src/settings.rs`); add an enum or range there if it has one
2. Add the field to `Settings` in `src/shared/types.d.ts`
3. If the window may set it: add the key to `LibrarySettingKey` (`types.d.ts`), `LIBRARY_SETTINGS` (`settings_gate.rs`) and `FIELDS` (`library-bridge.ts`) — never for a path or host
4. Render a row in `src/renderer/library-settings.ts`
5. Apply it in `services::apply_setting`

### Adding a command

Write it in the matching `commands/*.rs` with a `window: WebviewWindow` parameter and the sender check, add it to `generate_handler!` in `lib.rs`, and call it from the window's bridge with `invoke('<name>', { camelCaseArgs })`.

### Modifying the pipeline

Stages in `pipeline.rs` take the meeting dir, the injected closures (`AsrFn`, `ChatFn`, `PdfFn`), a `ProgressFn` and a `CancellationToken`; add stages in `run_pipeline` and write outputs with the constants in `paths.rs`. Test them with fake closures, as `transcribes_each_side_with_its_own_prompt` does.

### Commands and events

| Command (window → core) | Window | Returns |
|---|---|---|
| `library_list { query }` / `library_read { id }` | library | `{ meetings, activity }` / meeting or `null` |
| `library_open { id, target }`, `library_open_notes_folder`, `library_copy { text }` | library | opened? / — |
| `library_record { on }`, `library_pause { paused }`, `library_stop` | library | bool / bool / `{ ok, reason }` (native confirm) |
| `library_reprocess { id }`, `library_rename { id, title }`, `library_delete { id }` | library | `{ ok, reason }` |
| `library_health`, `library_initial_section`, `library_minimize`, `library_close` | library | health / section or `null` / — |
| `snippets_list`, `snippets_save { items }`, `todos_list`, `todos_save { items }` | library | the list as stored |
| `disk_choose`, `disk_cancel`, `disk_list { id }`, `disk_reveal { id }`, `disk_trash { id }` | library | `{ ok, root, entries, reason }` / … |
| `settings_get`, `settings_set { patch }`, `settings_choose_notes_folder`, `settings_open_ollama`, `settings_cancel_setup`, `settings_test_mic_stop` | library | `settingsState()` |
| `settings_pull_model { name }`, `settings_install_whisper { model }`, `settings_test_mic` | library | `{ ok, reason }` |
| `settings_open_dictations`, `settings_open_log`, `settings_copy_diagnostics`, `settings_restart_capture` | library | — / bool |
| `sync_sign_in`, `sync_now` / `sync_sign_out` | library | `{ ok, reason }` / `settingsState()` |
| `dictations_list`, `dictations_update { id, text }`, `dictations_remove { id }`, `dictations_copy { text }`, `dictations_close` | dictations | list / list or `null` |

| Event (core → window) | Payload |
|---|---|
| `library:changed` | — (re-list) |
| `library:progress` | `libraryActivity()` |
| `library:health` | `health()` |
| `library:liveLine` | `{ id, text, speaker }` |
| `library:show` | `'reader' \| 'quickcopy' \| 'disk' \| 'todos' \| 'settings'` |
| `disk:progress` | `{ files, dirs, current }` |
| `settings:changed` | — |
| `settings:micTest` | `{ testing, level?, micLabel?, micError? }` |
| `library:synced` | `'settings' \| 'snippets' \| 'todos' \| 'dictations'` (arrived from the account) |
| `dictations:changed` | — |
| `dictate:state` | `{ state, text?, error? }` (to the indicator) |

## Important notes

- **No telemetry, and an account only if you sign in.** Without signing in, two things can reach the internet, both only on a button press: `whisper_setup.rs` (GitHub + Hugging Face) and `Ollama::pull` (asks the local daemon to download a model). Signed in, `oauth.rs`/`cloud.rs` sync the light data described above; meeting audio, transcripts and notes never leave the machine.
- Ollama transcription uses the **OpenAI-compatible** `/v1/chat/completions` endpoint because the native `/api/chat` route drops audio.
- `collapse_repeats` (ollama.rs) defends against repetition loops; `clean_whisper_text` strips bracketed annotations and the phrases whisper invents on silence.
- The paste is the one place the app touches another application's window, with a fixed key sequence and no user input.
- The PDF renderer window loads a local file with an injected `default-src 'none'` CSP, has no capability (so no IPC), and refuses any navigation.
