# Minarrador

Local-only meeting notes app for Windows. Records mic + system audio, transcribes and summarises with Ollama, and can dictate a spoken sentence straight into whatever you're typing — nothing leaves the machine.

## Tech stack

- **Electron** (tray-only, no visible window) — entry point `src/main/main.js`
- **Node.js** — all backend logic in `src/main/`
- **Ollama** — local LLM inference for the notes, and for the transcript when whisper.cpp is not installed
- **whisper.cpp** — local ASR binary; the live transcript and, by default, the saved one (`npm run whisper:setup`)
- **PowerShell** — the `powershell.exe` built into Windows, used for the one-way paste of dictated text into the foreground application
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
│   │   ├── capture.js     # Audio capture controller + speech/silence detectors
│   │   ├── pipeline.js    # Post-recording chain: transcribe → summarise → PDF
│   │   ├── ollama.js      # Ollama HTTP client (transcription, chat, pull)
│   │   ├── whisper.js     # whisper.cpp server supervisor + /inference client
│   │   ├── whisper-setup.js # Downloads whisper.cpp; the one outbound path
│   │   ├── wav.js         # WAV read/write, PCM chunking, channel split, RMS
│   │   ├── pdf.js         # HTML → PDF via hidden BrowserWindow
│   │   ├── paths.js       # Meeting folder naming, file names, speaker labels
│   │   ├── library.js     # Read-only view over the notes folder (list, read, search)
│   │   ├── settings.js    # JSON settings store (%APPDATA%/Minarrador)
│   │   ├── snippets.js    # Quick-copy shorthand store (%APPDATA%/Minarrador)
│   │   ├── dictations.js  # Dictation archive store (%APPDATA%/Minarrador)
│   │   ├── dictation.js   # Voice-input controller (mic capture + transcription)
│   │   ├── paste.js       # OS-level Ctrl+V via built-in PowerShell
│   │   └── logger.js      # File logger
│   └── renderer/      # Hidden renderers for Web Audio capture
│       ├── capture.html   # Minimal page loaded by the hidden window
│       ├── capture.js     # Web Audio graph (mic + system loopback)
│       ├── pcm-worklet.js # AudioWorklet that ships PCM to main
│       ├── preload.js     # contextBridge exposing IPC to renderer
│       ├── transcript.*   # Live transcript window (page, styles, view, preload)
│       ├── library.*      # Meeting library window (page, styles, view, preload)
│       ├── snippets.*     # Quick-copy editor window (page, styles, view, preload)
│       ├── dictate-capture.*   # Mic-only worker behind the dictation hotkey
│       ├── dictate-indicator.* # Floating "listening" pill (page, styles, view, preload)
│       └── dictations.*        # Dictation history window (page, styles, view, preload)
├── vendor/whisper/    # whisper.cpp binaries + GGML models (gitignored, see setup)
├── dist/              # Build output (gitignored)
└── package.json
```

## Architecture

### Tray-only app

No main window is shown at startup. A hidden `BrowserWindow` exists solely to run the Web Audio API (unavailable in the main process). The tray icon is the app: **left-click opens the meeting library, right-click opens the menu.** Nothing is bound to double-click — Windows sends a plain click first, so a second action there would always arrive with the library already opening. Every other window (library, live transcript, quick-copy editor, dictations archive) is opened on demand, frameless, dark, and single-instance.

The menu is deliberately short: the quick-copy list, what is happening now,
Start/Stop and *Generate Notes*, the four things to open, and Troubleshooting.
Everything that is *configured* rather than *done* lives in the library window —
a menu is a poor place to be told that a model is not installed.

**Recording is also bound to a global shortcut** (`Ctrl+Shift+R` by default,
`applyHotkey()` in `main.js`), because the twenty seconds at the start of a call
are exactly where finding a tray icon and reading a menu means the meeting goes
unrecorded. The accelerator comes from `HOTKEY_CHOICES` in `settings.js` and
never from free text: a global shortcut is claimed against the whole desktop, so
a typo is either dead or steals a combination from another application, and the
value is written from a renderer. `globalShortcut.register` reports a
combination someone else already holds by returning false rather than throwing,
so the result is kept in `state.hotkeyRegistered` for the settings pane to mark
in red. Starting and stopping both raise a notification — a tray icon changing
colour is not confirmation that a room is being recorded, least of all when the
recording was started from a keyboard.

**The dictation hotkey is a second, independent global shortcut**
(`Win+Shift+X` by default, `applyDictateHotkey()` in `main.js`): press it, say a
sentence, press it again, and the transcribed text is pasted where you were
typing. It is deliberately separate from the meeting hotkey — `globalShortcut`
is unregistered one accelerator at a time rather than `unregisterAll`, which
would take the meeting shortcut with it — and its choices come from
`DICTATE_HOTKEY_CHOICES` in `settings.js` for the same reason as the meeting
one: a global accelerator is claimed against the whole desktop, never from free
text. Registration failure is kept in `state.dictateHotkeyRegistered` for the
settings pane to mark in red. See *Voice input* below.

### Audio capture flow

1. `capture.js` (main) creates the hidden renderer and listens for IPC messages
2. `capture.js` (renderer) opens mic + `getDisplayMedia` with `audio: 'loopback'`
3. A `ChannelMergerNode` puts the mic on the left and the loopback on the right
4. `pcm-worklet.js` converts to 16 kHz 16-bit PCM and ships it over IPC
5. Main process writes PCM to a `WavWriter` during recording
6. `SpeechDetector` watches idle levels and fires `'speech'` when sustained audio is detected;
   `SilenceDetector` does the inverse during one, and ends a meeting nobody stopped

**The two sources are kept apart, not mixed.** Left is you, right is everyone
else, so `transcribe()` can read each channel separately and put a name on every
line — action-item ownership used to work only when somebody said a name out
loud. They were never the same signal, so summing them threw away a separation
the graph already had, and it cost the meeting's most useful piece of structure.

The layout is decided by **main**, not by the renderer, because main owns the
file: a WAV header declares its channel count once and has to keep it for the
whole recording. `startRecording` reads `capture.recordingChannels` — two only
when both sources actually opened and `separateChannels` is on, since a stereo
file with a dead channel is twice the disk and a wasted transcription pass — and
sends it with `capture:setRecording`. The worklet emits interleaved stereo or
sums to mono accordingly, and a graph rebuilt mid-meeting is told the recording
state as it is built rather than waiting for a message that may not come.

Everything downstream is channel-aware: `deinterleave`/`downmix` in `wav.js`,
`LiveTranscriber` (which folds back to mono — see below), and `transcribe()`.
A mono recording, including every one made before this existed, still works
unchanged and simply carries no speaker labels.

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

**It is also kept.** Every line goes to `live-transcript.txt` in the meeting
folder as it is produced (`appendLiveTranscript` in `main.js`), which is what
turns the worst case from "a WAV" into "a rough transcript": the preview used to
exist only in a window and was wiped the moment processing started, so a
pipeline that then failed threw away text that already existed. It is appended
line by line rather than written at the end, because the case it is for is the
one where there is no end — a crash, a power cut, a quit mid-meeting. It writes
to `state.liveDir` rather than `state.currentDir` so the segment still decoding
when Stop is pressed lands in the meeting it was said in. `library.js` reads it
wherever `transcript.txt` is missing, and the reader labels those lines as the
rough preview they are.

1. `LiveTranscriber` buffers recorded PCM and cuts it into **segments at natural
   pauses** (trailing silence ≥ `silenceHoldMs`), not on a fixed clock, with a
   `maxSeconds` ceiling for someone who never pauses. The minimum measures
   *voiced* bytes, so a door slam plus silence is not an utterance. All of it is
   measured in seconds of meeting rather than bytes, since a two-channel
   recording is twice the bytes for the same audio.
2. Each segment is POSTed as a WAV to a `whisper-server` child process
   (`/inference`, multipart). The previous line is passed as `prompt` so a
   sentence split across segments keeps its context.
3. whisper.cpp runs ~7-8x realtime on CPU with `ggml-base`, so a caption lands
   about a second after the speaker stops.

**The preview folds two channels back to mono, and infers the speaker instead.**
The saved transcript reads each side separately, which costs a request per
speaker per chunk; here that would double the work in the one place with a
realtime floor to clear. `segmentSpeaker` picks whichever channel carried most
of the segment — with a 2:1 margin, because the microphone hears the speakers
and echo cancellation only mostly removes them, so a wrong label is worse than
none. The label goes into `live-transcript.txt` too, via `speakerLine`.

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
still appears and the user's unrelated folders never do. **Nothing in
`library.js` writes, renames or deletes.** The four things the *window* can
change all live in `main.js` and all name a meeting by its folder name:
`library:reprocess`, `library:record`, `library:rename` and `library:delete`.

**The archive can be edited, or it rots.** Every misfire was permanent and every
meeting was called whatever the summariser made of it. `deleteMeeting` uses
`shell.trashItem`, so a misclick is recoverable, and raises its own confirmation
through `dialog.showMessageBox` — a page cannot be the thing that vouches for
having asked first. `renameMeeting` writes `title.txt`, which is its own
artefact precisely because `notes.json` and `meta.json` are both rewritten by
every pipeline run: a rename stored in either would survive until the first
re-run and then quietly revert. `describeMeeting` prefers it over the model's
title and keeps the model's as `generatedTitle`, so a rename can be undone.

A card knows why it has no notes — `pending`, `unprocessed` (quit mid-run),
`failed` (`ERROR.txt`) — and `main.js` adds what only it can know, which
folder is recording and which are mid-pipeline, from `state.jobs`. The reader
renders `notes.json` directly rather than re-parsing `notes.md`, since the JSON
is the structured form the pipeline actually produced.

**A meeting with no notes carries the button that writes them.** The reader's
`notesNotice` used to print `npm run pipeline -- "<dir>"`, which assumes a
checkout, npm and a terminal — none of which exist for anyone who installed the
build, so the app's most likely failure (Ollama down at Stop) left a permanently
dead folder. It now sends `library:reprocess`, and `reprocessMeeting()` in main
re-runs `processMeeting`, which is re-runnable because every stage overwrites
its own artefact. The same run is one click away in the tray, on the newest
meeting still owed its notes (`state.retry`). Failures explain themselves in
place: `readMeeting` quotes the first line of `ERROR.txt` rather than telling
someone to go and open it.

A transcript can come from either of two files. `transcriptSource()` prefers
`transcript.txt` and falls back to `live-transcript.txt`, so a meeting whose
pipeline never ran is still readable, searchable and quotable — labelled in the
reader as the rough preview it is.

**Speaker labels are a field to the reader and a prefix on disk.** The pipeline
keeps `speaker` per segment in `transcript.json`; the flat files carry
`You: `/`Others: `, which `parseSpeakerLine` reads back for the live preview.
Everything that treats a transcript as prose — the card preview, the search —
goes through `spoken()` first, or a query for "you" would match every labelled
line in every meeting and report the count as though somebody had said it.

**The id is a folder name, never a path.** Every entry point runs it through
`meetingDir()`, which requires a bare name whose parent resolves to the notes
folder, and "open this" names a target from a fixed table (`OPEN_TARGETS`)
rather than a file. The notes folder is full of user files and the window is
one `shell.openPath` away from all of them, so the renderer is never given the
vocabulary to ask for one.

Search reads each transcript in full, so it is debounced in the renderer
and its responses are sequenced — a query over a large folder can outlive the
one typed after it, and the rail must not end up showing results for a query
that has left the box. Previews avoid the same cost by reading only the first
4 KB of a transcript, and only when there are no notes to quote.

The window refreshes itself on `library:changed`, which main sends at the four
moments the folder actually changes (recording start, recording end, pipeline
start, pipeline end) — never from `refreshTray`, which ticks once a second
while recording and would have the window re-reading every transcript for a
clock. `notifyLibrary()` also re-reads `state.retry` there, for the same reason
and on the same budget: one walk of the folder, four times a meeting.

**Progress rides its own channel for exactly that reason.** The tray has said
`Transcribing 12/60…` since the pipeline existed while the library card said
only `Working…` — the numbers were being produced, they simply never left the
process. `state.jobs` now holds `{ abort, progress }` per meeting (per meeting,
because two runs can overlap and one progress string cannot say which card it
belongs to), and `library:progress` carries the activity payload several times a
minute, throttled to `PROGRESS_MIN_MS`. The renderer's `renderProgress()`
updates the card's pill and the reader's notice **in place**: no IPC round trip,
no disk. Sending this on `library:changed` would have re-read every transcript
on disk for a chunk counter.

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
free-form string resolved inside a folder of weights. `micDeviceId` is the same
check in a different shape — an opaque handle rather than a path, but still
something real, so it is held against the list the capture worker reported.
`hotkey` is the same argument again: it is checked against `HOTKEY_CHOICES` by
the store's enum, because a global accelerator is claimed against the whole
desktop rather than against this app.

**The microphone pane names the device actually open**, not just that one is.
`getUserMedia` with no `deviceId` takes the Windows default, so a meeting can
record the laptop lid while the headset sits unused and every indicator says the
microphone is fine. `micDeviceId` is stored with `micDeviceLabel` beside it,
because Chromium salts device ids per origin and does not always reissue the
same one after a restart — `chosenMicId()` tries the id, then the label, then
falls back to the default and *says so* in `micError`.

**A first run that cannot work says so, and can fix itself.** `setupGaps()` in
the renderer turns `settingsState()` into the sentences the empty archive
carries, and the two downloads behind them are `settings:pullModel` and
`settings:installWhisper`. Only one runs at a time (`state.setup`), both are
cancellable, and `pullModel` accepts nothing but the two models the settings
already name — a tag is free text, and no string a page can invent should reach
`ollama pull`. Until this existed the app's own advice was `npm run
whisper:setup` and `ollama pull`, which need a checkout, npm and a terminal:
none of which exist for anyone who ran the installer.

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

The editor (`src/renderer/snippets.*`) is one of only two renderers in the app
that write anything (the other is the dictations archive); all of its IPC
channels check `event.sender.id` against the editor window. Saving refreshes the
tray immediately, and closing saves first — the window is never a way to discard
work.

### Voice input (`dictation.js`, `dictations.js`, `paste.js`)

The dictation hotkey is the app's second capture path: press it, say a sentence,
press it again, and the finished text is pasted into whatever had the cursor,
copied to the clipboard, and filed in the dictation archive. Same gesture as the
meeting recorder, for the length of a sentence rather than a meeting — and
deliberately separate from it.

**A second worker, not a second graph.** `DictationController` owns its own
hidden renderer (`dictate-capture.*`) that opens the microphone alone, keeps the
audio in memory, and joins the same media-permission allow-list as the meeting
worker (`registerMediaClient` in `capture.js`). The two never share a window or a
stream, so a dictation can run in the middle of a recorded meeting without
either disturbing the other. The renderer reuses `pcm-worklet.js`, feeding the
mic onto channel 0 of the worklet's two-channel merger and leaving channel 1
silent — the mono sum then reads as the mic at full gain rather than doubled.

**Press-to-start, press-to-stop.** Electron's `globalShortcut` fires on key-down
only, and the app ships no native keyboard hooks, so the feature is a toggle
rather than hold-to-talk: the press opens the mic, the next press stops it. The
tray's **Voice input** section exposes the same toggle and the hotkey's name.

**The finished text comes from a careful pass; the live caption is a preview.**
While the mic is open, the controller's own `LiveTranscriber` (whisper.cpp when
installed, the audio model otherwise) feeds captions to a small always-on-top
pill (`dictate-indicator.*`). The pill is `focusable: false` — a window that
could take the cursor would move the very target the text is about to be pasted
into. On stop the clip is trimmed of room tone (`trimSilence`, a 50 ms windowed
RMS gate) and transcribed by the engine `dictationEngineFor()` resolves from the
`dictateEngine` setting — the Ollama audio model by default, since "write it down
as I said it" is exactly the careful case, with a silent fall back to whisper.cpp
whenever the chosen engine cannot run. The saved-pass engine and the live-pass
one are separate settings, exactly as they are for meetings.

**The paste is Windows doing the typing.** Electron cannot type into another
application's window, so `paste.js` writes the text to the clipboard and then
spawns the PowerShell built into Windows to `SendKeys` Ctrl+V into the foreground
window — best-effort by design, because an elevated (admin) window will not
accept it, and the clipboard always holds the text either way. The paste runs
before the confirmation notification, so a paste that did not land is reported in
the same breath. `dictateAutoPaste` turns it off.

**Nothing said is lost.** Every successful dictation is added to the archive
(`dictations.js` → `dictations.json`, newest first) which the **Dictations…**
window (`src/renderer/dictations.*`) browses, edits and deletes — sender-checked
like the quick-copy editor, rows saving on blur, closing saves first. A
transcription that fails keeps the trimmed audio as a WAV under
`userData/dictation-errors`, so a machine that comes back can still finish the
job, and a session nobody stops hits `MAX_SECONDS` (five minutes) and is ended
with a notification.

### Post-recording pipeline (`pipeline.js`)

1. **Transcribe** — splits the WAV into 60 s chunks and reads each one. Which
   engine reads it is `transcribeEngineFor()`: whisper.cpp whenever it is
   installed and `transcribeEngine` has not been moved off it, otherwise the
   Ollama audio model over the OpenAI-compatible `/v1/chat/completions` endpoint.
   The tail of each chunk is passed to the next as `prompt`, exactly as the live
   preview does
2. **Summarise** — sends full transcript (or condensed version for long meetings) to Ollama, outputs structured JSON: title, 5-bullet summary, decisions, action items
3. **Render PDF** — asks Ollama to generate a print-ready HTML brief, converts to PDF via a headless `BrowserWindow`, deletes the intermediate HTML

Each step writes its artefact immediately, so a late failure never loses earlier work.

**A two-channel recording is transcribed one side at a time.** `tracksOf()`
splits it into the microphone track and the system track; each chunk is read for
both, and each keeps its *own* `prompt` tail, since the sentence a speaker is
continuing is their own rather than whatever the other side just said. The
chunking is done once, on the **downmix** — so both sides are cut in the same
place, and that place is a moment when neither of them was talking; chunking
each track on its own silences would put every line on a different grid. The cost
is far less than double, because the side that was listening is silence and
silence is skipped by the same `SILENCE_RMS` test that already existed.
`SPEAKER_RULES` is added to the summary prompt only when the transcript really
is labelled — telling a model to read speaker prefixes off a transcript that has
none invites it to imagine some.

A title someone typed is applied to `notes.md` and the PDF at the end of
`runPipeline` (`readTitle(dir) || notes.title`) but never written back into
`notes.json`, which stays the model's own output.

**whisper.cpp is the default for this pass too, not only for the preview.** An
audio LLM costs a request per chunk, so an hour of meeting takes about an hour;
whisper.cpp reads the same hour in a few minutes on `ggml-base`, and is a
recogniser rather than a model that sometimes loops (hence `collapseRepeats`).
There is no realtime floor here the way there is for captions, so a heavy model
costs only wall clock. It also changes what an
unreachable Ollama costs: `requireOllama()` is called up front *only* when
Ollama is also the transcriber — so no hour of work is spent on a run that was
doomed from the start — and then again before the notes, by which time
`transcript.txt` is on disk. Ollama down is then a partial failure with a full
transcript, and the notes are one **Generate notes** click away.

### Per-meeting output folder

Each recording creates a timestamped folder (e.g. `2026-08-11_14-32-05/`) under the configured notes directory containing:
- `audio.wav` — raw recording; two channels (mic left, system right) when both sources were live
- `transcript.txt` / `transcript.json` — full transcription, speaker-labelled where the audio allowed
- `live-transcript.txt` — the live preview, written line by line during the meeting
- `notes.md` / `notes.json` — structured meeting notes
- `notes.pdf` — formatted brief
- `meta.json` — recording metadata
- `title.txt` — only if renamed; a user title the pipeline never overwrites

### Never lose the meeting

The audio is the only irreplaceable artefact — notes can always be regenerated
from it, from the library, the tray, or `npm run pipeline`. Everything below
exists to make sure a folder either holds finished notes or explains itself:

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
- **Every live caption is on disk before it is on screen.** `live-transcript.txt`
  is what a folder holds when none of the above got as far as a transcript.
- **A recording that cannot be written stops instead of pretending.** `WavWriter`
  catches the write, seals what is on disk with a correct header and reports
  `error` rather than throwing back through the PCM IPC handler where nobody
  would catch it; `capture` raises `writeFailed` once and main ends the meeting.
  A full disk otherwise leaves the tray saying *Recording* over a file that
  stopped growing — and `checkDisk` is what usually catches it first, refusing to
  start under 300 MB and stopping a meeting under 150 MB.
- **Nothing runs for ever.** `SilenceDetector` ends a meeting after
  `silenceStopMinutes` of nothing (15 by default), `maxRecordingMinutes` is the
  hard ceiling behind it (4 hours), and a repeating notice from three hours in is
  for the person who is still there and has simply forgotten. All three ride the
  one-second tray tick rather than timers of their own.
- **Sleep is survivable.** A `powerSaveBlocker` holds off an idle suspend while
  recording, which is the case that actually happens; a lid close suspends the
  machine regardless, so `powerMonitor.on('resume')` rebuilds the audio graph and
  re-arms it into the same file. `CaptureController.restart()` is the one path
  for that, shared with the tray's *Restart Audio Capture*.
- **Only one caller can end a meeting.** There are now seven things that might —
  the tray, the shortcut, the library, silence, the duration cap, a full disk, a
  quit — and two arriving together used to mean two pipeline runs over one
  folder, or a second call finding the writer closed, reading that as "nothing
  was recorded", and deleting the meeting. `state.stopping` makes the first
  caller the only one.
- **A folder that lost its notes can be finished from inside the app.** Both
  `UNPROCESSED.txt` and `ERROR.txt` say so first and give the npm command
  second; `processMeeting` deletes both at the start of a run, so a folder never
  carries an explanation that has stopped being true.

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
- **No external runtime dependencies** — only Electron APIs, Node built-ins, two local HTTP APIs (Ollama, whisper-server), and the `powershell.exe` that ships with Windows, used for the dictation paste. whisper.cpp is a downloaded binary, not an npm package
- **Network access lives in `ollama.js`, `whisper.js` and `whisper-setup.js`** — eslint blocks bare `fetch` elsewhere in `src/main/`. The first two only ever reach a daemon on this machine; `whisper-setup.js` is the sole outbound path, and it fetches whisper.cpp and nothing else
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
| `npm run whisper:setup` | Download whisper.cpp + a GGML model into `vendor/whisper` (the tree that gets packaged; the app's own installer puts one under `userData` instead) |
| `npm run pipeline -- "path"` | Re-run the transcribe→summarise→PDF pipeline on a folder (`--engine whisper\|ollama`, `--transcribe`, `--summary`) |
| `npm run capture-test` | Test audio capture in isolation |

## Prerequisites

- **Node.js** ≥ 18
- **Ollama** running locally (`ollama serve`) with an audio-capable model pulled (e.g. `ollama pull gemma4:12b`)
- **whisper.cpp** for the live captions *and* the saved transcript. Optional — both fall back to Ollama without it — and installable from **Settings → Install whisper.cpp** or with `npm run whisper:setup`
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

Each stage in `pipeline.js` is a standalone async function (`transcribe`, `summarise`, `renderPdf`). They receive the meeting directory, config, and an options bag with `{ onProgress, signal, ollama, whisper }`. Add new stages in `runPipeline()` and write outputs to the meeting folder using `FILES` constants from `paths.js`.

### IPC channels

| Channel | Direction | Payload |
|---------|-----------|---------|
| `capture:configure` | main → renderer | `{ active, captureMic, captureSystem, micDeviceId, micDeviceLabel }` |
| `capture:setRecording` | main → renderer | `boolean`, `channels` (1 or 2) |
| `capture:pcm` | renderer → main | `ArrayBuffer` (16 kHz PCM, 1 or 2 channels) |
| `capture:level` | renderer → main | `{ mixed, mic, system }` RMS floats |
| `capture:status` | renderer → main | `{ micOk, systemOk, micError, systemError, micLabel }` |
| `capture:devices` | renderer → main | `{ id, label }[]` — the audio inputs on this machine |
| `dictate:start` | main → dictation worker | `{ micDeviceId, micDeviceLabel }` — open the mic and record |
| `dictate:stop` | main → dictation worker | — (close the mic; main waits for the worklet's flush) |
| `dictate:pcm` | dictation worker → main | `ArrayBuffer` (16 kHz mono PCM) |
| `dictate:level` | dictation worker → main | RMS float, for the indicator |
| `dictate:status` | dictation worker → main | `{ micOk, micError, micLabel, fatal }` |
| `dictate:state` | main → indicator | `{ state, text, error }` — listening / transcribing / done / error |
| `snippets:list` | editor → main (invoke) | → `{ label, text }[]` |
| `snippets:save` | editor → main (invoke) | `{ label, text }[]` → the list as stored |
| `snippets:close` | editor → main | — |
| `dictations:list` | dictations window → main (invoke) | → `{ id, text, createdAt }[]`, newest first |
| `dictations:update` | dictations window → main (invoke) | `{ id, text }` → the list, or `null` if the id is gone |
| `dictations:remove` | dictations window → main (invoke) | `id` → the list, or `null` |
| `dictations:copy` | dictations window → main | `string` for the clipboard |
| `dictations:close` | dictations window → main | — |
| `dictations:changed` | main → dictations window | — (a dictation landed; re-list) |
| `library:list` | library → main (invoke) | `query` → `{ meetings, activity }` |
| `library:read` | library → main (invoke) | `id` → the meeting, or `null` |
| `library:open` | library → main (invoke) | `{ id, target }` → opened? |
| `library:openNotesFolder` | library → main (invoke) | → opened? |
| `library:copy` | library → main | `string` for the clipboard |
| `library:record` | library → main (invoke) | `boolean` — start or stop; the result arrives as `library:changed` |
| `library:reprocess` | library → main (invoke) | `id` → `{ ok, reason }` — whether the run started; how it ends arrives as `library:changed` |
| `library:rename` | library → main (invoke) | `{ id, title }` → `{ ok, reason }`; an empty title restores the model's |
| `library:delete` | library → main (invoke) | `id` → `{ ok, reason }`; main raises the confirmation itself |
| `library:changed` | main → library | — (the folder changed; re-list) |
| `library:progress` | main → library | `libraryActivity()` — a run advanced; update in place, read nothing |
| `library:showSettings` | main → library | — (the tray's Settings… item) |
| `library:minimize` / `library:close` | library → main | — |
| `settings:get` | library → main (invoke) | → `settingsState()` |
| `settings:set` | library → main (invoke) | patch → `settingsState()` |
| `settings:chooseNotesFolder` | library → main (invoke) | → `settingsState()` |
| `settings:openOllama` | library → main (invoke) | → `settingsState()`, after the daemon answers or times out |
| `settings:pullModel` | library → main (invoke) | model name → `{ ok, reason }`; only the two the settings already name |
| `settings:installWhisper` | library → main (invoke) | GGML model key → `{ ok, reason }` |
| `settings:cancelSetup` | library → main (invoke) | → `settingsState()`, after aborting the download in flight |
| `settings:editQuickCopy` | library → main | — (opens the shorthand editor) |
| `settings:openDictations` | library → main | — (opens the dictations archive) |
| `settings:changed` | main → library | — (a setting, a model list or Ollama changed) |

## Important notes

- **No cloud, no telemetry, no accounts.** No audio, transcript, note or
  identifier ever leaves the machine. Two things can reach the internet, both
  only when a button is pressed and neither with any meeting data in it:
  `whisper-setup.js` fetches whisper.cpp from GitHub and Hugging Face, and
  `Ollama.pull` asks the local daemon to download a model.
- The Ollama transcription uses the **OpenAI-compatible** `/v1/chat/completions` endpoint because the native `/api/chat` route silently drops audio fields.
- Recordings shorter than 1 second are automatically discarded.
- The `collapseRepeats` function in `ollama.js` defends against audio model repetition loops.
- `cleanWhisperText` in `whisper.js` strips whisper's bracketed annotations and the phrases it invents on near-silence (`"you"`, `"Thanks for watching"`), which is the usual source of phantom captions during a pause.
- `src/main/whisper-setup.js` is the only code in the repo that makes a non-localhost request. It runs from **Settings → Install whisper.cpp** or from `npm run whisper:setup`, never on its own, and it downloads two files: a release binary and a set of weights.
- Pipeline retries transient Ollama failures (3 attempts with backoff) so a model swap mid-run doesn't kill a long transcription.
- The dictation paste is the one place the app touches another application's
  window, and it does it with a *fixed* PowerShell command (SendKeys Ctrl+V) that
  contains no user input — nothing is ever interpolated into the shell.
- A dictation whose transcription fails keeps the trimmed clip as a WAV under
  `%APPDATA%\Minarrador\dictation-errors`, so the words' audio survives even
  when the text could not be produced.
