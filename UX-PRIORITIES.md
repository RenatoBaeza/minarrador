# UX priorities

Features and fixes ranked by impact per unit of work, from a read of `src/main/`,
`src/renderer/` and the pipeline. Line references are to the tree as of
2026-08-12 (commit `b60c30d`).

---

## Tier 1 — these break the app's promise

**All four are implemented.** Each item keeps its original argument below, with
what shipped noted underneath it.

### 1. There is no way to re-run notes from inside the app

`main.js:488`, `renderer/library.js:266,272` and every `UNPROCESSED.txt` tell the
user to run `npm run pipeline -- "<dir>"`. A user who installed the NSIS build
has no repo, no npm, no script — so the *most likely* failure in the whole app
(Ollama not running when you hit Stop, `pipeline.js:414`) leaves a meeting
permanently stuck as a WAV. Every recording made before you start `ollama serve`
is a dead folder.

The fix is small: `processMeeting(dir, meta)` already exists and is re-runnable.
Add a `library:reprocess` IPC channel plus a **Generate notes** button on the
reader's `notesNotice`, and a "Retry notes…" item in the tray. Highest
impact/effort ratio in this document.

> **Done.** `library:reprocess` → `reprocessMeeting()` in `main.js`, a
> **Generate notes** / **Try again** button in the reader's notice, and
> *Generate Notes for …* in the tray on the newest meeting still owed them
> (`state.retry`). The reader now quotes the first line of `ERROR.txt` instead
> of pointing at the file, `processMeeting` clears `ERROR.txt`/`UNPROCESSED.txt`
> at the start of a run so a folder never carries a stale explanation, and both
> notes lead with the in-app route rather than the npm command.

### 2. Use whisper.cpp for the saved transcript, not just the live preview

`pipeline.js:38` transcribes exclusively via `ollama.transcribe` — 60 chunked
audio-LLM calls for an hour of audio. Meanwhile `whisper.transcribe(wavBuffer)`
(`whisper.js:401`) is already vendored, already running, ~7-8x realtime, and is
a purpose-built ASR rather than an LLM that sometimes loops (hence
`collapseRepeats`).

Switching the transcribe stage to whisper when available means an hour
transcribes in ~8 minutes instead of ~an hour, with better accuracy — and **the
pipeline then only needs Ollama for the summary step**, which pairs with item 1
to make Ollama-down a partial failure instead of a total one.

> **Done.** `transcribeEngineFor()` picks the engine, `runPipeline` takes a
> `whisper` option, and the Ollama reachability check moved: up front only when
> Ollama is also the transcriber, then again before the notes — so a daemon that
> is down now costs the notes and not the transcript. A `transcribeEngine`
> setting (**Settings → Saved transcript engine**) can force either engine, and
> `npm run pipeline` takes `--engine`.

### 3. The live transcript is thrown away

`LiveTranscriber` emits text straight to the transcript window (`main.js:790`)
and `transcript:clear` (`main.js:443`) wipes it when processing starts. Nothing
writes it to disk. When the pipeline fails, text that *already existed* is gone
and the user is left with audio only.

Appending each line to `live-transcript.txt` in the meeting folder is ~10 lines
and changes the worst case from "a WAV" to "a rough transcript".

> **Done.** `appendLiveTranscript()` writes each line as it is produced, into
> `state.liveDir` so the segment still decoding when Stop is pressed lands in
> the right meeting. `library.js` reads it wherever `transcript.txt` is missing
> — list, preview, search, reader and *Open transcript* — and the reader labels
> those lines as the rough preview they are.

### 4. No global hotkey, and no confirmation that recording started

No `globalShortcut` anywhere in the repo. Starting a recording during the first
20 seconds of a call means finding a tray icon, right-clicking, and reading a
menu. And `startRecording` (`main.js:335`) never calls `notify` — the only
feedback is a small icon colour change.

A `Ctrl+Shift+R` toggle plus a start toast is a couple of hours and changes how
the app feels more than anything else here.

> **Done.** `applyHotkey()` registers a toggle from `HOTKEY_CHOICES` (default
> `Ctrl+Shift+R`, or `off`), chosen in **Settings → Start and stop shortcut**,
> which marks the row red when another application already holds the
> combination — `globalShortcut.register` reports that by returning false rather
> than throwing. Both ends of a recording now notify.

---

## Tier 2 — output quality and trust

### 5. Record two channels instead of mixing to mono — free speaker separation

`renderer/capture.js:129` sums mic and loopback at 0.6 gain into one mono
stream. Keeping them as L = you / R = everyone else would let the pipeline
transcribe each channel and label lines.

This is the single biggest jump available in notes quality: action-item
ownership currently only works when someone says a name aloud
(`pipeline.js:80`). It is also the largest job here — the worklet, `WavWriter`
and `transcribe()` all change — but it is the difference between "notes" and
"minutes".

### 6. Nothing stops a runaway recording

No duration cap, no silence auto-stop, no disk check. Forget to hit Stop on
Friday and Monday's pipeline run is over a multi-hour WAV. A silence-based
auto-stop (the `SpeechDetector` machinery already exists, inverted) plus a
warning at ~3h.

### 7. No sleep handling

No `powerMonitor`, no `powerSaveBlocker`. Close the laptop mid-meeting and the
machine suspends while "Recording" is displayed; the audio graph's state on
resume is undefined. `powerSaveBlocker` while recording is the real fix;
`powerMonitor.on('resume')` rebuilding the graph is the backstop.

### 8. No microphone picker

`getUserMedia` at `renderer/capture.js:44` takes the Windows default with no
`deviceId`. If the default input is not the headset you are talking into, the
meeting quietly records the wrong device and `micOk: true` reports that
everything is fine.

---

## Tier 3 — living with the archive

### 9. The library cannot delete or rename

By design (`library.js:3-5`), but the consequence is that every 30-second
misfire is permanent and every meeting is titled by whatever the model produced.
Delete via `shell.trashItem` and an editable title would keep the archive from
rotting.

### 10. No "copy notes as Markdown" / "copy action items"

`Copy transcript` exists (`renderer/library.js:223`), but the thing people
actually do after a meeting is paste the action items into Slack or Jira.

### 11. No first-run setup path

The tray says `npm run whisper:setup` (`tray.js:130,254`) and there is no in-app
`ollama pull`. For anyone who did not build from source, both are unreachable —
the app can be installed into a state where it cannot work and only tells you so
in a disabled menu label.

### 12. Processing progress does not reach the library

The tray shows `Transcribing 12/60…` but the library card just says "Working…"
with no progress and no ETA. `onProgress` already produces the numbers; they
need to ride along on `library:changed`.

---

## Suggested starting point

Tier 1 is done: the "lost meeting" class of failure is gone — a folder now
either holds finished notes, or holds the audio, a rough transcript and a button
that finishes the job.

Next is item **5** (two-channel recording), which is the largest single jump
left in notes quality and the largest job in this document.
