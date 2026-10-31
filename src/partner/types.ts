import type {
  CellSpan,
  SpreadsheetCellStyleDeclarations,
  SpreadsheetColumn,
  UiToolbarCapability,
} from '../spreadsheet/types.ts';

/** Top-right header link rendered from `PartnerSheetPayload.chromeActions`. */
export interface PartnerChromeAction {
  label: string;
  /** Relative path (`/other-sheet`) or `https:` / `http:` / `mailto:` URL. */
  href: string;
  variant?: 'ghost' | 'primary';
  /** Phosphor regular icon name, e.g. `arrow-square-out` → `ph ph-arrow-square-out`. */
  icon?: string;
  openInNewTab?: boolean;
}

/** GET /api/sheets/{path} — Ark-owned sheet document payload for a grid. */
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
  /**
   * When `false`, the header Export PDF button is hidden and
   * `GET /api/sheets/{path}/pdf` returns 403. Omitted means export is allowed.
   * The partner CRUD route ignores this flag.
   */
  pdfExport?: boolean;
  /** Optional links in the header chrome (top right). Max 8; invalid entries ignored. */
  chromeActions?: ReadonlyArray<PartnerChromeAction>;
  /** Server document revision (increments per mutation). */
  revision?: number;
  /** Partner template the document was created from (pulled live at creation). */
  template?: { name?: string; version: string };
  /** Sparse out-of-schema cells keyed `"row:col"` (1-based grid indices). */
  cells?: Record<string, string | number>;
  /**
   * Per-cell presentation styles keyed `"row:col"` (1-based). Values are
   * sanitized CSS declarations (`color`, `background-color`, `font-weight`, …).
   */
  cellStyles?: Record<string, SpreadsheetCellStyleDeclarations>;
  /**
   * Merged rectangles. The value and style live on the anchor (`row`, `col`).
   * Covered cells are empty. Present only when the sheet has at least one merge.
   */
  cellSpans?: readonly CellSpan[];
}

/** Full replacement of the sheet's merge list. An empty array clears every merge. */
export interface CellSpansCommittedEvent {
  type: 'cell.spans_committed';
  cellSpans: readonly CellSpan[];
  /** Anchor used when a save failure needs a cell to mark. */
  row: number;
  col: number;
  sheetPath?: string;
  clientId?: string;
  markerHue?: number;
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

/** Full replacement of one cell's style. An empty `style` object clears it. */
export interface CellStyleCommittedEvent {
  type: 'cell.style_committed';
  row: number;
  col: number;
  columnId: string;
  style: SpreadsheetCellStyleDeclarations;
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
