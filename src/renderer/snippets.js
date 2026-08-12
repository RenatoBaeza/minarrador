'use strict';

// View layer for the quick-copy editor. Everything it can do is bounded by the
// `quickCopy` bridge in snippets-preload.js; it has no Node access.
//
// The list is edited as a whole and saved as a whole: there is no per-item
// identity to keep in sync, so deleting a card is simply not sending it.

const list = document.getElementById('list');
const empty = document.getElementById('empty');
// Detached until the first render says whether it is needed, so a window that
// does have shorthands never flashes "nothing here yet" while they load.
empty.remove();
// Not `status`: that name is a built-in window property and assigning to it
// would silently write to the browser status bar instead of this element.
const statusEl = document.getElementById('status');

/** Mirrors LIMITS in src/main/snippets.js, so the store never has to truncate. */
const MAX = { label: 60, text: 20_000 };

let dirty = false;
let saving = false;

function setDirty(value) {
  dirty = value;
  statusEl.textContent = value ? 'Unsaved changes' : 'Saved';
  statusEl.classList.toggle('dirty', value);
}

/** Shows the placeholder only while there is genuinely nothing to show. */
function refreshEmpty() {
  if (list.querySelector('.card')) empty.remove();
  else list.append(empty);
}

function card(snippet = { label: '', text: '' }) {
  const row = document.createElement('div');
  row.className = 'card';

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'name';
  name.maxLength = MAX.label;
  name.placeholder = 'Name (optional) — this is what the tray shows';
  name.value = snippet.label;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.title = 'Delete';
  remove.setAttribute('aria-label', 'Delete shorthand');
  remove.textContent = '✕';
  remove.addEventListener('click', () => {
    row.remove();
    refreshEmpty();
    setDirty(true);
  });

  const text = document.createElement('textarea');
  text.className = 'text';
  text.rows = 3;
  text.maxLength = MAX.text;
  text.placeholder = 'The text to put on the clipboard…';
  text.value = snippet.text;

  const top = document.createElement('div');
  top.className = 'card-top';
  top.append(name, remove);
  row.append(top, text);
  return row;
}

function render(snippets) {
  list.replaceChildren(...snippets.map(card));
  refreshEmpty();
}

const collect = () =>
  [...list.querySelectorAll('.card')].map((row) => ({
    label: row.querySelector('.name').value,
    text: row.querySelector('.text').value,
  }));

/**
 * Writes the list and marks whatever the store refused to keep.
 *
 * Never re-renders from the result: a card with an empty body is dropped by the
 * store, and making it vanish while someone is still filling it in would look
 * like the editor eating their work. The card stays, flagged, and starts
 * counting the moment it has text.
 */
async function save() {
  if (saving) return;
  saving = true;
  try {
    const stored = await window.quickCopy.save(collect());
    setDirty(false);
    if (stored.length !== list.querySelectorAll('.card').length) {
      for (const row of list.querySelectorAll('.card')) {
        row.classList.toggle('incomplete', !row.querySelector('.text').value.trim());
      }
    }
  } catch {
    // The store writes to disk; if that failed the work is still on screen, and
    // saying so beats a silent "Saved".
    statusEl.textContent = 'Could not save';
    statusEl.classList.add('dirty');
  } finally {
    saving = false;
  }
}

/** Closing is not a way to discard: whatever is on screen goes to disk first. */
async function closeWindow() {
  if (dirty) await save();
  window.quickCopy.close();
}

list.addEventListener('input', (e) => {
  e.target.closest('.card')?.classList.remove('incomplete');
  setDirty(true);
});

document.getElementById('add').addEventListener('click', () => {
  const row = card();
  empty.remove();
  list.append(row);
  row.querySelector('.name').focus();
  list.scrollTop = list.scrollHeight;
  setDirty(true);
});

document.getElementById('save').addEventListener('click', () => save());
document.getElementById('close').addEventListener('click', () => closeWindow());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeWindow();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

window.quickCopy.list().then((snippets) => {
  render(snippets);
  setDirty(false);
});
