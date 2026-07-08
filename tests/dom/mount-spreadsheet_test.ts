import { assertEquals, assertExists } from '@std/assert';
import { setupDom, teardownDom, type DomEnv } from './setup.ts';
import { mountSpreadsheet } from '../../src/spreadsheet/mount-spreadsheet.ts';
import { createInMemoryDataStore } from '../../src/spreadsheet/data-store.ts';
import type {
  SpreadsheetColumn,
  SpreadsheetConfig,
  InMemoryDataInitValue,
} from '../../src/spreadsheet/index.ts';

const COLUMNS: SpreadsheetColumn[] = [
  { id: 'name', header: 'Name', widthPx: 160 },
  { id: 'count', header: 'Count', widthPx: 100, valueType: 'number' },
  {
    id: 'status',
    header: 'Status',
    widthPx: 120,
    valueType: 'select',
    selectOptions: [
      { value: 'open', label: 'Open' },
      { value: 'done', label: 'Done' },
    ],
  },
];

function config(
  initial: Record<string, InMemoryDataInitValue> = {},
  overrides: Partial<SpreadsheetConfig> = {},
): SpreadsheetConfig {
  return {
    columns: COLUMNS,
    rowCount: 4,
    data: createInMemoryDataStore(initial),
    ...overrides,
  };
}

/** Wrap a test body in a fresh DOM env, flushing deferred focus/rAF work before teardown. */
function domTest(name: string, fn: (env: DomEnv) => void): void {
  Deno.test(name, async () => {
    const env = setupDom();
    try {
      fn(env);
      // Let queued focus / requestAnimationFrame callbacks run while the DOM
      // globals are still installed, so they don't throw after teardown.
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      teardownDom();
    }
  });
}

domTest('mount renders headers, gutters, and a cell per row/column', (env) => {
  const container = env.makeContainer();
  mountSpreadsheet(container, config());

  const headers = container.querySelectorAll('.sheet-column-header-label');
  assertEquals([...headers].map((h) => h.textContent), ['Name', 'Count', 'Status']);

  const cells = container.querySelectorAll('.sheet-cell');
  assertEquals(cells.length, 4 * 3);

  const gutters = container.querySelectorAll('.sheet-row-gutter');
  assertEquals([...gutters].map((g) => g.textContent), ['1', '2', '3', '4']);
});

domTest('mount hydrates cells from the data store', (env) => {
  const container = env.makeContainer();
  mountSpreadsheet(
    container,
    config({ '1:1': 'Ada', '1:2': 42, '2:3': 'done' }),
  );

  const cellContent = (row: number, col: number) =>
    container
      .querySelector(`.sheet-cell[data-row="${row}"][data-col="${col}"] .sheet-cell-content`)
      ?.textContent;

  assertEquals(cellContent(1, 1), 'Ada');
  assertEquals(cellContent(1, 2), '42');
  // Select column renders the option label, not the raw value.
  assertEquals(cellContent(2, 3), 'Done');
  assertEquals(cellContent(3, 1), '');
});

domTest('select cell exposes a value-type marker and caret affordance', (env) => {
  const container = env.makeContainer();
  mountSpreadsheet(container, config());

  const selectCell = container.querySelector('.sheet-cell[data-col="3"]');
  assertExists(selectCell);
  assertEquals(selectCell!.classList.contains('sheet-cell--select'), true);
  assertExists(selectCell!.querySelector('.sheet-cell-select-caret'));

  const numberCell = container.querySelector('.sheet-cell[data-col="2"]');
  assertEquals(numberCell!.classList.contains('sheet-cell--number'), true);
});

domTest('applyExternalValue updates the DOM and store, and rejects out-of-range', (env) => {
  const container = env.makeContainer();
  const cfg = config();
  const handle = mountSpreadsheet(container, cfg);

  assertEquals(handle.applyExternalValue(2, 1, 'Grace'), true);
  assertEquals(cfg.data.get(2, 1), 'Grace');
  assertEquals(
    container
      .querySelector('.sheet-cell[data-row="2"][data-col="1"] .sheet-cell-content')
      ?.textContent,
    'Grace',
  );

  // Row beyond rowCount and column beyond the grid are rejected.
  assertEquals(handle.applyExternalValue(99, 1, 'x'), false);
  assertEquals(handle.applyExternalValue(1, 99, 'x'), false);
});

domTest('mergeCellStyleOnSelection styles the active cell and records history', (env) => {
  const container = env.makeContainer();
  const handle = mountSpreadsheet(container, config());

  assertEquals(handle.historyEnabled, true);
  assertEquals(handle.canUndo(), false);

  handle.mergeCellStyleOnSelection({ 'font-weight': 'bold' });

  // Active cell defaults to (1,1).
  const cell = container.querySelector(
    '.sheet-cell[data-row="1"][data-col="1"]',
  ) as HTMLElement;
  assertEquals(cell.style.getPropertyValue('font-weight'), 'bold');
  assertEquals(handle.getCellStyleAt(1, 1)?.['font-weight'], 'bold');
  assertEquals(handle.canUndo(), true);
});

domTest('undo and redo revert and reapply a style change', (env) => {
  const container = env.makeContainer();
  const handle = mountSpreadsheet(container, config());
  const cell = container.querySelector(
    '.sheet-cell[data-row="1"][data-col="1"]',
  ) as HTMLElement;

  handle.mergeCellStyleOnSelection({ 'background-color': 'rgb(1, 2, 3)' });
  assertEquals(cell.style.getPropertyValue('background-color'), 'rgb(1, 2, 3)');

  assertEquals(handle.undo(), true);
  assertEquals(cell.style.getPropertyValue('background-color'), '');
  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], undefined);

  assertEquals(handle.redo(), true);
  assertEquals(cell.style.getPropertyValue('background-color'), 'rgb(1, 2, 3)');
});

domTest('arrow key navigation moves the active cell', (env) => {
  const container = env.makeContainer();
  mountSpreadsheet(container, config());

  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;
  const activeAt = () =>
    container.querySelector('.sheet-cell-active')?.getAttribute('data-row') +
    ':' +
    container.querySelector('.sheet-cell-active')?.getAttribute('data-col');

  assertEquals(activeAt(), '1:1');

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
  );
  assertEquals(activeAt(), '2:1');

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  assertEquals(activeAt(), '2:2');
});

domTest('Cmd+C copies the active cell when the viewport has focus (navigation mode)', (env) => {
  const container = env.makeContainer();
  const cfg = config({ '1:1': 'Alpha', '2:1': 'Beta' });
  mountSpreadsheet(container, cfg);
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;

  const written: string[] = [];
  const prevClipboard = globalThis.navigator.clipboard;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
      readText: () => Promise.resolve(''),
    },
  });
  try {
    viewport.focus();
    viewport.dispatchEvent(
      new env.window.KeyboardEvent('keydown', {
        key: 'c',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assertEquals(written, ['Alpha']);
  } finally {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: prevClipboard,
    });
  }
});

domTest('Cmd+V pastes into the active cell when the viewport has focus (navigation mode)', async (env) => {
  const container = env.makeContainer();
  const cfg = config({ '1:1': 'Alpha' }, { initialSelection: { row: 2, col: 1 } });
  mountSpreadsheet(container, cfg);
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;

  const prevClipboard = globalThis.navigator.clipboard;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve('Pasted value'),
    },
  });
  try {
    viewport.focus();
    viewport.dispatchEvent(
      new env.window.KeyboardEvent('keydown', {
        key: 'v',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assertEquals(cfg.data.get(2, 1), 'Pasted value');
    assertEquals(
      container.querySelector('.sheet-cell[data-row="2"][data-col="1"] .sheet-cell-content')
        ?.textContent,
      'Pasted value',
    );
  } finally {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: prevClipboard,
    });
  }
});

domTest('read-only column cells are marked and not style targets', (env) => {
  const container = env.makeContainer();
  const readOnlyCols: SpreadsheetColumn[] = [
    { id: 'id', header: 'ID', widthPx: 80, readOnly: true },
    { id: 'name', header: 'Name', widthPx: 160 },
  ];
  const handle = mountSpreadsheet(
    container,
    config({}, { columns: readOnlyCols }),
  );

  const idCell = container.querySelector('.sheet-cell[data-row="1"][data-col="1"]');
  assertEquals(idCell!.classList.contains('sheet-cell-readonly'), true);

  // Active cell is the read-only (1,1); styling should be a no-op with no history.
  handle.mergeCellStyleOnSelection({ 'font-weight': 'bold' });
  assertEquals(handle.canUndo(), false);
  assertEquals(handle.getCellStyleAt(1, 1), undefined);
});

domTest('hidden columns are omitted from the grid but kept in the store', (env) => {
  const container = env.makeContainer();
  const cols: SpreadsheetColumn[] = [
    { id: 'id', header: 'ID', widthPx: 72, readOnly: true, hidden: true },
    { id: 'name', header: 'Name', widthPx: 160 },
  ];
  const cfg = config({ '1:1': 42, '1:2': 'Ada' }, { columns: cols });
  const handle = mountSpreadsheet(container, cfg);

  const headers = container.querySelectorAll('.sheet-column-header-label');
  assertEquals([...headers].map((h) => h.textContent), ['Name']);

  const cells = container.querySelectorAll('.sheet-cell');
  assertEquals(cells.length, 4 * 1);

  assertEquals(cfg.data.get(1, 1), 42);
  assertEquals(handle.applyExternalValue(1, 1, 99), true);
  assertEquals(cfg.data.get(1, 1), 99);
  assertEquals(container.querySelector('.sheet-cell[data-col="1"]'), null);
});
