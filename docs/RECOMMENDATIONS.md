# Recommendations

Software-engineering and UX recommendations for Minarrador, ranked by value to
the person using it. Each item says what problem it solves, where it lands in
the code, and a rough size (S ≈ a day, M ≈ a few days, L ≈ a week or more).

The ranking follows one question: what makes the minutes after a meeting
better? That is when someone opens the app wanting something from it. Recording
itself is already well protected, as Never lose the meeting in `CLAUDE.md` shows.

---

## Tier 1: highest user value

### 1. Notes ready at Stop, not minutes later (M–L)

Problem. The saved transcript only starts at Stop. With whisper.cpp an hour
still takes a few minutes, and with the Ollama transcriber it takes about an
hour. Right after a meeting is when people want the action items, and it is
also when the app has nothing to show.

Recommendation. Transcribe the saved pass incrementally during the
recording. `LiveTranscriber` already cuts at natural pauses, so a second,
lower-priority queue can run the careful pass (the saved-transcript engine and
model) on each finished span and append it to a `transcript.partial.json`. At
Stop, `transcribe()` only has to cover the tail that is not done yet, then
moves on to `summarise()`.

- Keep today's whole-file pass as the fallback and as the Reprocess path,
  so correctness never depends on the incremental queue.
- Chunk boundaries must stay aligned across both tracks. Cut on the downmix
  pause, the same rule `transcribe()` uses now.
- Throttle it: if the live captions start falling behind (`LIVE_MAX_SECONDS`
  dropping audio), pause the background queue first.
- Payoff: notes arrive within a minute of Stop on whisper.cpp.

### 2. Ask questions of a meeting, and of the whole archive (M)

Problem. Search finds words. People actually want answers: "What did we
decide about the launch date?" or "When did Ana last mention the budget?"
The transcript and the local LLM are both already here.

Recommendation. Add an Ask box to the reader:

- This meeting: send the question and the transcript (or the `condense()`
  digests when it is long) to `summaryModel`, and require answers to quote
  timestamps taken from `transcript.json` segments. Render each timestamp as a
  link that scrolls the transcript to that line.
- Across meetings: first run the existing `findInMeeting` keyword search to
  pick the top N meetings, then ask over their notes and the matching snippets.
  This needs no embeddings or vector store, which keeps the
  no-runtime-dependency rule intact.
- It stays entirely local, so the privacy promise is unchanged.

### 3. Action items that outlive the meeting (M)

Problem. Action items are the most valuable output, but today they sit in
a PDF and a `notes.json` that nobody opens again. Nothing tracks whether they
got done.

Recommendation. Add an Action items sidebar feature (a new key in
`SECTIONS`) that collects every meeting's `action_items` into one list, with
owner, due date, source meeting and a done checkbox.

- Store done state in a per-meeting `actions.json`. This follows the same rule
  as `title.txt`: the pipeline rewrites `notes.json`, so user state has to live
  in its own artefact or a re-run erases it.
- Filters: Mine (owner = You, which the speaker labels already make
  possible), Open, Overdue.
- The tray tooltip or menu can show "3 open action items".

### 4. Meeting templates (S–M)

Problem. One `NOTES_SCHEMA` and one `SUMMARY_RULES` cover every kind of
meeting. A 1:1, a stand-up, a customer call and an interview each need
different notes: blockers, objections, candidate signal, and so on.

Recommendation. Offer a small, fixed set of templates (General, 1:1,
Stand-up, Customer call, Interview). Each one pairs extra schema fields with
extra prompt rules.

- The choice is made after the meeting, from the reader ("Regenerate as…"),
  which reuses `library:reprocess` with a template id. Store the choice in
  `meta.json` so it is remembered.
- Templates are an enum, never free text from the renderer. That matches
  the existing rule for hotkeys and model names. User-authored templates can
  come later, stored like `snippets.json`.
- `renderPdf` and `renderMarkdown` render unknown extra fields generically, so a
  new template needs no new renderer.

### 5. Share-ready output in one click (S)

Problem. Notes usually end up in an email, Slack or a doc. Today that
means opening the PDF or copying section by section.

Recommendation. Add a Copy as… menu in the reader with Markdown,
Plain text (email) and Rich text (use `clipboard.write({ html, text })` so
the formatting survives a paste into Outlook or Gmail). Add a separate
Copy action items only button. Both reuse `renderMarkdown` from `pipeline.js` on the
main side, and nothing leaves the machine except by the user's own paste.

### 6. Tell the "Others" apart (L)

Problem. Channel separation answers me vs. them. On a call with five
people, "Others" still merges four voices, so action-item owners are only as
good as the names said out loud.

Recommendation. Two steps, in order of cost:

1. Cheap: a "Who was there?" field (typed, or pulled from the title) passed
   to the summariser as a list of names to attribute to. This improves owner
   assignment without any audio work.
2. Real: diarise the system channel. whisper.cpp's `--diarize` only covers
   stereo input, so this needs a small local speaker-embedding model. Keep it
   behind a setting and an explicit download, like `whisper-setup.js`.

---

## Tier 2: performance and robustness

### 7. Take library I/O off the main process (S–M) — highest-priority engineering fix

Problem. The `library:list` handler (`main.js`, `library.listMeetings`)
walks the notes folder, and with a search query it reads every transcript,
using synchronous `fs` calls on the main process. That is the same
thread that receives `capture:pcm` and writes the WAV. As the archive grows,
typing in the search box while a meeting is recording blocks PCM IPC and the
one-second tray tick.

Recommendation.

- Move `listMeetings`, `findInMeeting` and `readMeeting` into a
  `worker_threads` worker, or at least to `fs.promises`. The module is already
  pure and read-only, so it moves cleanly.
- Add an in-memory cache keyed by folder + mtime for cards and transcript
  text. Each `library:changed` event then invalidates one folder instead of
  forcing a full re-read. Search over a cached set becomes microseconds.
- Measure it: log `listMeetings` duration per call. A 200-meeting archive is a
  good benchmark.

### 8. Warm the summary model at Stop (S)

Problem. When the transcript and the notes use different Ollama models,
the first `chat()` after transcription pays a cold load, which can take tens of
seconds for a 12B model.

Recommendation. When `transcribe()` enters its last few chunks (or at Stop
when whisper.cpp is transcribing), fire a zero-token warm-up request with
`keep_alive` for `summaryModel` —
`Ollama.preload()` already does exactly this. Do the same for the careful dictation engine when the dictation
hotkey is pressed, so the model loads while the user is still speaking.

### 9. Faster long-meeting summaries (S)

`condense()` digests blocks serially. With `OLLAMA_NUM_PARALLEL > 1` (the
default in recent Ollama releases) two or three blocks can run concurrently
with a small promise pool. Report progress as `done/total`, not by block index.
This roughly halves summary time for meetings over an hour.

### 10. Split the two 2,600–3,000-line files (M)

`src/main/main.js` (≈2,600 lines) and `src/renderer/library.js` (≈3,000 lines)
now hold most of the app. Features keep landing there, which makes them the
merge-conflict and regression hotspot.

- main.js: split by IPC namespace, into `ipc/library.js`,
  `ipc/settings.js`, `ipc/disk.js`, `ipc/dictation.js` and `recording.js`
  (start/stop/`state.stopping`). Each registers its handlers with a shared
  `fromLibrary(event)` guard. `main.js` keeps lifecycle and wiring.
- library.js (renderer): give each section in `SECTIONS` its own file
  (`library-reader.js`, `library-settings.js`, `library-quickcopy.js`,
  `library-disk.js`), loaded as ordinary `<script>` tags. No bundler is needed,
  which matches the no-bundler convention.

### 11. Guard the invariants with tests (S)

`test/` already covers the pure modules. The riskiest behaviour lives in
`main.js` and has no tests:

- `state.stopping`: two concurrent stop callers → exactly one pipeline run and
  no deleted folder.
- The capture-recovery path: `render-process-gone` → same WAV, counter reset on
  a healthy graph.
- `LIBRARY_SETTINGS` / preload `FIELDS` rejecting path-shaped keys.

Extracting `recording.js` (item 10) is what makes the first two testable
without Electron.

### 12. Settle the type-checking direction (S)

The working tree adds `tsconfig.json`, which includes `src//.ts`, and
deletes `jsconfig.json`. `CLAUDE.md` still says "no TypeScript". Choose one
and write it down. The low-cost option keeps plain JS and adds `checkJs` plus
`tsc --noEmit` to `npm run check`, which builds on the JSDoc the code already
has. Either way, update `CLAUDE.md` in the same commit.

---

## Tier 3: smaller UX wins

| # | Recommendation | Why it matters | Size |
|---|---|---|---|
| 13 | Audio playback synced to the transcript. Click a line to play from that timestamp (a `<audio>` served over a custom protocol scoped to the meeting folder, never `file:`). | "Did they really say that?" is the most common check, and today it means opening the WAV and scrubbing | M |
| 14 | Pre-meeting health check on the record button. Show green/amber dots for mic open, system audio open, whisper and Ollama reachable, before and in the first 10 s of a recording | A silent system channel is only discovered after the meeting | S |
| 15 | Compress stored audio. Offer to re-encode `audio.wav` to Opus after notes succeed (≈15× smaller) through a hidden-window `MediaRecorder`, so no new dependency is needed | A 16 kHz stereo hour is about 230 MB, and the Disk usage feature exists partly because of it | M |
| 16 | Pinned / starred meetings and tags in the rail, stored as a `tags.json` artefact | The archive becomes hard to scan after a few months | S |
| 17 | Summary language setting (the language the notes are written in, separate from the spoken language) | Bilingual users often speak Spanish and share notes in English, or the other way round | S |
| 18 | Dictation post-processing modes: as said, cleaned up (filler words removed, punctuation), formal email | Turns dictation from transcription into writing help, using the same local model | S |
| 19 | Keyboard-first library. `Ctrl+K` for search, `J`/`K` to move between meetings, `Ctrl+Shift+C` to copy notes | The window is opened mid-workflow, and a mouse detour costs more than it seems | S |
| 20 | First-run checklist that walks through the `setupGaps()` sentences as steps with progress, instead of a static list | Installer users meet Ollama and whisper.cpp for the first time here | S |

---

## Suggested order

1. #7 (library I/O off the main thread). It is a correctness risk during
   recording and a prerequisite for a larger archive.
2. #5, #8, #9. Each takes about a day and makes every meeting feel faster.
3. #3 Action items and #2 Ask. These are the features that bring
   people back to the archive.
4. #1 Incremental transcription. It is the biggest perceived-speed win and
   the most involved change, so do it after #10 and #11 make `main.js` safer
   to change.
5. #4 Templates, then the Tier 3 items as they fit.
