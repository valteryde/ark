import { formatCellHtml } from './cell-display.ts';
import type { SpreadsheetColumn } from './types.ts';

/** The `<input>` editor inside a cell shell, if present. */
export function getCellEditor(cell: HTMLElement): HTMLInputElement | null {
  return cell.querySelector<HTMLInputElement>('.sheet-cell-input');
}

/** Render a cell's display content (select chips, escaped text) from its raw value. */
export function applyCellDisplay(
  content: HTMLDivElement,
  column: SpreadsheetColumn | undefined,
  value: string,
): void {
  content.innerHTML = formatCellHtml(column, value);
}

/** Attribute tracking which inline CSS keys were applied by {@link applyCellInlineStyleRecord}. */
const SHEET_STYLE_PROPS_ATTR = 'data-sheet-style-props';

/** Apply kebab-case CSS declarations; clears previously applied keys tracked on the element. */
export function applyCellInlineStyleRecord(
  el: HTMLDivElement,
  style: Record<string, string> | undefined,
): void {
  const prev = el.getAttribute(SHEET_STYLE_PROPS_ATTR)?.split(',').filter(Boolean) ?? [];
  for (const prop of prev) {
    el.style.removeProperty(prop);
  }
  if (!style || Object.keys(style).length === 0) {
    el.removeAttribute(SHEET_STYLE_PROPS_ATTR);
    return;
  }
  const keys: string[] = [];
  for (const [k, v] of Object.entries(style)) {
    const name = k.trim();
    if (!name || v === undefined || v === '') continue;
    el.style.setProperty(name, v);
    keys.push(name);
  }
  if (keys.length === 0) {
    el.removeAttribute(SHEET_STYLE_PROPS_ATTR);
    return;
  }
  el.setAttribute(SHEET_STYLE_PROPS_ATTR, keys.join(','));
}
