# Minarrador — UX/UI best-practices review

A designer's pass over the app as it stands: the tray, the meeting library, the
live transcript, dictation, settings, notifications and microcopy. The lens is
"tray-only background app that must be invisible when you don't need it and
instantly legible when you do." Priorities are P1 (high impact, worth doing
next), P2 (solid win, schedule), P3 (polish).

First, what is already done well — so the suggestions build on it rather than
rewrite it:

- The tray icon + tooltip already carry the recording clock and state. Left/right
  click split (library vs menu) and the deliberate absence of double-click
  behaviour are correct decisions.
- The record button in the library has no state of its own; it mirrors the main
  process. Good.
- Cards explain themselves when there are no notes (`pending` / `unprocessed` /
  `failed`) and offer the way out in place (`Generate notes`). Good.
- The settings pane renders a value *and* whether what it names is installed,
  with a red `.row.missing`. That is the right mental model for a local app.
- The live transcript sticks to the bottom only when you're near the bottom —
  the rare auto-scroll behaviour users actually want.
- Empty states carry next steps instead of being dead ends.

---

## 1. First run & onboarding

**P1 — Validate the whole chain in under a minute, then say "ready" or "this
won't work."**
The empty archive's `setupGaps()` sentences already explain *what* is missing
and *how* to install it. Add a single "Test the pipeline" action that records
~5 seconds from the chosen mic, transcribes it, and shows the result back. A
user who sees their own voice come back as text knows the mic, whisper/Ollama
and settings all work together — the failure modes otherwise only surface at the
worst moment (the end of a real meeting).

**P1 — A first-run confirmation that the hotkeys are yours.** ✅ implemented
Two global shortcuts (`Ctrl+Shift+R`, `Win+Shift+X`) are the app's real UI, but
nothing ever shows the user *how to use them*. On first run (no `settings.json`
yet) a welcome notification now names the *actually registered* shortcuts —
"Record a meeting from anywhere with Ctrl + Shift + R — the waveform icon lives
in the tray. Press Win + Shift + X to speak a sentence…" — using the values
from the store, not the defaults.

**P2 — Onboarding checklist in the library placeholder, not in the tray.**
The tray menu is deliberately short (correct). The empty-library placeholder is
the natural home for a 3-item checklist: mic chosen ✓ / Ollama reachable ✓ /
whisper installed ✓, each live-checked the way the settings pane already checks
things. It doubles as a diagnostic readout the user can screenshot before asking
for help.

**P2 — Don't scare first-run users with engine names.**
"whisper.cpp", "Ollama", "GGML" mean nothing until a user knows what they do.
Keep the technical names in Settings, but in onboarding copy and empty states
lead with the *outcome* ("Live captions", "Smarter, faster transcription"),
with the engine name as the fine print.

---

## 2. Tray, hotkeys & global state

**P1 — Make the tray's "now" state unmistakable at a glance.**
The icon changes colour and the tooltip carries the clock, but the icon is
small and easily missed mid-meeting. The recording is the one thing the app
must never be ambiguous about. Options, in order of impact:
1. A repeating audio cue or a taskbar-flash on start so it lands even without
   looking at the tray (many users have "Always show icons" on and the tray
   collapsed).
2. A persistent, always-on-top, non-focusable "REC 00:12:34" pill — the same
   pattern as the dictation pill, so it reuses machinery that already exists.
   Must be `focusable:false` like the dictation pill, and dismissible for users
   who find it noisy.

**P1 — The menu's "what is happening now" line is the best real estate in the
app; keep it, but make it actionable.**
It should always answer "what will happen next", not just "what is happening":
idle → "Not recording — `Ctrl+Shift+R` to start"; recording → "Recording
00:12:34 — `Ctrl+Shift+R` to stop". A user who has never touched the shortcut
learns it from the menu itself.

**P2 — Never silently dead shortcuts.**
Registration failure is already marked red in Settings — good. Surface it at
the moment of failure too: if `Ctrl+Shift+R` fails to register at startup, the
tray menu line should say "Shortcut held by another app" (with the other app
named, if Windows can tell us) rather than only a red line in a pane the user
may never open.

**P2 — Right-click first should not open a submenu on the item people want most.**
The menu is short on purpose. Verify the *order* matches frequency-of-use at
meeting time: the quick-copy list sits above the recording controls deliberately
("reached mid-meeting"), but for a user who does not use quick copy, the first
four rows are dead weight every time they reach for Start Recording. Consider a
user-settable "always on top" order, or simply re-verify the assumption with a
quick teardown.

**P3 — A tray tooltip that also tells you *where* the audio is going.** ✅ implemented
During recording, append the target meeting folder name to the tooltip
("Minarrador — Recording — 00:12:34 — 2026-08-11_14-32-05"). It removes the
last trace of doubt about which meeting will hold the notes.

---

## 3. Recording feedback & the Stop moment

**P1 — Own the "I stopped it, now what?" moment.** ✅ implemented
After Stop, minutes of silence follow (transcribe → summarise → PDF) and the
only end signal is a notification. That is a long gap with no promise. The tray
already shows `Transcribing 12/60…`; the "Recording saved" notification now
states the whole plan up front — "Transcribing, then the notes and the PDF
brief." — so users calibrate their expectations instead of double-checking
whether it broke.

**P1 — Report failures the moment they are known, not at the end of the run.** ✅ fail-fast half implemented
`requireOllama()` already fails fast when Ollama is the transcriber — good.
At stop time, if the 60s poll says the daemon is down, the "Recording saved"
notification now says so immediately and its click action starts Ollama — so
with whisper transcribing, the daemon is up by the time the notes stage needs
it, and the common "Ollama was down at Stop" folder never happens in the first
place. (The "carry the alert into the tray line itself" half is not done.)

**P2 — Estimated remaining time.**
whisper throughput is predictable (`base` ≈ minutes per hour of audio). The
`Transcribing 12/60…` counter could add "≈ 3 min left" with a simple
bytes-per-second average of recent chunks. It turns an unbounded wait into a
known one — the single biggest perceived-latency win in this app.

**P2 — A "paused" appearance for the stop button.**
The record button flips green→red, which reads as *stop*. While the pipeline
runs, the meeting card says `Working…`. Make the *library* header button also
reflect "processing" (disabled + a small progress tick) so the one control
users keep reaching for agrees with the card.

**P3 — Auto-detect suggestion should be throttleable.**
`Suggest recording when audio is detected` is on by default and fires after
~15 s of speech. Fine for meetings, but a long call with music, or a podcast
played aloud, triggers it repeatedly. Make the cooldown visible ("suggestion
paused for 10 min") and, if it's cheap, let the notification be dismissed with
"Don't suggest again today" → writes `settings.json`.

---

## 4. Meeting library window

**P1 — Show recording duration on the card.** ✅ already in code
`meta.json` already records it. Duration ("1h 12m") is the field people use to
disambiguate and to decide whether a meeting is worth reading. It is in the
`.card-meta` row next to the day/time.

**P2 — Filters are cheaper than you think and the archive rots without them.** ✅ implemented
The rail is one flat list. Three quiet filters above the count — All / Needs
notes / This week — narrow the list via the existing `library:list` path
(`filter` joins `query`, and the two compose). "Needs notes" is the most
valuable: it is exactly the set of meetings that are owed work, which the app
already knows how to identify (`pending` / `unprocessed` / `failed`).

**P2 — Remember the user's place.** ✅ implemented
Restore on open: last selected meeting, and which tab (Notes vs Transcript) was
active. A user who lives in a transcript and opens the window 10 times a day
should not re-find their spot each time. Pure renderer state (`sessionStorage`),
no disk changes.

**P2 — Rename affordance is discoverable enough; undo is not.**
`describeMeeting` keeps the model title as `generatedTitle` precisely so a
rename can be undone, but nothing exposes that. A "Revert to generated title"
item in the meeting actions (only when the user title differs from the model's)
completes the loop the storage was built for.

**P3 — Add an inline "Copy title" / "Copy link to folder" affordance.**
People paste meeting references into chat constantly. A per-meeting "Copy
meeting ID/path" that puts the *folder name* (the id) on the clipboard is one
small action-button row entry and covers a real workflow ("see meeting
2026-08-11_14-32-05").

---

## 5. Reading notes & transcript

**P1 — Link action items back to the moment they were said.** ✅ implemented
This is the single highest-value UX addition available: the summary's action
items live in `notes.json` and the transcript segments are timestamped in
`transcript.json`. Clicking an action item now switches to the transcript and
flashes the best-matching line (owner's name scores highest, task words score
too — a best-effort match, since the model doesn't record the source segment).
It turns notes from a summary into a *map* of the meeting.

**P1 — Clickable timestamps / copy-the-line.**
Every transcript line has a `[mm:ss]`; make it (a) copy the line with its
timestamp to the clipboard, and (b) when `audio.wav` exists, one click could
seek/play from that moment in a lightweight player window. (P3 feasibility note:
no new runtime deps — a single `<audio>` element and `currentTime` is enough.)

**P2 — The Notes tab should quote where each decision/action came from.**
Currently decisions and actions are orphan sentences. A small "said at 14:05"
caption beside each, linking into the Transcript tab, makes them trustworthy
instead of asserted.

**P2 — "Copy transcript" with a format choice.** ✅ implemented
Copy-all exists. The actions row now also offers **Copy with timestamps** — the
same words with each line's `[mm:ss]` in front (speaker labels kept on both), so
"quote the bit about pricing" and "reproduce the meeting" are one click each.

**P3 — A reading line-length guard.**
The `.doc` column is capped at 720px — good. Check the *transcript* pane's
measure too: at ~1.7 line height and 14.5px, keep lines under ~90 characters so
the eye doesn't travel a full ultra-wide window per line.

---

## 6. Search

**P2 — Show a match preview, not just a count.**
Search already highlights and counts per meeting. The rail badge (`.tag.hits`)
tells you *how many*, not *where*. Add the first matched line as the card
preview when the query is active (it already shows the first 4 KB of a
transcript when there are no notes — extend that path to prefer a line around a
hit). Users decide "open or skip" without opening.

**P2 — Debounce feedback: say "searching" for big folders.** ✅ implemented
The debounce is correct. For a large archive, a single-line "Searching…" under
the box turns a 300 ms nothing into an acknowledged wait, and it costs nothing
on the fast path (it only appears once a search has actually been launched).

**P3 — Recent searches, in-window.**
Keep the last ~5 queries in `sessionStorage` and offer them on focusing the box
(one keydown away from the existing `Ctrl+F` focus path). Trivial, and it saves
people who search the same phrase daily.

**P3 — Consider fuzzy tolerance for transcript typos.**
whisper output is not the spelling people type. A small edit-distance tolerance
("Pricing" matching "priceing") materially improves hit rate. Only if the query
path can stay a folder walk without an index — keep the no-index constraint.

---

## 7. Live transcript window

**P2 — The footer disclaimer is doing the right job; make the header do more.**
"Rough live preview" in the footer is honest and good. The header status is
just "Idle" — it should reflect the engine actually running (whisper.cpp vs the
Ollama fallback) so a user who sees lag understands *why* (the lag table in the
README is the truth; the window should say the same sentence).

**P2 — A "Copy so far" button.** ✅ implemented
The whole point of the live preview is that it survives a crash via
`live-transcript.txt`. The window now has a **Copy so far** button that puts
every line shown so far on the clipboard (with the "Copied" feedback), so a
user can paste a half-meeting's worth of captions into an email without
touching disk.

**P3 — Distinguish the mic's speaker from the room in the preview.**
The saved transcript labels `You:` / `Others:`; the live preview folds to mono
and infers the speaker but writes labels to `live-transcript.txt`. Surface those
labels in the window the same way the reader does (`.who` chips) when they're
available, and don't when they're not.

**P3 — Pause/resume live captions.**
A tiny pause toggle that stops segments reaching the window but keeps recording
is a natural ask for sensitive stretches ("hold on, that's off the record") and
reads as a privacy feature, which is this app's whole brand.

---

## 8. Dictation & the pill

**P1 — The pill must tell you when it's *finished*, not just when it's listening.**
The pill currently shows "Listening" + caption. The state machine already exists
in `dictate:state` (`listening / transcribing / done / error`) — make the pill
visually carry it: red dot + "Transcribing…", then a brief green "Pasted" state
before fading. Right now a user cannot tell whether the text landed until the
confirmation notification arrives.

**P2 — Cancel affordance.**
`focusable:false` correctly protects the target cursor, but the pill could still
be *clickable* (click does not move focus). A click = cancel dictation is the
only panic exit other than pressing the hotkey again. Add it and say so in the
pill's title attribute.

**P2 — Warn before the 5-minute cap, not just at it.**
`MAX_SECONDS` (5 min) ends a session with a notification. The pill should show
a gentle "3 min of 5" count as it approaches, so an open mic past the point of
the user walking away doesn't quietly become a cap with no memory.

**P2 — Auto-paste failures deserve a retry, not just a clipboard.**
When the paste misses (elevated window), the text is on the clipboard — good —
but the notification could offer an explicit "Retry paste" action, since the
user is still sitting at the same window.

**P3 — A "text preview" before it's pasted is the killer feature; guard it.**
Already there via the pill caption. Guard the trust case: if the caption is
only 80% certain (whisper `prob` is available from `/inference`), show
"uncertain" styling and the confirmation notification should invite a "Retry"
that re-runs the careful engine — the cheap-and-correct fallback for misdictation.

---

## 9. Settings pane

**P1 — Order by consequence, then by frequency.** ✅ implemented
The pane already has the right model. The sections now run Recording →
Transcription and notes (Ollama) → Live transcript → Voice input → Storage and
shorthands, so the things that break meetings come first — a user who lands on
Settings with a broken meeting should not scroll past the fix.

**P1 — A "Test microphone" row.** ✅ implemented
Mic issues are the #1 first-run failure and the pane can't show levels. The
Recording section now has a **Test microphone** row: a button that opens the
chosen mic (via the dictation worker — same mic resolution, records nothing)
and a live green meter showing what it hears, with the device name on success
or the reason on failure. Auto-stops after 15 s, and is safe against a
dictation starting mid-test.

**P2 — Show installed-model sizes and the disk the folder consumes.**
"gemma4:12b" and "ggml-base.bin" are just names; their GBs are the reason
people hesitate or hit disk caps. The settings row hint can carry the size from
Ollama's `list` and the whisper folder, plus a one-line "notes folder: 2.3 GB"
reading at the bottom. It pre-empts the "why is my disk full" ticket.

**P2 — "Restore defaults" per section.**
Red `missing` rows are well done; add a quiet "Reset this section" link per
section that writes the defaults back through the existing `settings:set` gate.
It fixes the "I changed something, now nothing works" spiral without a nuke-all.

**P3 — Surface the loaded-vs-installed whisper model.**
`whisperModel` names a file; the *loaded* model matters for the live floor.
Show "loaded: base · installed: base, small, large-v3" in the hint so the
"which one am I actually running" question answers itself.

**P3 — A visible "all data stays on this machine" line.** ✅ implemented
One quiet line under the pane — "Everything Minarrador does runs on this
machine — audio, transcripts and notes never leave it." It is the app's entire
reason to exist and costs one sentence where the privacy-sensitive settings are.

---

## 10. Notifications

**P1 — Notifications are actions, not statements.**
End-of-pipeline already opens the PDF on click — the right pattern. Extend it:
recording-started → click opens the live transcript; recording-stopped → click
opens the meeting's library card; dictation-pasted → click opens the Dictations
entry. Every notification should leave the user one click from the thing it
announces.

**P2 — One notification per event, with a stable identity.**
When Ollama is down, several notifications can arrive in sequence (stop →
failed). Collapse to a single actionable one ("Notes failed — Ollama wasn't
running. Fix and retry") and let the retry be the notification's own action.

**P2 — The three-hour "you're still recording" reminder is excellent — make it
non-repeating-cumulative.**
It repeats on a one-second tick (well, on the tray tick) — good enough. Just
verify it escalates (quiet first, clearer later) and that stopping dismisses it
immediately, so it can't survive the meeting it's about.

**P3 — Respect Windows "quiet hours".**
Electron notifications follow system focus-assist. Don't fight it, but the
recording-stopped result is the one notification that arguably should bypass —
at minimum, don't rely on notifications as the *only* signal for the most
important states (see §2's always-on-top pill).

---

## 11. Accessibility & keyboard

**P2 — Keyboard should cover the two daily actions without the mouse.** ✅ implemented
`Ctrl+F` search, arrows, `Esc` exist. `Ctrl+N` start/stop recording, `Ctrl+,`
settings, and `Ctrl+Shift+C` copy-transcript (same click path as the action
button, so it gets the "Copied" feedback) are now bound too. Users on laptops +
touchpads spend a lot of time without a mouse button handy.

**P2 — Visible focus everywhere, not just on inputs.** ✅ focus-visible half done
Custom buttons (`.ghost`, `.card`, `.tab`, `.record`) rely on hover; a
`:focus-visible` outline is now in every window's stylesheet so keyboard users
see where they are. The rail already implements `listbox` semantics — the
`aria-activedescendant` half so screen readers announce the walked card is not
done.

**P2 — Contrast audit against WCAG AA.**
The muted grays (`#6b7280`, `#8b8b98`, `#5b5b68`) on `#16161a` are the riskiest
pairings (small 11.5px type). Audit and lift the dimmest metadata text to ≥4.5:1;
timestamps can stay dimmer as decorative. `color-scheme: dark` is already set —
good for native controls.

**P3 — `prefers-reduced-motion`.** ✅ implemented
The `.progress-track.indeterminate` sweep, the dictation pill's pulse and the
meters' transitions are now all gated behind `prefers-reduced-motion: reduce`.

**P3 — Transcript live region granularity.**
`role="log" aria-live="polite"` on the transcript is right, but a line-per-
caption can chatter. Consider `aria-relevant="additions"` + batching captions
into a single polite update per second so screen-reader users get "…continued"
instead of a stutter.

---

## 12. Copywriting & microcopy

**P2 — Errors should say what to do, in the order to do it.**
The failure notices already quote `ERROR.txt` and offer `Generate notes` —
excellent. Extend the pattern everywhere red appears: "Ollama not reachable →
Open Ollama" (exists), "whisper not installed → Install" (exists). The rule to
keep: a red thing must name the fix, never just the problem.

**P2 — Consistent tense and voice for the two main verbs.**
The app mixes "record / transcribe / generate notes" freely. Pick one user
model — "record a meeting" (user) vs "transcribe / summarise" (app) — and keep
`Start Recording / Stop Recording` as the only verbs for the primary action
across tray, button, and shortcuts. "Generate notes" is the right name for the
retry action; don't also call it "Reprocess" anywhere a user reads.

**P3 — Dates and durations in one format.** ✅ implemented
Cards group by day; transcript lines show `mm:ss`, growing an `h:mm:ss` field
once a recording passes an hour, so "07:12" can't read as the end of a long
meeting.

**P3 — The pill's caption should be a sentence, not a stutter.** ✅ implemented
Live caption fragments ("…and then we") are useful but look like errors. A
trailing ellipsis on a partial segment ("…and then we…") signals *in progress*
rather than *broken*, and drops the moment the segment ends in punctuation.

---

## 13. Trust & privacy

**P2 — Make "local" visible at the three moments it matters.**
First run (placeholder), Settings (folder rows), and the "suggest recording"
notification ("audio stays on this PC"). The README is a strong privacy
statement; the app should echo it where a worried user is actually looking.
This is the app's brand — one line in each of the three places is enough.

**P2 — The recording indicator is also a privacy signal to the room.**
If the always-on-top REC pill is added (§2), keep it clearly visible *to the
person presenting* too: a recording the room can't see is a trust leak, not a
feature. Default it on, allow opting out.

**P3 — Delete should say where things go.**
Delete uses `shell.trashItem` (recoverable) — great. Say so in the dialog
("Moved to Recycle Bin — you can restore it"), because "Delete" + a confirm is
what users fear, and this app can honestly defuse that fear.

---

## 14. Performance & perceived performance

**P2 — Stream progress, don't wait for it.**
`library:progress` already updates the card in place. Extend the same pattern
to the reader while a meeting is processing: the open card's progress bar should
move live too (it does for cards; confirm the reader notice re-renders on
`library:progress`, not only on `library:changed`).

**P2 — First paint of a meeting should be instant, notes second.**
When opening a meeting, show title + meta + the `live-transcript.txt`/first-4KB
preview immediately, then hydrate the full notes/transcript. The pieces exist
(`transcriptSource()`, 4 KB preview read); it's a render-order change that makes
large meetings feel instant.

**P3 — Defer PDF generation, or at least say it's the slow part.**
The PDF is the least-reused artefact and a real chunk of pipeline time. If it's
ever optional ("Generate PDF" after the fact, via `library:reprocess`-style
button), the pipeline's critical path shortens and "notes are done" arrives
sooner. Keep it default-on; this is a trade, not a recommendation to ship
without PDFs.

**P3 — Idle perf: nothing should tick when nothing is happening.**
The tray tick is once a second *while recording* (good, needed for the clock).
Verify it fully pauses when idle so a tray-only app is genuinely at rest on
battery machines — the promise of "invisible until you need it."

---

## Quick-win summary (do these first)

| # | Suggestion | Where |
|---|------------|-------|
| 1 | Duration + needs-notes filter on cards | Library rail — duration was already in code; filter ✅ |
| 2 | Stop-time plan + fail-fast notification | Pipeline/tray — ✅ plan + Ollama nudge done |
| 3 | Clickable action-item → transcript jump | Reader — ✅ done |
| 4 | Pill carries finished/error states | Dictation — already in code |
| 5 | Test-microphone row | Settings — ✅ done |
| 6 | Keyboard: `Ctrl+N`, `Ctrl+,`, `Ctrl+Shift+C` | Library — ✅ done |
| 7 | Show engine in live-transcript header | Transcript window — already in code |
| 8 | First-run hotkey notification | Startup — ✅ done |
| 9 | Focus-visible + AA contrast pass | Global — ✅ focus-visible + reduced-motion; contrast audit open |
| 10 | "Local" line in first-run, settings, suggest notification | Global — ✅ settings line done |

Additional ✅ in this pass: rail filters (needs/this-week), last-meeting + tab
restore, copy-with-timestamps, "Searching…" indicator, tray tooltip names the
target folder, "Copy so far" in the transcript window, settings reordered
consequence-first, transcript hours, pill ellipsis.
