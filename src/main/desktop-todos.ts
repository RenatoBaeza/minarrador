// The open to-do tasks, drawn onto the desktop wallpaper.
//
// A picture rather than a window: a window pinned behind everything still
// vanishes under Show desktop (Win+D), which is exactly the moment someone is
// looking at their wallpaper, and anything that is a window can be clicked. A
// wallpaper is neither. So the current wallpaper is copied, photographed with
// the list over it in an offscreen page, and the photograph is set as the
// desktop background. Turning the setting off puts the original back.
//
// The copy matters: Windows keeps its own re-encoded copy of the wallpaper
// (Themes\TranscodedWallpaper) and overwrites it with ours, so the original is
// kept in userData/desktop-todos and is what every redraw starts from. When
// the desktop is showing something we did not draw, the user changed it, and
// that becomes the new original.

import { app, BrowserWindow, nativeImage, powerMonitor, screen, type Display } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import log from './logger';
import * as todosStore from './todos';
import { ctx, delay } from './context';
import { errorMessage } from './errors';
import { notify } from './windows';
import {
  backgroundColor,
  backgroundCss,
  desktopHtml,
  desktopTasks,
  readWallpaper,
  setWallpaper,
  type WallpaperState,
} from './wallpaper';

/** Settles a burst of saves — a drag, a run of checkbox clicks — into one redraw. */
const REDRAW_MS = 1500;
/** Windows rewrites Themes\ in several steps when the wallpaper changes. */
const THEMES_SETTLE_MS = 3000;
/** Time for the offscreen page to decode the picture and paint. */
const PAINT_SETTLE_MS = 600;

/** The picture under the list, as it was before we drew on it. */
interface Original extends WallpaperState {
  /** File name of our copy inside the folder, or '' for a solid colour. */
  copy: string;
  size: number;
  mtimeMs: number;
}

const folder = (): string => path.join(app.getPath('userData'), 'desktop-todos');
const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** A wallpaper this module drew — never the original copy, which also lives here. */
function isOurs(file: string): boolean {
  return Boolean(file) && same(path.dirname(file), folder()) && /^wallpaper-[ab]\.png$/i.test(path.basename(file));
}

function readOriginal(): Original | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folder(), 'original.json'), 'utf8')) as Partial<Original>;
    if (typeof parsed.path !== 'string' || typeof parsed.copy !== 'string') return null;
    return {
      path: parsed.path,
      style: String(parsed.style ?? '10'),
      tile: String(parsed.tile ?? '0'),
      background: String(parsed.background ?? ''),
      copy: parsed.copy,
      size: Number(parsed.size) || 0,
      mtimeMs: Number(parsed.mtimeMs) || 0,
    };
  } catch {
    return null;
  }
}

function writeOriginal(original: Original): void {
  fs.writeFileSync(path.join(folder(), 'original.json'), JSON.stringify(original, null, 2));
}

/** Takes what the desktop is showing as the picture to draw on, copying it unless it is the one already kept. */
function adoptOriginal(current: WallpaperState, previous: Original | null): Original {
  let stat: fs.Stats | null = null;
  try {
    if (current.path) stat = fs.statSync(current.path);
  } catch {
    // A path to a file that is gone shows as the background colour, and so will we.
  }
  if (!stat?.isFile()) {
    const solid: Original = { ...current, copy: '', size: 0, mtimeMs: 0 };
    writeOriginal(solid);
    return solid;
  }

  const unchanged =
    previous?.copy &&
    same(previous.path, current.path) &&
    previous.size === stat.size &&
    previous.mtimeMs === stat.mtimeMs &&
    fs.existsSync(path.join(folder(), previous.copy));
  let copy = unchanged ? previous.copy : `original${path.extname(current.path).toLowerCase() || '.jpg'}`;
  if (!unchanged) {
    const target = path.join(folder(), copy);
    // Restoring to our own copy (the original file was gone) makes it the
    // desktop's current picture — copying it onto itself would truncate it.
    if (!same(current.path, target)) {
      for (const name of fs.readdirSync(folder())) {
        if (/^original\./i.test(name) && name !== 'original.json') fs.rmSync(path.join(folder(), name), { force: true });
      }
      fs.copyFileSync(current.path, target);
    } else {
      copy = path.basename(target);
    }
  }
  const original: Original = { ...current, copy, size: stat.size, mtimeMs: stat.mtimeMs };
  writeOriginal(original);
  return original;
}

/** Physical pixels of the primary display — the size Windows draws a Fill wallpaper at without scaling. */
const physical = (d: Display): { width: number; height: number } => ({
  width: Math.round(d.size.width * d.scaleFactor),
  height: Math.round(d.size.height * d.scaleFactor),
});

/** Photographs `html` at the primary display's size. */
async function photograph(htmlFile: string, display: Display): Promise<Buffer> {
  const { width, height } = display.size;
  const win = new BrowserWindow({
    show: false,
    frame: false,
    // Otherwise Windows clamps the window to the work area, and the picture
    // comes out a taskbar short.
    enableLargerThanScreen: true,
    width,
    height,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    win.setContentSize(width, height);
    await win.loadFile(htmlFile);
    await delay(PAINT_SETTLE_MS);
    let image = await win.webContents.capturePage();
    // The capture is at the display's scale, give or take a rounding pixel;
    // crop rather than resample, so the text stays sharp.
    const want = physical(display);
    const got = image.getSize();
    if (got.width >= want.width && got.height >= want.height) {
      image = image.crop({ x: 0, y: 0, ...want });
    } else {
      image = image.resize({ ...want, quality: 'best' });
    }
    return image.toPNG();
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** What the last applied picture was drawn from; equal means there is nothing to redraw. */
let lastKey = '';
let flip = false;

async function draw(): Promise<void> {
  const dir = folder();
  fs.mkdirSync(dir, { recursive: true });
  const current = await readWallpaper();
  let original = readOriginal();
  if (!isOurs(current.path)) original = adoptOriginal(current, original);
  // Ours, with no record of what was underneath (the folder was cleared):
  // drawing on our own picture would stack a list on a list, so draw on the
  // background colour instead.
  original ??= { ...current, path: '', copy: '', size: 0, mtimeMs: 0 };

  const display = screen.getPrimaryDisplay();
  const { tasks, more } = desktopTasks(todosStore.load());
  const key = JSON.stringify({
    tasks,
    more,
    original: [original.copy, original.size, original.mtimeMs, original.style, original.tile, original.background],
    display: [display.size, display.scaleFactor, display.bounds, display.workArea],
  });
  if (key === lastKey && isOurs(current.path) && fs.existsSync(current.path)) return;

  let picture = '';
  if (original.copy) {
    const natural = nativeImage.createFromPath(path.join(dir, original.copy)).getSize();
    picture = backgroundCss(
      original.copy,
      original,
      natural.width ? { width: natural.width / display.scaleFactor, height: natural.height / display.scaleFactor } : null,
    );
  }
  const { bounds, workArea } = display;
  const html = desktopHtml({
    tasks,
    more,
    background: [picture, backgroundColor(original.background)].filter(Boolean).join(', '),
    insets: {
      top: workArea.y - bounds.y,
      left: workArea.x - bounds.x,
      right: bounds.x + bounds.width - (workArea.x + workArea.width),
      bottom: bounds.y + bounds.height - (workArea.y + workArea.height),
    },
  });
  const htmlFile = path.join(dir, 'render.html');
  fs.writeFileSync(htmlFile, html);
  const png = await photograph(htmlFile, display);

  // Alternate between two files: handed the path it already has, Windows may
  // decide nothing changed.
  flip = !flip;
  const file = path.join(dir, `wallpaper-${flip ? 'a' : 'b'}.png`);
  fs.writeFileSync(file, png);
  // The picture is exactly the display's size, so Fill draws it 1:1 — the
  // original's own style is already baked into it.
  await setWallpaper(file, '10', '0');
  lastKey = key;
  log.info(`desktop to-do: drew ${tasks.length} task(s)${more > 0 ? ` (+${more})` : ''} onto the wallpaper`);
}

/** Puts back the picture the list was drawn on, if the desktop is still showing ours. */
async function restore(): Promise<void> {
  if (!fs.existsSync(folder())) return;
  const current = await readWallpaper();
  if (!isOurs(current.path)) {
    // They moved on to another picture themselves; nothing here is in use.
    fs.rmSync(folder(), { recursive: true, force: true });
    return;
  }
  const original = readOriginal();
  if (!original) {
    log.warn('desktop to-do: no record of the original wallpaper to restore');
    return;
  }
  // Windows' own Themes\TranscodedWallpaper is what we overwrote, so a path to
  // it would restore our picture rather than theirs; the copy is the original.
  const own =
    original.path && fs.existsSync(original.path) && !/^transcodedwallpaper/i.test(path.basename(original.path));
  const file = own ? original.path : original.copy ? path.join(folder(), original.copy) : '';
  await setWallpaper(file, original.style, original.tile);
  lastKey = '';
  // Only once the original is back on the desktop: the copy may be what it
  // is showing. Its absence is also what tells the next startup there is
  // nothing to undo.
  if (!own && original.copy) return;
  fs.rmSync(folder(), { recursive: true, force: true });
  log.info('desktop to-do: original wallpaper restored');
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;
let warned = false;

/**
 * Runs whichever of draw or restore the setting asks for, one at a time — a
 * request that arrives mid-run runs once more afterwards rather than alongside.
 */
async function run(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    if (ctx.settings.desktopTodos) await draw();
    else await restore();
    warned = false;
  } catch (err) {
    log.warn('desktop to-do: could not update the wallpaper:', errorMessage(err));
    if (!warned) notify('Could not update the wallpaper', errorMessage(err));
    warned = true;
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule(0);
    }
  }
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, ms);
}

/** A task was added, edited, reordered or ticked off. */
export function scheduleDesktopTodos(): void {
  if (ctx.settings.desktopTodos) schedule(REDRAW_MS);
}

let watcher: fs.FSWatcher | null = null;
let midnight: NodeJS.Timeout | null = null;

/** "Tomorrow" becomes "Today" at midnight without anyone touching the list. */
function armMidnight(): void {
  if (midnight) clearTimeout(midnight);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  midnight = setTimeout(() => {
    schedule(0);
    armMidnight();
  }, next.getTime() - now.getTime());
}

/**
 * Starts or stops following the list. Called at startup and whenever the
 * setting changes; turning it off is what restores the original picture.
 */
export function applyDesktopTodos({ startup = false }: { startup?: boolean } = {}): void {
  if (watcher) watcher.close();
  watcher = null;
  if (midnight) clearTimeout(midnight);
  midnight = null;

  if (!ctx.settings.desktopTodos) {
    // Someone turning it off — or a startup that finds a drawn wallpaper still
    // in place, from a settings file edited while the app was closed.
    if (!startup || fs.existsSync(folder())) schedule(0);
    return;
  }
  armMidnight();
  // A new wallpaper chosen in Windows lands here first. Our own set does too,
  // and finds nothing to redraw.
  try {
    watcher = fs.watch(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes'), () => {
      schedule(THEMES_SETTLE_MS);
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    log.warn('desktop to-do: cannot watch for wallpaper changes:', errorMessage(err));
  }
  schedule(0);
}

/** Display changes and wake-ups, wired once. */
export function initDesktopTodos(): void {
  const redraw = (): void => {
    if (ctx.settings.desktopTodos) schedule(REDRAW_MS);
  };
  screen.on('display-metrics-changed', redraw);
  screen.on('display-added', redraw);
  screen.on('display-removed', redraw);
  // A machine asleep over midnight wakes with yesterday's labels.
  powerMonitor.on('resume', redraw);
  applyDesktopTodos({ startup: true });
}

export function stopDesktopTodos(): void {
  if (timer) clearTimeout(timer);
  if (midnight) clearTimeout(midnight);
  watcher?.close();
  timer = midnight = watcher = null;
}
