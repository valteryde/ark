/**
 * Declarative cell renderers. The backend enables a subset via
 * `SpreadsheetConfig.enabledCellStyles`; disabled styles never run (cells render as plain text).
 */
export type CellDisplayStyle = 'plain' | 'priority' | 'status' | 'assignee';

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
  | 'merge'
  | 'align'
  | 'link'
  | 'filter'
  | 'functions';

export interface SpreadsheetColumn {
  /** Stable id for CRUD mapping (e.g. API field name). */
  id: string;
  header: string;
  widthPx: number;
  /** Visual renderer; respects `enabledCellStyles`. */
  displayStyle?: CellDisplayStyle;
  /**
   * When true, cells are display-only (darker styling, no edit). Backend-driven computed / system fields.
   */
  readOnly?: boolean;
}

/**
 * Inline CSS from JSON/API; keys are CSS property names (e.g. `"background-color"`, `"color"`).
 */
export type SpreadsheetCellStyleDeclarations = Record<string, string>;

/** One cell in a payload / `createInMemoryDataStore` initial map. */
export interface SpreadsheetCellInit {
  value: string | number;
  style?: SpreadsheetCellStyleDeclarations;
}

/**
 * Backing store for cell values. Implement with REST: load into cache, persist on set.
 */
export interface SpreadsheetDataStore {
  get(row: number, col: number): string | number | undefined;
  set(row: number, col: number, value: string | number): void;
  /** Optional inline styles for the cell shell (kebab-case keys). */
  getCellStyle?(row: number, col: number): SpreadsheetCellStyleDeclarations | undefined;
}

export interface SpreadsheetConfig {
  columns: SpreadsheetColumn[];
  rowCount: number;
  defaultRowHeightPx?: number;
  data: SpreadsheetDataStore;
  /**
   * Cell renderers the backend allows. If omitted, all non-plain styles are enabled.
   * If empty, only plain text rendering is used.
   */
  enabledCellStyles?: ReadonlySet<CellDisplayStyle> | CellDisplayStyle[];
  /**
   * Toolbar features the backend exposes (for chrome binding).
   */
  enabledUiCapabilities?: ReadonlySet<UiToolbarCapability> | UiToolbarCapability[];
}

export const CELL_STYLES_WITH_RENDERERS: CellDisplayStyle[] = ['priority', 'status', 'assignee'];

export const ALL_UI_CAPABILITIES: UiToolbarCapability[] = [
  'undo',
  'redo',
  'format-bold',
  'format-italic',
  'format-strikethrough',
  'fill',
  'borders',
  'merge',
  'align',
  'link',
  'filter',
  'functions',
];

export function resolveEnabledCellStyles(
  enabled?: ReadonlySet<CellDisplayStyle> | CellDisplayStyle[],
): Set<CellDisplayStyle> {
  if (enabled === undefined) {
    return new Set(CELL_STYLES_WITH_RENDERERS);
  }
  const list = enabled instanceof Set ? [...enabled] : [...enabled];
  return new Set(list);
}
