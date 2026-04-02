import type { SpreadsheetDataStore } from './types.ts';

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

/** In-memory store keyed by "row:col" — swap for a REST-backed adapter. */
export function createInMemoryDataStore(
  initial: Record<string, string | number | undefined> = {},
): SpreadsheetDataStore {
  const map = new Map<string, string | number>();
  for (const [k, v] of Object.entries(initial)) {
    if (v !== undefined) map.set(k, v);
  }
  return {
    get(row: number, col: number) {
      return map.get(cellKey(row, col));
    },
    set(row: number, col: number, value: string | number) {
      map.set(cellKey(row, col), value);
    },
  };
}
