// The little every bridge shares: reaching the Rust core, listening to it,
// and dragging a frameless window by its title bar.
//
// The pages never touch window.__TAURI__ themselves. Each one talks to the
// `window.<name>` API its bridge module installs, exactly as it talked to the
// Electron preload before — so the page code did not have to change.

export const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  window.__TAURI__.core.invoke<T>(command, args);

export function listen<T>(event: string, fn: (payload: T) => void): void {
  void window.__TAURI__.event.listen<T>(event, (e) => fn(e.payload));
}

const INTERACTIVE = 'button, input, select, textarea, a, [contenteditable], [data-no-drag]';

/**
 * Lets the elements matching `selector` move the window, as
 * `-webkit-app-region: drag` did under Electron. Anything clickable inside
 * them still gets its click. A double-click maximises when `maximize` is set.
 */
export function enableDrag(selector: string, { maximize = false }: { maximize?: boolean } = {}): void {
  const win = window.__TAURI__.window.getCurrentWindow();
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (!target?.closest(selector) || target.closest(INTERACTIVE)) return;
    if (e.detail === 2 && maximize) {
      void win.toggleMaximize();
      return;
    }
    void win.startDragging();
  });
}
