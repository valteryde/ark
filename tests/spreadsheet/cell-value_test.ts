import { assertEquals } from '@std/assert';
import {
  cellPlainTextForSearch,
  columnValueType,
  filterSelectOptions,
  isSelectColumn,
  parseCommittedCellValue,
  resolveSelectLabel,
} from '../../src/spreadsheet/cell-value.ts';
import type { SpreadsheetColumn } from '../../src/spreadsheet/types.ts';

function col(overrides: Partial<SpreadsheetColumn> = {}): SpreadsheetColumn {
  return { id: 'c', header: 'C', widthPx: 120, ...overrides };
}

const selectCol = col({
  valueType: 'select',
  selectOptions: [
    { value: 'open', label: 'Open' },
    { value: 'done', label: 'Done' },
    { value: 'in-progress', label: 'In Progress' },
  ],
});

Deno.test('columnValueType defaults to text', () => {
  assertEquals(columnValueType(undefined), 'text');
  assertEquals(columnValueType(col()), 'text');
  assertEquals(columnValueType(col({ valueType: 'number' })), 'number');
});

Deno.test('isSelectColumn requires select type and options', () => {
  assertEquals(isSelectColumn(selectCol), true);
  assertEquals(isSelectColumn(col({ valueType: 'select' })), false);
  assertEquals(isSelectColumn(col({ valueType: 'text' })), false);
});

Deno.test('parseCommittedCellValue: text passes through unchanged', () => {
  assertEquals(parseCommittedCellValue(col(), '  hi '), { ok: true, value: '  hi ' });
});

Deno.test('parseCommittedCellValue: number parses and rejects non-numbers', () => {
  const c = col({ valueType: 'number' });
  assertEquals(parseCommittedCellValue(c, '42'), { ok: true, value: 42 });
  assertEquals(parseCommittedCellValue(c, ''), { ok: true, value: '' });
  assertEquals(parseCommittedCellValue(c, 'abc'), { ok: false });
  assertEquals(parseCommittedCellValue(c, 'Infinity'), { ok: false });
});

Deno.test('parseCommittedCellValue: select matches by value or label (case-insensitive)', () => {
  assertEquals(parseCommittedCellValue(selectCol, 'done'), { ok: true, value: 'done' });
  assertEquals(parseCommittedCellValue(selectCol, 'In Progress'), {
    ok: true,
    value: 'in-progress',
  });
  assertEquals(parseCommittedCellValue(selectCol, 'nope'), { ok: false });
});

Deno.test('parseCommittedCellValue: select empty respects allowEmpty', () => {
  assertEquals(parseCommittedCellValue(selectCol, ''), { ok: true, value: '' });
  const strict = col({
    valueType: 'select',
    allowEmpty: false,
    selectOptions: [{ value: 'a' }, { value: 'b' }],
  });
  assertEquals(parseCommittedCellValue(strict, ''), { ok: true, value: 'a' });
});

Deno.test('resolveSelectLabel returns label for known value, else raw', () => {
  assertEquals(resolveSelectLabel(selectCol, 'in-progress'), 'In Progress');
  assertEquals(resolveSelectLabel(selectCol, 'unknown'), 'unknown');
  assertEquals(resolveSelectLabel(col(), 'x'), 'x');
});

Deno.test('cellPlainTextForSearch formats by column type', () => {
  assertEquals(cellPlainTextForSearch(undefined, undefined), '');
  assertEquals(cellPlainTextForSearch(col({ valueType: 'number' }), 7), '7');
  assertEquals(cellPlainTextForSearch(col(), '  hi '), 'hi');
  assertEquals(cellPlainTextForSearch(selectCol, 'done'), 'Done');
});

Deno.test('filterSelectOptions ranks prefix before substring', () => {
  const results = filterSelectOptions(selectCol, 'o');
  assertEquals(results.map((o) => o.value), ['open', 'done', 'in-progress']);
  assertEquals(filterSelectOptions(selectCol, ''), selectCol.selectOptions);
  assertEquals(filterSelectOptions(col(), 'x'), []);
});
