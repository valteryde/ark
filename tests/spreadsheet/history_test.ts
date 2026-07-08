import { assertEquals } from '@std/assert';
import {
  cellMapsEqual,
  cellStatesEqual,
  createSpreadsheetHistory,
  type HistoryCellMap,
} from '../../src/spreadsheet/history.ts';

function map(entries: Record<string, { value: string | number } | undefined>): HistoryCellMap {
  const m: HistoryCellMap = new Map();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

Deno.test('cellStatesEqual compares value, style, and comment', () => {
  assertEquals(cellStatesEqual(undefined, undefined), true);
  assertEquals(cellStatesEqual({ value: 'a' }, undefined), false);
  assertEquals(cellStatesEqual({ value: 'a' }, { value: 'a' }), true);
  assertEquals(cellStatesEqual({ value: 'a' }, { value: 'b' }), false);
  assertEquals(
    cellStatesEqual({ value: 'a', style: { color: 'red' } }, { value: 'a', style: { color: 'red' } }),
    true,
  );
  assertEquals(
    cellStatesEqual({ value: 'a', style: { color: 'red' } }, { value: 'a', style: { color: 'blue' } }),
    false,
  );
});

Deno.test('cellMapsEqual compares by size and contents', () => {
  assertEquals(cellMapsEqual(map({ '1:1': { value: 'a' } }), map({ '1:1': { value: 'a' } })), true);
  assertEquals(cellMapsEqual(map({ '1:1': { value: 'a' } }), map({ '1:1': { value: 'b' } })), false);
  assertEquals(cellMapsEqual(map({ '1:1': { value: 'a' } }), map({})), false);
});

Deno.test('push/undo/redo round trips', () => {
  const h = createSpreadsheetHistory();
  assertEquals(h.canUndo(), false);
  assertEquals(h.canRedo(), false);

  h.pushRecord(map({ '1:1': undefined }), map({ '1:1': { value: 'x' } }));
  assertEquals(h.canUndo(), true);

  const undone = h.undo();
  assertEquals(undone?.before.get('1:1'), undefined);
  assertEquals(h.canUndo(), false);
  assertEquals(h.canRedo(), true);

  const redone = h.redo();
  assertEquals(redone?.after.get('1:1'), { value: 'x' });
});

Deno.test('no-op records are ignored', () => {
  const h = createSpreadsheetHistory();
  h.pushRecord(map({ '1:1': { value: 'a' } }), map({ '1:1': { value: 'a' } }));
  assertEquals(h.canUndo(), false);
  h.pushRecord(map({}), map({}));
  assertEquals(h.canUndo(), false);
});

Deno.test('pushRecord clears the redo stack', () => {
  const h = createSpreadsheetHistory();
  h.pushRecord(map({ '1:1': undefined }), map({ '1:1': { value: 'x' } }));
  h.undo();
  assertEquals(h.canRedo(), true);
  h.pushRecord(map({ '2:2': undefined }), map({ '2:2': { value: 'y' } }));
  assertEquals(h.canRedo(), false);
});

Deno.test('runBatch collapses nested changes into one record', () => {
  const h = createSpreadsheetHistory();
  h.runBatch(() => {
    h.pushRecord(map({ '1:1': undefined }), map({ '1:1': { value: 'a' } }));
    h.runBatch(() => {
      h.pushRecord(map({ '1:2': undefined }), map({ '1:2': { value: 'b' } }));
    });
  });
  assertEquals(h.canUndo(), true);
  const rec = h.undo();
  assertEquals(rec?.after.size, 2);
  assertEquals(h.canUndo(), false);
});

Deno.test('undo stack respects maxDepth', () => {
  const h = createSpreadsheetHistory(2);
  for (let i = 0; i < 5; i++) {
    h.pushRecord(map({ [`${i}:1`]: undefined }), map({ [`${i}:1`]: { value: i } }));
  }
  assertEquals(h.undo() !== null, true);
  assertEquals(h.undo() !== null, true);
  assertEquals(h.undo(), null);
});

Deno.test('subscribe notifies on changes and can unsubscribe', () => {
  const h = createSpreadsheetHistory();
  let calls = 0;
  const off = h.subscribe(() => calls++);
  h.pushRecord(map({ '1:1': undefined }), map({ '1:1': { value: 'x' } }));
  assertEquals(calls, 1);
  off();
  h.pushRecord(map({ '2:2': undefined }), map({ '2:2': { value: 'y' } }));
  assertEquals(calls, 1);
});
