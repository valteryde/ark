import { cellKey, type InMemoryDataInitValue } from '../spreadsheet/data-store.ts';
import type {
  SpreadsheetColumn,
  SpreadsheetConfig,
  SpreadsheetSelectOption,
  UiToolbarCapability,
} from '../spreadsheet/types.ts';
import type { PartnerSheetPayload } from './types.ts';

function normalizeSelectOption(x: unknown): SpreadsheetSelectOption | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.value !== 'string') return null;
  const out: SpreadsheetSelectOption = { value: o.value };
  if (typeof o.label === 'string') out.label = o.label;
  if (typeof o.icon === 'string') out.icon = o.icon;
  if (typeof o.color === 'string') out.color = o.color;
  if (typeof o.backgroundColor === 'string') out.backgroundColor = o.backgroundColor;
  return out;
}

function normalizeColumn(c: unknown): SpreadsheetColumn | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.header !== 'string') return null;
  const widthPx = typeof o.widthPx === 'number' && Number.isFinite(o.widthPx) && o.widthPx > 0 ? o.widthPx : 120;
  const col: SpreadsheetColumn = { id: o.id, header: o.header, widthPx };
  if (typeof o.readOnly === 'boolean') col.readOnly = o.readOnly;
  if (o.valueType === 'text' || o.valueType === 'number' || o.valueType === 'select') {
    col.valueType = o.valueType;
  }
  if (Array.isArray(o.selectOptions)) {
    const opts: SpreadsheetSelectOption[] = [];
    for (const x of o.selectOptions) {
      const so = normalizeSelectOption(x);
      if (so) opts.push(so);
    }
    if (opts.length) col.selectOptions = opts;
  }
  if (typeof o.allowEmpty === 'boolean') col.allowEmpty = o.allowEmpty;
  return col;
}

/**
 * Flatten partner JSON into a grid payload.
 * Supports either a flat `{ columns, rows, ... }` or a nested `{ title, sheets: [{ columns, rows, ... }] }`
 * where the outer `title` is typically the page / view title.
 */
export function normalizePartnerSheetPayload(raw: unknown): PartnerSheetPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  let src: Record<string, unknown> = o;

  if (Array.isArray(o.sheets) && o.sheets.length > 0) {
    const inner = o.sheets[0];
    if (!inner || typeof inner !== 'object') return null;
    const i = inner as Record<string, unknown>;
    if (!Array.isArray(i.columns) || !Array.isArray(i.rows)) return null;
    src = {
      ...i,
      title: typeof o.title === 'string' ? o.title : typeof i.title === 'string' ? i.title : undefined,
      description:
        typeof o.description === 'string'
          ? o.description
          : typeof i.description === 'string'
            ? i.description
            : undefined,
      rowCount:
        typeof i.rowCount === 'number' && i.rowCount >= 1
          ? i.rowCount
          : typeof o.rowCount === 'number' && o.rowCount >= 1
            ? o.rowCount
            : undefined,
      defaultRowHeightPx:
        typeof i.defaultRowHeightPx === 'number' && i.defaultRowHeightPx > 0
          ? i.defaultRowHeightPx
          : typeof o.defaultRowHeightPx === 'number' && o.defaultRowHeightPx > 0
            ? o.defaultRowHeightPx
            : undefined,
      enabledUiCapabilities: i.enabledUiCapabilities ?? o.enabledUiCapabilities,
    };
  }

  if (!Array.isArray(src.columns) || !Array.isArray(src.rows)) return null;
  const columns = (src.columns as unknown[]).map(normalizeColumn).filter((c): c is SpreadsheetColumn => c !== null);
  if (columns.length === 0) return null;
  const rows = (src.rows as unknown[]).filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object');
  return {
    title: typeof src.title === 'string' ? src.title : undefined,
    description: typeof src.description === 'string' ? src.description : undefined,
    columns,
    rows,
    rowCount: typeof src.rowCount === 'number' && src.rowCount >= 1 ? src.rowCount : undefined,
    defaultRowHeightPx:
      typeof src.defaultRowHeightPx === 'number' && src.defaultRowHeightPx > 0
        ? src.defaultRowHeightPx
        : undefined,
    enabledUiCapabilities: Array.isArray(src.enabledUiCapabilities)
      ? (src.enabledUiCapabilities.filter((s): s is UiToolbarCapability => typeof s === 'string') as UiToolbarCapability[])
      : undefined,
  };
}

function cellValueFromRow(row: Record<string, unknown>, columnId: string): string | number | undefined {
  const v = row[columnId];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  return String(v);
}

/** Map API rows (objects keyed by column id) to createInMemoryDataStore initial keys `"row:col"`. */
export function rowsToInitialMap(
  columns: readonly SpreadsheetColumn[],
  rows: ReadonlyArray<Record<string, unknown>>,
): Record<string, InMemoryDataInitValue> {
  const initial: Record<string, InMemoryDataInitValue> = {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const rowIndex = r + 1;
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c]!;
      const v = cellValueFromRow(row, col.id);
      if (v !== undefined) {
        initial[cellKey(rowIndex, c + 1)] = v;
      }
    }
  }
  return initial;
}

/** Build SpreadsheetConfig from a validated payload and an existing data store. */
export function sheetPayloadToConfig(
  payload: PartnerSheetPayload,
  data: SpreadsheetConfig['data'],
): SpreadsheetConfig {
  const { columns, rows, rowCount, defaultRowHeightPx, enabledUiCapabilities } = payload;
  const minRows = Math.max(rows.length, 1);
  const rc = rowCount !== undefined && rowCount >= minRows ? rowCount : Math.max(minRows, 100);

  return {
    columns,
    rowCount: rc,
    defaultRowHeightPx,
    data,
    enabledUiCapabilities,
  };
}
