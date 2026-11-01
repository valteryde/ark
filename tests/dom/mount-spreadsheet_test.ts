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

domTest('applyExternalStyle paints and clears without undo history', (env) => {
  const container = env.makeContainer();
  const handle = mountSpreadsheet(container, config());
  const cell = container.querySelector(
    '.sheet-cell[data-row="1"][data-col="1"]',
  ) as HTMLElement;

  assertEquals(
    handle.applyExternalStyle(1, 1, {
      'font-weight': '700',
      color: '#112233',
      position: 'fixed',
    }),
    true,
  );
  assertEquals(cell.style.getPropertyValue('font-weight'), '700');
  assertEquals(handle.getCellStyleAt(1, 1)?.color, '#112233');
  assertEquals(handle.getCellStyleAt(1, 1)?.position, undefined);
  assertEquals(handle.canUndo(), false);

  assertEquals(handle.applyExternalStyle(1, 1, null), true);
  assertEquals(cell.style.getPropertyValue('font-weight'), '');
  assertEquals(handle.getCellStyleAt(1, 1), undefined);
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

domTest('edit mode plain arrow keys commit and move to adjacent cells', (env) => {
  const container = env.makeContainer();
  mountSpreadsheet(container, config({ '1:1': 'hello', '2:1': 'world' }));

  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;
  const activeAt = () =>
    container.querySelector('.sheet-cell-active')?.getAttribute('data-row') +
    ':' +
    container.querySelector('.sheet-cell-active')?.getAttribute('data-col');
  const activeInput = () =>
    container.querySelector('.sheet-cell-active .sheet-cell-input') as HTMLInputElement | null;
  const isEditing = () =>
    container.querySelector('.sheet-cell-active')?.classList.contains('sheet-cell-editing') ??
    false;

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
  );
  const input = activeInput();
  assertExists(input);
  assertEquals(isEditing(), true);

  input.setSelectionRange(2, 2);
  input.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  assertEquals(activeAt(), '1:2');
  assertEquals(isEditing(), false);

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
  );
  assertEquals(activeAt(), '1:1');

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
  );
  activeInput()!.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
  );
  assertEquals(activeAt(), '1:1');

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
  );
  assertEquals(activeAt(), '2:1');

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'x', bubbles: true }),
  );
  assertEquals(isEditing(), true);
  activeInput()!.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
  );
  assertEquals(activeAt(), '3:1');
  assertEquals(isEditing(), false);
});

domTest('Cmd+C copies the active cell when the viewport has focus (navigation mode)', (env) => {
  const container = env.makeContainer();
  const cfg = config({ '1:1': 'Alpha', '2:1': 'Beta' });
  mountSpreadsheet(container, cfg);
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;

  const written: string[] = [];
  const prevClipboard = globalThis.navigator.clipboard;
  const prevExecCommand = env.document.execCommand;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(`api:${text}`);
        return Promise.resolve();
      },
      readText: () => Promise.resolve(''),
    },
  });
  // Prefer the sync execCommand path (needed in Chrome iframes).
  env.document.execCommand = (commandId: string) => {
    if (commandId === 'copy') {
      const ta = env.document.querySelector<HTMLTextAreaElement>('textarea[data-ark-clipboard="1"]');
      if (ta) written.push(ta.value);
      return true;
    }
    return false;
  };
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
    if (prevExecCommand) env.document.execCommand = prevExecCommand;
    else delete (env.document as { execCommand?: unknown }).execCommand;
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

domTest('Cmd+C/Cmd+V use the in-app clipboard when system clipboard access is denied', async (env) => {
  const container = env.makeContainer();
  const cfg = config({ '1:1': 'Alpha' }, { initialSelection: { row: 1, col: 1 } });
  mountSpreadsheet(container, cfg);
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;

  const prevClipboard = globalThis.navigator.clipboard;
  const prevExecCommand = env.document.execCommand;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () => Promise.reject(new Error('denied')),
      readText: () => Promise.reject(new Error('denied')),
      read: () => Promise.reject(new Error('denied')),
    },
  });
  env.document.execCommand = () => false;
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
    viewport.dispatchEvent(
      new env.window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }),
    );
    viewport.dispatchEvent(
      new env.window.KeyboardEvent('keydown', {
        key: 'v',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assertEquals(cfg.data.get(2, 1), 'Alpha');
  } finally {
    if (prevExecCommand) env.document.execCommand = prevExecCommand;
    else delete (env.document as { execCommand?: unknown }).execCommand;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: prevClipboard,
    });
  }
});

domTest('link column renders an icon button and ignores typing, delete, and paste', async (env) => {
  const container = env.makeContainer();
  const cols: SpreadsheetColumn[] = [
    { id: 'name', header: 'Name', widthPx: 160 },
    {
      id: 'open',
      header: 'Open',
      widthPx: 56,
      valueType: 'link',
      icon: 'eye',
    },
  ];
  const cfg = config(
    { '1:1': 'Ada', '1:2': 'https://example.com/ada' },
    { columns: cols, initialSelection: { row: 1, col: 2 } },
  );
  mountSpreadsheet(container, cfg);
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;
  const link = container.querySelector(
    '.sheet-cell[data-row="1"][data-col="2"] a.sheet-cell-link',
  ) as HTMLAnchorElement;
  assertExists(link);
  assertEquals(link.getAttribute('href'), 'https://example.com/ada');
  assertEquals(link.getAttribute('target'), '_blank');
  assertEquals(link.querySelector('i')?.className, 'ph ph-eye');
  assertEquals(
    container.querySelector('.sheet-cell[data-col="2"]')?.classList.contains('sheet-cell--link'),
    true,
  );

  let opened = 0;
  link.click = () => {
    opened += 1;
  };
  viewport.focus();
  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  assertEquals(opened, 1);
  assertEquals(cfg.data.get(1, 2), 'https://example.com/ada');

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }),
  );
  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    }),
  );
  assertEquals(cfg.data.get(1, 2), 'https://example.com/ada');

  const prevClipboard = globalThis.navigator.clipboard;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { readText: () => Promise.resolve('https://evil.example') },
  });
  try {
    viewport.dispatchEvent(
      new env.window.KeyboardEvent('keydown', {
        key: 'v',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(cfg.data.get(1, 2), 'https://example.com/ada');
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

domTest('a seeded span widens the anchor and hides covered cells', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Hello', '2:1': 'Down' }, [
    { row: 1, col: 1, rowSpan: 1, colSpan: 2 },
    { row: 2, col: 1, rowSpan: 2, colSpan: 1 },
  ]);
  mountSpreadsheet(container, config({}, { data }));

  const anchor = container.querySelector('.sheet-cell[data-row="1"][data-col="1"]') as HTMLElement;
  const covered = container.querySelector('.sheet-cell[data-row="1"][data-col="2"]') as HTMLElement;
  assertEquals(anchor.classList.contains('sheet-cell--span-anchor'), true);
  assertEquals(anchor.style.width, '260px');
  assertEquals(anchor.getAttribute('aria-colspan'), '2');
  assertEquals(covered.classList.contains('sheet-cell--span-covered'), true);
  assertEquals(covered.getAttribute('aria-hidden'), 'true');

  const vertical = container.querySelector('.sheet-cell[data-row="2"][data-col="1"]') as HTMLElement;
  assertEquals(vertical.classList.contains('sheet-cell--span-rows'), true);
  assertEquals(vertical.style.height, '56px');
  assertEquals(vertical.textContent?.includes('Down'), true);
});

domTest('merge keeps the anchor value and undo restores covered cells', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Keep', '1:2': 'Drop' });
  const handle = mountSpreadsheet(container, config({}, { data }));
  assertEquals(handle.canMergeCells(), false);

  const cell = container.querySelector('.sheet-cell[data-row="1"][data-col="2"]') as HTMLElement;
  cell.dispatchEvent(
    new env.window.MouseEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true }),
  );
  assertEquals(handle.canMergeCells(), true);
  assertEquals(handle.mergeCells(), true);
  assertEquals(data.get(1, 1), 'Keep');
  assertEquals(data.get(1, 2), undefined);
  assertEquals(handle.getCellSpans(), [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }]);
  const anchor = container.querySelector('.sheet-cell[data-row="1"][data-col="1"]') as HTMLElement;
  assertEquals(anchor.style.width, '260px');
  assertEquals(handle.canUnmergeCells(), true);

  handle.undo();
  assertEquals(data.get(1, 2), 'Drop');
  assertEquals(handle.getCellSpans(), []);

  handle.redo();
  assertEquals(data.get(1, 2), undefined);
  assertEquals(handle.unmergeCells(), true);
  assertEquals(handle.getCellSpans(), []);
  assertEquals(data.get(1, 1), 'Keep');
});

domTest('arrow keys step off a merged cell', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Hello' }, [
    { row: 1, col: 1, rowSpan: 1, colSpan: 2 },
  ]);
  mountSpreadsheet(container, config({}, { data }));
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;
  viewport.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const active = container.querySelector('.sheet-cell-active') as HTMLElement;
  assertEquals(active.dataset.row, '1');
  assertEquals(active.dataset.col, '3');
});

domTest('a selection that includes a read-only column cannot merge', (env) => {
  const container = env.makeContainer();
  const cols: SpreadsheetColumn[] = [
    { id: 'name', header: 'Name', widthPx: 120 },
    { id: 'id', header: 'ID', widthPx: 80, readOnly: true },
  ];
  const handle = mountSpreadsheet(container, config({}, { columns: cols, rowCount: 2 }));
  const cell = container.querySelector('.sheet-cell[data-row="1"][data-col="2"]') as HTMLElement;
  cell.dispatchEvent(
    new env.window.MouseEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true }),
  );
  assertEquals(handle.canMergeCells(), false);
  assertEquals(handle.mergeCells(), false);
});

/* --- text overflow: long text runs across empty neighbours ---------------- */

function spillOf(container: HTMLElement, row: number, col: number): {
  spills: boolean;
  width: string;
} {
  const el = container.querySelector(`.sheet-cell[data-row="${row}"][data-col="${col}"]`) as HTMLElement;
  return {
    spills: el.classList.contains('sheet-cell--spill'),
    width: el.style.getPropertyValue('--sheet-spill-w'),
  };
}

domTest('long text spills into the empty columns to its right', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'a description that is far too long for one column' });
  mountSpreadsheet(container, config({}, { data }));

  // Name 160 + Count 100 + Status 120 = 380px mounted; 16px of cell padding.
  assertEquals(spillOf(container, 1, 1), { spills: true, width: '364px' });
});

domTest('a neighbour that holds something stops the spill', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({
    '1:1': 'a description that is far too long for one column',
    '1:2': 7,
  });
  mountSpreadsheet(container, config({}, { data }));
  assertEquals(spillOf(container, 1, 1).spills, false);
});

domTest('a styled or commented empty neighbour still blocks the spill', (env) => {
  const container = env.makeContainer();
  const filled = createInMemoryDataStore({
    '1:1': 'long description text',
    '1:2': { value: '', style: { color: '#111111' } },
  });
  mountSpreadsheet(container, config({}, { data: filled }));
  assertEquals(spillOf(container, 1, 1).spills, false);

  const commented = createInMemoryDataStore({
    '1:1': 'long description text',
    '1:3': { value: '', comment: 'heads up' },
  });
  const other = env.makeContainer();
  mountSpreadsheet(other, config({}, { data: commented }));
  // Column 2 is empty, so text runs to it but not past the commented column 3.
  assertEquals(spillOf(other, 1, 1), { spills: true, width: '244px' });
});

domTest('merged neighbours block the spill', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'long description text' }, [
    { row: 1, col: 2, rowSpan: 1, colSpan: 2 },
  ]);
  mountSpreadsheet(container, config({}, { data }));
  assertEquals(spillOf(container, 1, 1).spills, false);
});

domTest('right-aligned numbers spill leftwards instead', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:2': 12345678901234 });
  mountSpreadsheet(container, config({}, { data }));
  // Count 100 + the empty Name column (160) to its left, minus 16px padding.
  assertEquals(spillOf(container, 1, 2), { spills: true, width: '244px' });

  const handle = mountSpreadsheet(env.makeContainer(), config({ '1:1': 'Ada', '1:2': 12345678901234 }));
  assertEquals(handle.getActiveCellAddress(), 'A1');
});

domTest('cellOverflow: clip keeps every cell inside its own box', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'a description that is far too long' });
  mountSpreadsheet(container, config({}, { data, cellOverflow: 'clip' }));
  assertEquals(spillOf(container, 1, 1).spills, false);
});

domTest('filling a neighbour reclaims the spill from the cell on its left', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'a description that is far too long' });
  const handle = mountSpreadsheet(container, config({}, { data }));
  assertEquals(spillOf(container, 1, 1).spills, true);

  assertEquals(handle.applyExternalValue(1, 2, 'now taken'), true);
  assertEquals(spillOf(container, 1, 1).spills, false);
  assertEquals(spillOf(container, 1, 1).width, '');
});

/* --- wrap: only while the wrapped lines fit the row height ----------------- */

function domTestAsync(name: string, fn: (env: DomEnv) => Promise<void>): void {
  Deno.test(name, async () => {
    const env = setupDom();
    try {
      await fn(env);
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      teardownDom();
    }
  });
}

domTestAsync('white-space style wraps a cell, and falls back to spill when the lines do not fit', async (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({
    '1:1': { value: 'wrapped text needs vertical room to be readable', style: { 'white-space': 'pre-wrap' } },
  });
  const handle = mountSpreadsheet(container, config({}, { data }));
  const cell = container.querySelector('.sheet-cell[data-row="1"][data-col="1"]') as HTMLElement;

  assertEquals(cell.classList.contains('sheet-cell--wrap'), true);
  assertEquals(cell.classList.contains('sheet-cell--wrap-nofit'), false);
  // While wrapped text fits, the cell does not spill.
  assertEquals(cell.classList.contains('sheet-cell--spill'), false);

  // jsdom has no layout: report a content box taller than the row to force the fallback.
  Object.defineProperty(env.window.Element.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 999,
  });
  handle.applyExternalValue(1, 1, 'wrapped text needs vertical room to be readable');
  await Promise.resolve();

  assertEquals(cell.classList.contains('sheet-cell--wrap-nofit'), true);
  assertEquals(cell.classList.contains('sheet-cell--spill'), true);
  assertEquals(cell.style.getPropertyValue('--sheet-spill-w'), '364px');
});

domTest('clearing the wrap style removes the wrap class', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({
    '1:1': { value: 'text', style: { 'white-space': 'pre-wrap' } },
  });
  const handle = mountSpreadsheet(container, config({}, { data }));
  const cell = container.querySelector('.sheet-cell[data-row="1"][data-col="1"]') as HTMLElement;
  assertEquals(cell.classList.contains('sheet-cell--wrap'), true);

  handle.applyExternalStyle(1, 1, null);
  assertEquals(cell.classList.contains('sheet-cell--wrap'), false);
});

/* --- value bar ------------------------------------------------------------ */

function barOf(container: HTMLElement): {
  bar: HTMLElement;
  input: HTMLInputElement;
  address: HTMLElement;
} {
  const bar = container.querySelector('.sheet-input-bar') as HTMLElement;
  assertExists(bar);
  return {
    bar,
    input: bar.querySelector('.sheet-input-bar__input') as HTMLInputElement,
    address: bar.querySelector('.sheet-input-bar__address') as HTMLElement,
  };
}

domTest('value bar shows the active cell address and value', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Ada Lovelace' });
  const handle = mountSpreadsheet(container, config({}, { data }));
  const { bar, input, address } = barOf(container);

  assertEquals(input.value, 'Ada Lovelace');
  assertEquals(address.textContent, 'A1');
  assertEquals(bar.querySelector('.sheet-input-bar__hint')?.textContent, 'Name');
  assertEquals(handle.getActiveCellAddress(), 'A1');
  assertEquals(typeof handle.focusValueBar, 'function');
});

domTest('value bar commits on Enter and moves down', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Ada' });
  mountSpreadsheet(container, config({}, { data }));
  const { input, address } = barOf(container);

  input.focus();
  input.value = 'Ada Lovelace';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  assertEquals(String(data.get(1, 1)), 'Ada Lovelace');
  assertEquals(
    container.querySelector('.sheet-cell[data-row="1"][data-col="1"] .sheet-cell-content')?.textContent,
    'Ada Lovelace',
  );
  assertEquals(container.querySelector('.sheet-cell-active')?.getAttribute('data-row'), '2');
  assertEquals(address.textContent, 'A2');
  assertEquals(input.value, '');
});

domTest('value bar Escape reverts and does not write to the store', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Ada' });
  mountSpreadsheet(container, config({}, { data }));
  const { input } = barOf(container);

  input.focus();
  input.value = 'typo';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assertEquals(input.value, 'Ada');
  assertEquals(data.get(1, 1), 'Ada');
});

domTest('a pending value bar edit commits when the selection moves away', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Ada' });
  mountSpreadsheet(container, config({}, { data }));
  const { input } = barOf(container);
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;

  input.focus();
  input.value = 'Grace Hopper';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));

  viewport.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

  assertEquals(String(data.get(1, 1)), 'Grace Hopper');
  assertEquals(container.querySelector('.sheet-cell-active')?.getAttribute('data-row'), '2');
});

domTest('in-cell typing mirrors into the value bar', (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:1': 'Ada' });
  mountSpreadsheet(container, config({}, { data }));
  const { input } = barOf(container);
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;

  viewport.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  const cellInput = container.querySelector('.sheet-cell-active .sheet-cell-input') as HTMLInputElement;
  cellInput.value = 'Ada L';
  cellInput.dispatchEvent(new env.window.Event('input', { bubbles: true }));

  assertEquals(input.value, 'Ada L');
});

domTestAsync('a number column rejects a non-numeric value typed in the bar', async (env) => {
  const container = env.makeContainer();
  const data = createInMemoryDataStore({ '1:2': 12 });
  // The cell-anchored rejection hint auto-hides on a 2.2s timer; keep it
  // cancellable so the test does not leak it.
  const realSetTimeout = env.window.setTimeout.bind(env.window);
  const longTimers: number[] = [];
  env.window.setTimeout = (cb: () => void, ms?: number) => {
    const id = realSetTimeout(cb, ms) as unknown as number;
    if ((ms ?? 0) >= 1000) longTimers.push(id);
    return id;
  };
  try {
    const handle = mountSpreadsheet(container, config({}, { data }));
    const viewport = container.querySelector('.sheet-viewport') as HTMLElement;
    viewport.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await Promise.resolve();

    const { input, bar } = barOf(container);
    assertEquals(input.value, '12');
    input.focus();
    input.value = 'twelve';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    assertEquals(input.value, '12');
    assertEquals(data.get(1, 2), 12);
    assertEquals(bar.classList.contains('sheet-input-bar--invalid'), true);
    assertEquals(bar.querySelector('.sheet-input-bar__status')?.textContent, 'Enter a number');
    // The rejected edit must not move the selection.
    assertEquals(container.querySelector('.sheet-cell-active')?.getAttribute('data-col'), '2');
    assertEquals(handle.getActiveCellAddress(), 'B1');
  } finally {
    for (const id of longTimers) env.window.clearTimeout(id);
    env.window.setTimeout = realSetTimeout;
  }
});

domTest('read-only columns show their value in the bar without editing', (env) => {
  const container = env.makeContainer();
  const cols: SpreadsheetColumn[] = [
    { id: 'id', header: 'ID', widthPx: 60, readOnly: true },
    { id: 'name', header: 'Name', widthPx: 160 },
  ];
  const data = createInMemoryDataStore({ '1:1': 'REC-7' });
  mountSpreadsheet(container, config({}, { columns: cols, data, rowCount: 2 }));
  const { input, bar } = barOf(container);

  assertEquals(input.value, 'REC-7');
  assertEquals(input.readOnly, true);
  assertEquals(bar.classList.contains('sheet-input-bar--readonly'), true);
});

domTestAsync('a range selection labels the bar with its extent', async (env) => {
  const container = env.makeContainer();
  mountSpreadsheet(container, config());
  const viewport = container.querySelector('.sheet-viewport') as HTMLElement;
  const { address, bar } = barOf(container);

  viewport.dispatchEvent(
    new env.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, shiftKey: true }),
  );
  // The label follows the final selection, applied on the coalescing microtask.
  await Promise.resolve();

  assertEquals(address.textContent, 'A1:A2');
  assertEquals(bar.classList.contains('sheet-input-bar--multi'), true);
});

domTest('showValueBar false omits the bar entirely', (env) => {
  const container = env.makeContainer();
  mountSpreadsheet(container, config({}, { showValueBar: false }));
  assertEquals(container.querySelector('.sheet-input-bar'), null);
});
