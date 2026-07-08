import { assertEquals } from '@std/assert';
import {
  normalizePartnerSheetPayload,
  normalizeSheetTruthPayload,
  partnerEffectiveRowCount,
  rowsToInitialMap,
} from '../../src/partner/map-sheet-payload.ts';
import type { SpreadsheetColumn } from '../../src/spreadsheet/types.ts';

const columns: SpreadsheetColumn[] = [
  { id: 'name', header: 'Name', widthPx: 120 },
  { id: 'age', header: 'Age', widthPx: 120, valueType: 'number' },
];

Deno.test('normalizePartnerSheetPayload rejects malformed input', () => {
  assertEquals(normalizePartnerSheetPayload(null), null);
  assertEquals(normalizePartnerSheetPayload({}), null);
  assertEquals(normalizePartnerSheetPayload({ columns: [], rows: [] }), null);
  assertEquals(normalizePartnerSheetPayload({ columns: [{ id: 'a', header: 'A' }] }), null);
});

Deno.test('normalizePartnerSheetPayload reads flat shape and defaults widthPx', () => {
  const result = normalizePartnerSheetPayload({
    title: 'People',
    columns: [{ id: 'name', header: 'Name' }],
    rows: [{ name: 'Ada' }],
  });
  assertEquals(result?.title, 'People');
  assertEquals(result?.columns[0], { id: 'name', header: 'Name', widthPx: 120 });
  assertEquals(result?.rows, [{ name: 'Ada' }]);
});

Deno.test('normalizePartnerSheetPayload flattens nested sheets[0] and lifts title', () => {
  const result = normalizePartnerSheetPayload({
    title: 'Outer',
    sheets: [{ columns: [{ id: 'name', header: 'Name' }], rows: [{ name: 'Ada' }] }],
  });
  assertEquals(result?.title, 'Outer');
  assertEquals(result?.columns.length, 1);
});

Deno.test('normalizePartnerSheetPayload drops invalid columns', () => {
  const result = normalizePartnerSheetPayload({
    columns: [{ id: 'ok', header: 'OK' }, { header: 'no id' }, 'nope'],
    rows: [],
  });
  assertEquals(result?.columns.length, 1);
});

Deno.test('normalizePartnerSheetPayload parses hidden and forces readOnly', () => {
  const result = normalizePartnerSheetPayload({
    columns: [{ id: 'id', header: 'ID', widthPx: 72, hidden: true }],
    rows: [{ id: 1 }],
  });
  assertEquals(result?.columns[0], {
    id: 'id',
    header: 'ID',
    widthPx: 72,
    hidden: true,
    readOnly: true,
  });
});

Deno.test('rowsToInitialMap keys cells by row:col (1-indexed) and skips blanks', () => {
  const initial = rowsToInitialMap(columns, [
    { name: 'Ada', age: 30 },
    { name: 'Bo' },
  ]);
  assertEquals(initial['1:1'], 'Ada');
  assertEquals(initial['1:2'], 30);
  assertEquals(initial['2:1'], 'Bo');
  assertEquals('2:2' in initial, false);
});

Deno.test('rowsToInitialMap coerces booleans to strings', () => {
  const initial = rowsToInitialMap([{ id: 'flag', header: 'Flag', widthPx: 120 }], [
    { flag: true },
    { flag: false },
  ]);
  assertEquals(initial['1:1'], 'true');
  assertEquals(initial['2:1'], 'false');
});

Deno.test('partnerEffectiveRowCount honors explicit rowCount above data length', () => {
  assertEquals(partnerEffectiveRowCount({ columns, rows: [{}, {}], rowCount: 500 }), 500);
});

Deno.test('partnerEffectiveRowCount pads to at least 100', () => {
  assertEquals(partnerEffectiveRowCount({ columns, rows: [{}, {}] }), 100);
});

Deno.test('partnerEffectiveRowCount ignores rowCount below data length', () => {
  const rows = Array.from({ length: 150 }, () => ({}));
  assertEquals(partnerEffectiveRowCount({ columns, rows, rowCount: 5 }), 150);
});

Deno.test('normalizeSheetTruthPayload requires type and sheetPath', () => {
  assertEquals(normalizeSheetTruthPayload({ rows: [] }, null), null);
  assertEquals(
    normalizeSheetTruthPayload({ type: 'sheet.truth', rows: [] }, null),
    null,
  );
});

Deno.test('normalizeSheetTruthPayload falls back to prior columns when omitted', () => {
  const result = normalizeSheetTruthPayload(
    { type: 'sheet.truth', sheetPath: 'clients', rows: [{ name: 'Ada' }] },
    columns,
  );
  assertEquals(result?.sheetPath, 'clients');
  assertEquals(result?.payload.columns, columns);
  assertEquals(result?.payload.rows, [{ name: 'Ada' }]);
});

Deno.test('normalizeSheetTruthPayload requires columns when no fallback', () => {
  assertEquals(
    normalizeSheetTruthPayload(
      { type: 'sheet.truth', sheetPath: 'clients', rows: [] },
      null,
    ),
    null,
  );
});
