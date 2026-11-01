import { assertEquals } from '@std/assert';
import { cellAddress, cellRangeLabel, columnLetters } from '../../src/spreadsheet/cell-address.ts';

Deno.test('columnLetters counts up like a spreadsheet', () => {
  assertEquals(columnLetters(1), 'A');
  assertEquals(columnLetters(26), 'Z');
  assertEquals(columnLetters(27), 'AA');
  assertEquals(columnLetters(52), 'AZ');
  assertEquals(columnLetters(703), 'AAA');
  assertEquals(columnLetters(0), '');
});

Deno.test('cellAddress renders a single coordinate', () => {
  assertEquals(cellAddress(3, 3), 'C3');
  assertEquals(cellAddress(1, 1), 'A1');
  assertEquals(cellAddress(12, 28), 'AB12');
  assertEquals(cellAddress(0, 1), '');
});

Deno.test('cellRangeLabel collapses 1x1 and spans the rest', () => {
  assertEquals(cellRangeLabel({ row: 2, col: 2, rowSpan: 1, colSpan: 1 }), 'B2');
  assertEquals(cellRangeLabel({ row: 1, col: 1, rowSpan: 3, colSpan: 3 }), 'A1:C3');
  assertEquals(cellRangeLabel({ row: 4, col: 2, rowSpan: 1, colSpan: 2 }), 'B4:C4');
  assertEquals(cellRangeLabel({ row: 1, col: 1, rowSpan: 0, colSpan: 0 }), 'A1');
});
