// The library window's Disk usage feature.
//
// diskusage.ts walks the folder and hands the page opaque ids; everything that
// acts on an entry is here, behind the same sender check as the rest of the
// window. The one scan lives for as long as the window does — a tree of a whole
// drive is not something to keep in memory for a tray icon.

import { dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';

import log from '../logger';
import { DiskScan, AbortError as DiskAbortError, isWithin } from '../diskusage';
import { errorMessage } from '../errors';
import { state } from '../context';
import { alive, confirm, fromLibrary, onLibraryClosed, sendToLibrary, windows } from '../windows';
import { notifyLibrary } from '../ui';
import type { DiskChoice, Outcome } from '../../shared/types';

const disk: { scan: DiskScan | null; abort: AbortController | null } = {
  scan: null,
  /** Aborts the walk in flight, if there is one. */
  abort: null,
};

/** Disk-usage ids are positive integers the scan issued; anything else is 0, which names nothing. */
const diskId = (id: unknown): number => (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0);

export function cancelDiskScan(): void {
  disk.abort?.abort();
  disk.abort = null;
}

/**
 * Asks for a folder, then walks it.
 *
 * The folder comes from a native dialog, never from the page — the same rule
 * as the notes folder — so a renderer cannot point the walk anywhere.
 *
 * `ok` false with no reason means the dialog was cancelled.
 */
async function chooseDiskFolder(): Promise<DiskChoice> {
  const parent = alive(windows.library);
  const options: OpenDialogOptions = { title: 'Choose a folder to measure', properties: ['openDirectory'] };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return { ok: false };

  cancelDiskScan();
  const controller = new AbortController();
  disk.abort = controller;
  const scan = new DiskScan(picked.filePaths[0]);
  disk.scan = null;
  try {
    await scan.walk({ signal: controller.signal, onProgress: (p) => sendToLibrary('disk:progress', p) });
  } catch (err) {
    if (err instanceof DiskAbortError) return { ok: false, reason: 'Scan cancelled.' };
    log.error('disk scan failed for', scan.root, err);
    return { ok: false, reason: `Could not read that folder: ${errorMessage(err)}` };
  } finally {
    if (disk.abort === controller) disk.abort = null;
  }
  disk.scan = scan;
  const root = scan.rootEntry();
  return { ok: true, root, entries: (await scan.list(root.id)) ?? [] };
}

/**
 * Whether sending `target` to the Recycle Bin would take a meeting in progress
 * with it — the folder being recorded into, or one whose notes are being
 * written, or any folder that holds either.
 */
function diskTrashBlocked(target: string): string {
  const busy = [...state.jobs.keys()];
  if (state.phase === 'recording' && state.currentDir) busy.push(state.currentDir);
  if (busy.some((dir) => isWithin(target, dir))) return 'A meeting in there is still being recorded or processed.';
  return '';
}

/** Moves an entry the page was shown to the Recycle Bin, after asking. */
async function trashDiskEntry(id: number): Promise<Outcome> {
  const scan = disk.scan;
  const node = scan?.resolve(id);
  if (!scan || !node) return { ok: false, reason: 'That entry is not in the current scan any more.' };
  if (node.path === scan.root) return { ok: false, reason: 'The folder being measured cannot be deleted from here.' };
  const blocked = diskTrashBlocked(node.path);
  if (blocked) return { ok: false, reason: blocked };

  const confirmed = await confirm({
    type: 'warning',
    buttons: ['Move to Recycle Bin', 'Keep'],
    defaultId: 1,
    cancelId: 1,
    title: 'Move to the Recycle Bin?',
    message: `Move this ${node.isDirectory ? 'folder' : 'file'} to the Recycle Bin?`,
    detail: node.path,
  });
  if (!confirmed) return { ok: false };

  const failure = await shell.trashItem(node.path).then(
    () => '',
    (err: unknown) => errorMessage(err),
  );
  if (failure) {
    log.error('could not trash', node.path, failure);
    return { ok: false, reason: `Windows would not move that to the Recycle Bin: ${failure}` };
  }
  log.info('trashed from disk usage', node.path);
  disk.scan?.forget(id);
  // It may have been a meeting, or the notes folder's parent.
  notifyLibrary();
  return { ok: true };
}

/**
 * The folder comes from a dialog and every later call names an entry by the id
 * the scan issued — never a path, in either direction.
 */
export function registerDiskIpc(): void {
  onLibraryClosed(() => {
    cancelDiskScan();
    disk.scan = null;
  });

  ipcMain.handle('disk:choose', (event) => {
    if (!fromLibrary(event)) return { ok: false };
    return chooseDiskFolder();
  });

  ipcMain.handle('disk:cancel', (event) => {
    if (!fromLibrary(event)) return false;
    cancelDiskScan();
    return true;
  });

  ipcMain.handle('disk:list', async (event, id: unknown) => {
    if (!fromLibrary(event) || !disk.scan) return null;
    try {
      return await disk.scan.list(diskId(id));
    } catch (err) {
      log.error('disk list failed', err);
      return null;
    }
  });

  ipcMain.handle('disk:reveal', (event, id: unknown) => {
    if (!fromLibrary(event)) return false;
    const node = disk.scan?.resolve(diskId(id));
    if (!node) return false;
    shell.showItemInFolder(node.path);
    return true;
  });

  ipcMain.handle('disk:trash', (event, id: unknown) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return trashDiskEntry(diskId(id));
  });
}
