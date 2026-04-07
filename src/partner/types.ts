import type { SpreadsheetColumn, UiToolbarCapability } from '../spreadsheet/types.ts';

/** GET /ark/routing/{path} (and same-origin /api/ark/routing/{path}) for a grid. */
export interface PartnerSheetPayload {
  title?: string;
  description?: string;
  columns: SpreadsheetColumn[];
  rows: ReadonlyArray<Record<string, unknown>>;
  rowCount?: number;
  /** Non-editable padding rows after the data grid (see `SpreadsheetConfig.ghostRowCount`). */
  ghostRowCount?: number;
  defaultRowHeightPx?: number;
  enabledUiCapabilities?: ReadonlyArray<UiToolbarCapability>;
}

/** User deleted a grid row (e.g. context menu); backend should remove the record, not only clear cells. */
export interface RowDeletedEvent {
  type: 'row.deleted';
  row: number;
  sheetPath?: string;
  clientId?: string;
  markerHue?: number;
  recordId?: string | number;
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
  /**
   * First read-only column value for this row (e.g. primary key), when present.
   * Lets the partner apply tunnel updates by id instead of row index alone.
   */
  recordId?: string | number;
}

/**
 * Ephemeral cursor / edit presence (not persisted). Peers render an outline on the cell.
 * `navigate` = selection only; `edit` = cell input is focused (another user is “in” the cell).
 */
export interface CellPresenceEvent {
  type: 'cell.presence';
  row: number;
  col: number;
  mode: 'navigate' | 'edit';
  sheetPath?: string;
  clientId?: string;
  markerHue?: number;
}

export interface CellPresenceClearEvent {
  type: 'cell.presence_clear';
  sheetPath?: string;
  clientId?: string;
}

export function isPartnerSheetPayload(x: unknown): x is PartnerSheetPayload {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.columns) && Array.isArray(o.rows);
}
