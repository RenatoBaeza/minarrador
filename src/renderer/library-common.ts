// What every section of the library window shares: the page's fixed elements,
// the view state, the formatters, and the DOM helpers that keep model-written
// text out of markup. Every string rendered anywhere in this window has been
// through either a language model or a hand-edited file, so it reaches the DOM
// as text, never as markup — el() and highlighted() are how.

import type { LibraryActivity, MeetingCard, MeetingDetail, SettingsState } from '../shared/types';
import type { LibrarySection } from './bridges';

/** An element the page's markup guarantees; a missing one is a broken build, not a state. */
export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export const listEl = byId('list');
export const countEl = byId('count');
export const searchingEl = byId('searching');
export const readerEl = byId('reader');
export const placeholder = byId('placeholder');
export const queryEl = byId<HTMLInputElement>('query');
export const recordEl = byId<HTMLButtonElement>('record');
export const recordLabelEl = byId('record-label');
export const recordGlyphEl = recordEl.querySelector('.record-glyph') as HTMLElement;
export const navEls = [...document.querySelectorAll<HTMLButtonElement>('.nav-item')];
export const sectionNameEl = byId('section-name');
export const healthEl = byId('health');

/** The sidebar's features, by the mode each one puts the window in. */
export const SECTIONS: Record<LibrarySection, string> = {
  reader: 'Recording',
  quickcopy: 'Quick copy',
  disk: 'Disk usage',
  todos: 'To-do',
  settings: 'Settings',
};

export const isSection = (mode: unknown): mode is LibrarySection => typeof mode === 'string' && Object.hasOwn(SECTIONS, mode);

export interface MicTestEls {
  bar: HTMLElement;
  note: HTMLElement;
  button: HTMLButtonElement;
}

export interface View {
  meetings: MeetingCard[];
  selected: string | null;
  meeting: MeetingDetail | null;
  query: string;
  tab: 'notes' | 'transcript';
  mode: LibrarySection;
  settings: SettingsState | null;
  whisperPick: string;
  renaming: boolean;
  activity: LibraryActivity;
  recordWanted: boolean | null;
  micTest: { testing: boolean; level: number; note: string };
  micTestEls: MicTestEls | null;
}

export const view: View = {
  /** Cards currently in the rail, newest first. */
  meetings: [],
  /** Folder name of the open meeting, or null. */
  selected: null,
  /** The meeting the reader is showing, kept so settings can be closed back onto it. */
  meeting: null,
  /** The query the rail was built from, reused to highlight the reader. */
  query: '',
  /** 'notes' | 'transcript' — sticky across meetings, the way a reader expects. */
  tab: 'notes',
  /**
   * Which feature the sidebar has open: 'reader' (Recording — the rail and the
   * meeting it has open), 'quickcopy', 'disk', 'todos' or 'settings'. Only the first shows the rail.
   */
  mode: 'reader',
  /** settingsState() from the main process, or null before it has been asked for. */
  settings: null,
  /**
   * Which GGML weights the whisper.cpp install button would fetch.
   *
   * Lives here rather than in settings: nothing has been chosen until the
   * download finishes, and writing a whisperModel that is not on disk is
   * exactly the state the settings pane exists to mark in red.
   */
  whisperPick: 'base',
  /**
   * True while the title is an open text box.
   *
   * The reader redraws whenever the folder changes, and a pipeline finishing
   * elsewhere would otherwise throw away half a typed title.
   */
  renaming: false,
  activity: { recordingId: null, elapsed: 0, paused: false, liveEngine: '', processingIds: [], processing: [] },
  /**
   * What the last record click asked for, until the rail confirms it happened.
   * Recording is started and stopped in the main process, so this window learns
   * the result the same way it learns about a recording started from the tray.
   */
  recordWanted: null,
  /**
   * The microphone test in the settings pane: whether one is running, the last
   * level the dictation worker reported, and the note under the meter.
   */
  micTest: { testing: false, level: 0, note: '' },
  /** The meter's DOM, so a level can move the bar without re-rendering the pane. */
  micTestEls: null,
};

// ----------------------------------------------------------------- formatting

export const fmtDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
};

/** mm:ss for a transcript gutter, growing an hours field once there is one. */
export const fmtClock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
};

export const fmtTime = (date: Date): string => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * The heading a meeting sits under. Recent days get their name, because that is
 * how someone looking for "the one from Tuesday" thinks about it; anything
 * older is only ever found by month.
 */
export function dateGroup(date: Date): string {
  const days = Math.round((startOfDay(new Date()).getTime() - startOfDay(date).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  if (date.getFullYear() === new Date().getFullYear()) return date.toLocaleDateString([], { month: 'long' });
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string | number,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: this string came out of a language model.
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/**
 * Text with every occurrence of the active query wrapped in a <mark>.
 *
 * Built by splitting on index rather than by replacing into HTML — the whole
 * point of highlighting a transcript is that its content is untrusted.
 *
 * @returns {DocumentFragment}
 */
export function highlighted(text: string, query: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const needle = query.trim().toLowerCase();
  if (!needle) {
    frag.append(document.createTextNode(text));
    return frag;
  }

  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) frag.append(document.createTextNode(text.slice(from, at)));
    frag.append(el('mark', '', text.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  frag.append(document.createTextNode(text.slice(from)));
  return frag;
}


/**
 * Stroke paths for the side panel's icons, drawn on a 24-unit grid. Fixed
 * strings built with createElementNS — nothing here is ever parsed as markup.
 */
export const ICONS: Record<string, string[]> = {
  pdf: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6M9 17h4'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  audio: ['M8 5v14l11-7z'],
  copy: ['M8 8h12v12H8z', 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'],
  check: ['M5 12l5 5L20 7'],
  list: ['M9 6h11M9 12h11M9 18h11', 'M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  rename: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  files: ['M8 3h7l4 4v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M4 7v12a2 2 0 0 0 2 2h9'],
  reveal: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
};

export function icon(name: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Switches the sidebar feature. The switch itself lives in library.ts, which
 * owns the sidebar; a section that needs to send the window elsewhere — the
 * empty archive's "Open settings", the settings pane's "Edit quick copy…" —
 * goes through here rather than importing the page that imports it.
 */
let navigator: (mode: string) => Promise<void> = async () => {};

export const setNavigator = (fn: (mode: string) => Promise<void>): void => {
  navigator = fn;
};

export const navigate = (mode: string): Promise<void> => navigator(mode);
