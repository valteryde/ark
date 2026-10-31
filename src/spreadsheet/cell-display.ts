import { columnValueType, isSafeLinkHref, resolveSelectLabel } from './cell-value.ts';
import type { SpreadsheetColumn, SpreadsheetSelectOption } from './types.ts';

/** Phosphor “open in new” icon used when a link column does not set `icon`. */
const DEFAULT_LINK_ICON = 'arrow-square-out';

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

/** CSS Level 1 names plus `orange`, so keyword colors collapse to the same swatch as hex. */
const BASIC_NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  white: '#ffffff',
  maroon: '#800000',
  red: '#ff0000',
  purple: '#800080',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  green: '#008000',
  lime: '#00ff00',
  olive: '#808000',
  yellow: '#ffff00',
  navy: '#000080',
  blue: '#0000ff',
  teal: '#008080',
  aqua: '#00ffff',
  cyan: '#00ffff',
  orange: '#ffa500',
};

function hexFromSanitized(safe: string): string | null {
  const t = safe.trim().toLowerCase().replace(/\s+/g, '');
  const hex = /^#([0-9a-f]{3,8})$/.exec(t);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    }
    return `#${h.slice(0, 6)}`;
  }
  const rgb = /^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(t);
  if (!rgb) return null;
  const parts: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const n = Number(rgb[i]);
    if (!Number.isInteger(n) || n > 255) return null;
    parts.push(n.toString(16).padStart(2, '0'));
  }
  return `#${parts.join('')}`;
}

function canvasNamedColor(name: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#010101';
    ctx.fillStyle = name;
    const painted = hexFromSanitized(String(ctx.fillStyle));
    if (!painted || painted === '#010101') return null;
    return painted;
  } catch {
    return null;
  }
}

/**
 * `#rrggbb` form of a safe CSS color. Hex and `rgb()`/`rgba()` drop alpha.
 * Unknown strings are rejected. `transparent` is rejected so "no fill" stays a separate action.
 */
export function canonicalCssColor(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'transparent') return null;
  const safe = sanitizeCssColor(trimmed);
  if (safe) return hexFromSanitized(safe);
  const named = trimmed.toLowerCase();
  if (!/^[a-z]{3,20}$/.test(named)) return null;
  return BASIC_NAMED_COLORS[named] ?? canvasNamedColor(named);
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

function linkIconName(column: SpreadsheetColumn | undefined): string {
  const raw = column?.icon ? sanitizePhosphorIconName(column.icon) : null;
  return raw ?? DEFAULT_LINK_ICON;
}

/** Visible button text for a link column. Explicit `label`, otherwise the header. */
export function linkButtonLabel(column: SpreadsheetColumn | undefined): string {
  const explicit = column?.label?.trim() ?? '';
  if (explicit) return explicit;
  return column?.header?.trim() ?? '';
}

/** Icon button for a link column. Empty when the stored value is not a safe URL. */
function formatLinkCellHtml(column: SpreadsheetColumn | undefined, href: string): string {
  const safeHref = href.trim();
  if (!isSafeLinkHref(safeHref)) return '';
  const icon = linkIconName(column);
  const visible = linkButtonLabel(column);
  const aria = visible || 'Open';
  const newTab = column?.openInNewTab !== false;
  const targetAttr = newTab ? ' target="_blank" rel="noopener noreferrer"' : '';
  const textHtml = visible
    ? `<span class="sheet-cell-link__text">${escapeHtml(visible)}</span>`
    : '';
  return `<a class="sheet-cell-link" href="${escapeHtml(safeHref)}"${targetAttr} draggable="false" aria-label="${escapeHtml(aria)}" title="${escapeHtml(safeHref)}"><i class="ph ph-${escapeHtml(icon)}" aria-hidden="true"></i>${textHtml}</a>`;
}

/**
 * Build safe HTML for a cell from column metadata and raw string value.
 */
export function formatCellHtml(column: SpreadsheetColumn | undefined, value: string): string {
  const canonical = value.trim();
  if (!canonical) return '';

  const vt = columnValueType(column);
  if (vt === 'link') return formatLinkCellHtml(column, canonical);
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
