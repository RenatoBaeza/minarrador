// The library window: the app's front door, and a sidebar of features.
//
// This file is the page's entry point and owns what belongs to no one feature:
// the sidebar that switches between them, the keyboard, and the signals from
// main. Each feature is its own module beside it — library-reader (Recording),
// library-quickcopy, library-disk, library-todos, library-settings — sharing the
// helpers in library-common. Everything the window can do is bounded by the
// `library` bridge in library-preload.ts; it has no Node access and no path of
// its own — a meeting is a folder name it hands back to the main process.
//
// Loaded as an ES module (`<script type="module">`), so the features arrive as
// sibling imports with no bundler.

import { SECTIONS, byId, isSection, setNavigator, listEl, navEls, queryEl, readerEl, recordEl, searchingEl, sectionNameEl, view } from './library-common.js';
import { addLiveLine, openMeeting, refresh, renderPlaceholder, renderHealth, renderProgress, renderReader, select, toggleRecord } from './library-reader.js';
import { renderSettings } from './library-settings.js';
import { qcEditor, renderQuickCopy, saveQuickCopy } from './library-quickcopy.js';
import { renderTodos, saveTodos, tdEditor, todo } from './library-todos.js';
import { diskProgressText, diskView, renderDisk } from './library-disk.js';

/** Keystrokes settle before the main process reads every transcript on disk. */
const SEARCH_DEBOUNCE_MS = 180;

let searchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Switches the sidebar feature. Leaving quick copy or the to-do list writes it
 * first, so something typed a moment ago is never lost to a click elsewhere.
 */
async function showSection(mode: string): Promise<void> {
  if (!isSection(mode)) return;
  if (view.mode === 'quickcopy' && mode !== 'quickcopy') await saveQuickCopy();
  if (view.mode === 'todos' && mode !== 'todos') await saveTodos();
  const entering = view.mode !== mode;
  view.mode = mode;
  document.body.dataset.mode = mode;
  sectionNameEl.textContent = SECTIONS[mode];
  for (const item of navEls) {
    if (item.dataset.mode === mode) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (entering) readerEl.scrollTop = 0;

  if (mode === 'settings') {
    renderSettings(); // whatever was last read, so the pane is never blank
    view.settings = await window.library.settings.get();
    if (view.mode === 'settings') renderSettings();
  } else if (mode === 'quickcopy') {
    // Re-entering reloads from disk; staying put keeps what is being typed.
    if (entering) renderQuickCopy();
  } else if (mode === 'todos') {
    if (entering) renderTodos();
  } else if (mode === 'disk') {
    // The tree is kept while the window is open, so coming back finds it as left.
    if (entering) renderDisk();
  } else if (view.meeting) {
    renderReader(view.meeting);
  } else {
    renderPlaceholder();
  }
}

setNavigator(showSection);

/** Closing is not a way to discard: whatever is on screen goes to disk first. */
async function closeWindow() {
  await saveQuickCopy();
  await saveTodos();
  window.library.close();
}

recordEl.addEventListener('click', toggleRecord);

// ------------------------------------------------------------------- controls

queryEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    view.query = queryEl.value;
    // A search reads every transcript on disk, so it can outlast the keystroke;
    // say the wait is happening rather than leaving the rail to look unresponded.
    searchingEl.hidden = false;
    refresh();
    // Re-render the open meeting so its highlights follow the query.
    if (view.selected) select(view.selected);
  }, SEARCH_DEBOUNCE_MS);
});

/** Moves the selection through the rail, so a list can be read without the mouse. */
function step(delta: number): void {
  const ids = view.meetings.map((m) => m.id);
  if (!ids.length) return;
  const next = ids[Math.min(ids.length - 1, Math.max(0, ids.indexOf(view.selected ?? '') + delta))];
  if (next === view.selected) return;
  openMeeting(next);
  listEl.querySelector('.card.selected')?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  // The shorthand editor is modal and handles its own keys; nothing here —
  // Escape closing the window least of all — should act behind it.
  if (qcEditor.dialog?.open || tdEditor.dialog?.open) return;
  if (e.key === 'Escape') {
    // Escape backs out one layer at a time — another feature back to
    // Recording, then a search, then the window itself. Closing outright would
    // be the wrong guess twice.
    if (view.mode !== 'reader') {
      showSection('reader');
      return;
    }
    if (queryEl.value) {
      queryEl.value = '';
      view.query = '';
      refresh();
      return;
    }
    closeWindow();
    return;
  }
  // Ctrl+1, Ctrl+2… follow the sidebar top to bottom.
  if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    const item = document.querySelectorAll<HTMLElement>('.nav-features .nav-item')[Number(e.key) - 1];
    if (item) {
      e.preventDefault();
      void showSection(item.dataset.mode ?? '');
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && view.mode === 'quickcopy') {
    e.preventDefault();
    saveQuickCopy();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && view.mode === 'todos') {
    e.preventDefault();
    saveTodos();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && view.mode === 'todos') {
    e.preventDefault();
    todo.searchEl?.focus();
    todo.searchEl?.select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (view.mode !== 'reader') return;
    e.preventDefault();
    queryEl.focus();
    queryEl.select();
    return;
  }
  // Start/stop the recording and the settings pane, reachable without the
  // mouse from whichever feature is open.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    toggleRecord();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    showSection(view.mode === 'settings' ? 'reader' : 'settings');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
    // The only text boxes on this page are the search and a rename, and a box
    // with a selection in it has its own copy to do. Otherwise this is exactly
    // what the "Copy transcript" action button does — click it, so the "Copied"
    // feedback comes along for free.
    if (view.mode !== 'reader' || (e.target as Element).closest('input, textarea')) return;
    const copy = readerEl.querySelector<HTMLButtonElement>('[data-action="copy-transcript"]');
    if (copy && !copy.disabled) {
      e.preventDefault();
      copy.click();
    }
    return;
  }
  // Arrows walk the list unless they are being used to move a text cursor.
  if (
    (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
    view.mode === 'reader' &&
    !(e.target as Element).closest('input, textarea, select')
  ) {
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  }
});

byId('folder').addEventListener('click', () => void window.library.openNotesFolder());
byId('minimize').addEventListener('click', () => window.library.minimize());
byId('close').addEventListener('click', () => void closeWindow());
for (const item of navEls) item.addEventListener('click', () => void showSection(item.dataset.mode ?? ''));

// A run advancing is a number changing, not a folder changing: it updates what
// is on screen without anything being re-read from disk.
window.library.onProgress((activity) => renderProgress(activity));

// The live preview of the meeting being recorded, a caption at a time.
window.library.onLiveLine((line) => addLiveLine(line));

// A recording that just finished belongs at the top of the list without anyone
// having to reopen the window.
window.library.onChanged(async () => {
  await refresh();
  if (view.selected) select(view.selected);
  // Starting or stopping a meeting also decides whether the capture sources can
  // be changed, which only the settings pane shows.
  if (view.mode === 'settings') {
    view.settings = await window.library.settings.get();
    if (view.mode === 'settings') renderSettings();
  }
});

// A model list arriving, or Ollama coming up sixty seconds after someone
// started it, is the whole reason this pane can be trusted to say what is
// missing — so it redraws rather than waiting to be reopened. The empty-archive
// notice is built from the same state, so it follows along.
window.library.settings.onChanged(async () => {
  view.settings = await window.library.settings.get();
  if (view.mode === 'settings') renderSettings();
  else if (!view.selected) renderPlaceholder();
});

// A mic test reports a level roughly ten times a second; the meter moves in
// place, and only the start and the auto-stop re-render the row.
window.library.settings.onMicTest((p) => {
  if (typeof p.testing === 'boolean') view.micTest.testing = p.testing;
  if (typeof p.level === 'number') view.micTest.level = p.level;
  if (p.micError) view.micTest.note = `The microphone could not be opened: ${p.micError}`;
  else if (p.micLabel) view.micTest.note = `Hearing ${p.micLabel}.`;

  if (p.testing === false) {
    view.micTest = { testing: false, level: 0, note: '' };
    if (view.mode === 'settings') renderSettings();
    return;
  }
  const els = view.micTestEls;
  if (!els || view.mode !== 'settings') return;
  if (els.bar) els.bar.style.width = `${Math.min(100, Math.round(view.micTest.level * 600))}%`;
  if (els.note && view.micTest.note) els.note.textContent = view.micTest.note;
});

// A disk walk reports a few times a second; the counter moves in place.
window.library.disk.onProgress((p) => {
  if (!diskView.scanning) return;
  diskView.progress = p;
  const els = diskView.progressEl;
  if (!els || view.mode !== 'disk') return;
  els.counts.textContent = diskProgressText(p);
  els.current.textContent = p.current ?? '';
});

// The lights under the record button, pushed whenever what they report on
// changes — a source opening, Ollama answering, a recording's first seconds.
window.library.onHealth((health) => renderHealth(health));
void window.library.health().then(renderHealth);

// Main asking for a section, e.g. the tray's quick-copy "add one…" item.
window.library.onShow((section) => showSection(section));

// The settings are read at launch rather than when the pane is opened, because
// the placeholder is built from them: a first run with nothing installed opens
// onto an empty archive, and the reason it will stay empty belongs there.
Promise.all([refresh(), window.library.settings.get()]).then(([, settings]) => {
  view.settings = settings;
  // The tab is sticky across launches; the meeting is too, falling back to the
  // newest when it is gone — the window is usually opened to read the one that
  // just finished.
  if (sessionStorage.getItem('minarrador:tab') === 'transcript') view.tab = 'transcript';
  // A meeting being recorded wins over both: refresh() has already moved the
  // reader to it.
  const remembered = view.selected ?? sessionStorage.getItem('minarrador:lastMeeting');
  const first = view.meetings.find((m) => m.id === remembered) ?? view.meetings[0];
  if (first) select(first.id);
  else renderPlaceholder();
});
