// The library window's channels — the archive, quick copy, the to-do list — the
// live transcript window's two, and the protocol the reader's player loads
// audio from.
//
// The library reads the notes folder and nothing else. Every channel is
// sender-checked with fromLibrary, and the folder name a page sends back is
// resolved by library.ts rather than trusted as a path — the notes folder is
// full of user files, and a window that could name any path could hand any of
// them to the shell. library.ts itself never writes; the three things the
// archive nonetheless has to allow (rename, delete, reprocess) are done here
// and in recording.ts, after the same resolution.

import { clipboard, ipcMain, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';

import log from '../logger';
import * as library from '../library';
import * as snippetsStore from '../snippets';
import * as todosStore from '../todos';
import { AUDIO_SCHEME, monoSize, monoStream, parseRange, wavLayout } from '../audio-serve';
import { FILES, normaliseTitle } from '../paths';
import { errorMessage } from '../errors';
import { ctx, field, state } from '../context';
import { confirm, fromLibrary, fromTranscript, windows } from '../windows';
import { health, libraryActivity, notifyLibrary, notifySettings, refreshTray } from '../ui';
import { meetingBusy, reprocessMeeting, startRecording, stopRecording } from '../recording';
import type { LibraryList, Outcome } from '../../shared/types';

/**
 * Moves a meeting to the Recycle Bin.
 *
 * `trashItem` rather than an rm: this is a folder holding the only copy of a
 * conversation, and the difference between the two is whether a misclick is
 * recoverable. The confirmation is raised here rather than in the page for the
 * same reason it is a native dialog anywhere — the window that would be asking
 * is the window doing the asking.
 *
 * @param id meeting folder name
 */
async function deleteMeeting(id: string): Promise<Outcome> {
  const dir = library.meetingDir(ctx.settings.notesDir, id);
  if (!dir) return { ok: false, reason: 'That recording is not in the meetings folder any more.' };
  const busy = meetingBusy(dir);
  if (busy) return { ok: false, reason: busy };

  const card = await library.describeMeeting(dir);
  const confirmed = await confirm({
    type: 'warning',
    buttons: ['Move to Recycle Bin', 'Keep'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete this recording?',
    message: `Delete “${card?.title ?? id}”?`,
    detail:
      'The audio, the transcript, the notes and the brief all go to the Recycle Bin together. ' +
      'Nothing else in Minarrador keeps a copy.',
  });
  if (!confirmed) return { ok: false };

  const failure = await shell.trashItem(dir).then(
    () => '',
    (err: unknown) => errorMessage(err),
  );
  if (failure) {
    log.error('could not delete', dir, failure);
    return { ok: false, reason: `Windows would not move that folder to the Recycle Bin: ${failure}` };
  }
  log.info('deleted', dir);
  if (state.lastDir === dir) state.lastDir = null;
  notifyLibrary();
  return { ok: true };
}

/**
 * Retitles a meeting, or gives it back the title the model wrote.
 *
 * The folder name is left alone: it is the meeting's id everywhere — in
 * state.jobs, in the tray's retry item, in whatever the user has already
 * opened — and it is a timestamp, which is a better permanent name than
 * anything typed in a hurry. The title is what people read, and it goes in its
 * own file so the next pipeline run cannot overwrite it.
 */
function renameMeeting(id: string, title: unknown): Outcome {
  const dir = library.meetingDir(ctx.settings.notesDir, id);
  if (!dir) return { ok: false, reason: 'That recording is not in the meetings folder any more.' };
  const clean = normaliseTitle(title);
  try {
    if (clean) fs.writeFileSync(path.join(dir, FILES.title), `${clean}\n`);
    else fs.rmSync(path.join(dir, FILES.title), { force: true });
  } catch (err) {
    log.warn('could not rename', dir, errorMessage(err));
    return { ok: false, reason: `That title could not be saved: ${errorMessage(err)}` };
  }
  log.info(clean ? `renamed ${path.basename(dir)} to "${clean}"` : `reverted the title of ${path.basename(dir)}`);
  notifyLibrary();
  return { ok: true };
}

/**
 * Declares the audio protocol's privileges. Electron only accepts this before
 * the app is ready, so main.ts calls it at load time.
 *
 * `stream` is what lets a media element seek with Range requests; `standard`
 * gives the URL a host, so the meeting id is a clean path segment.
 */
export function registerAudioScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: AUDIO_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
}

/**
 * Serves `meeting-audio://meeting/<id>` as that meeting's audio, in mono.
 *
 * The id goes through openTarget like every other library request, so the
 * only file this can ever return is a meeting's audio.wav. The meeting being
 * recorded is refused: its header is not final, and the player would read a
 * file that is still growing.
 */
function handleAudio(): void {
  const empty = (status: number, headers: Record<string, string> = {}): Response =>
    new Response(null, { status, headers });

  protocol.handle(AUDIO_SCHEME, async (request) => {
    let id: string;
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'meeting') return empty(404);
      id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
      return empty(400);
    }
    const file = library.openTarget(ctx.settings.notesDir, id, 'audio');
    if (!file) return empty(404);
    if (state.phase === 'recording' && state.currentDir === path.dirname(file)) return empty(409);

    const layout = await wavLayout(file);
    if (!layout) return empty(415);
    const size = monoSize(layout);
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'invalid') return empty(416, { 'Content-Range': `bytes */${size}` });

    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = Readable.toWeb(monoStream(file, layout, start, end)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  });
}

export function registerLibraryIpc(): void {
  handleAudio();

  // Frameless windows have no system close button, so the page asks for one.
  ipcMain.on('transcript:close', (event) => {
    if (!fromTranscript(event)) return;
    windows.transcript?.close();
  });

  // The preview's "copy so far" is the one way text leaves that window. The
  // lines come from the page's own DOM, so this is a plain clipboard write.
  ipcMain.on('transcript:copy', (event, text: unknown) => {
    if (!fromTranscript(event)) return;
    clipboard.writeText(String(text ?? ''));
  });

  // Quick copy is edited in the library window's Quick copy feature. The store
  // normalises the payload regardless — it also has to survive a hand-edited
  // snippets.json.
  ipcMain.handle('snippets:list', (event) => {
    if (!fromLibrary(event)) return [];
    return snippetsStore.load();
  });

  ipcMain.handle('snippets:save', (event, list: unknown) => {
    if (!fromLibrary(event)) return [];
    const saved = snippetsStore.save(list);
    // The menu is rebuilt from the store, so a save is what makes a new
    // shorthand clickable — no restart, no reopening the menu twice.
    refreshTray();
    // The settings pane counts them, and the editor is opened from it.
    notifySettings();
    log.info(`quick copy: ${saved.length} shorthand(s) saved`);
    return saved;
  });

  // The to-do list is edited only in the library window's To-do feature, so it
  // is sender-checked exactly like quick copy, and the store normalises the
  // payload regardless.
  ipcMain.handle('todos:list', (event) => {
    if (!fromLibrary(event)) return [];
    return todosStore.load();
  });

  ipcMain.handle('todos:save', (event, list: unknown) => {
    if (!fromLibrary(event)) return [];
    const saved = todosStore.save(list);
    log.info(`to-do: ${saved.length} task(s) saved`);
    return saved;
  });

  ipcMain.handle('library:list', async (event, req: unknown): Promise<LibraryList> => {
    if (!fromLibrary(event)) return { meetings: [], activity: libraryActivity() };
    const query = field(req, 'query');
    const searching = typeof query === 'string' && query.trim() !== '';
    const started = performance.now();
    try {
      const meetings = await library.listMeetings(ctx.settings.notesDir, { query: searching ? query : '' });
      // The measurement the async move was made for: a list that takes long
      // here is time the search box spends waiting, not the recording.
      log.info(
        `library list: ${meetings.length} meeting(s) in ${Math.round(performance.now() - started)} ms` +
          (searching ? ' (search)' : ''),
      );
      return { meetings, activity: libraryActivity() };
    } catch (err) {
      log.error('library list failed', err);
      return { meetings: [], activity: libraryActivity() };
    }
  });

  ipcMain.handle('library:read', async (event, id: unknown) => {
    if (!fromLibrary(event)) return null;
    try {
      return await library.readMeeting(ctx.settings.notesDir, id);
    } catch (err) {
      log.error('library read failed for', id, err);
      return null;
    }
  });

  ipcMain.handle('library:health', (event) => {
    if (!fromLibrary(event)) return null;
    return health();
  });

  ipcMain.handle('library:open', async (event, req: unknown) => {
    if (!fromLibrary(event)) return false;
    const file = library.openTarget(ctx.settings.notesDir, field(req, 'id'), field(req, 'target'));
    if (!file) return false;
    const err = await shell.openPath(file);
    if (err) log.warn('could not open', file, err);
    return !err;
  });

  ipcMain.handle('library:openNotesFolder', async (event) => {
    if (!fromLibrary(event)) return false;
    const err = await shell.openPath(ctx.settings.notesDir);
    if (err) log.warn('could not open the notes folder:', err);
    return !err;
  });

  // The library is a reader, so the clipboard is the one way text leaves it.
  ipcMain.on('library:copy', (event, text: unknown) => {
    if (!fromLibrary(event)) return;
    clipboard.writeText(String(text ?? ''));
  });

  ipcMain.on('library:minimize', (event) => {
    if (!fromLibrary(event)) return;
    windows.library?.minimize();
  });

  ipcMain.on('library:close', (event) => {
    if (!fromLibrary(event)) return;
    windows.library?.close();
  });

  // Producing the notes for a meeting that has none — the way out of the app's
  // most likely failure, and the reason the reader's "Generate notes" button
  // exists. The id is a folder name and reprocessMeeting resolves it through
  // library.meetingDir like every other channel here.
  ipcMain.handle('library:reprocess', (event, id: unknown) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return reprocessMeeting(String(id ?? ''));
  });

  // The two ways the archive changes. Both name a meeting and nothing else, and
  // both are done here rather than in library.ts, which stays a reader.
  ipcMain.handle('library:delete', async (event, id: unknown) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return deleteMeeting(String(id ?? ''));
  });

  ipcMain.handle('library:rename', (event, req: unknown) => {
    if (!fromLibrary(event)) return { ok: false, reason: '' };
    return renameMeeting(String(field(req, 'id') ?? ''), field(req, 'title'));
  });

  // Starting a meeting from the library rather than the tray. Neither call is
  // awaited: startRecording is synchronous, and stopRecording runs the whole
  // pipeline, which is minutes of work no click should hang on. The window finds
  // out what happened from library:changed, the same way it finds out about a
  // recording started from the tray.
  ipcMain.handle('library:record', (event, on: unknown) => {
    if (!fromLibrary(event)) return false;
    if (on) {
      startRecording();
    } else {
      stopRecording().catch((err: unknown) => log.error('stop from the library failed', err));
    }
    return true;
  });
}
