import type { CellDisplayStyle, SpreadsheetColumn, UiToolbarCapability } from '../spreadsheet/types.ts';

/** GET /ark/routing/{path} (and same-origin /api/ark/routing/{path}) for a grid. */
export interface PartnerSheetPayload {
  title?: string;
  description?: string;
  columns: SpreadsheetColumn[];
  rows: ReadonlyArray<Record<string, unknown>>;
  rowCount?: number;
  defaultRowHeightPx?: number;
  enabledCellStyles?: ReadonlyArray<CellDisplayStyle>;
  enabledUiCapabilities?: ReadonlyArray<UiToolbarCapability>;
}

export interface CellValueCommittedEvent {
  type: 'cell.value_committed';
  row: number;
  col: number;
  columnId: string;
  value: string | number;
  /** When set, receivers ignore the event if it does not match the active sheet route. */
  sheetPath?: string;
  /** Stable id for this browser tab; receivers skip their own messages. */
  clientId?: string;
  /** 0–360; peers flash the cell with this hue when applying the remote value. */
  markerHue?: number;
}

export function isPartnerSheetPayload(x: unknown): x is PartnerSheetPayload {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.columns) && Array.isArray(o.rows);
}
