// The meeting library: a read-only view over the notes folder for the browsing
// window. Nothing here writes, deletes or renames — the folder on disk stays
// the app's public contract, and the window is a reader of it.
//
// Pure fs/path, no Electron, so it can be exercised from a plain Node test the
// way the rest of src/main is.
//
// Everything that touches the disk is asynchronous. This runs in the main
// process, which is also the thread that receives `capture:pcm` and writes the
// WAV — and a search used to read every transcript on disk with synchronous
// calls, so typing in the search box during a meeting held up the recording and
// the tray clock for as long as the read took. What is read is also cached
// (see LibraryCache), so the same archive is not re-read on every keystroke.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { FILES, SPEAKERS, normaliseTitle, parseFolderStamp, parseSpeakerLine, type Speaker } from './paths';
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
/**
 * Folders read at once while listing.
 *
 * Enough to keep the disk busy, few enough that a notes folder with thousands
 * of entries does not open thousands of handles in one go.
 */
const LIST_CONCURRENCY = 16;
/**
 * Transcript text kept in memory for search, in characters.
 *
 * An hour of meeting is ~50k characters, so this is several hundred meetings —
 * far past the point where the cache stops being the thing that matters. Past
 * it, the oldest entries are dropped and simply read again when searched.
 */
const MAX_CACHED_CHARS = 32 * 1024 * 1024;

/**
 * The files whose contents decide what a card says.
 *
 * Their size and modification time are the cache key: a pipeline run, a rename,
 * a failure note or a live caption all change one of them, and nothing else a
 * card shows can change without one of them changing too. The audio is left out
 * on purpose — it grows every second while recording, and only its existence
 * matters to a card.
 */
const CARD_FILES = [
  FILES.meta,
  FILES.notesJson,
  FILES.title,
  FILES.transcript,
  FILES.liveTranscript,
  'ERROR.txt',
  'UNPROCESSED.txt',
];

/** A parsed JSON file on disk, whose fields are only as trustworthy as whoever last edited it. */
type Loose = Record<string, unknown>;

const parseJson = (raw: string | null): Loose | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Loose) : null;
  } catch {
    // Half-written, or hand-edited into nonsense — the same as missing here.
    return null;
  }
};

/** A file's text, or null when it cannot be read. */
const readOrNull = async (file: string): Promise<string | null> => {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
};

const readJson = async (file: string): Promise<Loose | null> => parseJson(await readOrNull(file));

const readText = async (file: string): Promise<string> => (await readOrNull(file)) ?? '';

/** A field of a loosely-parsed object that is expected to be a list. */
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A field of a loosely-parsed object that is expected to be an object. */
const objectOf = (value: unknown): Loose => (value && typeof value === 'object' ? (value as Loose) : {});

/**
 * The first `bytes` of a file, so a four-hour transcript costs the same as a
 * four-minute one when all that is wanted is the opening line.
 */
async function head(file: string, bytes = PREVIEW_BYTES): Promise<string> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
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
 * Runs `fn` over `items`, at most `limit` at a time, keeping the input order.
 */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------- cache

interface CachedCard {
  signature: string;
  card: MeetingCard;
}

interface CachedText {
  signature: string;
  /** The transcript as spoken — speaker labels removed — and its lower-case twin for matching. */
  text: string;
  lower: string;
}

/**
 * What the library has already read, keyed by folder (cards) and by file
 * (transcripts), and valid for as long as the files behind it are unchanged.
 *
 * Nothing has to invalidate it by hand: every entry carries the sizes and
 * modification times it was built from, and a list compares those first — one
 * `readdir` and a few `stat`s per folder instead of reading and parsing its
 * notes, its meta and the head of its transcript. A search over a warm cache
 * reads no transcript at all. That is what `library:changed` costs now: the one
 * folder that changed is read again, and every other card comes from here.
 */
export class LibraryCache {
  readonly cards = new Map<string, CachedCard>();
  readonly texts = new Map<string, CachedText>();
  /** Characters held in `texts`, kept under MAX_CACHED_CHARS. */
  chars = 0;
  /** Counters for the tests and for the timing line main logs per list. */
  readonly stats = { cardHits: 0, cardMisses: 0, textHits: 0, textMisses: 0 };

  constructor(readonly maxChars = MAX_CACHED_CHARS) {}

  clear(): void {
    this.cards.clear();
    this.texts.clear();
    this.chars = 0;
  }

  /** Forgets every folder under `root` that `seen` does not list — ones deleted or renamed away. */
  prune(root: string, seen: Set<string>): void {
    for (const dir of this.cards.keys()) {
      if (path.dirname(dir) === root && !seen.has(dir)) this.cards.delete(dir);
    }
    for (const [file, entry] of this.texts) {
      const dir = path.dirname(file);
      if (path.dirname(dir) === root && !seen.has(dir)) {
        this.texts.delete(file);
        this.chars -= entry.text.length;
      }
    }
  }

  putText(file: string, entry: CachedText): void {
    const old = this.texts.get(file);
    if (old) {
      this.texts.delete(file);
      this.chars -= old.text.length;
    }
    // One transcript bigger than the whole budget is read each time instead.
    if (entry.text.length > this.maxChars) return;
    // A Map iterates in insertion order, so the first key is the oldest read.
    for (const [key, value] of this.texts) {
      if (this.chars + entry.text.length <= this.maxChars) break;
      this.texts.delete(key);
      this.chars -= value.text.length;
    }
    this.texts.set(file, entry);
    this.chars += entry.text.length;
  }
}

/** The cache main uses; tests pass their own. */
export const defaultCache = new LibraryCache();

// -------------------------------------------------------------------- folders

/**
 * Resolves a meeting id to its folder, refusing anything that is not a direct
 * child of the notes folder.
 *
 * The id arrives from a renderer, and every other function here takes one, so
 * this is the single place that decides which paths the window can reach. A
 * nested path, a `..`, or an absolute path all fail the same test: their parent
 * is not the notes folder.
 *
 * Synchronous on purpose: it is one stat, and every caller in main needs the
 * answer before it can decide anything else.
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

/** What a folder holds, read once per list: its file names, and a key for its card. */
interface FolderState {
  names: Set<string>;
  signature: string;
}

/**
 * Lists a folder and stats the files a card depends on.
 *
 * @returns null when the folder cannot be read at all
 */
async function folderState(dir: string): Promise<FolderState | null> {
  let names: Set<string>;
  try {
    names = new Set(await fsp.readdir(dir));
  } catch {
    return null;
  }
  const parts = await Promise.all(
    CARD_FILES.filter((name) => names.has(name)).map(async (name) => {
      try {
        const st = await fsp.stat(path.join(dir, name));
        return `${name}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${name}:?`;
      }
    }),
  );
  // Existence alone for the rest of what a card reports.
  for (const name of [FILES.audio, FILES.notes, FILES.pdf]) if (names.has(name)) parts.push(name);
  return { names, signature: parts.join('|') };
}

/**
 * Whether a folder in the notes directory is a meeting at all.
 *
 * The notes folder belongs to the user, who may well keep other things in it.
 * A meeting is recognised by its artefacts rather than by its name, so a
 * renamed folder still shows up and an unrelated one never does.
 */
const isMeeting = (names: Set<string>): boolean => [FILES.audio, FILES.notesJson, FILES.meta].some((f) => names.has(f));

/**
 * The best transcript a folder holds, and which one it is.
 *
 * transcript.txt is the pipeline's careful pass and always wins. The live
 * preview is the fallback, and it is the reason a meeting whose pipeline never
 * ran is still readable at all — it was written line by line while the meeting
 * happened, so it exists exactly in the case where nothing else does.
 */
function pickTranscript(dir: string, names: Set<string>): { file: string; source: TranscriptSource } {
  if (names.has(FILES.transcript)) return { file: path.join(dir, FILES.transcript), source: 'pipeline' };
  if (names.has(FILES.liveTranscript)) return { file: path.join(dir, FILES.liveTranscript), source: 'live' };
  return { file: '', source: 'none' };
}

/** {@link pickTranscript} for a caller that has not listed the folder. */
export function transcriptSource(dir: string): { file: string; source: TranscriptSource } {
  const names = new Set([FILES.transcript, FILES.liveTranscript].filter((f) => fs.existsSync(path.join(dir, f))));
  return pickTranscript(dir, names);
}

/** An ISO string for whatever the meta file happened to store, or null. */
function isoOr(value: unknown): string | null {
  const d = new Date((value ?? NaN) as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Builds one card from disk, uncached.
 *
 * @param dir absolute meeting folder
 */
async function buildCard(dir: string, names: Set<string>): Promise<MeetingCard> {
  const id = path.basename(dir);
  const [metaRaw, notes, titleRaw] = await Promise.all([
    names.has(FILES.meta) ? readJson(path.join(dir, FILES.meta)) : null,
    names.has(FILES.notesJson) ? readJson(path.join(dir, FILES.notesJson)) : null,
    names.has(FILES.title) ? readText(path.join(dir, FILES.title)) : '',
  ]);
  const meta = metaRaw ?? {};
  const has = (name: string): boolean => names.has(name);

  // meta.json is written twice — once when the audio closes, once when the
  // pipeline finishes — so it is the best answer when present. The folder name
  // is the fallback, and it is a good one: the app wrote it at the same moment.
  let startedAt = isoOr(meta.startedAt) ?? isoOr(parseFolderStamp(id));
  if (!startedAt) {
    try {
      startedAt = (await fsp.stat(dir)).mtime.toISOString();
    } catch {
      startedAt = new Date(0).toISOString();
    }
  }

  const transcript = pickTranscript(dir, names);
  const summary = arrayOf(notes?.summary).filter((s): s is string => typeof s === 'string');
  const preview = clip(spoken(summary[0] ?? (transcript.file ? await head(transcript.file) : '')));

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
  const chosen = normaliseTitle(titleRaw);
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

/** A card from the cache when its files are unchanged, from disk otherwise. */
async function cardFor(dir: string, state: FolderState, cache: LibraryCache): Promise<MeetingCard> {
  const hit = cache.cards.get(dir);
  if (hit && hit.signature === state.signature) {
    cache.stats.cardHits++;
    return hit.card;
  }
  cache.stats.cardMisses++;
  const card = await buildCard(dir, state.names);
  cache.cards.set(dir, { signature: state.signature, card });
  return card;
}

/**
 * What one meeting looks like in the list: enough to render a card and decide
 * whether to open it, and nothing that costs a full file read.
 *
 * @param dir absolute meeting folder
 * @returns null when the folder cannot be read
 */
export async function describeMeeting(dir: string, cache: LibraryCache = defaultCache): Promise<MeetingCard | null> {
  const state = await folderState(dir);
  return state ? { ...(await cardFor(dir, state, cache)) } : null;
}

/** A transcript as spoken, from the cache when the file is unchanged. */
async function spokenTranscript(file: string, cache: LibraryCache): Promise<CachedText | null> {
  if (!file) return null;
  let signature: string;
  try {
    const st = await fsp.stat(file);
    signature = `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = cache.texts.get(file);
  if (hit && hit.signature === signature) {
    cache.stats.textHits++;
    return hit;
  }
  cache.stats.textMisses++;
  const text = spoken(await readText(file));
  const entry = { signature, text, lower: text.toLowerCase() };
  cache.putText(file, entry);
  return entry;
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
async function findInMeeting(
  dir: string,
  names: Set<string>,
  card: MeetingCard,
  query: string,
  cache: LibraryCache,
): Promise<{ count: number; snippet: string } | null> {
  const needle = query.toLowerCase();
  const transcript = await spokenTranscript(pickTranscript(dir, names).file, cache);
  const haystacks = [
    { text: transcript?.text ?? '', lower: transcript?.lower ?? '', quote: true },
    { text: card.title, lower: card.title.toLowerCase(), quote: false },
    { text: card.preview, lower: card.preview.toLowerCase(), quote: false },
  ];

  let count = 0;
  let snippet = '';
  for (const { text, lower, quote } of haystacks) {
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
 * with where it was found. The cards handed back are copies, so a caller (or a
 * search annotating one) never edits what the cache holds.
 */
export async function listMeetings(
  notesDir: string,
  { query = '', cache = defaultCache }: { query?: unknown; cache?: LibraryCache } = {},
): Promise<MeetingCard[]> {
  const root = path.resolve(notesDir);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    // No notes folder yet: a first run, or a configured folder that has gone
    // missing. Both are an empty library rather than an error.
    return [];
  }

  const needle = String(query ?? '').trim().slice(0, MAX_QUERY);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  const seen = new Set<string>();

  const found = await mapPool(dirs, LIST_CONCURRENCY, async (dir): Promise<MeetingCard | null> => {
    const state = await folderState(dir);
    if (!state || !isMeeting(state.names)) return null;
    seen.add(dir);

    const card = { ...(await cardFor(dir, state, cache)) };
    if (needle) {
      const hit = await findInMeeting(dir, state.names, card, needle, cache);
      if (!hit) return null;
      card.matches = hit.count;
      card.preview = hit.snippet;
    }
    return card;
  });
  // A folder that is no longer here (deleted, renamed, stopped being a
  // meeting) should not keep its transcript in memory for the rest of the day.
  cache.prune(root, seen);

  const meetings = found.filter((m): m is MeetingCard => m !== null);
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
async function transcriptLines(dir: string, file: string, source: TranscriptSource): Promise<TranscriptLine[]> {
  const parsed = source === 'pipeline' ? await readJson(path.join(dir, FILES.transcriptJson)) : null;
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

  if (!file) return [];
  return (await readText(file))
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
async function errorSummary(dir: string): Promise<string> {
  const raw = await head(path.join(dir, 'ERROR.txt'), PREVIEW_BYTES);
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
export async function readMeeting(
  notesDir: string,
  id: unknown,
  cache: LibraryCache = defaultCache,
): Promise<MeetingDetail | null> {
  const dir = meetingDir(notesDir, id);
  if (!dir) return null;
  const state = await folderState(dir);
  if (!state || !isMeeting(state.names)) return null;

  const card = await cardFor(dir, state, cache);
  const transcript = pickTranscript(dir, state.names);
  const [notesRaw, metaRaw, lines, error] = await Promise.all([
    readJson(path.join(dir, FILES.notesJson)),
    readJson(path.join(dir, FILES.meta)),
    transcriptLines(dir, transcript.file, transcript.source),
    card.status === 'failed' ? errorSummary(dir) : Promise.resolve(''),
  ]);
  const notes = notesRaw ?? {};
  const meta = metaRaw ?? {};
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
    transcript: lines,
    // What went wrong, quoted rather than pointed at: "ERROR.txt says why" asks
    // someone to leave the window to read one sentence, and that sentence is
    // almost always the reason the Generate notes button beneath it will fail
    // too — usually Ollama being down.
    error,
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
