# PRD — Tasks (to-do list module)

| | |
|---|---|
| Status | Draft |
| Owner | Renato Baeza |
| Date | 2026-09-28 |
| Surface | Library window → new sidebar feature Tasks; tray menu; global quick-add hotkey |
| Reference product | Todoist (interaction model and best practices), adapted to a local-only, single-user desktop app |

---

## 1. Summary

Minarrador already produces commitments: every meeting's `notes.json` carries
`action_items` (`task`, `owner`, `due`), and every dictation is a sentence the
user wanted written down. Today those commitments end as a checklist inside a
PDF — nothing tracks whether they got done.

Tasks is a keyboard-first to-do list inside the library window that takes
Todoist's proven model — a single Inbox for capture, natural-language quick
add, Today/Upcoming views, projects with sections and sub-tasks, priorities,
labels, saved filters, recurring due dates and reminders — and ties it to the
two things only Minarrador has: meeting action items and voice
dictation. Like everything else in the app, it never leaves the machine.

## 2. Problem

1. Action items die in the notes. The summariser extracts them well, but
   there is no place to check them off, reschedule them or see them next to
   tomorrow's work. Users re-type them into another app — or don't.
2. Capture is the hard part, and it happens mid-meeting. A to-do app that
   needs a window to be found and focused loses the thought. Minarrador is
   already a tray app with global hotkeys; capture should cost one shortcut.
3. Cloud to-do apps conflict with the product promise. A task list built
   from meeting content is meeting content. Sending it to Todoist, Microsoft
   To Do or similar breaks "nothing leaves the machine".

## 3. Goals and non-goals

### Goals

- G1 — Capture in under 3 seconds from anywhere on the desktop, by keyboard
  or voice, without switching window.
- G2 — Zero re-typing of meeting action items. Every action item owned by
  the user can become a task in one click (or automatically), linked back to
  the meeting it came from.
- G3 — A daily working view. Today shows overdue + due-today work, so the
  list is something opened every morning, not an archive.
- G4 — Todoist-grade organisation for users who want it (projects,
  sections, sub-tasks, labels, priorities, filters), invisible to users who
  don't — the Inbox + Today path must work with none of it configured.
- G5 — Local, durable, recoverable. Same guarantees as the rest of the app:
  a JSON store in `%APPDATA%\Minarrador`, atomic writes, undo for every
  destructive action, and no network access.

### Non-goals (v1)

- Sync across devices, accounts, sharing, collaboration, assigning to other
  people, comments from others.
- Mobile app, web app, browser extension, email-to-task.
- Calendar integration (Google/Outlook) — it would be the first outbound
  connection carrying user data.
- Gamification (Todoist Karma, streaks). Revisit only if retention data asks
  for it — and there is no telemetry to produce that data, by design.
- Kanban board view (deferred to v2, see §12).
- Using Ollama for anything that must be instant; the LLM is optional
  enrichment, never on the capture path.

## 4. Users and jobs to be done

Primary persona — the meeting-heavy individual contributor or manager.
Five-plus calls a day, already uses Minarrador for notes, currently keeps
to-dos in a mix of sticky notes, a paper pad and a cloud app they are not
allowed to paste meeting content into.

| # | When… | I want to… | So that… |
|---|---|---|---|
| J1 | someone asks me for something mid-call | capture it without leaving the call | I don't lose it or the thread of the conversation |
| J2 | a meeting ends | turn my action items into tasks without re-typing | the notes become commitments I track |
| J3 | I start my day | see what is overdue and due today, in priority order | I know what to do first |
| J4 | I plan the week | see what's coming and move things between days | the load is realistic |
| J5 | a task repeats (weekly report, 1:1 prep) | set it once | it comes back by itself |
| J6 | I'm walking or my hands are busy | say the task out loud | voice is a first-class input, like dictation already is |
| J7 | I finish something | check it off and see it go | the list shrinks, with undo if I mis-clicked |
| J8 | I review a past meeting | see which of its action items are done | I can follow up credibly |

## 5. Todoist best practices adopted

Each practice below is what Todoist does well, and how it lands here.

| Todoist practice | Why it works | Minarrador adaptation |
|---|---|---|
| Inbox as the default destination | Capture without deciding where it goes; organise later | Every task without a project lands in Inbox. Inbox cannot be deleted or renamed |
| Quick Add with natural language (`tomorrow 5pm p1 #Work @calls`) | One text field replaces a form; the fastest capture UI in the category | Same grammar (§6.2), parsed locally and deterministically; tokens highlighted as they are recognised; `Esc` removes the last parse if it was wrong |
| Global quick-add shortcut | Capture from any app | New global hotkey from a fixed `TASK_HOTKEY_CHOICES` list, same rules as the meeting and dictation hotkeys |
| Today / Upcoming views | Separates "what now" from "everything" | Today = overdue + today; Upcoming = next 14 days grouped by day, drag between days to reschedule |
| Four priority levels (P1–P4) | Few enough to mean something | P1 red, P2 orange, P3 blue, P4 none (default). Sorting inside a day is priority first |
| Projects → sections → tasks → sub-tasks | Hierarchy that scales from one list to many | Projects (optionally nested one level), sections inside projects, sub-tasks up to 4 levels |
| Labels (`@waiting`, `@calls`) | Cross-cutting context that projects can't express | Free-form labels, colour optional, autocomplete in quick add |
| Filters with a query language (`today & p1`, `@waiting & !#Personal`) | Power users build their own views | Subset of Todoist's syntax (§6.6), saved as Filters in the sidebar |
| Recurring due dates in plain language (`every monday`, `every! 2 weeks`) | Routines without a separate feature | Parser supports `every` (from due date) and `every!` (from completion date) |
| Due date vs deadline | "When I'll work on it" ≠ "when it must be done" | `due` (scheduled) and optional `deadline` (hard limit) shown separately |
| Reminders | Due dates alone don't interrupt | Native Windows notification at a time, or relative to due time. Fired only while the app runs; missed ones fire on next start |
| Task descriptions and comments | Context lives with the task | Markdown description + timestamped notes. Meeting-sourced tasks link to the meeting |
| Undo toast on complete/delete | Makes fast actions safe | 7-second undo toast for complete, delete, move, bulk edit. Deleted tasks go to a 30-day Trash |
| Keyboard shortcuts everywhere | Heavy users never touch the mouse | Full map in §6.8; `?` shows the cheat-sheet |
| Multi-select & bulk edit | Weekly review in seconds | Shift/Ctrl-click or `Shift+↑/↓`, then set date, priority, project, label, or complete |
| Drag & drop reordering | Manual order is a legitimate intent | Same grip pattern as Quick copy; `Alt+↑/↓` from the keyboard |
| Completed history / activity | Evidence of progress, recoverable mistakes | Completed view per project and globally, with un-complete |
| Templates | Repeat multi-step checklists | Save a project as template (JSON), instantiate with relative dates. v1.1 |
| Productivity visualisation | Motivation | Out of scope for v1 (see non-goals); a plain "done today / this week" count is shown in Today |

## 6. Functional requirements

Priority: P0 = v1 must ship, P1 = v1 should ship, P2 = v1.1+.

### 6.1 Navigation and views

| ID | Req | Pri |
|---|---|---|
| V1 | New sidebar feature Tasks in the library window (`SECTIONS.tasks`), placed after Recording. Its rail lists: Inbox, Today (with count), Upcoming, then Projects, Labels, Filters, and Completed at the bottom | P0 |
| V2 | Inbox — tasks with no project, manual order | P0 |
| V3 | Today — overdue (red header, "Reschedule all" action) then today, sorted by priority, then time, then manual order | P0 |
| V4 | Upcoming — next 14 days, one group per day, empty days shown collapsed; drag a task onto a day header to reschedule | P0 |
| V5 | Project view — sections as collapsible groups; tasks without a section on top; add-section inline | P0 |
| V6 | Label view and Filter view — flat list, grouped by project | P1 |
| V7 | Completed — reverse-chronological, grouped by day, un-complete from here | P0 |
| V8 | Trash — deleted tasks for 30 days, restore or purge | P1 |
| V9 | Tray menu gains Add task… (opens quick add) and a Today (n) item that opens the Tasks feature on Today | P0 |
| V10 | Tray tooltip appends "n due today" when > 0 and not recording | P2 |

### 6.2 Quick add

A single text field, reachable from (a) the global task hotkey, (b) `Q` or `+`
anywhere in the Tasks feature, (c) the tray. The global variant opens a small
frameless, always-on-top, focusable window centred on the active monitor
(unlike the dictation pill, it must take the cursor), and closes on `Enter` or
`Esc`, returning focus to the previous window.

Recognised tokens (parsed on every keystroke, highlighted inline, removable by
clicking the chip or `Backspace` into it):

| Token | Examples | Result |
|---|---|---|
| Date | `today`, `tod`, `tomorrow`, `tmr`, `mon`, `next friday`, `in 3 days`, `jan 27`, `27/01`, `end of month`, `next week` | `due.date` |
| Time | `5pm`, `17:00`, `at 9`, `noon` | `due.time` |
| Recurrence | `every day`, `every weekday`, `every mon, thu`, `every 2 weeks`, `every! 3 days`, `every last day` | `due.recurrence` |
| Deadline | `{friday}`, `{jan 30}` | `deadline` |
| Duration | `for 30m`, `for 1h` | `duration` |
| Priority | `p1`…`p4`, `!!1`…`!!4` | `priority` |
| Project | `#Work`, `#"Client A"` (autocomplete; unknown name offers "Create project") | `projectId` |
| Section | `/Backlog` after a project | `sectionId` |
| Label | `@waiting`, `@calls` (autocomplete; unknown creates) | `labels[]` |
| Reminder | `!30m before`, `!9am` | `reminders[]` |

Rules:
- Parsing is deterministic and local (a hand-written parser in
  `src/main/taskparse.ts`, unit-tested). No LLM on this path.
- Dates respect the Windows locale for `dd/mm` vs `mm/dd` and first day of
  week; a setting overrides.
- Only the last date phrase wins; a phrase inside quotes is never parsed
  (`"call Monday Group"` stays text). A toggle in the field disables parsing
  for the current task.
- `Shift+Enter` adds and keeps the field open for the next task.
- Multi-line paste offers "Add 7 tasks" (one per line), each line parsed.

| ID | Req | Pri |
|---|---|---|
| Q1 | Quick-add window with the grammar above (date, time, priority, project, label) | P0 |
| Q2 | Recurrence, deadline, duration, reminder tokens | P1 |
| Q3 | Global hotkey `taskHotkey`, choices from `TASK_HOTKEY_CHOICES` (e.g. `Ctrl+Alt+A`, `Ctrl+Shift+A`, `Super+Shift+A`, `off`), disjoint from the meeting and dictation lists; failure kept in `state.taskHotkeyRegistered` and marked red in Settings | P0 |
| Q4 | Multi-line paste → bulk add | P1 |
| Q5 | Inline quick add at the bottom of any list, inheriting that view's project/section/date | P0 |

### 6.3 Voice capture

Reuses `DictationController` — no new audio path.

| ID | Req | Pri |
|---|---|---|
| D1 | In the quick-add window, a mic button / `Ctrl+M` starts a dictation; the transcript is inserted into the field and parsed like typed text ("remind me to send the deck tomorrow at 9 p1" → task send the deck, tomorrow 09:00, P1) | P1 |
| D2 | Setting `dictateTarget`: `paste` (today's behaviour) or `task` — when `task`, the dictation hotkey files the result straight into the Inbox and shows a notification with an Open action instead of pasting | P1 |
| D3 | The phrase prefixes "remind me to", "I need to", "todo" are stripped from voice input only | P1 |
| D4 | Dictations window gets a per-row Make task button | P2 |

### 6.4 Meeting integration (the differentiator)

| ID | Req | Pri |
|---|---|---|
| M1 | Meeting reader: each action item shows a checkbox-style Add to tasks control; the whole list has Add all mine (owner = the mic speaker label or `Unassigned`) | P0 |
| M2 | Created tasks carry `source: { kind: 'meeting', meetingId, itemIndex, text }`, land in a project chosen in Settings (default Inbox) with label `@meeting`, and the model's `due` string is run through the same date parser; unparseable text goes into the description | P0 |
| M3 | Items owned by someone else become tasks with label `@waiting` and the owner's name in the title ("Waiting on Ana: send pricing") when the user chooses Add as follow-up | P1 |
| M4 | Setting `autoTasksFromMeetings`: `off` (default) / `mine` / `all` — applied when the pipeline finishes the notes stage | P1 |
| M5 | The reader shows each item's live state (open / done / not tracked); the task detail links back and opens the meeting in the reader | P0 |
| M6 | Idempotent: re-running the pipeline never duplicates tasks — dedupe on `(meetingId, normalized text)`; a regenerated item that no longer matches is left alone, not deleted | P0 |
| M7 | Renaming or deleting a meeting never deletes tasks; a deleted meeting's link shows "meeting removed" | P0 |

### 6.5 Task model and editing

| ID | Req | Pri |
|---|---|---|
| T1 | Task fields: title (single line, Markdown inline allowed), description (Markdown), project, section, parent, priority, due (date, optional time, optional recurrence), deadline, duration, labels, reminders, notes, source, order, created/updated/completed timestamps | P0 |
| T2 | Task detail panel opens on `Enter` / click, in the reading column (same pattern as the meeting reader). Every field editable in place; changes save on blur and on a 600 ms idle, like the Quick copy editor | P0 |
| T3 | Sub-tasks: indent with `Tab` / `Ctrl+]`, outdent `Shift+Tab` / `Ctrl+[`; parent shows "2/5"; completing a parent completes children (with undo) | P0 |
| T4 | Completing a recurring task advances it to the next occurrence and records one completion entry; `every` computes from the old due date, `every!` from today; "Skip occurrence" is available | P1 |
| T5 | Overdue recurring tasks with `every` roll to the next occurrence after today, not the missed one | P1 |
| T6 | Duplicate, move to project, convert to sub-task, copy link (`minarrador://task/<id>` shown as text — see §8) | P1 |
| T7 | Notes on a task: timestamped plain entries, append-only in UI, deletable | P2 |

### 6.6 Organisation: projects, sections, labels, filters

| ID | Req | Pri |
|---|---|---|
| O1 | Create, rename, colour, archive, delete (to Trash) projects; one level of nesting; manual order | P0 |
| O2 | Sections inside a project: create, rename, reorder, collapse, delete (tasks move to project root, confirmed) | P0 |
| O3 | Labels: create on the fly, rename (propagates), colour, delete (removed from tasks) | P0 |
| O4 | Filters with a query subset: `today`, `tomorrow`, `overdue`, `no date`, `next 7 days`, `p1`…`p4`, `#Project`, `##Project` (incl. children), `/Section`, `@label`, `no labels`, `recurring`, `search: text`, `due before: <date>`, `created after: <date>`; operators `&`, `\|`, `!`, `( )`; `,` splits into separate groups on one page | P1 |
| O5 | Filter editor validates as you type and shows the match count; invalid queries never save | P1 |
| O6 | Favorites: pin projects, labels or filters to the top of the rail | P2 |

### 6.7 Search, sort, group

| ID | Req | Pri |
|---|---|---|
| S1 | `Ctrl+K` command palette across tasks (title + description), projects, labels, filters, and actions ("Go to Today", "Add task") | P1 |
| S2 | Per-view sort: manual (default), due date, priority, name, date added; group: none, project, priority, due date, label. Stored per view | P1 |
| S3 | Global search box in the Tasks rail, debounced and sequenced like the meeting search | P0 |

### 6.8 Keyboard

Shortcuts are scoped to the Tasks feature and inactive while a text field has
focus (except those with modifiers).

| Keys | Action |
|---|---|
| `Q` / `+` | Quick add |
| `Ctrl+Alt+A` (default, global) | Quick add from anywhere |
| `G` then `I` / `T` / `U` / `C` | Go to Inbox / Today / Upcoming / Completed |
| `↑` `↓` / `J` `K` | Move selection |
| `Enter` | Open task detail |
| `E` | Complete (undo with `Ctrl+Z` or `U` on the toast) |
| `Shift+E` / `Del` | Delete (to Trash) |
| `T` / `Y` / `W` / `R` | Due today / tomorrow / next week / remove date |
| `1`–`4` | Set priority |
| `V` | Move to project (picker) |
| `L` | Add label (picker) |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Alt+↑` / `Alt+↓` | Reorder |
| `Shift+↑/↓`, `Ctrl+A` | Extend selection / select all in view |
| `Ctrl+K` | Command palette |
| `?` | Shortcut cheat-sheet |

### 6.9 Reminders and notifications

| ID | Req | Pri |
|---|---|---|
| R1 | Absolute and relative reminders fire a native `Notification` with Complete and Snooze 10 min / Tomorrow actions (where Windows supports actions; otherwise click opens the task) | P1 |
| R2 | Default reminder for timed tasks (setting: none / at time / 10 / 30 min before) | P1 |
| R3 | Scheduler rides the existing one-second tray tick — no timers of its own; on start/resume it fires anything missed in the last 24 h once, grouped into one notification if > 3 | P1 |
| R4 | Optional morning digest at a chosen time: "5 tasks today, 2 overdue" → opens Today | P2 |
| R5 | No reminder ever fires during an active recording's first 10 s or while the dictation pill is up — they queue until it ends | P1 |

### 6.10 Settings (new rows in the Settings pane)

`taskHotkey`, `taskDefaultProject`, `autoTasksFromMeetings`, `dictateTarget`,
`taskDateOrder` (`auto` / `dmy` / `mdy`), `taskWeekStart` (`auto` / `mon` /
`sun`), `taskDefaultReminder`, `taskDigestTime`, `taskShowCompletedInline`.
All scalar, all added the standard way (§ Adding a new setting in
`CLAUDE.md`); `taskDefaultProject` is an opaque project id validated against
the store, like `micDeviceId` against the device list.

### 6.11 Import / export

| ID | Req | Pri |
|---|---|---|
| X1 | Export all tasks as JSON (the store format) and as CSV (Todoist-compatible column order: `TYPE, CONTENT, DESCRIPTION, PRIORITY, INDENT, DATE, …`) | P1 |
| X2 | Import a Todoist CSV export or a Minarrador JSON export; preview the counts before committing; an import is one undo step | P1 |

## 7. Architecture

Follows the existing module shape; no new runtime dependencies.

```
src/main/tasks.ts        # Store: load/normalize/save, CRUD, ordering, undo journal
src/main/taskparse.ts    # Quick-add grammar → { title, due, priority, ... } (pure, tested)
src/main/taskquery.ts    # Filter query parser + evaluator (pure, tested)
src/main/recurrence.ts   # next-occurrence maths (pure, tested)
src/main/reminders.ts    # Due-reminder scan, driven by the tray tick
src/renderer/library.   # renderTasks(), task detail, rail entries (SECTIONS.tasks)
src/renderer/quickadd.  # Global quick-add window (page, styles, view, preload)
```

### 7.1 Storage

- `%APPDATA%\Minarrador\tasks.json` — a separate store, for the same reason
  `snippets.json` is: the settings store only holds scalars.
- Shape: `{ version: 1, projects[], sections[], labels[], filters[], tasks[], completed[], trash[] }`.
- `normalize()` is the single gate on load and on every IPC payload, as in
  `snippets.ts`: unknown keys dropped, strings length-capped (title 500,
  description 16 000), enums coerced, orphans (missing project/parent)
  re-homed to Inbox rather than dropped.
- Atomic writes: write `tasks.json.tmp`, `fsync`, rename; keep
  `tasks.json.bak` from the previous successful save. A file that fails to
  parse is renamed to `tasks.corrupt-<timestamp>.json`, the `.bak` is loaded,
  and the user is told — a to-do list that silently empties is the worst
  failure this module can have.
- Writes are debounced (250 ms) and flushed on `before-quit`.
- `completed[]` older than 1 year is moved to `tasks-archive-<year>.json` on
  start, so the hot file stays small.
- Scale target: 10 000 open tasks, 100 000 completed, with every view
  rendering in < 100 ms (in-memory indices by project, due date and label).

### 7.2 Data model (TypeScript, in `src/shared/types.d.ts`)

```ts
type TaskId = string;            // crypto.randomUUID()
type Priority = 1 | 2 | 3 | 4;   // 1 = highest (P1)

interface Due {
  date: string;                  // 'YYYY-MM-DD', local
  time?: string;                 // 'HH:mm', local
  recurrence?: { rule: string; fromCompletion: boolean }; // rule as typed, e.g. 'every 2 weeks'
  timezone?: 'floating';         // v1: always floating local time
}

interface Task {
  id: TaskId;
  title: string;
  description: string;
  projectId: string | null;      // null = Inbox
  sectionId: string | null;
  parentId: TaskId | null;
  order: number;                 // fractional index within its container
  priority: Priority;
  due: Due | null;
  deadline: string | null;       // 'YYYY-MM-DD'
  durationMin: number | null;
  labels: string[];              // label ids
  reminders: { id: string; at?: string; before?: number }[];
  notes: { at: string; text: string }[];
  source: null
        | { kind: 'meeting'; meetingId: string; itemIndex: number; text: string }
        | { kind: 'dictation'; dictationId: string };
  createdAt: string; updatedAt: string; completedAt: string | null;
}
```

Fractional `order` means a drag writes one task, not the whole list.

### 7.3 IPC

All `tasks:` handlers check `event.sender.id` against the library window (or
the quick-add window for `tasks:add`), exactly like `snippets:`.

| Channel | Direction | Payload |
|---|---|---|
| `tasks:query` | library → main (invoke) | `{ view, id?, query? }` → `{ tasks, groups, counts }` |
| `tasks:add` | library / quick-add → main (invoke) | raw text + context `{ projectId?, sectionId?, date? }` → the task |
| `tasks:parse` | library / quick-add → main (invoke) | raw text → parsed tokens with ranges, for highlighting |
| `tasks:update` | library → main (invoke) | `{ ids[], patch }` → updated tasks + `undoToken` |
| `tasks:complete` / `tasks:uncomplete` | library → main (invoke) | `ids[]` → `undoToken` |
| `tasks:delete` / `tasks:restore` | library → main (invoke) | `ids[]` → `undoToken` |
| `tasks:undo` | library → main (invoke) | `undoToken` → ok |
| `tasks:move` | library → main (invoke) | `{ id, projectId, sectionId, parentId, before?, after? }` |
| `tasks:meta` | library → main (invoke) | → `{ projects, sections, labels, filters }` |
| `tasks:metaSave` | library → main (invoke) | a single project/section/label/filter upsert or delete |
| `tasks:fromMeeting` | library → main (invoke) | `{ meetingId, itemIndexes[], mode: 'mine' \| 'followup' }` → created ids |
| `tasks:changed` | main → library / tray | — (re-query the current view) |
| `quickadd:close` | quick-add → main | — |

### 7.4 Integration points in existing code

- `main.ts`: `applyTaskHotkey()` beside `applyHotkey()` /
  `applyDictateHotkey()`; unregister by accelerator, never `unregisterAll`.
- `pipeline.ts`: after the notes stage writes `notes.json`, main (not the
  pipeline) applies `autoTasksFromMeetings` — the pipeline stays free of UI
  and store concerns and remains runnable from `npm run pipeline`.
- `library.ts` (main): `readMeeting` enriches each action item with its
  tracked state from the task store.
- `tray.ts`: Add task… and Today (n), recomputed on `tasks:changed`
  and at midnight — not on every tick.
- `dictation.ts`: honours `dictateTarget` after a successful transcription;
  the paste path is untouched when it is `paste`.

## 8. Privacy and security

- No network. `tasks.ts`, `taskparse.ts`, `taskquery.ts` and
  `reminders.ts` make no requests; the existing eslint rule against bare
  `fetch` in `src/main/` covers them. Tasks are never sent to Ollama in v1.
- The renderer never names a file. Export/import (§6.11) go through
  `dialog.showSaveDialog` / `showOpenDialog` in main, as the notes folder does.
- Imported data is untrusted. It passes through `normalize()` and is
  rendered as text; Markdown in descriptions is rendered with a whitelist
  (no raw HTML, no `javascript:` links, links open via `shell.openExternal`
  only for `http(s)` after a confirmation).
- No custom protocol in v1. `minarrador://` deep links would register a
  handler any web page could call; the "copy link" action copies a task id
  used only by the in-app palette until that trade-off is decided (§12).
- The quick-add window gets the same CSP, `sandbox: true`,
  `contextIsolation: true` and a minimal preload as every other window.

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| Capture latency | Global hotkey → focused field in < 150 ms (window pre-created hidden, like the capture worker) |
| View render | < 100 ms for 10 000 open tasks; lists virtualised beyond 500 rows |
| Durability | No acknowledged change lost on crash or power cut beyond the 250 ms debounce; corrupt file never loads as empty |
| Undo | Every destructive or bulk action reversible for 7 s via toast, and single-level `Ctrl+Z` until the next action |
| Accessibility | Full keyboard operation; ARIA roles (`listbox`/`option`, `treeitem` for sub-tasks); priority never conveyed by colour alone (icon + text in detail); respects `prefers-reduced-motion`; contrast ≥ 4.5:1 on the dark theme |
| Theming | Uses `theme.css` tokens; no new palette |
| Time | Floating local dates; DST-safe recurrence (date maths on calendar days, not milliseconds); midnight rollover refreshes Today |
| Testing | `taskparse`, `taskquery`, `recurrence` and `normalize` have table-driven unit tests under `test/` (≥ 200 parser cases, incl. locale variants and quoted text) |
| Footprint | No new runtime dependency; idle CPU unchanged (reminders ride the existing tick) |

## 10. UX notes

- Empty states teach the grammar. Empty Inbox: "Press Ctrl+Alt+A anywhere
  and type Call Ana tomorrow 3pm p1". Empty Today: "Nothing due today" plus
  the count completed today.
- Completion feels instant. The row checks, strikes through and collapses
  over 250 ms; the toast offers Undo. No confirmation dialog for completing.
- Deletion of a project is the one action with a native confirmation
  (raised by main, like meeting delete), because it takes many tasks with it.
- Meeting-sourced tasks show a small meeting glyph; hovering shows the
  meeting title and date; clicking jumps to the reader with the item
  highlighted.
- Priority flags use the Todoist colour convention (red/orange/blue/none)
  via theme tokens, with the checkbox ring tinted — the most recognisable
  pattern in the category.
- The detail panel never hides the list on wide windows (two columns ≥ 1100 px),
  and replaces it on narrow ones with a Back affordance.

## 11. Success metrics

There is no telemetry, by design, so metrics are measured by local-only
counters shown to the user (Settings → Tasks → "Your stats") and by
dogfooding sessions.

| Metric | Target (after 4 weeks of use) |
|---|---|
| Median quick-add time (hotkey → Enter), measured locally | ≤ 4 s |
| Share of meetings with ≥ 1 action item where ≥ 1 item became a task | ≥ 60 % |
| Tasks completed / tasks created | ≥ 50 % |
| Days per week the Tasks feature is opened | ≥ 4 |
| Quick-add parses corrected by the user (chip removed) | ≤ 5 % |
| Data-loss incidents (store corruption without recovery) | 0 |

Qualitative: in dogfooding, the user stops keeping a second to-do list.

## 12. Release plan

| Milestone | Scope |
|---|---|
| M1 — Core list | Store + atomic writes, Inbox/Today/Upcoming/Completed, projects, sections, sub-tasks, priorities, labels, inline + global quick add (date/time/priority/project/label), keyboard map, undo, search |
| M2 — Meetings | M1–M7 (add from reader, dedupe, live state, auto-add setting), `@waiting` follow-ups |
| M3 — Time | Recurrence, deadlines, durations, reminders, digest, Trash |
| M4 — Power | Filters + query language, command palette, bulk edit, sort/group, import/export |
| v2 candidates | Board view, templates, Ollama-assisted "split this into sub-tasks" and "suggest due date" (opt-in, local), calendar-style week view with durations, `minarrador://` deep links |

Each milestone ships behind no flag — it is a local app — but M1 must land
with the durability and undo requirements complete, never deferred.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Date parser mis-reads task text ("Finish Monday deck") | Highlighted chips, click to un-parse, quoting, per-task toggle; large test table |
| Global hotkey collides with another app | Fixed choice list, registration result surfaced in red, `off` option |
| Store corruption loses the user's list | tmp+rename, `.bak`, corrupt-file quarantine, recovery notice |
| Library window grows into a monolith (`library.js` already large) | Tasks renderer in its own module(s) loaded by the page; main-side logic in pure, tested files |
| Auto-created tasks from meetings feel like spam | Default `off`; `mine` only adds items owned by the user; dedupe on re-run |
| Reminders need the app running | Login item is already on by default; missed reminders fire on next start; stated plainly in Settings |
| Scope creep toward a full Todoist clone | Non-goals list; v2 bucket; the meeting integration is the reason this exists |

## 14. Open questions

1. Should the dictation hotkey have a third mode — decide per utterance
   ("task: …" prefix routes to Tasks, otherwise paste)?
2. Nested projects: one level (proposed) or unlimited like Todoist?
3. Should completing a meeting-sourced task write anything back to the
   meeting folder (e.g. a `tasks.json` status snapshot), or does the folder
   stay pipeline-owned only? Proposed: no writes — the reader queries the store.
4. Is a custom URL protocol worth its attack surface for linking from notes,
   Outlook or OneNote?
5. Once the TypeScript migration lands, do the new pure modules live in
   `src/shared/` so renderer-side previews can reuse the parser?

## Appendix A — Quick-add grammar examples

| Input | Title | Due | Other |
|---|---|---|---|
| `Send deck to Ana tomorrow 9am p1 #Sales` | Send deck to Ana | tomorrow 09:00 | P1, #Sales |
| `Pay rent every! 1st` | Pay rent | next 1st | recurring from completion |
| `Weekly report every fri 4pm @admin` | Weekly report | next Fri 16:00 | recurring, @admin |
| `Review "Monday Group" notes next week` | Review "Monday Group" notes | next week's first day | quoted text untouched |
| `Draft proposal {jan 30} for 2h` | Draft proposal | — | deadline Jan 30, 120 min |
| `Call supplier !30m before at 3pm` | Call supplier | today 15:00 | reminder 14:30 |
