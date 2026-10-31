import { assertEquals } from '@std/assert';
import {
  cellSpansEqual,
  coveredCellKeys,
  expandRectToSpans,
  mergeSpanList,
  normalizeCellSpans,
  spanCovering,
  spansAfterClearingRow,
  unmergeSpanList,
} from '../../src/spreadsheet/cell-span.ts';

Deno.test('normalizeCellSpans drops bad entries and overlaps', () => {
  const spans = normalizeCellSpans(
    [
      { row: 1, col: 1, rowSpan: 1, colSpan: 2 },
      { row: 1, col: 1, rowSpan: 1, colSpan: 1 },
      { row: 1, col: 2, rowSpan: 2, colSpan: 1 },
      { row: 0, col: 1, rowSpan: 2, colSpan: 2 },
      { row: 3, col: 1, rowSpan: 2, colSpan: 2 },
      'nope',
    ],
    { maxRow: 10, maxCol: 4 },
  );
  assertEquals(spans, [
    { row: 1, col: 1, rowSpan: 1, colSpan: 2 },
    { row: 3, col: 1, rowSpan: 2, colSpan: 2 },
  ]);
});

Deno.test('normalizeCellSpans drops rectangles outside the sheet', () => {
  assertEquals(
    normalizeCellSpans([{ row: 2, col: 1, rowSpan: 2, colSpan: 1 }], { maxRow: 2, maxCol: 2 }),
    [],
  );
});

Deno.test('spanCovering finds the anchor and covered cells', () => {
  const spans = [{ row: 2, col: 2, rowSpan: 2, colSpan: 3 }];
  assertEquals(spanCovering(spans, 2, 2), spans[0]);
  assertEquals(spanCovering(spans, 3, 4), spans[0]);
  assertEquals(spanCovering(spans, 2, 1), null);
  assertEquals(spanCovering([], 1, 1), null);
});

Deno.test('coveredCellKeys skips the anchor', () => {
  assertEquals(coveredCellKeys({ row: 1, col: 1, rowSpan: 2, colSpan: 2 }), ['1:2', '2:1', '2:2']);
});

Deno.test('mergeSpanList replaces intersecting spans', () => {
  const next = mergeSpanList(
    [
      { row: 1, col: 1, rowSpan: 1, colSpan: 2 },
      { row: 4, col: 1, rowSpan: 2, colSpan: 1 },
    ],
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
  );
  assertEquals(next, [
    { row: 4, col: 1, rowSpan: 2, colSpan: 1 },
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
  ]);
});

Deno.test('unmergeSpanList and row clear drop intersecting spans', () => {
  const spans = [
    { row: 1, col: 1, rowSpan: 1, colSpan: 3 },
    { row: 3, col: 1, rowSpan: 3, colSpan: 1 },
  ];
  assertEquals(unmergeSpanList(spans, { row: 1, col: 2, rowSpan: 1, colSpan: 1 }), [
    spans[1],
  ]);
  assertEquals(spansAfterClearingRow(spans, 4), [spans[0]]);
  assertEquals(cellSpansEqual(spansAfterClearingRow(spans, 2), spans), true);
});

Deno.test('expandRectToSpans includes every span the selection touches', () => {
  const expanded = expandRectToSpans(
    { row: 2, col: 2, rowSpan: 1, colSpan: 1 },
    [
      { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
      { row: 5, col: 5, rowSpan: 2, colSpan: 2 },
    ],
  );
  assertEquals(expanded, { row: 1, col: 1, rowSpan: 2, colSpan: 2 });
});
