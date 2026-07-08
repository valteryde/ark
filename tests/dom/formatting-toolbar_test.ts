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
