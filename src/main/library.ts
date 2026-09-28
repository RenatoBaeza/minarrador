// The meeting library: a read-only view over the notes folder for the browsing
// window. Nothing here writes, deletes or renames — the folder on disk stays
// the app's public contract, and the window is a reader of it.
//
// Pure fs/path, no Electron, so it can be exercised from a plain Node test the
// way the rest of src/main is.

import fs from 'node:fs';
import path from 'node:path';

import { FILES, SPEAKERS, parseFolderStamp, parseSpeakerLine, readTitle, type Speaker } from './paths';
import type {
  ActionItem,
  Decision,
  MeetingCard,
  MeetingDetail,
  MeetingStatus,
  TranscriptLine,
  TranscriptSource,
} from '../shared/types';

/** How much of a meeting rides along in the list payload, per card. */
const PREVIEW_CHARS = 180;
/** Bytes of transcript read for a preview when there are no notes to quote. */
const PREVIEW_BYTES = 4096;
/** Characters of context kept either side of a search hit. */
const SNIPPET_PAD = 70;
/** Longest query worth honouring; past this it is a paste, not a search. */
const MAX_QUERY = 120;
/** How much of ERROR.txt the reader quotes before it stops being a sentence. */
const ERROR_CHARS = 400;

/** A parsed JSON file on disk, whose fields are only as trustworthy as whoever last edited it. */
type Loose = Record<string, unknown>;

const readJson = (file: string): Loose | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Loose) : null;
  } catch {
    // Missing, half-written, or hand-edited into nonsense — all the same here.
    return null;
  }
};

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** A field of a loosely-parsed object that is expected to be a list. */
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A field of a loosely-parsed object that is expected to be an object. */
const objectOf = (value: unknown): Loose => (value && typeof value === 'object' ? (value as Loose) : {});

/**
 * The first `bytes` of a file, so a four-hour transcript costs the same as a
 * four-minute one when all that is wanted is the opening line.
 */
function head(file: string, bytes = PREVIEW_BYTES): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

const clip = (text: unknown, chars = PREVIEW_CHARS): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
};

/**
 * A speaker-labelled transcript with the labels taken back off.
 *
 * Everything that treats a transcript as text — the card preview, the search —
 * wants what was said, not how the file marks up who said it. Leaving them in
 * would also make searching for "you" match every line of every two-channel
 * meeting, and report the count as though somebody had said it.
 */
const SPEAKER_PREFIX = new RegExp(`^(?:${Object.values(SPEAKERS).join('|')}): `, 'gm');
const spoken = (text: unknown): string => String(text ?? '').replace(SPEAKER_PREFIX, '');

/**
 * Resolves a meeting id to its folder, refusing anything that is not a direct
 * child of the notes folder.
 *
 * The id arrives from a renderer, and every other function here takes one, so
 * this is the single place that decides which paths the window can reach. A
 * nested path, a `..`, or an absolute path all fail the same test: their parent
 * is not the notes folder.
 *
 * @returns the absolute folder, or null when the id is not one
 */
export function meetingDir(notesDir: string, id: unknown): string | null {
  // A bare folder name, and nothing that has to be interpreted as a path: the
  // window lists names, so anything else is a page asking a question it was
  // never given the vocabulary for.
  if (typeof id !== 'string' || !id.trim() || path.basename(id) !== id) return null;
  const root = path.resolve(notesDir);
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}

/**
 * The best transcript a folder holds, and which one it is.
 *
 * transcript.txt is the pipeline's careful pass and always wins. The live
 * preview is the fallback, and it is the reason a meeting whose pipeline never
 * ran is still readable at all — it was written line by line while the meeting
 * happened, so it exists exactly in the case where nothing else does.
 */
export function transcriptSource(dir: string): { file: string; source: TranscriptSource } {
  const full = path.join(dir, FILES.transcript);
  if (fs.existsSync(full)) return { file: full, source: 'pipeline' };
  const live = path.join(dir, FILES.liveTranscript);
  if (fs.existsSync(live)) return { file: live, source: 'live' };
  return { file: '', source: 'none' };
}

/**
 * Whether a folder in the notes directory is a meeting at all.
 *
 * The notes folder belongs to the user, who may well keep other things in it.
 * A meeting is recognised by its artefacts rather than by its name, so a
 * renamed folder still shows up and an unrelated one never does.
 */
const isMeeting = (dir: string): boolean =>
  [FILES.audio, FILES.notesJson, FILES.meta].some((f) => fs.existsSync(path.join(dir, f)));

/** An ISO string for whatever the meta file happened to store, or null. */
function isoOr(value: unknown): string | null {
  const d = new Date((value ?? NaN) as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What one meeting looks like in the list: enough to render a card and decide
 * whether to open it, and nothing that costs a full file read.
 *
 * @param dir absolute meeting folder
 */
export function describeMeeting(dir: string): MeetingCard {
  const id = path.basename(dir);
  const meta = readJson(path.join(dir, FILES.meta)) ?? {};
  const notes = readJson(path.join(dir, FILES.notesJson));
  const has = (name: string): boolean => fs.existsSync(path.join(dir, name));

  // meta.json is written twice — once when the audio closes, once when the
  // pipeline finishes — so it is the best answer when present. The folder name
  // is the fallback, and it is a good one: the app wrote it at the same moment.
  let startedAt = isoOr(meta.startedAt) ?? isoOr(parseFolderStamp(id));
  if (!startedAt) {
    try {
      startedAt = fs.statSync(dir).mtime.toISOString();
    } catch {
      startedAt = new Date(0).toISOString();
    }
  }

  const transcript = transcriptSource(dir);
  const summary = arrayOf(notes?.summary).filter((s): s is string => typeof s === 'string');
  const preview = clip(spoken(summary[0] ?? (transcript.file ? head(transcript.file) : '')));

  const failed = has('ERROR.txt');
  const status: MeetingStatus = notes
    ? 'ready'
    : failed
      ? 'failed'
      : has('UNPROCESSED.txt')
        ? 'unprocessed'
        : 'pending';

  // A title someone typed beats the one a model guessed at, always. Otherwise
  // every meeting is called whatever the summariser made of it, and an archive
  // of "Weekly Sync Discussion" is an archive nobody can find anything in.
  const chosen = readTitle(dir);
  const generated = typeof notes?.title === 'string' && notes.title.trim() ? notes.title.trim() : '';

  return {
    id,
    title: chosen || generated || 'Untitled recording',
    generatedTitle: generated,
    renamed: Boolean(chosen),
    startedAt,
    durationSeconds:
      typeof meta.durationSeconds === 'number' && Number.isFinite(meta.durationSeconds) ? meta.durationSeconds : 0,
    status,
    preview,
    decisions: Array.isArray(notes?.decisions) ? notes.decisions.length : 0,
    actionItems: Array.isArray(notes?.action_items) ? notes.action_items.length : 0,
    transcriptSource: transcript.source,
    files: {
      audio: has(FILES.audio),
      transcript: transcript.source !== 'none',
      notes: has(FILES.notes),
      pdf: has(FILES.pdf),
    },
  };
}

/**
 * Finds `query` in a meeting and returns a quotable hit.
 *
 * The transcript is the only artefact read in full, and only while searching —
 * it is also the only place most of what was said exists, so a library that
 * could not search it would only ever find meetings by their title.
 *
 * @returns null when nothing matched
 */
function findInMeeting(dir: string, card: MeetingCard, query: string): { count: number; snippet: string } | null {
  const needle = query.toLowerCase();
  const transcript = spoken(readText(transcriptSource(dir).file));
  const haystacks = [
    { text: transcript, quote: true },
    { text: card.title, quote: false },
    { text: card.preview, quote: false },
  ];

  let count = 0;
  let snippet = '';
  for (const { text, quote } of haystacks) {
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    if (at === -1) continue;
    if (!snippet) {
      snippet = quote
        ? clip(
            `${at > SNIPPET_PAD ? '…' : ''}${text.slice(Math.max(0, at - SNIPPET_PAD), at + needle.length + SNIPPET_PAD)}…`,
            PREVIEW_CHARS,
          )
        : card.preview;
    }
    while (at !== -1) {
      count++;
      at = lower.indexOf(needle, at + needle.length);
    }
  }
  return count ? { count, snippet } : null;
}

/**
 * Every meeting in the notes folder, newest first.
 *
 * `query` filters by title and transcript text and annotates each survivor
 * with where it was found.
 */
export function listMeetings(notesDir: string, { query = '' }: { query?: unknown } = {}): MeetingCard[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(notesDir, { withFileTypes: true });
  } catch {
    // No notes folder yet: a first run, or a configured folder that has gone
    // missing. Both are an empty library rather than an error.
    return [];
  }

  const needle = String(query ?? '').trim().slice(0, MAX_QUERY);
  const meetings: MeetingCard[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(notesDir, entry.name);
    if (!isMeeting(dir)) continue;

    const card = describeMeeting(dir);
    if (needle) {
      const hit = findInMeeting(dir, card, needle);
      if (!hit) continue;
      card.matches = hit.count;
      card.preview = hit.snippet;
    }
    meetings.push(card);
  }

  // Descending by start time, with the folder name breaking a tie — two
  // meetings in the same second only differ by the `-2` suffix.
  meetings.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  return meetings;
}

const asSpeaker = (value: unknown): Speaker =>
  typeof value === 'string' && Object.hasOwn(SPEAKERS, value) ? (value as Speaker) : '';

/**
 * Splits a transcript into the lines the reader shows.
 *
 * transcript.json carries the chunk boundaries the pipeline used, which is what
 * gives each line a timestamp. Without it — a folder from an older version, one
 * where only the .txt survived, or one where the pipeline never ran and the live
 * preview is all there is — the file's own line breaks stand in, untimed.
 *
 * A line also knows which side of the conversation it came from, when the
 * recording kept the two apart. transcript.json carries that as a field;
 * everywhere else it is a prefix on the line, which is read back off here so
 * the reader can render it as a speaker rather than as part of the sentence.
 *
 * @param source which file is being read; the live preview writes one caption
 *   per line, the pipeline one paragraph per chunk
 */
function transcriptLines(dir: string, file: string, source: TranscriptSource): TranscriptLine[] {
  const parsed = source === 'pipeline' ? readJson(path.join(dir, FILES.transcriptJson)) : null;
  const segments = Array.isArray(parsed?.segments) ? (parsed.segments as unknown[]) : null;
  if (segments) {
    return segments
      .map(objectOf)
      .filter((s): s is Loose & { text: string } => typeof s.text === 'string' && Boolean(s.text.trim()))
      .map((s) => ({
        startSeconds: typeof s.startSeconds === 'number' && Number.isFinite(s.startSeconds) ? s.startSeconds : null,
        speaker: asSpeaker(s.speaker),
        text: s.text.trim(),
      }));
  }

  return readText(file)
    .split(source === 'live' ? /\n+/ : /\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({ startSeconds: null, ...parseSpeakerLine(block) }));
}

/**
 * The one sentence in ERROR.txt worth putting in the reader.
 *
 * The file is written as "Processing failed at <when>", a blank line, then the
 * stack. The first line of that stack is what went wrong; the frames under it
 * belong in the file rather than in a window someone is reading notes in.
 */
function errorSummary(dir: string): string {
  const raw = head(path.join(dir, 'ERROR.txt'), PREVIEW_BYTES);
  if (!raw.trim()) return '';
  const body = raw.split(/\n\s*\n/).slice(1).join('\n').trim() || raw;
  const first = body.split('\n').find((line) => line.trim()) ?? '';
  return clip(first.trim().replace(/^Error:\s*/, ''), ERROR_CHARS);
}

/**
 * Everything the reader pane shows for one meeting.
 *
 * Built from notes.json rather than notes.md: the JSON is the structured form
 * the pipeline actually produced, and re-parsing the markdown back out of it
 * would only invent a second place for the shape to drift.
 *
 * @returns null when the id does not name a meeting folder
 */
export function readMeeting(notesDir: string, id: unknown): MeetingDetail | null {
  const dir = meetingDir(notesDir, id);
  if (!dir || !isMeeting(dir)) return null;

  const card = describeMeeting(dir);
  const notes = readJson(path.join(dir, FILES.notesJson)) ?? {};
  const meta = readJson(path.join(dir, FILES.meta)) ?? {};
  const transcript = transcriptSource(dir);
  const sources = objectOf(meta.sources);
  const models = objectOf(meta.models);

  const decisions: Decision[] = arrayOf(notes.decisions)
    .map(objectOf)
    .map((d) => ({ decision: String(d.decision ?? ''), context: String(d.context ?? '') }))
    .filter((d) => d.decision);
  const actionItems: ActionItem[] = arrayOf(notes.action_items)
    .map(objectOf)
    .map((a) => ({ task: String(a.task ?? ''), owner: String(a.owner ?? ''), due: String(a.due ?? '') }))
    .filter((a) => a.task);

  return {
    ...card,
    summary: arrayOf(notes.summary).filter((s): s is string => typeof s === 'string' && Boolean(s.trim())),
    decisions,
    actionItems,
    transcript: transcriptLines(dir, transcript.file, transcript.source),
    // What went wrong, quoted rather than pointed at: "ERROR.txt says why" asks
    // someone to leave the window to read one sentence, and that sentence is
    // almost always the reason the Generate notes button beneath it will fail
    // too — usually Ollama being down.
    error: card.status === 'failed' ? errorSummary(dir) : '',
    sources: {
      mic: Boolean(sources.mic),
      system: Boolean(sources.system),
    },
    /** Names for the two sides, so the reader never has to know the channel scheme. */
    speakers: SPEAKERS,
    models: {
      transcribe: String(models.transcribe ?? ''),
      summary: String(models.summary ?? ''),
    },
    // No folder path. The reader used to print one, in the instruction to run
    // `npm run pipeline` by hand that the Generate notes button replaced — and
    // the window opens files by naming a target, so it has no other use for one.
  };
}

/**
 * Files the window is allowed to hand to the shell, by name.
 *
 * `transcript` is a list because a meeting can hold either of two, and the
 * reader offers the same button for both — the pipeline's pass when it exists,
 * the live preview when it is all there is.
 */
export const OPEN_TARGETS: Readonly<Record<string, readonly string[]>> = {
  folder: [],
  pdf: [FILES.pdf],
  notes: [FILES.notes],
  transcript: [FILES.transcript, FILES.liveTranscript],
  audio: [FILES.audio],
};

/**
 * Resolves an "open this" request to a path, or null if it names nothing real.
 *
 * The renderer picks from {@link OPEN_TARGETS} rather than sending a path, so
 * the worst a compromised page can do is open a meeting file that already
 * exists — and the id still has to survive {@link meetingDir}.
 */
export function openTarget(notesDir: string, id: unknown, target: unknown): string | null {
  const dir = meetingDir(notesDir, id);
  // hasOwn, not `in`: every object inherits a 'constructor', and looking one up
  // would hand path.join a function instead of a file name.
  if (!dir || typeof target !== 'string' || !Object.hasOwn(OPEN_TARGETS, target)) return null;
  const names = OPEN_TARGETS[target];
  if (!names.length) return fs.existsSync(dir) ? dir : null;
  return names.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file)) ?? null;
}
