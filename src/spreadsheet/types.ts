/**
 * Toolbar / chrome features the backend may expose. The app shell can hide controls when
 * a capability is missing (wiring TBD); the contract is defined here for API payloads.
 */
export type UiToolbarCapability =
  | 'undo'
  | 'redo'
  | 'format-bold'
  | 'format-italic'
  | 'format-strikethrough'
  | 'fill'
  | 'borders'
  | 'align'
  | 'link'
  | 'comment'
  | 'functions';

/** Stored cell value is always the canonical `value` string. */
export interface SpreadsheetSelectOption {
  value: string;
  label?: string;
  /**
   * Phosphor icon name (lowercase, hyphens), e.g. `check-circle` → classes `ph ph-check-circle`.
   * Must match /^[a-z0-9-]+$/ after trim. Invalid values are ignored at render time.
   */
  icon?: string;
  /** CSS color for pill text (hex or safe rgb/rgba only; validated at render time). */
  color?: string;
  /** CSS background for the pill (hex or safe rgb/rgba only). */
  backgroundColor?: string;
}

export type SpreadsheetColumnValueType = 'text' | 'number' | 'select';

export interface SpreadsheetColumn {
  /** Stable id for CRUD mapping (e.g. API field name). */
  id: string;
  header: string;
  widthPx: number;
  /**
   * When true, cells are display-only (darker styling, no edit). Backend-driven computed / system fields.
   */
  readOnly?: boolean;
  /**
   * Value kind for commit-time validation and editors. Omitted means `'text'`.
   */
  valueType?: SpreadsheetColumnValueType;
  /**
   * Allowed values when `valueType === 'select'`. User picks via suggestions / autofill; commit must match `value`.
   */
  selectOptions?: ReadonlyArray<SpreadsheetSelectOption>;
  /**
   * When false on a select column, empty input commits as the first option’s value. Default true.
   */
  allowEmpty?: boolean;
}

/**
 * Inline CSS from JSON/API; keys are CSS property names (e.g. `"background-color"`, `"color"`).
 */
export type SpreadsheetCellStyleDeclarations = Record<string, string>;

/** One cell in a payload / `createInMemoryDataStore` initial map. */
export interface SpreadsheetCellInit {
  value: string | number;
  style?: SpreadsheetCellStyleDeclarations;
  /** Plain-text note attached to the cell (not shown in-cell; surfaced via comment UI). */
  comment?: string;
}

/**
 * Backing store for cell values. Implement with REST: load into cache, persist on set.
 */
export interface SpreadsheetDataStore {
  get(row: number, col: number): string | number | undefined;
  set(row: number, col: number, value: string | number): void;
  /** Optional inline styles for the cell shell (kebab-case keys). */
  getCellStyle?(row: number, col: number): SpreadsheetCellStyleDeclarations | undefined;
  /** Merge CSS keys onto the cell; `undefined` or empty string removes that property. */
  mergeCellStyle?(row: number, col: number, patch: Record<string, string | undefined>): void;
  /** True if the backing map has an entry for this cell (used for undo snapshots). */
  hasCell?(row: number, col: number): boolean;
  /** Full `{ value, style }` for the cell, or `undefined` if the key is absent. */
  getStoredCell?(row: number, col: number): SpreadsheetCellInit | undefined;
  /** Set cell exactly, or `null` to remove the key. Required for undo/redo when implemented. */
  replaceCell?(row: number, col: number, cell: SpreadsheetCellInit | null): void;
}

export interface SpreadsheetConfig {
  columns: SpreadsheetColumn[];
  rowCount: number;
  defaultRowHeightPx?: number;
  data: SpreadsheetDataStore;
  /**
   * Toolbar features the backend exposes (for chrome binding).
   */
  enabledUiCapabilities?: ReadonlySet<UiToolbarCapability> | UiToolbarCapability[];
  /**
   * When a paste needs more rows than `rowCount`, the host can remount with a larger `rowCount`
   * and replay the paste. If set, called instead of clipping when the paste grid extends past the bottom.
   */
  growRowCountForPaste?: (args: { minRowCount: number; plain: string }) => void;
  /**
   * Wrap undo/redo snapshot application so outbound sync (e.g. partner collab) is suppressed,
   * matching remote apply paths.
   */
  suppressOutboundSyncDuring?: (fn: () => void) => void;
}

export const ALL_UI_CAPABILITIES: UiToolbarCapability[] = [
  'undo',
  'redo',
  'format-bold',
  'format-italic',
  'format-strikethrough',
  'fill',
  'borders',
  'align',
  'link',
  'comment',
  'functions',
];

export function resolveEnabledUiCapabilities(
  enabled?: ReadonlySet<UiToolbarCapability> | UiToolbarCapability[],
): Set<UiToolbarCapability> {
  if (enabled === undefined) {
    return new Set(ALL_UI_CAPABILITIES);
  }
  const list = enabled instanceof Set ? [...enabled] : [...enabled];
  return new Set(list);
}

/** Local cursor for WebSocket presence (not stored in the sheet). */
export type CollabPresenceMode = 'navigate' | 'edit';

export interface CollabPresencePayload {
  row: number;
  col: number;
  mode: CollabPresenceMode;
}

/** Remote peer cursor to render as an outline on the grid. */
export interface RemoteCollabPeer {
  clientId: string;
  row: number;
  col: number;
  mode: CollabPresenceMode;
  /** 0–360; defaults in the UI if omitted by older clients. */
  markerHue: number;
}

/** Returned by `mountSpreadsheet` for wiring the formatting toolbar and extensions. */
export interface SpreadsheetMountHandle {
  /** Apply CSS property patches to the current selection (via store `mergeCellStyle`). */
  mergeCellStyleOnSelection(patch: Record<string, string | undefined>): void;
  /** Per-cell CSS patches when values differ across the selection (e.g. mixed strikethrough). */
  mergeCellStyleOnEachTarget(
    patchForCell: (row: number, col: number) => Record<string, string | undefined>,
  ): void;
  /** True when every writable target cell’s style property satisfies the predicate. */
  everyTargetCellStyle(
    cssProperty: string,
    predicate: (value: string | undefined) => boolean,
  ): boolean;
  getCellStyleAt(row: number, col: number): SpreadsheetCellStyleDeclarations | undefined;
  subscribeSelectionChange(cb: () => void): () => void;
  /** Whether undo/redo is available (requires `replaceCell` on the data store). */
  readonly historyEnabled: boolean;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  subscribeHistoryChange(cb: () => void): () => void;
  /** Coalesce multiple mutations into one undo step (e.g. color picker drag). */
  runHistoryBatch(fn: () => void): void;
  /** Start a coalesced undo group; pair with `endHistoryBatch` (e.g. native color UI). */
  beginHistoryBatch(): void;
  endHistoryBatch(): void;
  /** True when the config enables comments and the store supports `getStoredCell` / `replaceCell`. */
  readonly commentsEnabled: boolean;
  /** Focused cell is the paste anchor (top-left of range when a multi-cell selection is active). */
  openCommentEditor(): void;
  /**
   * Apply a value from outside local editing (e.g. WebSocket collab). Does not create undo history.
   * Returns false if row/col is out of range or the cell is not mounted.
   */
  applyExternalValue(
    row: number,
    col: number,
    value: string | number,
    options?: { remoteMarkerHue?: number },
  ): boolean;
  /** Current cell + whether the editor is focused (for collab presence). */
  getCollabPresencePayload(): CollabPresencePayload | null;
  /** Show other users’ cursors; pass `[]` to clear. */
  setRemoteCollabPresence(peers: readonly RemoteCollabPeer[]): void;
  /**
   * Subtle per-cell hint when persistence (partner tunnel) failed after a local commit.
   * Clears when the user edits the cell or after a short timeout.
   */
  showCellPersistError(row: number, col: number, message?: string): void;
  /**
   * Re-apply clipboard TSV/CSV text as if the user pasted it (same validation as native paste).
   * Used after the host expands `rowCount` following `growRowCountForPaste`.
   */
  replayClipboardPaste(plain: string): void;
}
