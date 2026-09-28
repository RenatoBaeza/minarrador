// The Quick copy feature: the list behind the tray's top section, and the
// editor behind each shorthand.

import type { Snippet } from '../shared/types';
import { el, readerEl, view } from './library-common.js';

/**
 * How long quick copy waits after the last keystroke before writing the list.
 * The tray is rebuilt on every save, so this is about not doing that per key.
 */
export const QUICK_COPY_SAVE_MS = 600;

/** Mirrors LIMITS in src/main/snippets.ts, so the store never has to truncate. */
export const QUICK_COPY_MAX = { label: 60, text: 20_000 };

// ----------------------------------------------------------------- quick copy

/**
 * The quick-copy editor: the list behind the tray's top section.
 *
 * Edited as a whole and saved as a whole — there is no per-item identity to
 * keep in sync, so deleting a card is simply not sending it. It saves itself a
 * moment after the typing stops, and again on the way out of the feature or
 * the window, so there is no state in which work on screen is not on its way
 * to disk.
 */
export const quickCopy = {
  dirty: false,
  saving: null as Promise<void> | null,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  listEl: null as HTMLElement | null,
  statusEl: null as HTMLElement | null,
};

/** A quick-copy row's two fields; the card builds both, so both are always there. */
export const qcName = (row: Element): HTMLInputElement => row.querySelector('.qc-name') as HTMLInputElement;
export const qcText = (row: Element): HTMLTextAreaElement => row.querySelector('.qc-text') as HTMLTextAreaElement;

export function setQuickCopyStatus(text: string, dirty: boolean): void {
  if (!quickCopy.statusEl) return;
  quickCopy.statusEl.textContent = text;
  quickCopy.statusEl.classList.toggle('dirty', dirty);
}

export function markQuickCopyDirty() {
  quickCopy.dirty = true;
  setQuickCopyStatus('Unsaved changes', true);
  clearTimeout(quickCopy.timer);
  quickCopy.timer = setTimeout(() => saveQuickCopy(), QUICK_COPY_SAVE_MS);
}

/** How many lines a card's text runs to beyond the one the card shows. */
export function refreshCardMore(row: HTMLElement): void {
  const extra = qcText(row).value.split('\n').length - 1;
  const more = row.querySelector('.qc-more') as HTMLElement;
  more.hidden = extra < 1;
  more.textContent = `+${extra} line${extra === 1 ? '' : 's'}`;
}

/**
 * One shorthand as a single compact row: name, the first line of the text, and
 * two icon buttons. The text still edits in place — it grows to fit while it
 * has focus — and the pencil opens the full editor for anything longer.
 */
export function quickCopyCard(snippet: Snippet = { label: '', text: '' }): HTMLElement {
  const row = el('div', 'qc-card');

  // The row is draggable only while the grip is held: a draggable ancestor
  // would otherwise swallow the mouse gestures that select text in the fields.
  const grip = el('button', 'qc-grip', '⋮⋮');
  grip.type = 'button';
  grip.title = 'Drag to reorder (or Alt+↑ / Alt+↓)';
  grip.setAttribute('aria-label', 'Reorder shorthand');
  grip.addEventListener('pointerdown', () => {
    row.draggable = true;
  });
  grip.addEventListener('pointerup', () => {
    row.draggable = false;
  });
  grip.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const sibling = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling?.classList.contains('qc-card')) return;
    if (e.key === 'ArrowUp') sibling.before(row);
    else sibling.after(row);
    grip.focus();
    markQuickCopyDirty();
  });

  const name = el('input', 'qc-name');
  name.type = 'text';
  name.maxLength = QUICK_COPY_MAX.label;
  name.placeholder = 'Name (optional)';
  name.title = 'What the tray shows';
  name.value = snippet.label;

  const text = el('textarea', 'qc-text');
  text.rows = 1;
  text.maxLength = QUICK_COPY_MAX.text;
  text.placeholder = 'Text to put on the clipboard…';
  text.value = snippet.text;
  text.spellcheck = false;

  const more = el('span', 'qc-more');
  more.hidden = true;

  const edit = el('button', 'qc-icon qc-edit', '✎');
  edit.type = 'button';
  edit.title = 'Open in editor';
  edit.setAttribute('aria-label', 'Open shorthand in editor');
  edit.addEventListener('click', () => openQuickCopyEditor(row));

  const remove = el('button', 'qc-icon qc-remove', '✕');
  remove.type = 'button';
  remove.title = 'Delete';
  remove.setAttribute('aria-label', 'Delete shorthand');
  remove.addEventListener('click', () => {
    row.remove();
    refreshQuickCopyEmpty();
    markQuickCopyDirty();
  });

  const field = el('div', 'qc-field');
  field.append(text, more);
  row.append(grip, name, field, edit, remove);
  text.addEventListener('input', () => refreshCardMore(row));
  refreshCardMore(row);
  return row;
}

// ------------------------------------------------------- quick copy editor

/**
 * The full editor behind a card's pencil: a large plain-text area with the
 * tools a clipboard phrase actually needs — case, whitespace, line joins,
 * bullets, find and replace, a date stamp — and a live count against the
 * store's limit.
 *
 * Every tool edits through `insertText`, so each one is a single step on the
 * textarea's own undo stack and Ctrl+Z behaves the way it does everywhere else.
 * Closing keeps the edit (Escape, ✕, Done, a click outside); only "Discard
 * changes" throws it away, since no key in this app is a way to lose work.
 */
export interface QcEditor {
  dialog: HTMLDialogElement | null;
  /** The card being edited. */
  row: HTMLElement | null;
  /** What the card held when the editor opened, so an unchanged close is a no-op. */
  original: Snippet | null;
  name: HTMLInputElement;
  text: HTMLTextAreaElement;
  stats: HTMLElement;
  findBar: HTMLElement | null;
  find: HTMLInputElement;
  replace: HTMLInputElement;
  matchCase: HTMLInputElement;
  findCount: HTMLElement;
}

/**
 * The editor's state and controls. The controls are built once, by
 * buildQuickCopyEditor, before anything that reads them can run — every tool
 * lives inside the dialog it builds.
 */
export const qcEditor = { dialog: null, row: null, original: null, findBar: null } as QcEditor;

/** Replaces the selection — or, with nothing selected, everything — undoably. */
export function qcReplaceSelection(fn: (text: string) => string, { whole = false }: { whole?: boolean } = {}): void {
  const t = qcEditor.text;
  t.focus();
  let { selectionStart: a, selectionEnd: b } = t;
  if (whole || a === b) {
    a = 0;
    b = t.value.length;
  }
  const before = t.value.slice(a, b);
  const after = fn(before).slice(0, QUICK_COPY_MAX.text - (t.value.length - before.length));
  if (after === before) return;
  t.setSelectionRange(a, b);
  document.execCommand('insertText', false, after);
  t.setSelectionRange(a, a + after.length);
  qcRefreshStats();
}

export function qcInsert(str: string): void {
  qcEditor.text.focus();
  document.execCommand('insertText', false, str);
  qcRefreshStats();
}

export function qcHistory(command: 'undo' | 'redo'): void {
  qcEditor.text.focus();
  document.execCommand(command);
  qcRefreshStats();
}

export const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s\-("'“‘])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
export const sentenceCase = (s: string): string => s.toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_, p, c) => p + c.toUpperCase());

export function toggleBullets(s: string): string {
  const lines = s.split('\n');
  const bulleted = lines.filter((l) => l.trim()).every((l) => /^\s*[•\-*] /.test(l));
  return lines.map((l) => (!l.trim() ? l : bulleted ? l.replace(/^(\s*)[•\-*] /, '$1') : `• ${l}`)).join('\n');
}

/** The toolbar, in groups. A tool with `toggle` is a pressed/unpressed switch. */
export interface QcTool {
  label: string;
  title: string;
  toggle?: string;
  pressed?: boolean;
  run: (button: HTMLButtonElement) => void;
}

export const QC_TOOLS: QcTool[][] = [
  [
    { label: '↶', title: 'Undo (Ctrl+Z)', run: () => qcHistory('undo') },
    { label: '↷', title: 'Redo (Ctrl+Y)', run: () => qcHistory('redo') },
  ],
  [
    { label: 'AB', title: 'UPPERCASE', run: () => qcReplaceSelection((s) => s.toUpperCase()) },
    { label: 'ab', title: 'lowercase', run: () => qcReplaceSelection((s) => s.toLowerCase()) },
    { label: 'Ab', title: 'Title Case', run: () => qcReplaceSelection(titleCase) },
    { label: 'Ab.', title: 'Sentence case', run: () => qcReplaceSelection(sentenceCase) },
  ],
  [
    {
      label: 'Trim',
      title: 'Remove trailing spaces, and blank lines at the start and end',
      run: () => qcReplaceSelection((s) => s.replace(/[ \t]+$/gm, '').replace(/^\s*\n|\n\s*$/g, ''), { whole: true }),
    },
    { label: '¶', title: 'Collapse runs of blank lines into one', run: () => qcReplaceSelection((s) => s.replace(/\n{3,}/g, '\n\n')) },
    { label: 'Join', title: 'Join the selected lines into one', run: () => qcReplaceSelection((s) => s.replace(/[ \t]*\n+[ \t]*/g, ' ')) },
    { label: '•', title: 'Toggle bullets on the selected lines', run: () => qcReplaceSelection(toggleBullets) },
  ],
  [
    {
      label: 'Date',
      title: "Insert today's date",
      run: () => qcInsert(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })),
    },
    {
      label: 'Time',
      title: 'Insert the current time',
      run: () => qcInsert(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
    },
  ],
  [
    { label: 'Find', title: 'Find and replace (Ctrl+F)', toggle: 'find', run: () => qcToggleFind() },
    { label: 'Wrap', title: 'Wrap long lines', toggle: 'wrap', pressed: true, run: (b) => qcToggleClass(b, 'nowrap', true) },
    { label: 'Mono', title: 'Monospaced font', toggle: 'mono', run: (b) => qcToggleClass(b, 'mono') },
  ],
];

export function qcToggleClass(btn: HTMLButtonElement, cls: string, inverted = false): void {
  const on = qcEditor.text.classList.toggle(cls);
  btn.setAttribute('aria-pressed', String(inverted ? !on : on));
  qcEditor.text.focus();
}

export function qcRefreshStats() {
  const t = qcEditor.text;
  const v = t.value;
  const words = (v.match(/\S+/g) ?? []).length;
  const lines = v ? v.split('\n').length : 0;
  const upto = v.slice(0, t.selectionStart).split('\n');
  const sel = Math.abs(t.selectionEnd - t.selectionStart);
  qcEditor.stats.textContent =
    `${v.length.toLocaleString()} / ${QUICK_COPY_MAX.text.toLocaleString()} chars · ` +
    `${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'} · ` +
    `Ln ${upto.length}, Col ${upto[upto.length - 1].length + 1}` +
    (sel ? ` · ${sel} selected` : '');
  qcEditor.stats.classList.toggle('full', v.length >= QUICK_COPY_MAX.text);
  qcRefreshFindCount();
}

// Find and replace works on literal text, never a regex, so nothing typed misfires.

export const qcFold = (s: string): string => (qcEditor.matchCase.checked ? s : s.toLowerCase());

export function qcRefreshFindCount() {
  if (!qcEditor.findBar || qcEditor.findBar.hidden) return;
  const n = qcFold(qcEditor.find.value);
  qcEditor.findCount.textContent = n ? `${qcFold(qcEditor.text.value).split(n).length - 1} found` : '';
}

export function qcFindNext() {
  const n = qcFold(qcEditor.find.value);
  if (!n) return;
  const t = qcEditor.text;
  const hay = qcFold(t.value);
  let at = hay.indexOf(n, t.selectionEnd);
  if (at === -1) at = hay.indexOf(n); // wrap round to the top
  if (at === -1) return;
  t.focus();
  t.setSelectionRange(at, at + n.length);
  // Selecting does not always scroll a textarea to the match; bring it into view.
  const lh = parseFloat(getComputedStyle(t).lineHeight) || 20;
  const y = (t.value.slice(0, at).split('\n').length - 1) * lh;
  if (y < t.scrollTop || y > t.scrollTop + t.clientHeight - lh) t.scrollTop = Math.max(0, y - 2 * lh);
  qcRefreshStats();
}

export function qcReplaceOne() {
  const t = qcEditor.text;
  const n = qcFold(qcEditor.find.value);
  if (n && qcFold(t.value.slice(t.selectionStart, t.selectionEnd)) === n) {
    t.focus();
    document.execCommand('insertText', false, qcEditor.replace.value);
  }
  qcFindNext();
}

export function qcReplaceAll() {
  const n = qcEditor.find.value;
  if (!n) return;
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), qcEditor.matchCase.checked ? 'g' : 'gi');
  const rep = qcEditor.replace.value;
  qcReplaceSelection((s) => s.replace(re, () => rep), { whole: true });
}

export function qcToggleFind(force?: boolean): void {
  const bar = qcEditor.findBar;
  if (!bar) return;
  bar.hidden = force === undefined ? !bar.hidden : !force;
  qcEditor.dialog?.querySelector('[data-toggle="find"]')?.setAttribute('aria-pressed', String(!bar.hidden));
  if (bar.hidden) {
    qcEditor.text.focus();
    return;
  }
  const t = qcEditor.text;
  const sel = t.value.slice(t.selectionStart, t.selectionEnd);
  if (sel && !sel.includes('\n')) qcEditor.find.value = sel;
  qcEditor.find.focus();
  qcEditor.find.select();
  qcRefreshFindCount();
}

/** A button that acts on the textarea without taking its selection away first. */
export function qcButton(
  className: string,
  label: string,
  title: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => onClick(b));
  return b;
}

export function buildQuickCopyEditor() {
  const dialog = el('dialog', 'qc-editor');
  dialog.setAttribute('aria-label', 'Edit shorthand');

  const head = el('div', 'qce-head');
  const name = el('input', 'qce-name');
  name.type = 'text';
  name.maxLength = QUICK_COPY_MAX.label;
  name.placeholder = 'Name (optional) — this is what the tray shows';
  head.append(name, qcButton('qc-icon', '✕', 'Close (Esc) — keeps your changes', () => closeQuickCopyEditor(true)));

  const toolbar = el('div', 'qce-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  for (const group of QC_TOOLS) {
    const g = el('div', 'qce-group');
    for (const tool of group) {
      const b = qcButton('qce-tool', tool.label, tool.title, tool.run);
      if (tool.toggle) {
        b.dataset.toggle = tool.toggle;
        b.setAttribute('aria-pressed', String(Boolean(tool.pressed)));
      }
      g.append(b);
    }
    toolbar.append(g);
  }

  const findBar = el('div', 'qce-find');
  findBar.hidden = true;
  const find = el('input', 'qce-input');
  find.type = 'text';
  find.placeholder = 'Find';
  const replace = el('input', 'qce-input');
  replace.type = 'text';
  replace.placeholder = 'Replace with';
  const caseLabel = el('label', 'qce-case');
  caseLabel.title = 'Match case';
  const matchCase = el('input');
  matchCase.type = 'checkbox';
  caseLabel.append(matchCase, document.createTextNode('Aa'));
  const findCount = el('span', 'qce-count');
  find.addEventListener('input', () => qcRefreshFindCount());
  matchCase.addEventListener('change', () => qcRefreshFindCount());
  find.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    qcFindNext();
  });
  replace.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) qcReplaceAll();
    else qcReplaceOne();
  });
  findBar.append(
    find,
    replace,
    caseLabel,
    findCount,
    qcButton('qce-tool', 'Next', 'Find next (Enter, F3)', qcFindNext),
    qcButton('qce-tool', 'Replace', 'Replace this match', qcReplaceOne),
    qcButton('qce-tool', 'All', 'Replace every match (Ctrl+Enter)', qcReplaceAll),
  );

  const text = el('textarea', 'qce-text');
  text.maxLength = QUICK_COPY_MAX.text;
  text.placeholder = 'The text to put on the clipboard…';
  for (const ev of ['input', 'select', 'keyup', 'mouseup']) text.addEventListener(ev, () => qcRefreshStats());
  text.addEventListener('keydown', (e) => {
    // Tab indents, as in any editor; Shift+Tab takes one indent back off.
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = text;
    if (a === b && !e.shiftKey) {
      qcInsert('\t');
      return;
    }
    text.setSelectionRange(text.value.lastIndexOf('\n', a - 1) + 1, b);
    qcReplaceSelection((s) => (e.shiftKey ? s.replace(/^(\t| {1,4})/gm, '') : s.replace(/^/gm, '\t')));
  });

  const foot = el('div', 'qce-foot');
  const stats = el('span', 'qce-stats');
  const copy = qcButton('button', 'Copy', 'Put this text on the clipboard now', (b) => {
    window.library.copy(text.value);
    b.textContent = 'Copied';
    setTimeout(() => {
      b.textContent = 'Copy';
    }, 1200);
  });
  foot.append(
    stats,
    qcButton('button danger', 'Discard changes', '', () => closeQuickCopyEditor(false)),
    copy,
    qcButton('button primary', 'Done', 'Save and close (Ctrl+Enter)', () => closeQuickCopyEditor(true)),
  );

  dialog.append(head, toolbar, findBar, text, foot);

  dialog.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault(); // no native cancel: closing goes through one path
      if (!findBar.hidden && findBar.contains(document.activeElement)) qcToggleFind(false);
      else closeQuickCopyEditor(true);
    } else if (mod && (key === 'enter' || key === 's') && !findBar.contains(document.activeElement)) {
      e.preventDefault();
      closeQuickCopyEditor(true);
    } else if (mod && (key === 'f' || key === 'h')) {
      e.preventDefault();
      qcToggleFind(true);
      if (key === 'h') replace.focus();
    } else if (e.key === 'F3') {
      e.preventDefault();
      qcFindNext();
    }
  });
  // A press on the backdrop lands on the dialog itself, outside its box.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeQuickCopyEditor(true);
  });

  document.body.append(dialog);
  Object.assign(qcEditor, { dialog, name, text, stats, findBar, find, replace, matchCase, findCount });
}

export function openQuickCopyEditor(row: HTMLElement): void {
  if (!qcEditor.dialog) buildQuickCopyEditor();
  const label = qcName(row).value;
  const text = qcText(row).value;
  qcEditor.row = row;
  qcEditor.original = { label, text };
  qcEditor.name.value = label;
  qcEditor.text.value = text;
  qcToggleFind(false);
  qcEditor.dialog?.showModal();
  qcEditor.text.focus();
  qcEditor.text.setSelectionRange(0, 0);
  qcEditor.text.scrollTop = 0;
  qcRefreshStats();
}

/** @param {boolean} keep write the edit back to the card, or throw it away */
export function closeQuickCopyEditor(keep: boolean): void {
  const { dialog, row, original } = qcEditor;
  if (!dialog?.open) return;
  const label = qcEditor.name.value;
  const text = qcEditor.text.value;
  dialog.close();
  qcEditor.row = null;
  if (!row?.isConnected) return; // deleted, or the pane re-rendered underneath
  row.querySelector<HTMLElement>('.qc-edit')?.focus();
  if (!keep || (label === original?.label && text === original?.text)) return;
  qcName(row).value = label;
  qcText(row).value = text;
  row.classList.remove('incomplete');
  refreshCardMore(row);
  markQuickCopyDirty();
  saveQuickCopy();
}

/** Shows the placeholder only while there is genuinely nothing to show. */
export function refreshQuickCopyEmpty() {
  const list = quickCopy.listEl;
  if (!list) return;
  const empty = list.querySelector('.none');
  if (list.querySelector('.qc-card')) empty?.remove();
  else if (!empty) {
    list.append(el('p', 'none', 'Nothing here yet. Add a shorthand and it appears at the top of the tray menu, ready to copy.'));
  }
}

export const collectQuickCopy = () =>
  [...(quickCopy.listEl?.querySelectorAll('.qc-card') ?? [])].map((row) => ({
    label: qcName(row).value,
    text: qcText(row).value,
  }));

/**
 * Writes the list and marks whatever the store refused to keep.
 *
 * Never re-renders from the result: a card with an empty body is dropped by the
 * store, and making it vanish while someone is still filling it in would look
 * like the editor eating their work. The card stays, flagged, and starts
 * counting the moment it has text.
 */
export async function saveQuickCopy() {
  clearTimeout(quickCopy.timer);
  if (quickCopy.saving) await quickCopy.saving;
  if (!quickCopy.dirty || !quickCopy.listEl) return;
  const cards = [...quickCopy.listEl.querySelectorAll('.qc-card')];
  quickCopy.dirty = false;
  setQuickCopyStatus('Saving…', false);
  quickCopy.saving = (async () => {
    try {
      await window.library.quickCopy.save(collectQuickCopy());
      if (!quickCopy.dirty) setQuickCopyStatus('Saved', false);
      for (const row of cards) row.classList.toggle('incomplete', !qcText(row).value.trim());
    } catch {
      // The store writes to disk; if that failed the work is still on screen,
      // and saying so beats a silent "Saved".
      quickCopy.dirty = true;
      setQuickCopyStatus('Could not save', true);
    } finally {
      quickCopy.saving = null;
    }
  })();
  await quickCopy.saving;
}

export async function renderQuickCopy() {
  const doc = el('div', 'doc');
  doc.append(
    el('h1', '', 'Quick copy'),
    el('p', 'settings-lead', 'Phrases you type all day. Each one becomes an item at the top of the tray menu that copies it on click.'),
  );

  const toolbar = el('div', 'qc-toolbar');
  const add = el('button', 'button primary', '+ New shorthand');
  add.type = 'button';
  const status = el('span', 'qc-status', 'Loading…');
  toolbar.append(add, status);

  const list = el('div', 'qc-list');
  list.addEventListener('input', (e) => {
    (e.target as Element).closest('.qc-card')?.classList.remove('incomplete');
    markQuickCopyDirty();
  });
  // Leaving a field is as good a moment as any to put it on disk.
  list.addEventListener('focusout', () => {
    if (quickCopy.dirty) saveQuickCopy();
  });
  // Drag to reorder. The card moves live under the pointer, so the drop is
  // only a confirmation; the order on screen is the order saved, and the tray
  // menu is rebuilt from that save.
  let dragged: HTMLElement | null = null;
  let startIndex = -1;
  const cardsOf = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('.qc-card')];
  list.addEventListener('dragstart', (e) => {
    const card = (e.target as Element).closest?.<HTMLElement>('.qc-card') ?? null;
    dragged = card;
    if (!card) return;
    startIndex = cardsOf().indexOf(card);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    }
    card.classList.add('dragging');
  });
  list.addEventListener('dragover', (e) => {
    const moving = dragged;
    if (!moving) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const after = cardsOf().find((card) => {
      if (card === moving) return false;
      const box = card.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (after) {
      if (after !== moving.nextElementSibling) after.before(moving);
    } else if (list.lastElementChild !== moving) {
      list.append(moving);
    }
  });
  list.addEventListener('drop', (e) => {
    if (dragged) e.preventDefault();
  });
  list.addEventListener('dragend', () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged.draggable = false;
    const moved = cardsOf().indexOf(dragged) !== startIndex;
    dragged = null;
    if (moved) {
      markQuickCopyDirty();
      saveQuickCopy();
    }
  });
  add.addEventListener('click', () => {
    const row = quickCopyCard();
    list.append(row);
    refreshQuickCopyEmpty();
    qcName(row).focus();
    row.scrollIntoView({ block: 'nearest' });
  });

  doc.append(toolbar, list);
  quickCopy.listEl = list;
  quickCopy.statusEl = status;
  quickCopy.dirty = false;
  readerEl.replaceChildren(doc);

  let snippets;
  try {
    snippets = await window.library.quickCopy.list();
  } catch {
    setQuickCopyStatus('Could not read the list', true);
    return;
  }
  // Someone clicked away, or back again, before the list arrived.
  if (view.mode !== 'quickcopy' || quickCopy.listEl !== list) return;
  list.replaceChildren(...snippets.map((snippet) => quickCopyCard(snippet)));
  refreshQuickCopyEmpty();
  setQuickCopyStatus('Saved', false);
}
