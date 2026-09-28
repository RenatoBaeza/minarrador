import path from 'node:path';
import fs from 'node:fs';

import { electronPath } from './electron-lazy';
import type { Speaker } from '../shared/types';

/**
 * The repository root — or, packaged, the root of app.asar.
 *
 * Compiled code runs from out/src/main, three levels below it, while assets/
 * and vendor/ stay where they are in the tree. Every path to either is built
 * from this one constant, so the depth is written down exactly once.
 */
export const APP_ROOT = path.join(__dirname, '..', '..', '..');

/** Slug used for the per-meeting folder name: 2026-08-11_14-32-05. */
export function folderStamp(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/**
 * Inverse of folderStamp: the local time a folder name encodes, or null when
 * the name was not written by this app. Tolerates the `-2` suffix two meetings
 * in the same second get.
 *
 * Reconstructing the date is not enough on its own — `Date` happily rolls
 * `2026-13-45` over into the following year — so the parse is only accepted
 * when it stamps back to the name it came from.
 *
 * @param name folder name, e.g. '2026-08-11_14-32-05'
 */
export function parseFolderStamp(name: unknown): Date | null {
  const text = String(name ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return folderStamp(date) === text.slice(0, 19) ? date : null;
}

/** Creates and returns a fresh folder for one recording. */
export function createMeetingDir(notesDir: string, date: Date = new Date()): string {
  let dir = path.join(notesDir, folderStamp(date));
  let n = 2;
  while (fs.existsSync(dir)) dir = path.join(notesDir, `${folderStamp(date)}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * What a channel of a two-channel recording is called in a transcript.
 *
 * The keys are the channels the capture graph produces — left is the
 * microphone, right is everything the system played — and the values are what
 * goes in front of a line. Kept here with the file names because that is what
 * this is: part of the format of transcript.txt and live-transcript.txt, which
 * are read back by the library and by whoever opens the folder.
 */
export const SPEAKERS = { mic: 'You', system: 'Others' } as const;

export type { Speaker };

const isSpeaker = (value: unknown): value is keyof typeof SPEAKERS =>
  typeof value === 'string' && Object.hasOwn(SPEAKERS, value);

/** One transcript line, labelled when it is known who said it. */
export const speakerLine = (speaker: unknown, text: unknown): string =>
  isSpeaker(speaker) ? `${SPEAKERS[speaker]}: ${text}` : String(text);

/**
 * Pulls a speaker label back off a line written by {@link speakerLine}.
 *
 * Only needed for the live preview, which is a flat text file — the pipeline's
 * transcript keeps the speaker as a field in transcript.json.
 *
 * @returns `speaker` is '' when unlabelled
 */
export function parseSpeakerLine(line: unknown): { speaker: Speaker; text: string } {
  const text = String(line ?? '');
  for (const [speaker, label] of Object.entries(SPEAKERS) as [keyof typeof SPEAKERS, string][]) {
    if (text.startsWith(`${label}: `)) return { speaker, text: text.slice(label.length + 2) };
  }
  return { speaker: '', text };
}

export const FILES = {
  audio: 'audio.wav',
  transcript: 'transcript.txt',
  transcriptJson: 'transcript.json',
  /**
   * The live preview, kept as it is produced.
   *
   * Rough by construction and always superseded by `transcript`, which is a
   * separate careful pass over the saved WAV — but it is written line by line
   * during the meeting, so it is the one piece of text that survives a pipeline
   * that never ran. That turns the worst case from "a WAV" into "a rough
   * transcript", which is why it is a first-class artefact rather than a log.
   */
  liveTranscript: 'live-transcript.txt',
  notes: 'notes.md',
  notesJson: 'notes.json',
  html: 'notes.html',
  pdf: 'notes.pdf',
  meta: 'meta.json',
  /**
   * A title the user typed, which wins over the one the model produced.
   *
   * Its own file rather than a field in notes.json or meta.json because both of
   * those are rewritten every time the notes are generated again: a rename
   * would survive until the first re-run and then quietly revert. Nothing in
   * the pipeline touches this one.
   */
  title: 'title.txt',
} as const;

/** Longest title worth keeping; past this it is a paragraph, not a name. */
export const MAX_TITLE = 120;

/**
 * A user-typed title, flattened to the one line a rail card can show.
 *
 * @returns '' when there is nothing left, which means "use the model's"
 */
export const normaliseTitle = (text: unknown): string =>
  String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

/** The title someone typed over this meeting, or '' if they never did. */
export function readTitle(dir: string): string {
  try {
    return normaliseTitle(fs.readFileSync(path.join(dir, FILES.title), 'utf8'));
  } catch {
    // No override, which is the normal case.
    return '';
  }
}

export const userData = (): string => electronPath('userData');
