import { Tray, Menu, nativeImage, clipboard, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';

import { APP_ROOT } from './paths';
import type { Snippet } from './snippets';

const ASSETS = path.join(APP_ROOT, 'assets');

type IconState = 'idle' | 'recording' | 'processing';

function icon(state: IconState): Electron.NativeImage {
  const img = nativeImage.createFromPath(path.join(ASSETS, `tray-${state}.png`));
  img.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(path.join(ASSETS, `tray-${state}@2x.png`)).toPNG(),
  });
  return img;
}

export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** How much of a shorthand fits on one menu row before it starts crowding the menu. */
const SNIPPET_LABEL_CHARS = 44;

/**
 * The one-line name a shorthand wears in the menu.
 *
 * Falls back to the text itself, flattened, for anyone who could not be
 * bothered to name it — which is most of them.
 */
export function snippetLabel(snippet: Snippet): string {
  const raw = (snippet.label || snippet.text).replace(/\s+/g, ' ').trim();
  const short = raw.length > SNIPPET_LABEL_CHARS ? `${raw.slice(0, SNIPPET_LABEL_CHARS - 1)}…` : raw;
  // Windows reads '&' in a menu label as a mnemonic and eats it, so "R&D" would
  // show up as "RD" with a underlined D.
  return short.replace(/&/g, '&&');
}

/** Everything the menu can do, injected so this file stays a pure view. */
export interface TrayActions {
  openLibrary(): void;
  openQuickCopy(): void;
  startRecording(): void;
  stopRecording(): void;
  toggleDictation(): void;
  quit(): void;
}

export interface TrayView {
  state: 'idle' | 'recording' | 'processing';
  /** Seconds recorded so far. */
  elapsed: number;
  /** Human-readable pipeline progress. */
  progress: string;
  /** The folder being recorded into, if any. */
  currentDir?: string | null;
  /** Quick-copy shorthands. */
  snippets?: Snippet[];
  /** The recording shortcut, '' when off. */
  hotkey?: string;
  dictation?: { active: boolean; transcribing: boolean; hotkey: string };
}

/**
 * Owns the tray icon and its menu. All behaviour is injected so this file stays
 * a pure view over app state.
 */
export class AppTray {
  readonly actions: TrayActions;
  tray: Tray | null;
  lastIconState: IconState;

  constructor(actions: TrayActions) {
    this.actions = actions;
    this.tray = new Tray(icon('idle'));
    this.tray.setToolTip('Minarrador');
    // Left-click opens the meeting library — the app's front door, and the one
    // surface with somewhere to go. Right-click keeps the menu, which is where
    // recording lives, so the two clicks stay meaningfully different.
    //
    // Nothing is bound to double-click: Windows sends a plain click first, so a
    // second action here would always arrive with the library already opening.
    this.tray.on('click', () => this.actions.openLibrary());
    this.lastIconState = 'idle';
  }

  update(view: TrayView): void {
    const {
      state,
      elapsed,
      progress,
      snippets = [],
      hotkey = '',
      dictation = { active: false, transcribing: false, hotkey: '' },
    } = view;
    const a = this.actions;
    const tray = this.tray;
    if (!tray) return;

    const iconState: IconState = state === 'recording' ? 'recording' : state === 'processing' ? 'processing' : 'idle';
    if (iconState !== this.lastIconState) {
      tray.setImage(icon(iconState));
      this.lastIconState = iconState;
    }

    const headline =
      state === 'recording'
        ? `Recording — ${clock(elapsed)}`
        : state === 'processing'
          ? progress || 'Processing…'
          : 'Idle';
    // The menu no longer carries a status line, so the tooltip is where the
    // clock and the meeting's folder are read.
    tray.setToolTip(`Minarrador — ${headline}${view.currentDir ? ` — ${view.currentDir}` : ''}`);

    // The shortcut rides on the label, so the menu doubles as a reminder of it.
    const withKey = (label: string, key: string): string => (key ? `${label} (${key})` : label);

    // The shorthands, the two ways to capture speech, and the way out.
    // Everything configured or browsed lives in the library window, which a
    // left-click opens. A tray-only app has no window whose close means "quit",
    // so without the last item the only exit is Task Manager.
    const template: MenuItemConstructorOptions[] = [
      { label: 'Quick copy', enabled: false },
      ...(snippets.length
        ? snippets.map((snippet) => ({
            label: snippetLabel(snippet),
            click: () => clipboard.writeText(snippet.text),
          }))
        : [{ label: 'No shorthands yet — add one…', click: () => a.openQuickCopy() }]),
      { type: 'separator' },
      state === 'recording'
        ? { label: withKey('Stop recording', hotkey), click: () => a.stopRecording() }
        // Starting a new meeting while the previous one is still processing is fine.
        : { label: withKey('Record meeting', hotkey), click: () => a.startRecording() },
      dictation.transcribing
        ? { label: 'Transcribing dictation…', enabled: false }
        : {
            label: withKey(dictation.active ? 'Stop dictation' : 'Start dictation', dictation.hotkey),
            click: () => a.toggleDictation(),
          },
      { type: 'separator' },
      {
        // Quitting mid-meeting saves the audio and skips the notes, so say so
        // where the click happens rather than only afterwards.
        label: state === 'recording' ? 'Quit Minarrador (saves the recording)' : 'Quit Minarrador',
        click: () => a.quit(),
      },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
