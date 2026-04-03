import { createInMemoryDataStore, type InMemoryDataInitValue } from '../spreadsheet/data-store.ts';
import type { SpreadsheetColumn, SpreadsheetDataStore } from '../spreadsheet/types.ts';

export type OnCellSetNotify = (args: {
  row: number;
  col: number;
  columnId: string;
  value: string | number;
}) => void;

/**
 * In-memory store that notifies on `set` for collab/tunnel (skips when applyingRemote).
 */
export function createPartnerNotifyDataStore(
  columns: readonly SpreadsheetColumn[],
  initial: Record<string, InMemoryDataInitValue>,
  onSet: OnCellSetNotify,
): SpreadsheetDataStore {
  const inner = createInMemoryDataStore(initial);
  let applyingRemote = false;

  return {
    get: (row, col) => inner.get(row, col),
    getCellStyle: (row, col) => inner.getCellStyle?.(row, col),
    mergeCellStyle: (row, col, patch) => inner.mergeCellStyle?.(row, col, patch),
    hasCell: (row, col) => inner.hasCell?.(row, col),
    getStoredCell: (row, col) => inner.getStoredCell?.(row, col),
    replaceCell: (row, col, cell) => inner.replaceCell?.(row, col, cell),
    set(row, col, value) {
      inner.set(row, col, value);
      if (applyingRemote) return;
      const colDef = columns[col - 1];
      if (!colDef) return;
      onSet({ row, col, columnId: colDef.id, value });
    },
    /** Call around applyExternalValue / remote applies so outbound notify does not fire. */
    withRemoteApply<T>(fn: () => T): T {
      applyingRemote = true;
      try {
        return fn();
      } finally {
        applyingRemote = false;
      }
    },
  };
}

export type PartnerNotifyDataStore = SpreadsheetDataStore & {
  withRemoteApply<T>(fn: () => T): T;
};

export function isPartnerNotifyDataStore(s: SpreadsheetDataStore): s is PartnerNotifyDataStore {
  return typeof (s as PartnerNotifyDataStore).withRemoteApply === 'function';
}
