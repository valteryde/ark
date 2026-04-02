import type {
  SpreadsheetCellInit,
  SpreadsheetDataStore,
  SpreadsheetCellStyleDeclarations,
} from './types.ts';

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

type StoredCell = {
  value: string | number;
  style?: SpreadsheetCellStyleDeclarations;
};

/** Value for one key in the initial map: plain scalar or `{ value, style }`. */
export type InMemoryDataInitValue = string | number | SpreadsheetCellInit | undefined;

function normalizeInitEntry(v: InMemoryDataInitValue): StoredCell | undefined {
  if (v === undefined) return undefined;
  if (v !== null && typeof v === 'object' && 'value' in v) {
    const o = v as SpreadsheetCellInit;
    return { value: o.value, style: o.style };
  }
  return { value: v as string | number };
}

/** In-memory store keyed by "row:col" — swap for a REST-backed adapter. */
export function createInMemoryDataStore(
  initial: Record<string, InMemoryDataInitValue> = {},
): SpreadsheetDataStore {
  const map = new Map<string, StoredCell>();
  for (const [k, v] of Object.entries(initial)) {
    const cell = normalizeInitEntry(v);
    if (cell !== undefined) map.set(k, cell);
  }
  return {
    get(row: number, col: number) {
      return map.get(cellKey(row, col))?.value;
    },
    getCellStyle(row: number, col: number) {
      return map.get(cellKey(row, col))?.style;
    },
    set(row: number, col: number, value: string | number) {
      const k = cellKey(row, col);
      const prev = map.get(k);
      map.set(k, { value, style: prev?.style });
    },
    mergeCellStyle(row: number, col: number, patch: Record<string, string | undefined>) {
      const k = cellKey(row, col);
      const prev = map.get(k);
      const value = prev !== undefined ? prev.value : '';
      const style: SpreadsheetCellStyleDeclarations = { ...prev?.style };
      for (const [p, val] of Object.entries(patch)) {
        const name = p.trim();
        if (!name) continue;
        if (val === undefined || val === '') {
          delete style[name];
        } else {
          style[name] = val;
        }
      }
      const nextStyle = Object.keys(style).length > 0 ? style : undefined;
      if (prev === undefined && value === '' && nextStyle === undefined) {
        return;
      }
      map.set(k, { value, style: nextStyle });
    },
  };
}
