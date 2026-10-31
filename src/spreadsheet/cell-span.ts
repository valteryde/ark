import { cellKey } from './data-store.ts';
import type { CellSpan } from './types.ts';

/** A span covers at least two cells. 1×1 rectangles are ordinary cells. */
export function isMergeSpan(span: CellSpan): boolean {
  return span.rowSpan > 1 || span.colSpan > 1;
}

export function cloneCellSpans(spans: readonly CellSpan[]): CellSpan[] {
  return spans.map((span) => ({
    row: span.row,
    col: span.col,
    rowSpan: span.rowSpan,
    colSpan: span.colSpan,
  }));
}

export function cellSpansEqual(a: readonly CellSpan[], b: readonly CellSpan[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.row !== right.row ||
      left.col !== right.col ||
      left.rowSpan !== right.rowSpan ||
      left.colSpan !== right.colSpan
    ) {
      return false;
    }
  }
  return true;
}

export function spansOverlap(a: CellSpan, b: CellSpan): boolean {
  const aRow2 = a.row + a.rowSpan - 1;
  const bRow2 = b.row + b.rowSpan - 1;
  const aCol2 = a.col + a.colSpan - 1;
  const bCol2 = b.col + b.colSpan - 1;
  return a.row <= bRow2 && b.row <= aRow2 && a.col <= bCol2 && b.col <= aCol2;
}

/** The span that contains `(row, col)`, including its anchor. */
export function spanCovering(
  spans: readonly CellSpan[],
  row: number,
  col: number,
): CellSpan | null {
  for (const span of spans) {
    if (
      row >= span.row &&
      row < span.row + span.rowSpan &&
      col >= span.col &&
      col < span.col + span.colSpan
    ) {
      return span;
    }
  }
  return null;
}

/** Every cell in the rectangle except the anchor, as `row:col` keys. */
export function coveredCellKeys(span: CellSpan): string[] {
  const keys: string[] = [];
  for (let row = span.row; row < span.row + span.rowSpan; row++) {
    for (let col = span.col; col < span.col + span.colSpan; col++) {
      if (row === span.row && col === span.col) continue;
      keys.push(cellKey(row, col));
    }
  }
  return keys;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function parseSpan(raw: unknown, bounds?: { maxRow: number; maxCol: number }): CellSpan | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const row = positiveInt(o.row);
  const col = positiveInt(o.col);
  const rowSpan = positiveInt(o.rowSpan);
  const colSpan = positiveInt(o.colSpan);
  if (row === null || col === null || rowSpan === null || colSpan === null) return null;
  if (rowSpan === 1 && colSpan === 1) return null;
  if (bounds) {
    if (row > bounds.maxRow || col > bounds.maxCol) return null;
    if (row + rowSpan - 1 > bounds.maxRow || col + colSpan - 1 > bounds.maxCol) return null;
  }
  return { row, col, rowSpan, colSpan };
}

const MAX_SPANS = 10_000;

/**
 * Keep well-formed, in-bounds, non-overlapping spans. Later overlaps and
 * anything that is not a merge rectangle are dropped so one bad entry does
 * not blank the sheet.
 */
export function normalizeCellSpans(
  raw: unknown,
  bounds?: { maxRow: number; maxCol: number },
): CellSpan[] {
  if (!Array.isArray(raw)) return [];
  const out: CellSpan[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SPANS) break;
    const span = parseSpan(item, bounds);
    if (!span) continue;
    if (out.some((kept) => spansOverlap(kept, span))) continue;
    out.push(span);
  }
  return out;
}

/** Replace every span that intersects `rect` with `rect`. */
export function mergeSpanList(existing: readonly CellSpan[], rect: CellSpan): CellSpan[] {
  const kept = existing.filter((span) => !spansOverlap(span, rect));
  if (!isMergeSpan(rect)) return kept;
  kept.push({ row: rect.row, col: rect.col, rowSpan: rect.rowSpan, colSpan: rect.colSpan });
  return kept;
}

/** Drop every span that intersects `rect`. */
export function unmergeSpanList(existing: readonly CellSpan[], rect: CellSpan): CellSpan[] {
  return existing.filter((span) => !spansOverlap(span, rect));
}

/**
 * Deleting a row clears that row's cells and does not shift later rows.
 * A rectangle with a hole in it cannot stay one span, so any span that
 * includes the row is removed. The anchor value on a different row remains.
 */
export function spansAfterClearingRow(spans: readonly CellSpan[], row: number): CellSpan[] {
  return spans.filter((span) => row < span.row || row >= span.row + span.rowSpan);
}

/** Grow `rect` until it fully contains every span it touches. */
export function expandRectToSpans(rect: CellSpan, spans: readonly CellSpan[]): CellSpan {
  let minRow = rect.row;
  let minCol = rect.col;
  let maxRow = rect.row + rect.rowSpan - 1;
  let maxCol = rect.col + rect.colSpan - 1;
  let changed = true;
  let guard = 0;
  while (changed && guard++ <= spans.length) {
    changed = false;
    const box: CellSpan = {
      row: minRow,
      col: minCol,
      rowSpan: maxRow - minRow + 1,
      colSpan: maxCol - minCol + 1,
    };
    for (const span of spans) {
      if (!spansOverlap(span, box)) continue;
      const spanMaxRow = span.row + span.rowSpan - 1;
      const spanMaxCol = span.col + span.colSpan - 1;
      if (span.row < minRow || spanMaxRow > maxRow || span.col < minCol || spanMaxCol > maxCol) {
        minRow = Math.min(minRow, span.row);
        maxRow = Math.max(maxRow, spanMaxRow);
        minCol = Math.min(minCol, span.col);
        maxCol = Math.max(maxCol, spanMaxCol);
        changed = true;
      }
    }
  }
  return {
    row: minRow,
    col: minCol,
    rowSpan: maxRow - minRow + 1,
    colSpan: maxCol - minCol + 1,
  };
}
