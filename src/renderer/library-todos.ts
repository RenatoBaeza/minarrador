// The To-do feature: the task list, its sorts and filters, and the task editor.

import type { Todo, TodoPriority } from '../shared/types';
import { el, readerEl, startOfDay, view } from './library-common.js';
import { qcButton, type QcTool } from './library-quickcopy.js';

// ---------------------------------------------------------------------- to-do

/**
 * The to-do list: tasks with a title, a description written in a proper
 * editor, a project, a priority and a due date.
 *
 * `todo.items` is the page's copy of the whole list, in manual order — the
 * order someone dragged the tasks into. Sorting and filtering are views over
 * it, so sorting by due date and back never loses that order. Like quick copy,
 * the list is saved as a whole a moment after each change, and again on the
 * way out of the feature or the window.
 */

/** Mirrors LIMITS in src/main/todos.ts, so the store never has to truncate. */
export const TODO_MAX = { title: 200, project: 60, description: 50_000 };

/** Settles a burst of edits — a drag, a run of checkbox clicks — into one write. */
export const TODO_SAVE_MS = 400;

/** Lowest to highest. Mirrors PRIORITIES in src/main/todos.ts. */
export const PRIORITIES: readonly TodoPriority[] = ['none', 'low', 'medium', 'high'];
export const PRIORITY_LABEL: Record<TodoPriority, string> = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High' };

export type TodoSort = 'manual' | 'priority' | 'due' | 'project' | 'title' | 'created' | 'updated';

export const TODO_SORTS: Record<TodoSort, string> = {
  manual: 'My order',
  priority: 'Priority',
  due: 'Due date',
  project: 'Project',
  title: 'Title',
  created: 'Date added',
  updated: 'Last edited',
};

/** Which way each sort reads without the reverse button: most useful first. */
export const TODO_SORT_DESC: Record<TodoSort, boolean> = {
  manual: false,
  priority: true,
  due: false,
  project: false,
  title: false,
  created: true,
  updated: true,
};

/** The view's choices, remembered across launches in this browser profile. */
export interface TodoPrefs {
  sort: TodoSort;
  reverse: boolean;
  project: string; // '' every project, '\0' none
  showDone: boolean;
}

export const TODO_PREFS_KEY = 'minarrador:todoPrefs';
export const NO_PROJECT = '\0';

export function loadTodoPrefs(): TodoPrefs {
  const fallback: TodoPrefs = { sort: 'manual', reverse: false, project: '', showDone: false };
  try {
    const stored = JSON.parse(localStorage.getItem(TODO_PREFS_KEY) ?? 'null') as Partial<TodoPrefs> | null;
    if (!stored || typeof stored !== 'object') return fallback;
    return {
      sort: Object.hasOwn(TODO_SORTS, stored.sort ?? '') ? (stored.sort as TodoSort) : 'manual',
      reverse: stored.reverse === true,
      project: typeof stored.project === 'string' ? stored.project : '',
      showDone: stored.showDone === true,
    };
  } catch {
    return fallback;
  }
}

export function saveTodoPrefs(): void {
  try {
    localStorage.setItem(TODO_PREFS_KEY, JSON.stringify(todo.prefs));
  } catch {
    // A preference that does not stick is not worth an error.
  }
}

export const todo = {
  items: [] as Todo[],
  loaded: false,
  dirty: false,
  saving: null as Promise<void> | null,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  prefs: loadTodoPrefs(),
  query: '',
  listEl: null as HTMLElement | null,
  statusEl: null as HTMLElement | null,
  countEl: null as HTMLElement | null,
  searchEl: null as HTMLInputElement | null,
  projectSel: null as HTMLSelectElement | null,
};

export const newTodoId = (): string => crypto.randomUUID();

/** Today as YYYY-MM-DD in local time — the form a date input writes. */
export function localDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Overdue · 3 Sep", "Today", "Tomorrow", "Fri", "12 Oct" — what a list is scanned for. */
export function dueLabel(due: string, done: boolean): { text: string; className: string } | null {
  if (!due) return null;
  const today = localDay();
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = Math.round((date.getTime() - startOfDay(new Date()).getTime()) / 86_400_000);
  const sameYear = y === new Date().getFullYear();
  const short = date.toLocaleDateString([], sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  if (done) return { text: short, className: '' };
  if (due < today) return { text: `Overdue · ${short}`, className: 'overdue' };
  if (days === 0) return { text: 'Today', className: 'today' };
  if (days === 1) return { text: 'Tomorrow', className: 'soon' };
  if (days < 7) return { text: date.toLocaleDateString([], { weekday: 'long' }), className: 'soon' };
  return { text: short, className: '' };
}

export const projectsOf = (items: Todo[]): string[] =>
  [...new Set(items.map((t) => t.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

/**
 * The comparison each sort makes. Empty values — no due date, no project —
 * go last whichever way the list reads, since "no date" is not the earliest
 * date or the latest one.
 */
export function todoCompare(sort: TodoSort, reverse: boolean): (a: Todo, b: Todo) => number {
  const order = new Map(todo.items.map((t, i) => [t.id, i]));
  const manual = (a: Todo, b: Todo) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  const rank = (t: Todo) => PRIORITIES.indexOf(t.priority);
  const text = (x: string, y: string) => x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
  const desc = TODO_SORT_DESC[sort] !== reverse;
  const dir = (n: number) => (desc ? -n : n);
  // Blank goes last regardless of direction; otherwise compare, then fall through.
  const blankLast = (x: string, y: string, then: () => number) => (!x !== !y ? (x ? -1 : 1) : x === y ? then() : dir(text(x, y)));

  const primary: Record<TodoSort, (a: Todo, b: Todo) => number> = {
    manual: (a, b) => dir(manual(a, b)),
    priority: (a, b) => dir(rank(a) - rank(b)) || blankLast(a.due, b.due, () => manual(a, b)) || manual(a, b),
    due: (a, b) => blankLast(a.due, b.due, () => rank(b) - rank(a) || manual(a, b)),
    project: (a, b) => blankLast(a.project, b.project, () => manual(a, b)),
    title: (a, b) => dir(text(a.title, b.title)) || manual(a, b),
    created: (a, b) => dir(a.createdAt.localeCompare(b.createdAt)) || manual(a, b),
    updated: (a, b) => dir(a.updatedAt.localeCompare(b.updatedAt)) || manual(a, b),
  };
  // Finished tasks sink below open ones, whatever the sort.
  return (a, b) => Number(a.done) - Number(b.done) || primary[sort](a, b);
}

/** What the list shows: filtered by project, completion and the search box, then sorted. */
export function visibleTodos(): Todo[] {
  const { project, showDone, sort, reverse } = todo.prefs;
  const needle = todo.query.trim().toLowerCase();
  return todo.items
    .filter((t) => showDone || !t.done)
    .filter((t) => !project || (project === NO_PROJECT ? !t.project : t.project === project))
    .filter((t) => !needle || `${t.title}\n${t.project}\n${t.description}`.toLowerCase().includes(needle))
    .sort(todoCompare(sort, reverse));
}

/** Dragging only makes sense when the list on screen is in the saved order. */
export const todoDraggable = (): boolean => todo.prefs.sort === 'manual' && !todo.prefs.reverse;

export function setTodoStatus(text: string, dirty: boolean): void {
  if (!todo.statusEl) return;
  todo.statusEl.textContent = text;
  todo.statusEl.classList.toggle('dirty', dirty);
}

export function markTodosDirty(): void {
  todo.dirty = true;
  setTodoStatus('Unsaved changes', true);
  clearTimeout(todo.timer);
  todo.timer = setTimeout(() => saveTodos(), TODO_SAVE_MS);
}

/** Changes one task and stamps it, then redraws the list. */
export function updateTodo(id: string, patch: Partial<Todo>): void {
  const index = todo.items.findIndex((t) => t.id === id);
  if (index === -1) return;
  todo.items[index] = { ...todo.items[index], ...patch, updatedAt: new Date().toISOString() };
  markTodosDirty();
  drawTodos();
}

export function removeTodo(id: string): void {
  todo.items = todo.items.filter((t) => t.id !== id);
  markTodosDirty();
  drawTodos();
}

export async function saveTodos(): Promise<void> {
  clearTimeout(todo.timer);
  if (todo.saving) await todo.saving;
  if (!todo.dirty || !todo.loaded) return;
  todo.dirty = false;
  setTodoStatus('Saving…', false);
  todo.saving = (async () => {
    try {
      await window.library.todos.save(todo.items);
      if (!todo.dirty) setTodoStatus('Saved', false);
    } catch {
      // The work is still on screen; say it did not reach the disk.
      todo.dirty = true;
      setTodoStatus('Could not save', true);
    } finally {
      todo.saving = null;
    }
  })();
  await todo.saving;
}

/** A new task at the top of the manual order — the one just thought of is the one being looked at. */
export function addTodo(title: string, extra: Partial<Todo> = {}): Todo {
  const now = new Date().toISOString();
  const project = todo.prefs.project && todo.prefs.project !== NO_PROJECT ? todo.prefs.project : '';
  const item: Todo = {
    id: newTodoId(),
    title: title.replace(/\s+/g, ' ').trim().slice(0, TODO_MAX.title),
    description: '',
    project,
    priority: 'none',
    due: '',
    done: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  todo.items.unshift(item);
  return item;
}

export function todoRow(t: Todo, draggable: boolean): HTMLElement {
  const row = el('div', `td-row${t.done ? ' done' : ''} p-${t.priority}`);
  row.dataset.id = t.id;

  if (draggable) {
    const grip = el('button', 'qc-grip td-grip', '⋮⋮');
    grip.type = 'button';
    grip.title = 'Drag to reorder (or Alt+↑ / Alt+↓)';
    grip.setAttribute('aria-label', 'Reorder task');
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
      if (!sibling?.classList.contains('td-row')) return;
      if (e.key === 'ArrowUp') sibling.before(row);
      else sibling.after(row);
      commitTodoOrder();
      todo.listEl?.querySelector<HTMLElement>(`.td-row[data-id="${CSS.escape(t.id)}"] .td-grip`)?.focus();
    });
    row.append(grip);
  } else {
    row.append(el('span', 'td-grip-space'));
  }

  const check = el('input', 'td-check');
  check.type = 'checkbox';
  check.checked = t.done;
  check.title = t.done ? 'Mark as not done' : 'Mark as done';
  check.setAttribute('aria-label', `Done: ${t.title}`);
  check.addEventListener('change', () => updateTodo(t.id, { done: check.checked }));

  const main = el('button', 'td-main');
  main.type = 'button';
  main.title = 'Open task';
  main.append(el('span', 'td-title', t.title));
  const firstLine = t.description.split('\n').find((l) => l.trim());
  if (firstLine) main.append(el('span', 'td-desc', firstLine.trim()));
  main.addEventListener('click', () => openTodoEditor(t.id));

  const meta = el('div', 'td-meta');
  if (t.project) {
    const chip = el('button', 'td-project', t.project);
    chip.type = 'button';
    chip.title = `Show only ${t.project}`;
    chip.addEventListener('click', () => setTodoPref({ project: t.project }));
    meta.append(chip);
  }
  if (t.priority !== 'none') meta.append(el('span', `td-priority ${t.priority}`, PRIORITY_LABEL[t.priority]));
  const due = dueLabel(t.due, t.done);
  if (due) meta.append(el('span', `td-due ${due.className}`, due.text));

  const remove = el('button', 'qc-icon qc-remove', '✕');
  remove.type = 'button';
  remove.title = 'Delete task';
  remove.setAttribute('aria-label', `Delete ${t.title}`);
  remove.addEventListener('click', () => removeTodo(t.id));

  row.append(check, main, meta, remove);
  return row;
}

/**
 * Writes the order on screen back into the manual order.
 *
 * The visible tasks keep the slots they already held in `todo.items` and are
 * only permuted among them, so reordering a filtered list — one project, say —
 * never shuffles the tasks it is hiding.
 */
export function commitTodoOrder(): void {
  const list = todo.listEl;
  if (!list) return;
  const ids = [...list.querySelectorAll<HTMLElement>('.td-row')].map((r) => r.dataset.id ?? '');
  const byTodoId = new Map(todo.items.map((t) => [t.id, t]));
  const slots = todo.items.map((t, i) => (ids.includes(t.id) ? i : -1)).filter((i) => i !== -1);
  const next = todo.items.slice();
  slots.forEach((slot, n) => {
    const item = byTodoId.get(ids[n]);
    if (item) next[slot] = item;
  });
  if (next.every((t, i) => t === todo.items[i])) return;
  todo.items = next;
  markTodosDirty();
}

/** Rebuilds the list from `todo.items` — cheap, and nothing in a row holds unsaved text. */
export function drawTodos(): void {
  const list = todo.listEl;
  if (!list || !todo.loaded) return;
  const shown = visibleTodos();
  const draggable = todoDraggable();
  list.classList.toggle('manual', draggable);

  // Keep the project filter's options in step with what exists.
  const sel = todo.projectSel;
  if (sel) {
    const projects = projectsOf(todo.items);
    if (todo.prefs.project && todo.prefs.project !== NO_PROJECT && !projects.includes(todo.prefs.project)) {
      todo.prefs.project = '';
      saveTodoPrefs();
    }
    sel.replaceChildren(
      new Option('All projects', ''),
      ...projects.map((p) => new Option(p, p)),
      new Option('No project', NO_PROJECT),
    );
    sel.value = todo.prefs.project;
  }

  const open = todo.items.filter((t) => !t.done).length;
  const overdue = todo.items.filter((t) => !t.done && t.due && t.due < localDay()).length;
  if (todo.countEl) {
    todo.countEl.textContent =
      `${open} open` + (overdue ? ` · ${overdue} overdue` : '') + ` · ${todo.items.length - open} done`;
  }

  const rows: HTMLElement[] = [];
  let group: string | null = null;
  for (const t of shown) {
    // Sorting by project reads as sections; the heading is what was sorted by.
    if (todo.prefs.sort === 'project' && !t.done) {
      const heading = t.project || 'No project';
      if (heading !== group) rows.push(el('div', 'td-group', heading));
      group = heading;
    } else if (t.done && group !== '\0done') {
      if (rows.length) rows.push(el('div', 'td-group', 'Done'));
      group = '\0done';
    }
    rows.push(todoRow(t, draggable && !t.done));
  }
  if (!rows.length) {
    const empty = todo.items.length
      ? 'Nothing matches. Clear the search or pick another project.'
      : 'No tasks yet. Type one above and press Enter.';
    rows.push(el('p', 'none', empty));
  }
  // Redraws happen under the pointer and the keyboard; keep focus where it was.
  const focusedId = (document.activeElement?.closest('.td-row') as HTMLElement | null)?.dataset.id;
  const focusedClass = [...(document.activeElement?.classList ?? [])].find((c) => c.startsWith('td-'));
  list.replaceChildren(...rows);
  if (focusedId && focusedClass) {
    list.querySelector<HTMLElement>(`.td-row[data-id="${CSS.escape(focusedId)}"] .${focusedClass}`)?.focus();
  }
}

export function setTodoPref(patch: Partial<TodoPrefs>): void {
  Object.assign(todo.prefs, patch);
  saveTodoPrefs();
  syncTodoControls();
  drawTodos();
}

/** The controls that mirror `todo.prefs`, kept here so a chip click updates them too. */
export let syncTodoControls: () => void = () => {};

export async function renderTodos(): Promise<void> {
  const doc = el('div', 'doc td-doc');
  doc.append(
    el('h1', '', 'To-do'),
    el('p', 'settings-lead', 'Tasks, with a project, a priority and a due date. Click one to write its description.'),
  );

  // Quick add: a title and Enter is a task. Everything else is in the editor.
  const add = el('form', 'td-add');
  const addInput = el('input', 'td-add-input');
  addInput.type = 'text';
  addInput.maxLength = TODO_MAX.title;
  addInput.placeholder = 'Add a task and press Enter…';
  addInput.setAttribute('aria-label', 'New task title');
  const addButton = el('button', 'button primary', 'Add');
  addButton.type = 'submit';
  const details = el('button', 'button', 'Add with details…');
  details.type = 'button';
  details.title = 'Open the editor for a new task';
  add.append(addInput, addButton, details);
  add.addEventListener('submit', (e) => {
    e.preventDefault();
    // Until the list has arrived there is nothing to add to: the load would
    // replace a task typed in the meantime.
    if (!todo.loaded || !addInput.value.trim()) return;
    addTodo(addInput.value);
    addInput.value = '';
    markTodosDirty();
    drawTodos();
  });
  details.addEventListener('click', () => {
    if (todo.loaded) openTodoEditor(null, addInput.value);
  });

  // Sort, filter, search.
  const bar = el('div', 'td-bar');
  const sortLabel = el('label', 'td-control');
  sortLabel.append(el('span', '', 'Sort'));
  const sortSel = el('select', 'td-select');
  for (const [value, label] of Object.entries(TODO_SORTS)) sortSel.append(new Option(label, value));
  sortSel.addEventListener('change', () => setTodoPref({ sort: sortSel.value as TodoSort }));
  sortLabel.append(sortSel);

  const reverse = el('button', 'qce-tool td-reverse');
  reverse.type = 'button';
  reverse.addEventListener('click', () => setTodoPref({ reverse: !todo.prefs.reverse }));

  const projectLabel = el('label', 'td-control');
  projectLabel.append(el('span', '', 'Project'));
  const projectSel = el('select', 'td-select');
  projectSel.addEventListener('change', () => setTodoPref({ project: projectSel.value }));
  projectLabel.append(projectSel);

  const doneLabel = el('label', 'td-control td-toggle');
  const doneBox = el('input');
  doneBox.type = 'checkbox';
  doneBox.addEventListener('change', () => setTodoPref({ showDone: doneBox.checked }));
  doneLabel.append(doneBox, el('span', '', 'Show done'));

  const search = el('input', 'td-search');
  search.type = 'search';
  search.placeholder = 'Search tasks… (Ctrl+F)';
  search.setAttribute('aria-label', 'Search tasks');
  search.value = todo.query;
  search.addEventListener('input', () => {
    todo.query = search.value;
    drawTodos();
  });

  bar.append(sortLabel, reverse, projectLabel, doneLabel, search);

  const foot = el('div', 'td-foot');
  const count = el('span', 'td-count');
  const status = el('span', 'qc-status', 'Loading…');
  foot.append(count, status);

  const list = el('div', 'td-list');
  // Drag to reorder, only in "My order": the row moves live under the pointer
  // and the drop writes the order on screen back into the saved one.
  let dragged: HTMLElement | null = null;
  const rowsOf = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('.td-row:not(.done)')];
  list.addEventListener('dragstart', (e) => {
    dragged = (e.target as Element).closest?.<HTMLElement>('.td-row') ?? null;
    if (!dragged) return;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    }
    dragged.classList.add('dragging');
  });
  list.addEventListener('dragover', (e) => {
    const moving = dragged;
    if (!moving) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rows = rowsOf();
    const after = rows.find((r) => {
      if (r === moving) return false;
      const box = r.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (after) {
      if (after !== moving.nextElementSibling) after.before(moving);
    } else {
      const last = rows[rows.length - 1];
      if (last && last !== moving) last.after(moving);
    }
  });
  list.addEventListener('drop', (e) => {
    if (dragged) e.preventDefault();
  });
  list.addEventListener('dragend', () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged.draggable = false;
    dragged = null;
    commitTodoOrder();
    drawTodos();
  });

  doc.append(add, bar, list, foot);
  todo.listEl = list;
  todo.statusEl = status;
  todo.countEl = count;
  todo.searchEl = search;
  todo.projectSel = projectSel;

  syncTodoControls = () => {
    sortSel.value = todo.prefs.sort;
    const desc = TODO_SORT_DESC[todo.prefs.sort] !== todo.prefs.reverse;
    reverse.textContent = desc ? '↓' : '↑';
    reverse.title = `${desc ? 'Descending' : 'Ascending'} — click to reverse`;
    reverse.setAttribute('aria-label', reverse.title);
    doneBox.checked = todo.prefs.showDone;
  };
  syncTodoControls();
  readerEl.replaceChildren(doc);

  // Unsaved edits in memory are newer than the file; only a clean list reloads.
  if (!todo.loaded || !todo.dirty) {
    try {
      todo.items = await window.library.todos.list();
      todo.loaded = true;
    } catch {
      setTodoStatus('Could not read the list', true);
      return;
    }
  }
  // Someone clicked away, or back again, before the list arrived.
  if (view.mode !== 'todos' || todo.listEl !== list) return;
  setTodoStatus(todo.dirty ? 'Unsaved changes' : 'Saved', todo.dirty);
  drawTodos();
  addInput.focus();
}

// --------------------------------------------------------------- task editor

/**
 * The editor behind a task: its fields along the top, and the description as a
 * large plain-text area with list, checklist and date tools. Every tool edits
 * through `insertText`, so Ctrl+Z undoes it like any other keystroke.
 *
 * Closing keeps the edit (Escape, ✕, Done, a click outside); only "Discard
 * changes" throws it away — the same rule as the quick-copy editor.
 */
export interface TdEditor {
  dialog: HTMLDialogElement | null;
  /** The task being edited, or null for one that does not exist yet. */
  id: string | null;
  title: HTMLInputElement;
  project: HTMLInputElement;
  projects: HTMLDataListElement;
  priority: HTMLSelectElement;
  due: HTMLInputElement;
  done: HTMLInputElement;
  text: HTMLTextAreaElement;
  stats: HTMLElement;
  remove: HTMLButtonElement;
}

export const tdEditor = { dialog: null, id: null } as TdEditor;

/** Replaces the selected lines — or the current one — undoably. */
export function tdReplaceLines(fn: (text: string) => string): void {
  const t = tdEditor.text;
  t.focus();
  const a = t.value.lastIndexOf('\n', t.selectionStart - 1) + 1;
  let b = t.value.indexOf('\n', Math.max(t.selectionEnd - (t.selectionEnd > t.selectionStart ? 1 : 0), a));
  if (b === -1) b = t.value.length;
  const before = t.value.slice(a, b);
  const after = fn(before).slice(0, TODO_MAX.description - (t.value.length - before.length));
  if (after === before) return;
  t.setSelectionRange(a, b);
  document.execCommand('insertText', false, after);
  t.setSelectionRange(a, a + after.length);
  tdRefreshStats();
}

export function tdInsert(str: string): void {
  tdEditor.text.focus();
  document.execCommand('insertText', false, str);
  tdRefreshStats();
}

export function tdHistory(command: 'undo' | 'redo'): void {
  tdEditor.text.focus();
  document.execCommand(command);
  tdRefreshStats();
}

/** Any list marker a line can start with: checklist, bullet or number. */
export const LIST_MARKER = /^(\s*)(?:[-*•] \[[ xX]\] |[-*•] |\d+\. )/;

/**
 * Adds a prefix to every non-blank line, or takes it off when all already have
 * it. A line that is already a list item has its marker swapped rather than
 * stacked, so bulleting a checklist gives "- item", not "- - [ ] item".
 */
export function togglePrefix(s: string, has: RegExp, add: (line: string, i: number) => string): string {
  const lines = s.split('\n');
  const all = lines.filter((l) => l.trim()).every((l) => has.test(l));
  let n = 0;
  return lines
    .map((l) => (!l.trim() ? l : all ? l.replace(has, '$1') : add(l.replace(LIST_MARKER, '$1'), n++)))
    .join('\n');
}

/** Ticks every checklist line in the selection, or unticks them if all are ticked. */
export function toggleTicks(s: string): string {
  const boxes = s.split('\n').filter((l) => /^\s*[-*] \[[ xX]\] /.test(l));
  if (!boxes.length) return s;
  const allTicked = boxes.every((l) => /^\s*[-*] \[[xX]\] /.test(l));
  return s.replace(/^(\s*[-*] )\[[ xX]\] /gm, `$1[${allTicked ? ' ' : 'x'}] `);
}

export const TD_TOOLS: QcTool[][] = [
  [
    { label: '↶', title: 'Undo (Ctrl+Z)', run: () => tdHistory('undo') },
    { label: '↷', title: 'Redo (Ctrl+Y)', run: () => tdHistory('redo') },
  ],
  [
    { label: '•', title: 'Bulleted list', run: () => tdReplaceLines((s) => togglePrefix(s, /^(\s*)[-*•] (?!\[)/, (l) => `- ${l}`)) },
    { label: '1.', title: 'Numbered list', run: () => tdReplaceLines((s) => togglePrefix(s, /^(\s*)\d+\. /, (l, i) => `${i + 1}. ${l}`)) },
    { label: '☐', title: 'Checklist', run: () => tdReplaceLines((s) => togglePrefix(s, /^(\s*)[-*] \[[ xX]\] /, (l) => `- [ ] ${l}`)) },
    { label: '☑', title: 'Tick or untick checklist items (Ctrl+Enter on a line)', run: () => tdReplaceLines(toggleTicks) },
  ],
  [
    { label: 'H', title: 'Heading', run: () => tdReplaceLines((s) => togglePrefix(s, /^()#{1,3} /, (l) => `## ${l}`)) },
    { label: '—', title: 'Divider', run: () => tdInsert('\n---\n') },
  ],
  [
    {
      label: 'Date',
      title: "Insert today's date",
      run: () => tdInsert(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })),
    },
    {
      label: 'Time',
      title: 'Insert the current time',
      run: () => tdInsert(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
    },
  ],
  [
    {
      label: 'Wrap',
      title: 'Wrap long lines',
      toggle: 'wrap',
      pressed: true,
      run: (b) => b.setAttribute('aria-pressed', String(!tdEditor.text.classList.toggle('nowrap'))),
    },
    {
      label: 'Mono',
      title: 'Monospaced font',
      toggle: 'mono',
      run: (b) => b.setAttribute('aria-pressed', String(tdEditor.text.classList.toggle('mono'))),
    },
  ],
];

export function tdRefreshStats(): void {
  const v = tdEditor.text.value;
  const words = (v.match(/\S+/g) ?? []).length;
  const boxes = v.match(/^\s*[-*] \[[ xX]\] /gm) ?? [];
  const ticked = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
  tdEditor.stats.textContent =
    `${words.toLocaleString()} word${words === 1 ? '' : 's'}` +
    (boxes.length ? ` · ${ticked}/${boxes.length} checked` : '') +
    ` · ${v.length.toLocaleString()} / ${TODO_MAX.description.toLocaleString()} chars`;
  tdEditor.stats.classList.toggle('full', v.length >= TODO_MAX.description);
}

export function buildTodoEditor(): void {
  const dialog = el('dialog', 'qc-editor td-editor');
  dialog.setAttribute('aria-label', 'Edit task');

  const head = el('div', 'qce-head');
  const title = el('input', 'qce-name');
  title.type = 'text';
  title.maxLength = TODO_MAX.title;
  title.placeholder = 'Task title';
  title.setAttribute('aria-label', 'Title');
  const done = el('input', 'td-check');
  done.type = 'checkbox';
  done.title = 'Done';
  done.setAttribute('aria-label', 'Done');
  head.append(done, title, qcButton('qc-icon', '✕', 'Close (Esc) — keeps your changes', () => closeTodoEditor(true)));

  const fields = el('div', 'td-fields');
  const field = (label: string, control: HTMLElement): HTMLElement => {
    const wrap = el('label', 'td-field');
    wrap.append(el('span', '', label), control);
    return wrap;
  };
  const project = el('input', 'qce-input');
  project.type = 'text';
  project.maxLength = TODO_MAX.project;
  project.placeholder = 'None';
  const projects = el('datalist');
  projects.id = 'td-projects';
  project.setAttribute('list', projects.id);
  const priority = el('select', 'td-select');
  for (const p of [...PRIORITIES].reverse()) priority.append(new Option(PRIORITY_LABEL[p], p));
  const due = el('input', 'qce-input td-date');
  due.type = 'date';
  const quick = el('div', 'td-quick');
  const dueChip = (label: string, value: () => string) =>
    qcButton('qce-tool', label, '', () => {
      due.value = value();
    });
  quick.append(
    dueChip('Today', () => localDay()),
    dueChip('Tomorrow', () => localDay(1)),
    dueChip('+1 week', () => localDay(7)),
    dueChip('Clear', () => ''),
  );
  const dueWrap = el('div', 'td-due-wrap');
  dueWrap.append(due, quick);
  fields.append(field('Project', project), projects, field('Priority', priority), field('Due', dueWrap));

  const toolbar = el('div', 'qce-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  for (const group of TD_TOOLS) {
    const g = el('div', 'qce-group');
    for (const tool of group) {
      const b = qcButton('qce-tool', tool.label, tool.title, tool.run);
      if (tool.toggle) b.setAttribute('aria-pressed', String(Boolean(tool.pressed)));
      g.append(b);
    }
    toolbar.append(g);
  }

  const text = el('textarea', 'qce-text');
  text.maxLength = TODO_MAX.description;
  text.placeholder = 'Description — notes, links, a checklist of steps…';
  text.setAttribute('aria-label', 'Description');
  text.addEventListener('input', () => tdRefreshStats());
  text.addEventListener('keydown', (e) => {
    // Enter continues a list, as in any editor; on an empty item it ends the list.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const a = text.selectionStart;
      if (a !== text.selectionEnd) return;
      const lineStart = text.value.lastIndexOf('\n', a - 1) + 1;
      const line = text.value.slice(lineStart, a);
      const m = /^(\s*)([-*•] \[[ xX]\] |[-*•] |(\d+)\. )/.exec(line);
      if (!m) return;
      e.preventDefault();
      if (line.trim() === m[2].trim()) {
        text.setSelectionRange(lineStart, a);
        tdInsert('');
        return;
      }
      const marker = m[3] ? `${Number(m[3]) + 1}. ` : m[2].replace(/\[[xX]\]/, '[ ]');
      tdInsert(`\n${m[1]}${marker}`);
      return;
    }
    // Ctrl+Enter on a checklist line ticks it.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && /^\s*[-*] \[[ xX]\] /m.test(text.value)) {
      const lineStart = text.value.lastIndexOf('\n', text.selectionStart - 1) + 1;
      if (/^\s*[-*] \[[ xX]\] /.test(text.value.slice(lineStart))) {
        e.preventDefault();
        e.stopPropagation();
        tdReplaceLines(toggleTicks);
      }
      return;
    }
    // Tab indents; Shift+Tab takes one indent back off.
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    tdReplaceLines((s) => (e.shiftKey ? s.replace(/^(\t| {1,2})/gm, '') : s.replace(/^/gm, '  ')));
  });

  const foot = el('div', 'qce-foot');
  const stats = el('span', 'qce-stats');
  const remove = qcButton('button danger', 'Delete task', '', () => {
    const id = tdEditor.id;
    tdEditor.id = null;
    dialog.close();
    if (id) removeTodo(id);
  });
  foot.append(
    stats,
    remove,
    qcButton('button', 'Discard changes', '', () => closeTodoEditor(false)),
    qcButton('button primary', 'Done', 'Save and close (Ctrl+S)', () => closeTodoEditor(true)),
  );

  dialog.append(head, fields, toolbar, text, foot);

  dialog.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault(); // no native cancel: closing goes through one path
      closeTodoEditor(true);
    } else if (mod && (e.key.toLowerCase() === 's' || (e.key === 'Enter' && e.target !== text))) {
      e.preventDefault();
      closeTodoEditor(true);
    }
  });
  dialog.addEventListener('mousedown', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeTodoEditor(true);
  });

  document.body.append(dialog);
  Object.assign(tdEditor, { dialog, title, project, projects, priority, due, done, text, stats, remove });
}

/** Opens a task, or — with `id` null — a blank one that exists only once it has a title. */
export function openTodoEditor(id: string | null, title = ''): void {
  if (!tdEditor.dialog) buildTodoEditor();
  const t = id ? todo.items.find((x) => x.id === id) : null;
  if (id && !t) return;
  const filterProject = todo.prefs.project && todo.prefs.project !== NO_PROJECT ? todo.prefs.project : '';
  tdEditor.id = id;
  tdEditor.title.value = t?.title ?? title.trim();
  tdEditor.project.value = t?.project ?? filterProject;
  tdEditor.priority.value = t?.priority ?? 'none';
  tdEditor.due.value = t?.due ?? '';
  tdEditor.done.checked = t?.done ?? false;
  tdEditor.text.value = t?.description ?? '';
  tdEditor.remove.hidden = !t;
  tdEditor.projects.replaceChildren(...projectsOf(todo.items).map((p) => new Option(p)));
  tdEditor.dialog?.showModal();
  if (t) {
    tdEditor.text.focus();
    tdEditor.text.setSelectionRange(0, 0);
    tdEditor.text.scrollTop = 0;
  } else {
    tdEditor.title.focus();
  }
  tdRefreshStats();
}

/** @param keep write the edit to the task, or throw it away */
export function closeTodoEditor(keep: boolean): void {
  const { dialog, id } = tdEditor;
  if (!dialog?.open) return;
  dialog.close();
  tdEditor.id = null;
  if (!keep) return;

  const title = tdEditor.title.value.replace(/\s+/g, ' ').trim();
  const patch: Partial<Todo> = {
    project: tdEditor.project.value.replace(/\s+/g, ' ').trim().slice(0, TODO_MAX.project),
    priority: tdEditor.priority.value as TodoPriority,
    due: tdEditor.due.value,
    done: tdEditor.done.checked,
    description: tdEditor.text.value,
  };

  if (!id) {
    // A new task with nothing to call it is not a task; one with only a
    // description would be unfindable, so that gets a title of its own.
    const fallback = patch.description?.split('\n').find((l) => l.trim())?.trim() ?? '';
    if (!title && !fallback) return;
    addTodo(title || fallback, patch);
    markTodosDirty();
    drawTodos();
    return;
  }

  const current = todo.items.find((t) => t.id === id);
  if (!current) return; // deleted underneath
  // An emptied title keeps the old one: clearing a field is not a way to delete.
  if (title) patch.title = title;
  const changed = (Object.keys(patch) as (keyof Todo)[]).some((k) => patch[k] !== current[k]);
  if (changed) updateTodo(id, patch);
  todo.listEl?.querySelector<HTMLElement>(`.td-row[data-id="${CSS.escape(id)}"] .td-main`)?.focus();
}
