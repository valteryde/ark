import { assertEquals, assertExists } from '@std/assert';
import { setupDom, teardownDom, type DomEnv } from './setup.ts';
import { mountSpreadsheet } from '../../src/spreadsheet/mount-spreadsheet.ts';
import { mountFormattingToolbar } from '../../src/spreadsheet/formatting-toolbar.ts';
import { createInMemoryDataStore } from '../../src/spreadsheet/data-store.ts';
import { resolveEnabledUiCapabilities } from '../../src/spreadsheet/types.ts';
import type {
  SpreadsheetColumn,
  SpreadsheetMountHandle,
} from '../../src/spreadsheet/index.ts';

const COLUMNS: SpreadsheetColumn[] = [{ id: 'name', header: 'Name', widthPx: 160 }];

function mountSheet(env: DomEnv): {
  toolbar: HTMLElement;
  handle: SpreadsheetMountHandle;
} {
  const gridContainer = env.makeContainer();
  const handle = mountSpreadsheet(gridContainer, {
    columns: COLUMNS,
    rowCount: 3,
    data: createInMemoryDataStore(),
  });
  const toolbar = env.makeContainer();
  mountFormattingToolbar(toolbar, handle, resolveEnabledUiCapabilities());
  return { toolbar, handle };
}

function domTest(name: string, fn: (env: DomEnv) => void): void {
  Deno.test(name, async () => {
    const env = setupDom();
    try {
      fn(env);
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      teardownDom();
    }
  });
}

domTest('merge buttons stay disabled until the selection can merge', (env) => {
  const { toolbar, handle } = mountSheet(env);
  const merge = buttonByTitle(toolbar, 'Merge cells');
  const unmerge = buttonByTitle(toolbar, 'Unmerge cells');
  assertEquals(merge.disabled, true);
  assertEquals(unmerge.disabled, true);
  assertEquals(handle.canMergeCells(), false);
});

domTest('toolbar renders a zoom control and formatting buttons', (env) => {
  const { toolbar } = mountSheet(env);

  assertExists(toolbar.querySelector('select.app-toolbar__zoom'));
  const titles = [...toolbar.querySelectorAll('button.app-toolbar__icon')].map(
    (b) => b.getAttribute('title'),
  );
  for (const expected of ['Bold', 'Italic']) {
    assertEquals(titles.includes(expected), true);
  }
});

domTest('clicking Bold toggles font-weight on the active cell', (env) => {
  const { toolbar, handle } = mountSheet(env);
  const bold = [...toolbar.querySelectorAll('button.app-toolbar__icon')].find(
    (b) => b.getAttribute('title') === 'Bold',
  ) as HTMLButtonElement;
  assertExists(bold);

  bold.click();
  assertEquals(handle.getCellStyleAt(1, 1)?.['font-weight'], '700');
  assertEquals(bold.getAttribute('aria-pressed'), 'true');

  bold.click();
  assertEquals(handle.getCellStyleAt(1, 1)?.['font-weight'], undefined);
  assertEquals(bold.getAttribute('aria-pressed'), 'false');
});

domTest('zoom select changes the sheet zoom', (env) => {
  const { toolbar, handle } = mountSheet(env);
  const zoom = toolbar.querySelector('select.app-toolbar__zoom') as HTMLSelectElement;

  zoom.value = '1.5';
  zoom.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  assertEquals(handle.getZoom(), 1.5);
});

function buttonByTitle(toolbar: HTMLElement, title: string): HTMLButtonElement {
  const button = [...toolbar.querySelectorAll('button')].find(
    (el) => el.getAttribute('title') === title,
  );
  assertExists(button);
  return button as HTMLButtonElement;
}

function openColorMenu(env: DomEnv, toolbar: HTMLElement, title: string): HTMLElement {
  buttonByTitle(toolbar, title).click();
  const menu = env.document.querySelector('.app-color-menu');
  assertExists(menu);
  return menu as HTMLElement;
}

domTest('fill and text color open a palette menu instead of a bare color input', (env) => {
  const { toolbar } = mountSheet(env);
  assertEquals(toolbar.querySelector('input[type="color"]'), null);

  const menu = openColorMenu(env, toolbar, 'Fill color');
  assertEquals(menu.querySelectorAll('.app-color-menu__grid .app-color-menu__swatch').length, 80);
  assertExists(menu.querySelector('input[type="color"]'));
  const labels = [...menu.querySelectorAll('.app-color-menu__label')].map((el) => el.textContent);
  assertEquals(labels.includes('Custom'), true);
  assertEquals(labels.includes('Recent'), true);
  assertEquals((menu.querySelector('.app-color-menu__recent') as HTMLElement).hidden, true);
  assertEquals(buttonByTitle(toolbar, 'Fill color').getAttribute('aria-expanded'), 'true');

  buttonByTitle(toolbar, 'Fill color').click();
  assertEquals(env.document.querySelector('.app-color-menu'), null);
  assertEquals(buttonByTitle(toolbar, 'Fill color').getAttribute('aria-expanded'), 'false');
});

domTest('a palette swatch sets fill color and No fill clears it', (env) => {
  const { toolbar, handle } = mountSheet(env);
  const menu = openColorMenu(env, toolbar, 'Fill color');
  const red = menu.querySelector('[data-color="#ff0000"]') as HTMLButtonElement;
  assertExists(red);
  red.click();

  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], '#ff0000');
  assertEquals(env.document.querySelector('.app-color-menu'), null);
  handle.undo();
  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], undefined);

  const again = openColorMenu(env, toolbar, 'Fill color');
  const recent = [...again.querySelectorAll('.app-color-menu__recent-row [data-color]')].map(
    (el) => (el as HTMLElement).dataset.color,
  );
  assertEquals(recent[0], '#ff0000');
  (again.querySelector('[data-color="#ff0000"]') as HTMLButtonElement).click();
  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], '#ff0000');

  const clearing = openColorMenu(env, toolbar, 'Fill color');
  (clearing.querySelector('.app-color-menu__reset') as HTMLButtonElement).click();
  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], undefined);
});

domTest('custom color drags collapse into one undo step', (env) => {
  const { toolbar, handle } = mountSheet(env);
  const menu = openColorMenu(env, toolbar, 'Fill color');
  const input = menu.querySelector('input[type="color"]') as HTMLInputElement;
  assertExists(input);

  input.value = '#111111';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  input.value = '#222222';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], '#222222');

  handle.undo();
  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], undefined);
});

domTest('text color menu sets text color and lists colors already on the sheet', (env) => {
  const grid = env.makeContainer();
  const handle = mountSpreadsheet(grid, {
    columns: [
      {
        id: 'name',
        header: 'Name',
        widthPx: 160,
        selectOptions: [{ value: 'A', backgroundColor: '#d8f3dc', color: '#1b4332' }],
      },
      { id: 'sys', header: 'Sys', widthPx: 80, readOnly: true },
    ],
    rowCount: 2,
    data: createInMemoryDataStore({
      '1:1': { value: 'x', style: { 'background-color': '#fef3c7' } },
      '2:2': { value: 'y', style: { 'background-color': '#112233', color: '#abcdef' } },
    }),
  });
  const toolbar = env.makeContainer();
  mountFormattingToolbar(toolbar, handle, resolveEnabledUiCapabilities());

  const fill = openColorMenu(env, toolbar, 'Fill color');
  const fillRecent = [...fill.querySelectorAll('.app-color-menu__recent-row [data-color]')].map(
    (el) => (el as HTMLElement).dataset.color,
  );
  assertEquals(fillRecent, ['#112233', '#fef3c7', '#d8f3dc']);

  buttonByTitle(toolbar, 'Text color').click();
  const text = env.document.querySelector('.app-color-menu') as HTMLElement;
  assertEquals(text.getAttribute('aria-label'), 'Text color');
  const textRecent = [...text.querySelectorAll('.app-color-menu__recent-row [data-color]')].map(
    (el) => (el as HTMLElement).dataset.color,
  );
  assertEquals(textRecent, ['#abcdef', '#1b4332']);

  (text.querySelector('[data-color="#0000ff"]') as HTMLButtonElement).click();
  assertEquals(handle.getCellStyleAt(1, 1)?.color, '#0000ff');
  assertEquals(handle.getCellStyleAt(1, 1)?.['background-color'], '#fef3c7');

  const reopened = openColorMenu(env, toolbar, 'Text color');
  (reopened.querySelector('.app-color-menu__reset') as HTMLButtonElement).click();
  assertEquals(handle.getCellStyleAt(1, 1)?.color, undefined);
});

domTest('wrap text button toggles the white-space style and reflects it back', (env) => {
  const { toolbar, handle } = mountSheet(env);
  const wrap = buttonByTitle(toolbar, 'Wrap text');
  assertExists(wrap.querySelector('i.ph-arrow-elbow-down-right'));
  assertEquals(wrap.getAttribute('aria-pressed'), 'false');

  wrap.click();
  assertEquals(handle.getCellStyleAt(1, 1)?.['white-space'], 'pre-wrap');
  assertEquals(wrap.getAttribute('aria-pressed'), 'true');

  wrap.click();
  assertEquals(handle.getCellStyleAt(1, 1)?.['white-space'], undefined);
  assertEquals(wrap.getAttribute('aria-pressed'), 'false');

  // One undo step reverts the wrap, and the button follows the stored style.
  wrap.click();
  assertEquals(handle.undo(), true);
  assertEquals(handle.getCellStyleAt(1, 1)?.['white-space'], undefined);
  assertEquals(wrap.getAttribute('aria-pressed'), 'false');
});

domTest('wrap button is omitted when the backend does not expose the capability', (env) => {
  const gridContainer = env.makeContainer();
  const handle = mountSpreadsheet(gridContainer, {
    columns: COLUMNS,
    rowCount: 3,
    data: createInMemoryDataStore(),
    enabledUiCapabilities: ['undo', 'redo', 'align'],
  });
  const toolbar = env.makeContainer();
  mountFormattingToolbar(toolbar, handle, resolveEnabledUiCapabilities(['undo', 'redo', 'align']));
  assertEquals(
    [...toolbar.querySelectorAll('button')].some((b) => b.getAttribute('title') === 'Wrap text'),
    false,
  );
});

domTest('clicking outside the color menu closes it', (env) => {
  const { toolbar } = mountSheet(env);
  openColorMenu(env, toolbar, 'Fill color');
  env.document.body.dispatchEvent(
    new env.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  assertEquals(env.document.querySelector('.app-color-menu'), null);
});
