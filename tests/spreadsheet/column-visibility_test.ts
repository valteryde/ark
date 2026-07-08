import { assertEquals } from '@std/assert';
import {
  clampToVisibleColumn,
  firstVisibleColumnIndex,
  isHiddenColumn,
  isVisibleColumn,
  lastVisibleColumnIndex,
  stepVisibleColumn,
  sumVisibleColumnWidths,
  visibleColumnCount,
} from '../../src/spreadsheet/column-visibility.ts';
import type { SpreadsheetColumn } from '../../src/spreadsheet/types.ts';

const columns: SpreadsheetColumn[] = [
  { id: 'id', header: 'ID', widthPx: 72, readOnly: true, hidden: true },
  { id: 'name', header: 'Name', widthPx: 200 },
  { id: 'note', header: 'Note', widthPx: 120, hidden: true, readOnly: true },
];

Deno.test('column visibility helpers detect hidden columns', () => {
  assertEquals(isHiddenColumn(columns, 1), true);
  assertEquals(isHiddenColumn(columns, 2), false);
  assertEquals(isVisibleColumn(columns, 2), true);
  assertEquals(visibleColumnCount(columns), 1);
  assertEquals(firstVisibleColumnIndex(columns), 2);
  assertEquals(lastVisibleColumnIndex(columns), 2);
});

Deno.test('clampToVisibleColumn snaps to nearest visible column', () => {
  assertEquals(clampToVisibleColumn(columns, 1), 2);
  assertEquals(clampToVisibleColumn(columns, 3), 2);
  assertEquals(clampToVisibleColumn(columns, 2), 2);
});

Deno.test('stepVisibleColumn stays on sole visible column', () => {
  assertEquals(stepVisibleColumn(columns, 2, -1), 2);
  assertEquals(stepVisibleColumn(columns, 2, 1), 2);
});

Deno.test('sumVisibleColumnWidths excludes hidden columns', () => {
  assertEquals(sumVisibleColumnWidths(columns, [72, 200, 120]), 200);
});
