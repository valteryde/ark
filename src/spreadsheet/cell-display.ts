import { columnValueType, resolveSelectLabel } from './cell-value.ts';
import type { SpreadsheetColumn, SpreadsheetSelectOption } from './types.ts';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Allow #rgb, #rrggbb, #rgba, and rgb()/rgba() with numeric components only. */
export function sanitizeCssColor(input: string): string | null {
  const t = input.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t)) {
    return t;
  }
  const rgb =
    /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(t) ??
    /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(?:0?\.\d+|1(?:\.0+)?|0)\s*\)$/.exec(
      t,
    );
  if (!rgb) return null;
  for (let i = 1; i <= 3; i++) {
    const n = Number(rgb[i]);
    if (n > 255) return null;
  }
  return t;
}

export function sanitizePhosphorIconName(input: string): string | null {
  const t = input.trim().toLowerCase();
  return /^[a-z0-9-]{1,48}$/.test(t) ? t : null;
}

function optionHasPresentation(o: SpreadsheetSelectOption): boolean {
  if (o.icon && sanitizePhosphorIconName(o.icon)) return true;
  if (o.color && sanitizeCssColor(o.color)) return true;
  if (o.backgroundColor && sanitizeCssColor(o.backgroundColor)) return true;
  return false;
}

/**
 * HTML for a select option chip (dropdown row or cell). Caller sets innerHTML only from this + trusted wrapper.
 */
export function formatSelectOptionMarkup(opt: SpreadsheetSelectOption, displayLabel: string): string {
  const label = escapeHtml(displayLabel.trim() || opt.value);
  if (!optionHasPresentation(opt)) {
    return label;
  }
  const parts: string[] = [];
  const c = opt.color ? sanitizeCssColor(opt.color) : null;
  const bg = opt.backgroundColor ? sanitizeCssColor(opt.backgroundColor) : null;
  if (c) parts.push(`color: ${c}`);
  if (bg) parts.push(`background-color: ${bg}`);
  const styleAttr = parts.length ? ` style="${parts.join('; ')}"` : '';
  const iconRaw = opt.icon ? sanitizePhosphorIconName(opt.icon) : null;
  const iconHtml = iconRaw
    ? `<i class="ph ph-${escapeHtml(iconRaw)}" aria-hidden="true"></i>`
    : '';
  return `<span class="sheet-select-pill"${styleAttr}>${iconHtml}<span class="sheet-select-pill__text">${label}</span></span>`;
}

/**
 * Build safe HTML for a cell from column metadata and raw string value.
 */
export function formatCellHtml(column: SpreadsheetColumn | undefined, value: string): string {
  const canonical = value.trim();
  if (!canonical) return '';

  const vt = columnValueType(column);
  if (vt === 'select' && column?.selectOptions?.length) {
    const opt = column.selectOptions.find((o) => o.value === canonical);
    if (opt) {
      const displayText = (opt.label ?? opt.value).trim();
      return formatSelectOptionMarkup(opt, displayText || opt.value);
    }
  }

  const displayText =
    vt === 'select' ? resolveSelectLabel(column, canonical).trim() : canonical;
  if (!displayText) return '';
  return escapeHtml(displayText);
}
