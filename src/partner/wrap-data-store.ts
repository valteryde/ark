import { cellSpansEqual } from '../spreadsheet/cell-span.ts';
import { cellStylesEqual } from '../spreadsheet/cell-style.ts';
import { createInMemoryDataStore, type InMemoryDataInitValue } from '../spreadsheet/data-store.ts';
import { floatingImagesEqual, floatingImagesForCommit } from '../spreadsheet/floating-image.ts';
import type {
  CellSpan,
  FloatingImage,
  SpreadsheetCellStyleDeclarations,
  SpreadsheetColumn,
  SpreadsheetDataStore,
} from '../spreadsheet/types.ts';

export type OnCellSetNotify = (args: {
  row: number;
  col: number;
  columnId: string;
  value: string | number;
  recordId?: string | number;
}) => void;

export type OnCellStyleNotify = (args: {
  row: number;
  col: number;
  columnId: string;
  /** Full replacement style. An empty object clears formatting. */
  style: SpreadsheetCellStyleDeclarations;
  recordId?: string | number;
}) => void;

function readOnlyIdColumnIndex(columns: readonly SpreadsheetColumn[]): number {
  const i = columns.findIndex((c) => c.readOnly);
  return i >= 0 ? i + 1 : 0;
}

function storedValue(value: string | number | undefined): string | number {
  return value === undefined ? '' : value;
}

/**
 * In-memory store that notifies on `set` / style changes for collab (skips when applyingRemote).
 */
export function createPartnerNotifyDataStore(
  columns: readonly SpreadsheetColumn[],
  initial: Record<string, InMemoryDataInitValue>,
  onSet: OnCellSetNotify,
  onStyle?: OnCellStyleNotify,
  options?: {
    cellSpans?: readonly CellSpan[];
    onCellSpans?: (spans: readonly CellSpan[]) => void;
    floatingImages?: readonly FloatingImage[];
    /** Wire list: `src` is omitted when the bytes did not change. */
    onFloatingImages?: (images: readonly FloatingImage[]) => void;
  },
): PartnerNotifyDataStore {
  const inner = createInMemoryDataStore(
    initial,
    options?.cellSpans ?? [],
    options?.floatingImages ?? [],
  );
  const onCellSpans = options?.onCellSpans;
  const onFloatingImages = options?.onFloatingImages;
  let applyingRemote = false;

  function recordIdFor(row: number, col: number): string | number | undefined {
    const idCol = readOnlyIdColumnIndex(columns);
    if (idCol <= 0 || idCol === col) return undefined;
    const v = inner.get(row, idCol);
    if (v !== undefined && v !== '') return v;
    return undefined;
  }

  function emitValue(row: number, col: number, value: string | number, skipReadOnly = false): void {
    const colDef = columns[col - 1];
    if (!colDef || (skipReadOnly && colDef.readOnly)) return;
    const recordId = recordIdFor(row, col);
    onSet({
      row,
      col,
      columnId: colDef.id,
      value,
      ...(recordId !== undefined ? { recordId } : {}),
    });
  }

  function emitStyle(row: number, col: number): void {
    if (!onStyle) return;
    const colDef = columns[col - 1];
    if (!colDef || colDef.readOnly) return;
    const recordId = recordIdFor(row, col);
    onStyle({
      row,
      col,
      columnId: colDef.id,
      style: inner.getCellStyle?.(row, col) ?? {},
      ...(recordId !== undefined ? { recordId } : {}),
    });
  }

  return {
    get: (row, col) => inner.get(row, col),
    getCellStyle: (row, col) => inner.getCellStyle?.(row, col),
    forEachStoredCell: (visit) => inner.forEachStoredCell?.(visit),
    mergeCellStyle(row, col, patch) {
      const before = inner.getCellStyle?.(row, col);
      inner.mergeCellStyle?.(row, col, patch);
      if (applyingRemote) return;
      if (cellStylesEqual(before, inner.getCellStyle?.(row, col))) return;
      emitStyle(row, col);
    },
    setCellStyle(row, col, style) {
      const before = inner.getCellStyle?.(row, col);
      inner.setCellStyle?.(row, col, style);
      if (applyingRemote) return;
      if (cellStylesEqual(before, inner.getCellStyle?.(row, col))) return;
      emitStyle(row, col);
    },
    hasCell: (row, col) => inner.hasCell?.(row, col) ?? false,
    getStoredCell: (row, col) => inner.getStoredCell?.(row, col),
    replaceCell(row, col, cell) {
      const before = inner.getStoredCell?.(row, col);
      inner.replaceCell?.(row, col, cell);
      if (applyingRemote) return;
      const after = inner.getStoredCell?.(row, col);
      const beforeValue = storedValue(before?.value);
      const afterValue = storedValue(after?.value);
      if (beforeValue !== afterValue) emitValue(row, col, afterValue, true);
      if (!cellStylesEqual(before?.style, after?.style)) emitStyle(row, col);
    },
    set(row, col, value) {
      inner.set(row, col, value);
      if (applyingRemote) return;
      emitValue(row, col, value);
    },
    getCellSpans: () => inner.getCellSpans?.() ?? [],
    setCellSpans(spans) {
      const before = inner.getCellSpans?.() ?? [];
      inner.setCellSpans?.(spans);
      if (applyingRemote) return;
      const after = inner.getCellSpans?.() ?? [];
      if (cellSpansEqual(before, after)) return;
      onCellSpans?.(after);
    },
    getFloatingImages: () => inner.getFloatingImages?.() ?? [],
    setFloatingImages(images) {
      const before = inner.getFloatingImages?.() ?? [];
      inner.setFloatingImages?.(images);
      if (applyingRemote) return;
      const after = inner.getFloatingImages?.() ?? [];
      if (floatingImagesEqual(before, after)) return;
      onFloatingImages?.(floatingImagesForCommit(before, after));
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
