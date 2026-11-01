/**
 * A1-style addresses for grid coordinates (1-based row/column), used by the
 * value bar and by any host chrome that wants to label the active cell.
 */

/** 1-based column index → letters: 1 → `A`, 26 → `Z`, 27 → `AA`. */
export function columnLetters(col: number): string {
  let n = Math.trunc(col);
  if (!Number.isFinite(n) || n < 1) return '';
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `C3` for row 3, column 3. Empty string for a non-positive coordinate. */
export function cellAddress(row: number, col: number): string {
  const letters = columnLetters(col);
  const r = Math.trunc(row);
  if (!letters || !Number.isFinite(r) || r < 1) return '';
  return `${letters}${r}`;
}

/** Single address when the rectangle is 1x1, otherwise `A1:C3`. */
export function cellRangeLabel(rect: {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}): string {
  const rowSpan = Math.max(1, Math.trunc(rect.rowSpan));
  const colSpan = Math.max(1, Math.trunc(rect.colSpan));
  const start = cellAddress(rect.row, rect.col);
  if (!start) return '';
  if (rowSpan === 1 && colSpan === 1) return start;
  const end = cellAddress(rect.row + rowSpan - 1, rect.col + colSpan - 1);
  return end ? `${start}:${end}` : start;
}
