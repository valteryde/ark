/** Bounds applied to user-resized column widths. */
export const COLUMN_MIN_WIDTH_PX = 48;
export const COLUMN_MAX_WIDTH_PX = 800;

export function clampColumnWidth(w: number): number {
  if (!Number.isFinite(w)) return COLUMN_MIN_WIDTH_PX;
  return Math.max(COLUMN_MIN_WIDTH_PX, Math.min(COLUMN_MAX_WIDTH_PX, Math.round(w)));
}

/** Load persisted widths from `sessionStorage`; returns `null` on any mismatch/parse failure. */
export function readPersistedColumnWidths(
  key: string | undefined,
  columnCount: number,
): number[] | null {
  if (!key || columnCount === 0) return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const widths = (parsed as { widths?: unknown }).widths;
    if (!Array.isArray(widths) || widths.length !== columnCount) return null;
    const out: number[] = [];
    for (const w of widths) {
      if (typeof w !== 'number' || !Number.isFinite(w)) return null;
      out.push(clampColumnWidth(w));
    }
    return out;
  } catch {
    return null;
  }
}

export function persistColumnWidths(key: string | undefined, widths: readonly number[]): void {
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ widths }));
  } catch {
    /* quota / disabled storage: silently ignore */
  }
}
