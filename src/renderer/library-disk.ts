// The Disk usage feature: a folder someone picked, measured once, as a tree.

import type { DiskEntry, DiskProgress } from '../shared/types';
import { el, icon, readerEl, view } from './library-common.js';

// ----------------------------------------------------------------- disk usage

/**
 * The Disk usage feature: a folder someone picked, measured once, as a tree
 * that opens a level at a time, largest first.
 *
 * Every entry is an id the main process issued — this page never holds a path
 * it could send back. Names and the chosen folder's own path arrive for display
 * only, and go into the DOM as text.
 */
export const diskView: {
  root: DiskEntry | null;
  children: Map<number, DiskEntry[]>;
  parents: Map<number, number>;
  expanded: Set<number | string>;
  loading: Set<number>;
  scanning: boolean;
  progress: Partial<DiskProgress> | null;
  message: string;
  seq: number;
  progressEl: { counts: HTMLElement; current: HTMLElement } | null;
} = {
  /** The folder being measured, as `{ id, name, size }`, or null before a scan. */
  root: null,
  /** Folder id → its entries, largest first, once it has been opened. */
  children: new Map(),
  /** Entry id → the id of the folder it was listed in, for walking totals up. */
  parents: new Map(),
  /** Open folder ids, and `files:<id>` for an open "loose files" group. */
  expanded: new Set(),
  /** Folder ids whose listing is on its way. */
  loading: new Set(),
  scanning: false,
  /** `{ files, dirs, current }` from the walk in flight. */
  progress: null,
  /** A sentence about the last scan or delete that did not go through. */
  message: '',
  /** Bumped per scan, so a scan that was superseded cannot land over the new one. */
  seq: 0,
  /** The live-updating scan counter, so progress moves without a re-render. */
  progressEl: null,
};

export const DISK_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function fmtSize(bytes: number): string {
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < DISK_UNITS.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${unit ? size.toFixed(size < 10 ? 2 : 1) : size} ${DISK_UNITS[unit]}`;
}

export const fmtCount = (n: number | undefined): string => Number(n ?? 0).toLocaleString();

export function diskProgressText(p: Partial<DiskProgress> | null): string {
  if (!p) return 'Choose a folder in the dialog…';
  return `${fmtCount(p.dirs)} folders · ${fmtCount(p.files)} files`;
}

export async function chooseDiskFolder() {
  const seq = ++diskView.seq;
  diskView.scanning = true;
  diskView.progress = null;
  diskView.message = '';
  if (view.mode === 'disk') renderDisk();

  let result;
  try {
    result = await window.library.disk.choose();
  } catch {
    result = { ok: false, reason: 'The scan failed.' };
  }
  if (seq !== diskView.seq) return;
  diskView.scanning = false;
  const root = result?.ok ? result.root : undefined;
  if (root) {
    diskView.root = root;
    diskView.children = new Map([[root.id, result.entries ?? []]]);
    diskView.parents = new Map((result.entries ?? []).map((e) => [e.id, root.id]));
    diskView.expanded = new Set([root.id]);
    diskView.loading = new Set();
  } else if (result?.reason) {
    diskView.message = result.reason;
  }
  if (view.mode === 'disk') renderDisk();
}

export async function toggleDiskFolder(id: number): Promise<void> {
  if (diskView.expanded.has(id)) {
    diskView.expanded.delete(id);
    drawDiskTree();
    return;
  }
  if (!diskView.children.has(id)) {
    const seq = diskView.seq;
    diskView.loading.add(id);
    drawDiskTree();
    const entries = await window.library.disk.list(id).catch(() => null);
    if (seq !== diskView.seq) return;
    diskView.loading.delete(id);
    if (!entries) {
      diskView.message = 'That folder is not in the current scan any more — choose the folder again.';
      renderDisk();
      return;
    }
    diskView.children.set(id, entries);
    for (const e of entries) diskView.parents.set(e.id, id);
  }
  diskView.expanded.add(id);
  drawDiskTree();
}

export async function trashDiskEntry(id: number): Promise<void> {
  const seq = diskView.seq;
  const result = await window.library.disk.trash(id).catch(() => ({ ok: false, reason: 'The delete failed.' }));
  // A new scan started while the confirmation was up; this tree is gone.
  if (seq !== diskView.seq) return;
  if (!result?.ok) {
    if (result?.reason) {
      diskView.message = result.reason;
      if (view.mode === 'disk') renderDisk();
    }
    return;
  }
  // Take it out of its folder, and its weight out of every folder above it,
  // the same way main has already done for its own totals.
  const parentId = diskView.parents.get(id);
  if (parentId === undefined) return;
  const siblings = diskView.children.get(parentId) ?? [];
  const gone = siblings.find((e) => e.id === id);
  diskView.children.set(
    parentId,
    siblings.filter((e) => e.id !== id),
  );
  const bytes = gone?.size ?? 0;
  for (let up: number | undefined = parentId; up !== undefined; up = diskView.parents.get(up)) {
    const above = diskView.parents.get(up);
    const holder =
      up === diskView.root?.id ? [diskView.root] : (above === undefined ? undefined : diskView.children.get(above)) ?? [];
    const entry = holder.find((e) => e.id === up);
    if (entry) entry.size = Math.max(0, entry.size - bytes);
  }
  diskView.message = '';
  if (view.mode === 'disk') renderDisk();
}

/** A share of the parent as a bar, cool when small and warm when it dominates. */
export function diskBar(size: number, parentSize: number): HTMLElement {
  const pct = parentSize ? (size / parentSize) * 100 : 0;
  const track = el('div', 'du-bar');
  const fill = el('div', 'du-bar-fill');
  fill.style.width = `${Math.max(pct, 0.5)}%`;
  fill.style.backgroundColor = `hsl(${200 - pct * 1.5}, 70%, 58%)`;
  track.append(fill);
  return track;
}

export function diskActionButton(
  iconName: string,
  title: string,
  action: 'reveal' | 'trash',
  id: number,
  danger = false,
): HTMLButtonElement {
  const button = el('button', `du-act${danger ? ' danger' : ''}`);
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.dataset.action = action;
  button.dataset.id = String(id);
  button.append(icon(iconName));
  return button;
}

/**
 * One line of the tree. `kind` is 'dir', 'file' or 'group' (the loose files of
 * a folder that also has subfolders, gathered so they compete as one line).
 */
export function diskRow({
  kind,
  id,
  name,
  size,
  parentSize,
  depth,
  open,
  loading,
  inaccessible,
  toggle,
}: {
  kind: 'dir' | 'file' | 'group';
  id?: number;
  name: string;
  size: number;
  parentSize: number;
  depth: number;
  open: boolean;
  loading?: boolean;
  inaccessible?: string;
  /** What the twisty toggles: a folder id, or `files:<id>` for a loose-files group. */
  toggle: number | string | null;
}): HTMLElement {
  const row = el('div', `du-row${inaccessible ? ' inaccessible' : ''}`);
  const nameCell = el('div', 'du-name');
  nameCell.style.paddingLeft = `${depth * 18}px`;

  const twisty = el('button', 'du-twisty', toggle ? (loading ? '…' : open ? '▾' : '▸') : '');
  twisty.type = 'button';
  if (toggle) {
    twisty.dataset.action = 'toggle';
    twisty.dataset.id = String(toggle);
    twisty.setAttribute('aria-expanded', String(Boolean(open)));
    twisty.setAttribute('aria-label', open ? `Collapse ${name}` : `Expand ${name}`);
  } else {
    twisty.disabled = true;
    twisty.tabIndex = -1;
  }
  const label = el('span', 'du-label', name);
  label.title = inaccessible ? `${name} — could not be read (${inaccessible})` : name;
  nameCell.append(twisty, icon(kind === 'dir' ? 'folder' : kind === 'group' ? 'files' : 'file'), label);

  const sizeCell = el('div', 'du-size', inaccessible ? 'unreadable' : fmtSize(size));
  const pctCell = el('div', 'du-pct', parentSize && !inaccessible ? `${((size / parentSize) * 100).toFixed(1)}%` : '');

  const actions = el('div', 'du-actions');
  if (kind !== 'group' && id !== undefined) {
    actions.append(
      diskActionButton('reveal', 'Show in Explorer', 'reveal', id),
      diskActionButton('trash', 'Move to Recycle Bin', 'trash', id, true),
    );
  }

  row.append(nameCell, diskBar(size, parentSize), sizeCell, pctCell, actions);
  return row;
}

/** The rows under one open folder, recursively, in the order they are drawn. */
export function diskRows(folderId: number, folderSize: number, depth: number, out: HTMLElement[]): void {
  const entries = diskView.children.get(folderId) ?? [];
  const folders = entries.filter((e) => e.isDirectory);
  const files = entries.filter((e) => !e.isDirectory);

  const pushEntry = (entry: DiskEntry, parentSize: number, level: number): void => {
    const open = diskView.expanded.has(entry.id);
    out.push(
      diskRow({
        kind: entry.isDirectory ? 'dir' : 'file',
        id: entry.id,
        name: entry.name,
        size: entry.size,
        parentSize,
        depth: level,
        open,
        loading: diskView.loading.has(entry.id),
        inaccessible: entry.inaccessible,
        toggle: entry.isDirectory ? entry.id : null,
      }),
    );
    if (entry.isDirectory && open) diskRows(entry.id, entry.size, level + 1, out);
  };

  // Loose files only get a line of their own beside subfolders; a folder of
  // nothing but files just lists them.
  if (!folders.length || !files.length) {
    for (const entry of entries) pushEntry(entry, folderSize, depth);
    return;
  }
  const groupKey = `files:${folderId}`;
  const groupSize = files.reduce((sum, f) => sum + f.size, 0);
  type Line = DiskEntry | { group: true; size: number };
  const lines: Line[] = [...folders, { group: true as const, size: groupSize }].sort((a, b) => b.size - a.size);
  for (const line of lines) {
    if (!('group' in line)) {
      pushEntry(line, folderSize, depth);
      continue;
    }
    const open = diskView.expanded.has(groupKey);
    out.push(
      diskRow({
        kind: 'group',
        name: `Loose files (${files.length})`,
        size: groupSize,
        parentSize: folderSize,
        depth,
        open,
        toggle: groupKey,
      }),
    );
    if (open) for (const file of files) pushEntry(file, groupSize, depth + 1);
  }
}

export function drawDiskTree(): void {
  const tree = readerEl.querySelector('.du-tree');
  const root = diskView.root;
  if (!tree || !root) return;
  const rows: HTMLElement[] = [];
  diskRows(root.id, root.size, 0, rows);
  if (!rows.length) rows.push(el('div', 'du-empty', 'This folder is empty.'));
  tree.replaceChildren(...rows);
}

export function renderDisk() {
  const doc = el('div', 'doc du-doc');
  doc.append(
    el('h1', '', 'Disk usage'),
    el(
      'p',
      'settings-lead',
      'Pick a folder to see what is taking the space inside it, largest first. Anything deleted from here goes to the Recycle Bin.',
    ),
  );

  const toolbar = el('div', 'qc-toolbar');
  const choose = el('button', 'button primary', diskView.root ? 'Measure another folder…' : 'Choose a folder…');
  choose.type = 'button';
  choose.disabled = diskView.scanning;
  choose.addEventListener('click', () => chooseDiskFolder());
  toolbar.append(choose);
  if (diskView.scanning) {
    const cancel = el('button', 'button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => window.library.disk.cancel());
    toolbar.append(cancel);
  }
  doc.append(toolbar);

  if (diskView.message) doc.append(el('div', 'notice notice-warn', diskView.message));

  diskView.progressEl = null;
  if (diskView.scanning) {
    const box = el('div', 'du-scan');
    const counts = el('div', 'du-scan-counts', diskProgressText(diskView.progress));
    const current = el('div', 'du-scan-current', diskView.progress?.current ?? '');
    box.append(counts, current);
    diskView.progressEl = { counts, current };
    doc.append(box);
  } else if (diskView.root) {
    const root = diskView.root;
    const head = el('div', 'du-head');
    const where = el('span', 'du-root', root.name);
    where.title = root.name;
    const reveal = diskActionButton('reveal', 'Show in Explorer', 'reveal', root.id);
    reveal.addEventListener('click', () => window.library.disk.reveal(root.id));
    head.append(where, el('span', 'du-total', fmtSize(root.size)), reveal);

    const columns = el('div', 'du-row du-columns');
    columns.append(el('div', '', 'Name'), el('div'), el('div', 'du-size', 'Size on disk'), el('div'), el('div'));

    const tree = el('div', 'du-tree');
    tree.setAttribute('role', 'tree');
    tree.addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLElement>('button[data-action]');
      if (!button) return;
      const { action } = button.dataset;
      const raw = button.dataset.id ?? '';
      if (action === 'toggle' && raw.startsWith('files:')) {
        if (diskView.expanded.has(raw)) diskView.expanded.delete(raw);
        else diskView.expanded.add(raw);
        drawDiskTree();
      } else if (action === 'toggle') {
        toggleDiskFolder(Number(raw));
      } else if (action === 'reveal') {
        window.library.disk.reveal(Number(raw));
      } else if (action === 'trash') {
        trashDiskEntry(Number(raw));
      }
    });
    doc.append(head, columns, tree);
  }

  readerEl.replaceChildren(doc);
  drawDiskTree();
}
