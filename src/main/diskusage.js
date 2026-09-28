'use strict';

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

const fs = require('node:fs/promises');
const path = require('node:path');

/** How often progress is reported while walking, at most. */
const PROGRESS_MIN_MS = 120;

/**
 * Space an entry occupies on disk, rounded up to the allocation unit.
 *
 * Node reports no `blksize` on Windows, so NTFS's usual 4 KB cluster stands in.
 *
 * @param {import('node:fs').Stats} stats
 */
function sizeOnDisk(stats) {
  if (!stats.size) return 0;
  const cluster = stats.blksize || 4096;
  return Math.ceil(stats.size / cluster) * cluster;
}

/**
 * True when `child` is `parent` or lies inside it.
 *
 * Case-insensitive, because every path this app handles is on Windows.
 */
function isWithin(parent, child) {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class AbortError extends Error {
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
class DiskScan {
  /** @param {string} root an absolute folder, chosen by the user */
  constructor(root) {
    this.root = path.resolve(root);
    /** @type {Map<string, number>} absolute directory path → bytes under it */
    this.dirSizes = new Map();
    /** @type {Map<number, { path: string, isDirectory: boolean, size: number }>} */
    this.ids = new Map();
    this.nextId = 1;
  }

  /**
   * Walks the whole tree once, recording every directory's total.
   *
   * Symbolic links and junctions are counted as the link, never followed:
   * Windows keeps several junctions that point back up their own tree
   * (`Application Data` inside `AppData\Local`), and following one would count
   * the same bytes forever.
   *
   * @param {{ onProgress?: (p: { files: number, dirs: number, current: string }) => void,
   *           signal?: AbortSignal }} [options]
   * @returns {Promise<{ files: number, dirs: number }>}
   */
  async walk({ onProgress, signal } = {}) {
    const counts = { files: 0, dirs: 0 };
    let last = 0;
    const report = (current) => {
      const now = Date.now();
      if (!onProgress || now - last < PROGRESS_MIN_MS) return;
      last = now;
      onProgress({ ...counts, current });
    };

    const visit = async (dir) => {
      if (signal?.aborted) throw new AbortError();
      counts.dirs++;
      report(dir);
      let items;
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
  rootEntry() {
    return { ...this.#issue(this.root, true, this.dirSizes.get(this.root) ?? 0), name: this.root };
  }

  /**
   * What is directly inside a folder the page was given, largest first.
   *
   * @param {number} id
   * @returns {Promise<object[] | null>} null when the id is not one of ours
   */
  async list(id) {
    const node = this.ids.get(id);
    if (!node?.isDirectory) return null;
    let items;
    try {
      items = await fs.readdir(node.path, { withFileTypes: true });
    } catch {
      return [];
    }

    const out = [];
    for (const item of items) {
      const full = path.join(node.path, item.name);
      const isDirectory = item.isDirectory();
      let size = 0;
      let inaccessible;
      if (isDirectory) {
        // A folder created after the walk has no total; zero is the honest one.
        size = this.dirSizes.get(full) ?? 0;
      } else {
        try {
          size = sizeOnDisk(await fs.lstat(full));
        } catch (err) {
          inaccessible = err.code ?? err.message;
        }
      }
      const entry = { ...this.#issue(full, isDirectory, size), name: item.name };
      if (isDirectory) entry.hasChildren = true;
      if (inaccessible) entry.inaccessible = inaccessible;
      out.push(entry);
    }
    return out.sort((a, b) => b.size - a.size);
  }

  /** @returns {{ path: string, isDirectory: boolean, size: number } | null} */
  resolve(id) {
    return this.ids.get(id) ?? null;
  }

  /**
   * Takes an entry out of the totals once it has gone to the Recycle Bin, so a
   * folder expanded afterwards adds up without a rescan. The weight taken off is
   * the one this scan reported, never a number the page sends back.
   *
   * @param {number} id
   */
  forget(id) {
    const node = this.ids.get(id);
    if (!node) return;
    this.ids.delete(id);
    const { size } = node;
    for (let dir = path.dirname(node.path); isWithin(this.root, dir); dir = path.dirname(dir)) {
      if (this.dirSizes.has(dir)) this.dirSizes.set(dir, Math.max(0, this.dirSizes.get(dir) - size));
      if (dir === path.dirname(dir)) break;
    }
    if (node.isDirectory) {
      for (const dir of this.dirSizes.keys()) if (isWithin(node.path, dir)) this.dirSizes.delete(dir);
    }
  }

  #issue(full, isDirectory, size) {
    const id = this.nextId++;
    this.ids.set(id, { path: full, isDirectory, size });
    return { id, isDirectory, size };
  }
}

module.exports = { DiskScan, AbortError, sizeOnDisk, isWithin };
