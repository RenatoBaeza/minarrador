'use strict';

// View layer for the dictations window. Every row is editable and every row
// saves itself: the text is a textarea that commits on blur, so an edit is
// saved the moment the cursor leaves the box. Copy and delete are per-row, and
// the whole list re-reads from the store whenever one arrives from a new
// dictation.

const listEl = document.getElementById('list');
const empty = document.getElementById('empty');
const statusEl = document.getElementById('status');
// Detached until the first render decides whether it is needed, so a window
// that does have dictations never flashes "nothing here yet".
empty.remove();

const MAX_TEXT = 20_000; // mirrors LIMITS.text in src/main/dictations.js

let dirty = new Set();
/** Saves in flight, keyed by id, so a blur can't double-fire one row's save. */
const pending = new Set();

/** How long ago a dictation was made, as a one-line label. */
function formatWhen(createdAt) {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (start === dayStart) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((dayStart - start) / 86_400_000);
  if (days === 1) return 'Yesterday';
  if (days > 0 && days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function setStatus(text, isDirty = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('dirty', isDirty);
}

function refreshEmpty() {
  if (listEl.querySelector('.card')) empty.remove();
  else listEl.append(empty);
}

function card(item) {
  const row = document.createElement('div');
  row.className = 'card';
  row.dataset.id = item.id;

  const top = document.createElement('div');
  top.className = 'card-top';
  top.append(el('span', 'when', formatWhen(item.createdAt) || item.createdAt));

  const copy = el('button', 'button', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => {
    window.dictations.copy(text.value);
    copy.textContent = 'Copied';
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1200);
  });
  top.append(copy);

  const remove = el('button', 'button danger', 'Delete');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    const result = await window.dictations.remove(item.id);
    if (result !== null) {
      dirty.delete(item.id);
      row.remove();
      refreshEmpty();
      setStatus(result.length ? 'Saved' : 'Empty');
    } else {
      remove.disabled = false;
    }
  });
  top.append(remove);

  const text = document.createElement('textarea');
  text.className = 'text';
  text.maxLength = MAX_TEXT;
  text.value = item.text;
  // Commit when the cursor leaves the box — the natural end of an edit.
  text.addEventListener('blur', () => saveOne(item.id, text, row));
  text.addEventListener('input', () => {
    dirty.add(item.id);
    text.classList.add('dirty');
    setStatus('Unsaved changes', true);
  });

  row.append(top, text);
  return row;
}

/** Saves one card that has changes; drops it silently if the row vanished. */
async function saveOne(id, textEl, row) {
  if (!dirty.has(id) || pending.has(id)) return;
  pending.add(id);
  try {
    const result = await window.dictations.update(id, textEl.value);
    if (result === null) {
      // Deleted elsewhere while this window sat open; the row is a ghost.
      row.remove();
      refreshEmpty();
      return;
    }
    dirty.delete(id);
    textEl.classList.remove('dirty');
    setStatus('Saved');
  } catch {
    setStatus('Could not save', true);
  } finally {
    pending.delete(id);
  }
}

/** Saves every card that still has changes — the way a close never loses work. */
async function saveAll() {
  for (const row of listEl.querySelectorAll('.card')) {
    const id = row.dataset.id;
    if (dirty.has(id)) {
      const textEl = row.querySelector('textarea.text');
      await saveOne(id, textEl, row);
    }
  }
}

function render(items) {
  listEl.replaceChildren(...items.map(card));
  dirty = new Set();
  setStatus(items.length ? 'Ready' : 'Empty');
  refreshEmpty();
}

async function refresh() {
  const items = await window.dictations.list();
  render(items);
}

/** Closing is not a way to discard work, exactly as the quick-copy editor does. */
async function closeWindow() {
  await saveAll();
  window.dictations.close();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

document.getElementById('close').addEventListener('click', () => closeWindow());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeWindow();
  }
});

// The window re-lists when a dictation lands, but never while it is being
// edited — a fresh render would eat an in-progress edit.
window.dictations.onChanged(async () => {
  if (dirty.size) return;
  await refresh();
});

window.dictations.list().then((items) => render(items));
