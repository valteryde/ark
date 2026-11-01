import { sanitizeCssColor } from './cell-display.ts';
import type { SpreadsheetCellStyleDeclarations } from './types.ts';

/**
 * Allowlist of per-cell presentation CSS. Mirrors `server/app/cell_style.py`.
 * Unknown properties and unsafe values are dropped.
 */
const MAX_STYLE_VALUE_LEN = 80;

const FONT_WEIGHT_WORD = new Set(['normal', 'bold', 'bolder', 'lighter']);
const FONT_STYLE = new Set(['normal', 'italic', 'oblique']);
const JUSTIFY = new Set([
  'normal',
  'flex-start',
  'flex-end',
  'center',
  'start',
  'end',
  'left',
  'right',
  'stretch',
]);
const TEXT_ALIGN = new Set(['left', 'right', 'center', 'start', 'end', 'justify']);
const BORDER_STYLE = new Set(['none', 'solid', 'dashed', 'dotted', 'double']);
const DECORATION = new Set(['none', 'underline', 'overline', 'line-through']);
/** Wrap keywords only; `pre` / `pre-line` stay out so hard breaks can't reshape a grid row. */
const WHITE_SPACE = new Set(['normal', 'nowrap', 'pre-wrap']);

function sanitizeColor(value: string): string | null {
  const t = value.trim();
  if (t.length > MAX_STYLE_VALUE_LEN) return null;
  const css = sanitizeCssColor(t);
  if (css) return css;
  if (/^[a-zA-Z]{3,20}$/.test(t)) return t.toLowerCase();
  return null;
}

function fontWeight(value: string): string | null {
  const t = value.trim();
  if (/^[1-9]00$/.test(t)) return t;
  const low = t.toLowerCase();
  return FONT_WEIGHT_WORD.has(low) ? low : null;
}

function keyword(value: string, allowed: Set<string>): string | null {
  const low = value.trim().toLowerCase();
  return allowed.has(low) ? low : null;
}

function fontSize(value: string): string | null {
  const m = /^(\d{1,2}(?:\.\d{1,2})?)px$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 8 || n > 96) return null;
  return `${m[1]}px`;
}

function borderWidth(value: string): string | null {
  const m = /^(\d(?:\.\d)?)px$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 0 || n > 8) return null;
  return `${m[1]}px`;
}

function decoration(value: string): string | null {
  const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (!DECORATION.has(part)) return null;
    if (part === 'none') continue;
    if (!out.includes(part)) out.push(part);
  }
  if (parts.includes('none') && out.length === 0) return 'none';
  if (out.length === 0) return null;
  return out.join(' ');
}

function boxShadow(value: string): string | null {
  const m = /^inset\s+0\s+0\s+0\s+1px\s+(.+)$/.exec(value.trim());
  if (!m) return null;
  const color = sanitizeColor(m[1]!);
  if (!color) return null;
  return `inset 0 0 0 1px ${color}`;
}

const SANITIZERS: Record<string, (value: string) => string | null> = {
  color: sanitizeColor,
  'background-color': sanitizeColor,
  'border-color': sanitizeColor,
  'font-weight': fontWeight,
  'font-style': (v) => keyword(v, FONT_STYLE),
  'font-size': fontSize,
  'text-decoration-line': decoration,
  'text-align': (v) => keyword(v, TEXT_ALIGN),
  'white-space': (v) => keyword(v, WHITE_SPACE),
  'justify-content': (v) => keyword(v, JUSTIFY),
  'align-items': (v) => keyword(v, JUSTIFY),
  'box-shadow': boxShadow,
  'border-width': borderWidth,
  'border-style': (v) => keyword(v, BORDER_STYLE),
};

/** Drop unknown or unsafe declarations. Empty input yields `undefined`. */
export function sanitizeCellStyle(raw: unknown): SpreadsheetCellStyleDeclarations | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: SpreadsheetCellStyleDeclarations = {};
  for (const [name, fn] of Object.entries(SANITIZERS)) {
    const value = input[name];
    if (typeof value !== 'string') continue;
    const safe = fn(value);
    if (safe) out[name] = safe;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** True when a cell's sanitized style asks for wrapped text. */
export function cellWantsWrap(style: SpreadsheetCellStyleDeclarations | undefined): boolean {
  const v = sanitizeCellStyle(style)?.['white-space'];
  return v === 'pre-wrap' || v === 'normal';
}

export function cellStylesEqual(
  a: SpreadsheetCellStyleDeclarations | undefined,
  b: SpreadsheetCellStyleDeclarations | undefined,
): boolean {
  const left = sanitizeCellStyle(a) ?? {};
  const right = sanitizeCellStyle(b) ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}
