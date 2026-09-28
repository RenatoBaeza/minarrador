// Disk usage: what is taking the space under a folder someone picked.
//
// Ported from the standalone File Size Viewer, with one change of shape to fit
// this app's rule that no path ever crosses into a renderer. The page is handed
// opaque numeric ids for the entries it has been shown, and every later request
// — list a folder, reveal it, send it to the Recycle Bin — names one of those
// ids. The path behind it is looked up here, so the page can only ever act on
// something this module listed from inside the folder the user chose through a
// dialog.
//
// The walk is done once. The original re-walked every subfolder each time one
// was expanded, which on a deep tree is the whole scan again per click; here
// the first pass records the size of every directory it passes through, and
// expanding one is a single readdir plus a lookup.
//
// Nothing here writes. Moving to the Recycle Bin is main.js's business, behind a
// native confirmation, the same as deleting a meeting.

import fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';

import { errorCode, errorMessage } from './errors';
import type { DiskEntry, DiskProgress } from '../shared/types';

/** How often progress is reported while walking, at most. */
const PROGRESS_MIN_MS = 120;

export type { DiskEntry, DiskProgress };

/** What an id stands for, on this side of the bridge only. */
export interface DiskNode {
  path: string;
  isDirectory: boolean;
  size: number;
}

/**
 * Space an entry occupies on disk, rounded up to the allocation unit.
 *
 * Node reports no `blksize` on Windows, so NTFS's usual 4 KB cluster stands in.
 */
export function sizeOnDisk(stats: Pick<Stats, 'size' | 'blksize'>): number {
  if (!stats.size) return 0;
  const cluster = stats.blksize || 4096;
  return Math.ceil(stats.size / cluster) * cluster;
}

/**
 * True when `child` is `parent` or lies inside it.
 *
 * Case-insensitive, because every path this app handles is on Windows.
 */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class AbortError extends Error {
  constructor() {
    super('Scan cancelled');
    this.name = 'AbortError';
  }
}

/**
 * One scan of one folder. Holds the directory sizes the walk found and the ids
 * handed to the page; both die with the object, so a new scan is a clean slate
 * and an id from the last one resolves to nothing.
 */
export class DiskScan {
  readonly root: string;
  /** Absolute directory path → bytes under it. */
  readonly dirSizes = new Map<string, number>();
  readonly ids = new Map<number, DiskNode>();
  nextId = 1;

  /** @param root an absolute folder, chosen by the user */
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Walks the whole tree once, recording every directory's total.
   *
   * Symbolic links and junctions are counted as the link, never followed:
   * Windows keeps several junctions that point back up their own tree
   * (`Application Data` inside `AppData\Local`), and following one would count
   * the same bytes forever.
   */
  async walk({
    onProgress,
    signal,
  }: { onProgress?: (p: DiskProgress) => void; signal?: AbortSignal } = {}): Promise<{ files: number; dirs: number }> {
    const counts = { files: 0, dirs: 0 };
    let last = 0;
    const report = (current: string): void => {
      const now = Date.now();
      if (!onProgress || now - last < PROGRESS_MIN_MS) return;
      last = now;
      onProgress({ ...counts, current });
    };

    const visit = async (dir: string): Promise<number> => {
      if (signal?.aborted) throw new AbortError();
      counts.dirs++;
      report(dir);
      let items: Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        this.dirSizes.set(dir, 0);
        return 0;
      }
      let total = 0;
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          total += await visit(full);
        } else {
          counts.files++;
          try {
            total += sizeOnDisk(await fs.lstat(full));
          } catch {
            // locked, vanished mid-scan or denied — it simply does not count
          }
        }
      }
      this.dirSizes.set(dir, total);
      return total;
    };

    await visit(this.root);
    onProgress?.({ ...counts, current: '' });
    return counts;
  }

  /** The chosen folder, as the page shows it at the top of the tree. */
  rootEntry(): DiskEntry {
    return { ...this.#issue(this.root, true, this.dirSizes.get(this.root) ?? 0), name: this.root };
  }

  /**
   * What is directly inside a folder the page was given, largest first.
   *
   * @returns null when the id is not one of ours
   */
  async list(id: number): Promise<DiskEntry[] | null> {
    const node = this.ids.get(id);
    if (!node?.isDirectory) return null;
    let items: Dirent[];
    try {
      items = await fs.readdir(node.path, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: DiskEntry[] = [];
    for (const item of items) {
      const full = path.join(node.path, item.name);
      const isDirectory = item.isDirectory();
      let size = 0;
      let inaccessible: string | undefined;
      if (isDirectory) {
        // A folder created after the walk has no total; zero is the honest one.
        size = this.dirSizes.get(full) ?? 0;
      } else {
        try {
          size = sizeOnDisk(await fs.lstat(full));
        } catch (err) {
          inaccessible = errorCode(err) || errorMessage(err);
        }
      }
      const entry: DiskEntry = { ...this.#issue(full, isDirectory, size), name: item.name };
      if (isDirectory) entry.hasChildren = true;
      if (inaccessible) entry.inaccessible = inaccessible;
      out.push(entry);
    }
    return out.sort((a, b) => b.size - a.size);
  }

  resolve(id: number): DiskNode | null {
    return this.ids.get(id) ?? null;
  }

  /**
   * Takes an entry out of the totals once it has gone to the Recycle Bin, so a
   * folder expanded afterwards adds up without a rescan. The weight taken off is
   * the one this scan reported, never a number the page sends back.
   */
  forget(id: number): void {
    const node = this.ids.get(id);
    if (!node) return;
    this.ids.delete(id);
    const { size } = node;
    for (let dir = path.dirname(node.path); isWithin(this.root, dir); dir = path.dirname(dir)) {
      const total = this.dirSizes.get(dir);
      if (total !== undefined) this.dirSizes.set(dir, Math.max(0, total - size));
      if (dir === path.dirname(dir)) break;
    }
    if (node.isDirectory) {
      for (const dir of this.dirSizes.keys()) if (isWithin(node.path, dir)) this.dirSizes.delete(dir);
    }
  }

  #issue(full: string, isDirectory: boolean, size: number): Omit<DiskEntry, 'name'> {
    const id = this.nextId++;
    this.ids.set(id, { path: full, isDirectory, size });
    return { id, isDirectory, size };
  }
}
