import { assertEquals } from '@std/assert';
import {
  clampColumnWidth,
  COLUMN_MAX_WIDTH_PX,
  COLUMN_MIN_WIDTH_PX,
} from '../../src/spreadsheet/column-width.ts';

Deno.test('clampColumnWidth clamps to bounds and rounds', () => {
  assertEquals(clampColumnWidth(200.4), 200);
  assertEquals(clampColumnWidth(10), COLUMN_MIN_WIDTH_PX);
  assertEquals(clampColumnWidth(9999), COLUMN_MAX_WIDTH_PX);
});

Deno.test('clampColumnWidth falls back to min for non-finite input', () => {
  assertEquals(clampColumnWidth(Number.NaN), COLUMN_MIN_WIDTH_PX);
  assertEquals(clampColumnWidth(Number.POSITIVE_INFINITY), COLUMN_MIN_WIDTH_PX);
});
