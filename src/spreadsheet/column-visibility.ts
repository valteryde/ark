import type { SpreadsheetColumn } from './types.ts';

export function isHiddenColumn(columns: readonly SpreadsheetColumn[], col: number): boolean {
  if (col < 1 || col > columns.length) return false;
  return columns[col - 1]?.hidden === true;
}

export function isVisibleColumn(columns: readonly SpreadsheetColumn[], col: number): boolean {
  return col >= 1 && col <= columns.length && !isHiddenColumn(columns, col);
}

export function firstVisibleColumnIndex(columns: readonly SpreadsheetColumn[]): number {
  for (let c = 1; c <= columns.length; c++) {
    if (isVisibleColumn(columns, c)) return c;
  }
  return 1;
}

export function lastVisibleColumnIndex(columns: readonly SpreadsheetColumn[]): number {
  for (let c = columns.length; c >= 1; c--) {
    if (isVisibleColumn(columns, c)) return c;
  }
  return columns.length;
}

export function clampToVisibleColumn(columns: readonly SpreadsheetColumn[], col: number): number {
  const clamped = Math.max(1, Math.min(columns.length, col));
  if (isVisibleColumn(columns, clamped)) return clamped;
  const first = firstVisibleColumnIndex(columns);
  const last = lastVisibleColumnIndex(columns);
  if (first > last) return clamped;
  for (let d = 1; d <= columns.length; d++) {
    if (isVisibleColumn(columns, clamped - d)) return clamped - d;
    if (isVisibleColumn(columns, clamped + d)) return clamped + d;
  }
  return first;
}

export function stepVisibleColumn(
  columns: readonly SpreadsheetColumn[],
  col: number,
  delta: number,
): number {
  const step = delta >= 0 ? 1 : -1;
  let c = Math.max(1, Math.min(columns.length, col));
  for (let i = 0; i < columns.length; i++) {
    c += step;
    if (c < 1) return firstVisibleColumnIndex(columns);
    if (c > columns.length) return lastVisibleColumnIndex(columns);
    if (isVisibleColumn(columns, c)) return c;
  }
  return clampToVisibleColumn(columns, col);
}

export function visibleColumnCount(columns: readonly SpreadsheetColumn[]): number {
  return columns.filter((c) => !c.hidden).length;
}

export function sumVisibleColumnWidths(
  columns: readonly SpreadsheetColumn[],
  widths: readonly number[],
): number {
  let total = 0;
  for (let i = 0; i < columns.length; i++) {
    if (!columns[i]?.hidden) total += widths[i] ?? 0;
  }
  return total;
}
