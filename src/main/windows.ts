// Every window the app opens, and the few ways the rest of the main process
// talks to them.
//
// Each window is single-instance: a second copy of an editor over one file means
// whichever is saved last wins, silently, and a second library is a second
// reader over the same folders with nothing to gain from the split. So each one
// is a slot here, and "show" means "focus it if it is there, build it if not".

import {
  BrowserWindow,
  Notification,
  dialog,
  nativeImage,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type NativeImage,
} from 'electron';
import path from 'node:path';

import log from './logger';
import { APP_ROOT } from './paths';
import { clear } from './context';
import type { DictateIndicatorState } from '../shared/types';

export const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(APP_ROOT, 'assets');

/** The sidebar features main can open the library window onto. */
export type LibrarySection = 'reader' | 'settings' | 'quickcopy' | 'disk' | 'todos';

/** The open windows, or null. Read through {@link alive}; a closed one clears its own slot. */
export const windows: {
  library: BrowserWindow | null;
  dictations: BrowserWindow | null;
  indicator: BrowserWindow | null;
} = { library: null, dictations: null, indicator: null };

/** When the "Pasted" pill last got told to leave, so a second dictation can bring it back. */
let indicatorTimer: NodeJS.Timeout | null = null;

/** What else has to let go when the library closes: the mic test, a disk scan. */
const libraryClosed: (() => void)[] = [];

let appIconCache: NativeImage | null = null;

/**
 * The app icon, shared by every surface that shows one.
 *
 * On Windows the .ico is the same multi-size icon the installer puts on the
 * shortcut, so the taskbar, Alt-Tab and the window thumbnail all pick the size
 * they want instead of rescaling one PNG into something soft.
 */
export function appIcon(): NativeImage {
  if (appIconCache) return appIconCache;
  const preferred = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  let img = nativeImage.createFromPath(path.join(ASSETS, preferred));
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  appIconCache = img;
  return img;
}

/** The window if it is still there, or null. */
export const alive = (win: BrowserWindow | null): BrowserWindow | null => (win && !win.isDestroyed() ? win : null);

/** Brings an existing window forward. */
function raise(win: BrowserWindow): BrowserWindow {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/** The web preferences every window here shares: sandboxed, isolated, its own preload. */
const secure = (preload: string): Electron.WebPreferences => ({
  preload: path.join(RENDERER, preload),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

/**
 * The dictations archive: everything the voice-input hotkey has transcribed.
 *
 * Frameless and single-instance like every other window here — two copies of an
 * editor over one file means whichever is saved last wins, silently.
 */
export function showDictationsWindow(): BrowserWindow {
  const open = alive(windows.dictations);
  if (open) return raise(open);

  const win = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 420,
    minHeight: 320,
    show: false,
    frame: false,
    title: 'Dictations',
    backgroundColor: '#16161a',
    icon: appIcon(),
    webPreferences: secure('dictations-preload.js'),
  });
  windows.dictations = win;

  win.once('ready-to-show', () => windows.dictations?.show());
  win.on('closed', () => {
    windows.dictations = null;
  });
  win.loadFile(path.join(RENDERER, 'dictations.html')).catch((err: unknown) => {
    log.error('dictations window failed to load', err);
  });
  return win;
}

/**
 * Tells an open dictations window that the list changed, so it re-reads the
 * store. A dictation landing mid-edit leaves the row alone — the window skips
 * a refresh while it has unsaved text.
 */
export function notifyDictations(): void {
  alive(windows.dictations)?.webContents.send('dictations:changed');
}

/**
 * The floating pill that says a dictation is in flight.
 *
 * `focusable: false` is the whole point: the window it floats over is the one
 * the finished text is about to be pasted into, and a window that could take
 * the cursor would move the target. It is positioned over the primary display's
 * work area, out of the way of whatever is being read.
 */
export function showDictateIndicator(): BrowserWindow {
  const open = alive(windows.indicator);
  if (open) {
    open.show();
    return open;
  }

  const width = 380;
  const height = 64;
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + wa.height - height - 48),
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#16161a',
    webPreferences: secure('dictate-indicator-preload.js'),
  });
  windows.indicator = win;
  win.on('closed', () => {
    windows.indicator = null;
  });
  win.loadFile(path.join(RENDERER, 'dictate-indicator.html')).catch((err: unknown) => {
    log.error('dictate indicator failed to load', err);
  });
  win.once('ready-to-show', () => windows.indicator?.show());
  return win;
}

/** Sends state to the indicator if it is up; a no-op otherwise. */
export function sendToDictate(payload: DictateIndicatorState): void {
  alive(windows.indicator)?.webContents.send('dictate:state', payload);
}

/** The indicator leaves by itself a few seconds after it has said "Pasted". */
export function scheduleIndicatorHide(): void {
  clear(indicatorTimer);
  indicatorTimer = setTimeout(() => {
    indicatorTimer = null;
    alive(windows.indicator)?.hide();
  }, 4000);
}

/** Drops the indicator's pending hide, on the way out. */
export function cancelIndicatorHide(): void {
  clear(indicatorTimer);
  indicatorTimer = null;
}

/** Registers something to let go of when the library window closes. */
export function onLibraryClosed(fn: () => void): void {
  libraryClosed.push(fn);
}

/**
 * The meeting library: the archive of everything ever recorded, and the only
 * window in this app someone opens without a meeting in progress.
 *
 * Left-clicking the tray icon lands here, so it is the app's front door — hence
 * the size, and hence single-instance like the rest: a second copy would be a
 * second reader over the same folders with nothing to gain from the split.
 *
 * Read-only over the notes folder: everything it shows comes out of library.ts,
 * which never writes. Settings are the exception, and they go through the same
 * store the tray used to write — see ipc/settings.ts.
 *
 * @param options.section the sidebar feature to open on rather than whatever
 *   was last showing — how the tray's empty quick-copy row lands.
 */
export function showLibraryWindow({ section = null }: { section?: LibrarySection | null } = {}): BrowserWindow {
  const showSection = (win: BrowserWindow): void => {
    if (section) win.webContents.send('library:show', section);
  };

  const open = alive(windows.library);
  if (open) {
    raise(open);
    showSection(open);
    return open;
  }

  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 780,
    minHeight: 480,
    show: false,
    frame: false,
    title: 'Minarrador',
    backgroundColor: '#16161a',
    icon: appIcon(),
    webPreferences: secure('library-preload.js'),
  });
  windows.library = win;

  win.once('ready-to-show', () => windows.library?.show());
  // The page has to exist before it can be told which pane to open on, so a
  // freshly built window waits for its script rather than sending into nothing.
  win.webContents.once('did-finish-load', () => {
    const current = alive(windows.library);
    if (current) showSection(current);
  });
  win.on('closed', () => {
    windows.library = null;
    // The pane that asked for the mic is gone; the test must not keep it open.
    // Nor a disk scan, or the tree of a whole drive it was holding.
    for (const fn of libraryClosed) fn();
  });
  win.loadFile(path.join(RENDERER, 'library.html')).catch((err: unknown) => {
    log.error('library window failed to load', err);
  });
  return win;
}

/** Posts to the library window when one is open; a no-op otherwise. */
export function sendToLibrary(channel: string, payload?: unknown): void {
  alive(windows.library)?.webContents.send(channel, payload);
}

export type SenderEvent = IpcMainEvent | IpcMainInvokeEvent;

/**
 * Whether a message came from the library window.
 *
 * Every library channel checks it, in every IPC module: the notes folder is
 * full of user files, and the window is one `shell.openPath` away from them —
 * so a channel that answered any sender would answer the capture worker, the
 * indicator, or a page that model-authored HTML reached.
 */
export const fromLibrary = (event: SenderEvent): boolean => event.sender.id === windows.library?.webContents.id;

export const fromDictations = (event: SenderEvent): boolean => event.sender.id === windows.dictations?.webContents.id;

/** A native confirmation, parented to the library window when there is one. */
export async function confirm(options: MessageBoxOptions): Promise<boolean> {
  const parent = alive(windows.library);
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
}

export function notify(title: string, body: string, onClick?: (() => void) | null): void {
  if (!Notification.isSupported()) {
    log.info(`notification: ${title} — ${body}`);
    return;
  }
  const n = new Notification({
    title,
    body,
    icon: appIcon(),
    silent: false,
  });
  if (onClick) n.on('click', onClick);
  n.show();
}
