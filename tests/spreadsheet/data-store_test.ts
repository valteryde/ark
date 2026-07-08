import { assertEquals } from '@std/assert';
import { cellKey, createInMemoryDataStore } from '../../src/spreadsheet/data-store.ts';
import type { SpreadsheetDataStore } from '../../src/spreadsheet/types.ts';

/** The in-memory store implements every optional method, so widen for tests. */
const makeStore = (
  ...args: Parameters<typeof createInMemoryDataStore>
): Required<SpreadsheetDataStore> =>
  createInMemoryDataStore(...args) as Required<SpreadsheetDataStore>;

Deno.test('cellKey formats row:col', () => {
  assertEquals(cellKey(2, 3), '2:3');
});

Deno.test('createInMemoryDataStore seeds scalar and object init values', () => {
  const store = makeStore({
    '1:1': 'hello',
    '1:2': 42,
    '2:1': { value: 'styled', style: { 'font-weight': 'bold' } },
  });
  assertEquals(store.get(1, 1), 'hello');
  assertEquals(store.get(1, 2), 42);
  assertEquals(store.get(2, 1), 'styled');
  assertEquals(store.getCellStyle(2, 1), { 'font-weight': 'bold' });
  assertEquals(store.get(9, 9), undefined);
});

Deno.test('set preserves existing style and comment', () => {
  const store = makeStore({
    '1:1': { value: 'a', style: { color: 'red' }, comment: 'note' },
  });
  store.set(1, 1, 'b');
  assertEquals(store.get(1, 1), 'b');
  assertEquals(store.getCellStyle(1, 1), { color: 'red' });
  assertEquals(store.getStoredCell(1, 1)?.comment, 'note');
});

Deno.test('mergeCellStyle adds and removes declarations', () => {
  const store = makeStore();
  store.mergeCellStyle(1, 1, { color: 'red', 'font-weight': 'bold' });
  assertEquals(store.getCellStyle(1, 1), { color: 'red', 'font-weight': 'bold' });
  store.mergeCellStyle(1, 1, { color: undefined });
  assertEquals(store.getCellStyle(1, 1), { 'font-weight': 'bold' });
});

Deno.test('mergeCellStyle on empty cell with only removals is a no-op', () => {
  const store = makeStore();
  store.mergeCellStyle(1, 1, { color: undefined });
  assertEquals(store.hasCell(1, 1), false);
});

Deno.test('getStoredCell omits empty style and comment', () => {
  const store = makeStore({ '1:1': 'plain' });
  assertEquals(store.getStoredCell(1, 1), { value: 'plain' });
  assertEquals(store.getStoredCell(5, 5), undefined);
});

Deno.test('replaceCell writes and deletes', () => {
  const store = makeStore();
  store.replaceCell(1, 1, { value: 'x', style: { color: 'blue' }, comment: '  ' });
  assertEquals(store.getStoredCell(1, 1), { value: 'x', style: { color: 'blue' } });
  store.replaceCell(1, 1, null);
  assertEquals(store.hasCell(1, 1), false);
});
