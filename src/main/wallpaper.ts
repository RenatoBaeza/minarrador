// The desktop wallpaper: reading which picture Windows shows, setting another,
// and laying the open to-do tasks out over it.
//
// Windows has no API Node can reach for this, so — like the dictation paste —
// it is the PowerShell built into Windows doing it, with fixed scripts. Values
// travel in environment variables, never in the command line, so a wallpaper
// path with a quote in it is a path and not a second statement.
//
// No Electron import: the layout is pure and tested directly, and the two
// PowerShell calls only need child_process. desktop-todos.ts decides when to
// draw and does the drawing.

import { spawn } from 'node:child_process';

import type { Todo, TodoPriority } from '../shared/types';

const POWERSHELL = 'powershell.exe';

/** What `HKCU\Control Panel\Desktop` says the desktop is showing. */
export interface WallpaperState {
  /** The picture's path; '' for a solid colour. */
  path: string;
  /** `WallpaperStyle`: '10' fill, '6' fit, '2' stretch, '0' centre or tile, '22' span. */
  style: string;
  /** `TileWallpaper`: '1' repeats a style-0 picture. */
  tile: string;
  /** `Colors\Background`, "R G B" — what shows around a picture that does not cover. */
  background: string;
}

// UTF-8 out, or a path with an accent in it comes back as something else.
const READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$d = Get-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Desktop'",
  "$c = Get-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Colors' -ErrorAction SilentlyContinue",
  '[pscustomobject]@{ path = [string]$d.WallPaper; style = [string]$d.WallpaperStyle; ' +
    'tile = [string]$d.TileWallpaper; background = [string]$c.Background } | ConvertTo-Json -Compress',
].join('; ');

// SPI_SETDESKWALLPAPER (20) with SPIF_UPDATEINIFILE | SPIF_SENDCHANGE (3): the
// same call the Settings app makes, so the choice persists and Explorer redraws.
// Style and tile are written first because SPI reads them when it applies.
const SET_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$k = 'HKCU:\\Control Panel\\Desktop'",
  'Set-ItemProperty -LiteralPath $k -Name WallpaperStyle -Value $env:MINARRADOR_WALLPAPER_STYLE',
  'Set-ItemProperty -LiteralPath $k -Name TileWallpaper -Value $env:MINARRADOR_WALLPAPER_TILE',
  "Add-Type -Namespace Minarrador -Name Desktop -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode, " +
    "SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, string value, uint flags);'",
  'if (-not [Minarrador.Desktop]::SystemParametersInfo(20, 0, $env:MINARRADOR_WALLPAPER, 3)) ' +
    '{ throw ("SystemParametersInfo failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }',
].join('; ');

function powershell(script: string, env: Record<string, string> = {}, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Encoded, so the quotes inside the scripts survive Windows' argument
    // quoting intact; the scripts are still fixed text.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('powershell timed out'));
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split(/\r?\n/)[0] || `powershell exited with ${code}`));
    });
  });
}

const digits = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? value.trim() : fallback;

export async function readWallpaper(): Promise<WallpaperState> {
  // trim() also drops the byte-order mark PowerShell may put first.
  const parsed: unknown = JSON.parse((await powershell(READ_SCRIPT)).trim() || '{}');
  const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return {
    path: typeof record.path === 'string' ? record.path.trim() : '',
    style: digits(record.style, '10'),
    tile: digits(record.tile, '0'),
    background: typeof record.background === 'string' ? record.background.trim() : '',
  };
}

/** Points the desktop at `file` ('' for a solid colour) with the given style. */
export async function setWallpaper(file: string, style: string, tile: string): Promise<void> {
  await powershell(SET_SCRIPT, {
    MINARRADOR_WALLPAPER: file,
    MINARRADOR_WALLPAPER_STYLE: digits(style, '10'),
    MINARRADOR_WALLPAPER_TILE: digits(tile, '0'),
  });
}

// ------------------------------------------------------------------- layout

/** How many tasks fit on a desktop before it stops being a glance. */
export const DESKTOP_MAX_TASKS = 12;

export interface DesktopTask {
  title: string;
  project: string;
  priority: TodoPriority;
  /** "Overdue · 3 Sep", "Today", … or '' for no due date. */
  due: string;
  /** 'overdue' | 'today' | 'soon' | '' — how loudly to show `due`. */
  urgency: string;
}

/** Midnight of `date`, local time. */
const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** The due label the To-do list shows, for an open task. Mirrors dueLabel in library-todos.ts. */
export function dueText(due: string, now: Date): { text: string; urgency: string } {
  if (!due) return { text: '', urgency: '' };
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = Math.round((date.getTime() - startOfDay(now).getTime()) / 86_400_000);
  const short = date.toLocaleDateString(
    [],
    y === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
  );
  if (days < 0) return { text: `Overdue · ${short}`, urgency: 'overdue' };
  if (days === 0) return { text: 'Today', urgency: 'today' };
  if (days === 1) return { text: 'Tomorrow', urgency: 'soon' };
  if (days < 7) return { text: date.toLocaleDateString([], { weekday: 'long' }), urgency: 'soon' };
  return { text: short, urgency: '' };
}

/**
 * The open tasks, in the order someone dragged them into — the list's own
 * order is the one they curated, and the desktop is not the place to re-sort it.
 */
export function desktopTasks(todos: readonly Todo[], now = new Date()): { tasks: DesktopTask[]; more: number } {
  const open = todos.filter((t) => !t.done);
  const tasks = open.slice(0, DESKTOP_MAX_TASKS).map((t) => {
    const { text, urgency } = dueText(t.due, now);
    return { title: t.title, project: t.project, priority: t.priority, due: text, urgency };
  });
  return { tasks, more: open.length - tasks.length };
}

/**
 * The CSS `background` that draws the picture the way Windows would for the
 * stored style, so the copy with the tasks on it looks like the original.
 * `natural` is the picture's own size in CSS pixels, for the styles that do
 * not scale it.
 */
export function backgroundCss(
  image: string,
  { style, tile }: Pick<WallpaperState, 'style' | 'tile'>,
  natural: { width: number; height: number } | null,
): string {
  const url = `url("${image.replace(/["\\\n\r]/g, '')}")`;
  const own = natural ? `${natural.width}px ${natural.height}px` : 'auto';
  if (style === '0' && tile === '1') return `${url} top left / ${own} repeat`;
  if (style === '0') return `${url} center / ${own} no-repeat`;
  if (style === '2') return `${url} center / 100% 100% no-repeat`;
  if (style === '6') return `${url} center / contain no-repeat`;
  // 10 (fill), 22 (span, which a single-display render can only approximate)
  // and anything unknown.
  return `${url} center / cover no-repeat`;
}

/** `Colors\Background` ("R G B") as CSS; black when it is not three numbers. */
export function backgroundColor(rgb: string): string {
  const parts = rgb.trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? `rgb(${parts.join(', ')})`
    : 'rgb(0, 0, 0)';
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export interface DesktopPage {
  tasks: DesktopTask[];
  more: number;
  /** The whole `background` declaration for the page — picture and colour. */
  background: string;
  /** Space the taskbar and other app bars take, in CSS pixels, so the list keeps clear of them. */
  insets: { top: number; right: number; bottom: number; left: number };
}

/**
 * The page the wallpaper is photographed from: the picture, and the tasks in a
 * panel at the bottom right, just above the taskbar — the corner desktop
 * icons, which line up from the top left, reach last. It grows upwards, so a
 * short list stays tucked into the corner.
 *
 * Every task string is escaped: titles are the user's own text, and they land
 * in markup.
 */
export function desktopHtml({ tasks, more, background, insets }: DesktopPage): string {
  const rows = tasks
    .map((t) => {
      const meta = [
        t.project ? `<span class="project">${escapeHtml(t.project)}</span>` : '',
        t.due ? `<span class="due ${t.urgency}">${escapeHtml(t.due)}</span>` : '',
      ].filter(Boolean);
      return (
        `<li class="p-${t.priority}"><span class="dot"></span><div class="body">` +
        `<div class="title">${escapeHtml(t.title)}</div>` +
        (meta.length ? `<div class="meta">${meta.join('<span class="sep">·</span>')}</div>` : '') +
        '</div></li>'
      );
    })
    .join('');
  const body = tasks.length
    ? `<ul>${rows}</ul>${more > 0 ? `<p class="more">+ ${more} more</p>` : ''}`
    : '<p class="empty">Nothing on the list.</p>';
  const count = tasks.length + Math.max(0, more);

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'">
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  body { background: ${background}; font-family: 'Segoe UI Variable Text', 'Segoe UI', sans-serif; color: #fff; }
  .panel {
    position: absolute; bottom: ${insets.bottom + 40}px; right: ${insets.right + 40}px;
    width: 380px; max-height: calc(100% - ${insets.top + insets.bottom + 80}px); overflow: hidden;
    padding: 10px 14px 8px; border-radius: 12px;
    background: rgba(12, 14, 18, 0.78); backdrop-filter: blur(18px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.10);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
  }
  h1 { margin: 0 0 10px; font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; }
  h1 .count { opacity: 0.6; margin-left: 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 10px; padding: 6px 0; }
  li + li { border-top: 1px solid rgba(255, 255, 255, 0.08); }
  .dot { flex: none; width: 9px; height: 9px; margin-top: 6px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, 0.55); box-sizing: border-box; }
  .p-high .dot { background: #ff6b6b; border-color: #ff6b6b; }
  .p-medium .dot { background: #ffb547; border-color: #ffb547; }
  .p-low .dot { background: #6aa8ff; border-color: #6aa8ff; }
  .body { min-width: 0; }
  .title { font-size: 15px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .meta { margin-top: 1px; font-size: 12px; opacity: 0.72; }
  .sep { margin: 0 6px; }
  .due.overdue { color: #ff8f8f; opacity: 1; font-weight: 600; }
  .due.today { color: #ffd27a; font-weight: 600; }
  .more, .empty { margin: 8px 0 0; font-size: 12px; opacity: 0.65; }
</style></head>
<body><div class="panel"><h1>To-do${count ? `<span class="count">${count}</span>` : ''}</h1>${body}</div></body></html>`;
}
