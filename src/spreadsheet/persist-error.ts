import { cellKey } from './data-store.ts';
import {
  cancelHidePersistTooltip,
  hidePersistTooltip,
  hidePersistTooltipIfAnchor,
  scheduleHidePersistTooltip,
  showPersistTooltipForDot,
} from './persist-tooltip.ts';

export interface PersistErrorController {
  /** Show a "save failed" dot on the cell (auto-clears after ~8s). No-op out of bounds. */
  show(row: number, col: number, message?: string): void;
  /** Remove the dot + any pending auto-clear timer for the cell. */
  clear(row: number, col: number): void;
}

/**
 * Renders subtle per-cell "could not save" markers (a red dot with a hover/focus
 * tooltip). Kept separate from the grid so its only coupling is the cell element
 * map and the shared persist tooltip singleton.
 */
export function createPersistErrorController(opts: {
  cells: ReadonlyMap<string, HTMLElement>;
  dataRowCount: number;
  dataColumnCount: number;
}): PersistErrorController {
  const { cells, dataRowCount, dataColumnCount } = opts;
  const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clear(row: number, col: number): void {
    const k = cellKey(row, col);
    const t = clearTimers.get(k);
    if (t !== undefined) {
      clearTimeout(t);
      clearTimers.delete(k);
    }
    const el = cells.get(k);
    if (el) {
      const dot = el.querySelector('.sheet-cell-persist-dot');
      hidePersistTooltipIfAnchor(dot);
      dot?.remove();
    }
  }

  function show(row: number, col: number, message?: string): void {
    if (row < 1 || row > dataRowCount || col < 1 || col > dataColumnCount) return;
    const k = cellKey(row, col);
    const el = cells.get(k);
    if (!el) return;
    clear(row, col);
    const hint = message?.trim()
      ? message.trim()
      : 'Could not save — check your connection or try again';
    const hintForTip = hint.length > 4000 ? `${hint.slice(0, 3997)}…` : hint;
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'sheet-cell-persist-dot';
    dot.tabIndex = 0;
    dot.setAttribute('aria-label', 'Save failed');
    dot.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    dot.addEventListener('click', (e) => e.stopPropagation());
    dot.addEventListener('mouseenter', () => {
      cancelHidePersistTooltip();
      showPersistTooltipForDot(dot, hintForTip);
    });
    dot.addEventListener('mouseleave', () => scheduleHidePersistTooltip());
    dot.addEventListener('focus', () => showPersistTooltipForDot(dot, hintForTip));
    dot.addEventListener('blur', () => hidePersistTooltip());
    el.appendChild(dot);
    const tid = window.setTimeout(() => clear(row, col), 8000);
    clearTimers.set(k, tid);
  }

  return { show, clear };
}
