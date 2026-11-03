import { assertEquals } from '@std/assert';
import {
  createPartnerNotifyDataStore,
  type OnCellSetNotify,
  type OnCellStyleNotify,
} from '../../src/partner/wrap-data-store.ts';
import type { SpreadsheetColumn } from '../../src/spreadsheet/types.ts';

const columns: SpreadsheetColumn[] = [
  { id: 'id', header: 'ID', widthPx: 80, readOnly: true },
  { id: 'name', header: 'Name', widthPx: 160 },
];

Deno.test('mergeCellStyle notifies the sanitized style and keeps the value', () => {
  const values: Parameters<OnCellSetNotify>[0][] = [];
  const styles: Parameters<OnCellStyleNotify>[0][] = [];
  const store = createPartnerNotifyDataStore(
    columns,
    { '1:2': 'Ada' },
    (ev) => values.push(ev),
    (ev) => styles.push(ev),
  );
  store.mergeCellStyle?.(1, 2, {
    'background-color': '#fef3c7',
    color: '#111827',
    'font-weight': '700',
    position: 'fixed',
  });
  assertEquals(values, []);
  assertEquals(styles.length, 1);
  assertEquals(styles[0]?.columnId, 'name');
  assertEquals(styles[0]?.style, {
    color: '#111827',
    'background-color': '#fef3c7',
    'font-weight': '700',
  });
  assertEquals(store.get(1, 2), 'Ada');
});

Deno.test('read-only columns do not emit style commits', () => {
  const styles: Parameters<OnCellStyleNotify>[0][] = [];
  const store = createPartnerNotifyDataStore(columns, {}, () => {}, (ev) => styles.push(ev));
  store.mergeCellStyle?.(1, 1, { color: '#111827' });
  assertEquals(styles, []);
});

Deno.test('replaceCell notifies value and style changes for undo', () => {
  const values: Parameters<OnCellSetNotify>[0][] = [];
  const styles: Parameters<OnCellStyleNotify>[0][] = [];
  const store = createPartnerNotifyDataStore(
    columns,
    { '1:2': { value: 'Ada', style: { 'font-weight': '700' } } },
    (ev) => values.push(ev),
    (ev) => styles.push(ev),
  );
  store.replaceCell?.(1, 2, null);
  assertEquals(values.map((v) => v.value), ['']);
  assertEquals(styles.map((s) => s.style), [{}]);
});

Deno.test('remote apply does not notify', () => {
  const values: Parameters<OnCellSetNotify>[0][] = [];
  const styles: Parameters<OnCellStyleNotify>[0][] = [];
  const store = createPartnerNotifyDataStore(
    columns,
    {},
    (ev) => values.push(ev),
    (ev) => styles.push(ev),
  );
  store.withRemoteApply(() => {
    store.set(1, 2, 'Bo');
    store.setCellStyle?.(1, 2, { color: '#111827' });
  });
  assertEquals(values, []);
  assertEquals(styles, []);
  assertEquals(store.get(1, 2), 'Bo');
  assertEquals(store.getCellStyle?.(1, 2), { color: '#111827' });
});

Deno.test('setCellSpans notifies the full list and remote apply stays quiet', () => {
  const batches: unknown[] = [];
  const store = createPartnerNotifyDataStore(columns, {}, () => {}, undefined, {
    onCellSpans: (spans) => batches.push(spans),
  });
  assertEquals(store.getCellSpans?.(), []);
  store.setCellSpans?.([
    { row: 1, col: 2, rowSpan: 1, colSpan: 2 },
  ]);
  assertEquals(batches, [[{ row: 1, col: 2, rowSpan: 1, colSpan: 2 }]]);
  store.withRemoteApply(() => {
    store.setCellSpans?.([]);
  });
  assertEquals(batches.length, 1);
  assertEquals(store.getCellSpans?.(), []);
});

Deno.test('setFloatingImages omits src on a move and keeps it for a new image', () => {
  const src =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const batches: unknown[] = [];
  const store = createPartnerNotifyDataStore(columns, {}, () => {}, undefined, {
    floatingImages: [{ id: 'pic', x: 0, y: 0, width: 40, height: 24, src }],
    onFloatingImages: (images) => batches.push(images),
  });
  store.setFloatingImages?.([{ id: 'pic', x: 12, y: 4, width: 40, height: 24, src }]);
  assertEquals(batches, [[{ id: 'pic', x: 12, y: 4, width: 40, height: 24 }]]);
  store.setFloatingImages?.([
    { id: 'pic', x: 12, y: 4, width: 40, height: 24, src },
    { id: 'next', x: 0, y: 0, width: 48, height: 48, src },
  ]);
  assertEquals(batches[1], [
    { id: 'pic', x: 12, y: 4, width: 40, height: 24 },
    { id: 'next', x: 0, y: 0, width: 48, height: 48, src },
  ]);
  store.withRemoteApply(() => {
    store.setFloatingImages?.([]);
  });
  assertEquals(batches.length, 2);
});

Deno.test('forEachStoredCell walks the inner store', () => {
  const store = createPartnerNotifyDataStore(
    columns,
    { '1:2': { value: 'Ada', style: { color: '#111827' } } },
    () => {},
  );
  const seen: string[] = [];
  store.forEachStoredCell?.((cell) => {
    seen.push(`${cell.row}:${cell.col}:${cell.style?.color ?? ''}`);
  });
  assertEquals(seen, ['1:2:#111827']);
});
