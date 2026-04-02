import type { SpreadsheetColumn, SpreadsheetSelectOption } from './types.ts';

const MAX_SUGGEST = 50;

export function columnValueType(
  column: SpreadsheetColumn | undefined,
): 'text' | 'number' | 'select' {
  return column?.valueType ?? 'text';
}

export function isSelectColumn(column: SpreadsheetColumn | undefined): boolean {
  return (
    columnValueType(column) === 'select' &&
    (column?.selectOptions?.length ?? 0) > 0
  );
}

export function parseCommittedCellValue(
  column: SpreadsheetColumn | undefined,
  raw: string,
): { ok: true; value: string | number } | { ok: false } {
  const vt = columnValueType(column);
  if (vt === 'text') {
    return { ok: true, value: raw };
  }
  if (vt === 'number') {
    const t = raw.trim();
    if (t === '') return { ok: true, value: '' };
    const n = Number(t);
    if (!Number.isFinite(n)) return { ok: false };
    return { ok: true, value: n };
  }
  const options = column?.selectOptions ?? [];
  const t = raw.trim();
  if (t === '') {
    if (column?.allowEmpty !== false) return { ok: true, value: '' };
    const first = options[0];
    if (first) return { ok: true, value: first.value };
    return { ok: false };
  }
  const match = options.find((o) => o.value === t);
  if (match) return { ok: true, value: match.value };
  return { ok: false };
}

export function resolveSelectLabel(
  column: SpreadsheetColumn | undefined,
  storedValue: string,
): string {
  if (columnValueType(column) !== 'select') return storedValue;
  const t = storedValue.trim();
  const opt = column?.selectOptions?.find((o) => o.value === t);
  return opt?.label ?? opt?.value ?? storedValue;
}

/** Prefix matches first, then substring; case-insensitive on value and label. */
export function filterSelectOptions(
  column: SpreadsheetColumn | undefined,
  query: string,
): SpreadsheetSelectOption[] {
  if (!isSelectColumn(column)) return [];
  const options = column!.selectOptions!;
  const q = query.trim().toLowerCase();
  if (!q) return [...options].slice(0, MAX_SUGGEST);
  const prefix: SpreadsheetSelectOption[] = [];
  const substr: SpreadsheetSelectOption[] = [];
  for (const o of options) {
    const v = o.value.toLowerCase();
    const l = (o.label ?? o.value).toLowerCase();
    if (v.startsWith(q) || l.startsWith(q)) prefix.push(o);
    else if (v.includes(q) || l.includes(q)) substr.push(o);
  }
  return [...prefix, ...substr].slice(0, MAX_SUGGEST);
}
