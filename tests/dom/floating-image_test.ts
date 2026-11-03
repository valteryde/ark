import { assertEquals } from '@std/assert';
import { setupDom, teardownDom, type DomEnv } from './setup.ts';
import { mountSpreadsheet } from '../../src/spreadsheet/mount-spreadsheet.ts';
import { createInMemoryDataStore } from '../../src/spreadsheet/data-store.ts';
import type { SpreadsheetColumn } from '../../src/spreadsheet/types.ts';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const COLUMNS: SpreadsheetColumn[] = [
  { id: 'name', header: 'Name', widthPx: 160 },
  { id: 'note', header: 'Note', widthPx: 100 },
];

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

domTest('a floating image sits beside the gutter and a drag updates its box', (env) => {
  const data = createInMemoryDataStore({}, [], [
    { id: 'pic', x: 10, y: 20, width: 40, height: 30, src: PNG },
  ]);
  const container = env.makeContainer();
  const handle = mountSpreadsheet(container, { columns: COLUMNS, rowCount: 4, data });
  const el = container.querySelector<HTMLElement>('.sheet-floating-image');
  if (!el) throw new Error('image was not rendered');
  assertEquals(el.style.left, '58px');
  assertEquals(el.style.top, '20px');
  assertEquals(el.style.width, '40px');

  const PointerEvent = env.window.PointerEvent as typeof globalThis.PointerEvent;
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: 0,
      clientY: 0,
      button: 0,
      bubbles: true,
      pointerId: 1,
    }),
  );
  env.window.dispatchEvent(
    new PointerEvent('pointermove', {
      clientX: 15,
      clientY: 8,
      button: 0,
      bubbles: true,
      pointerId: 1,
    }),
  );
  env.window.dispatchEvent(
    new PointerEvent('pointerup', {
      clientX: 15,
      clientY: 8,
      button: 0,
      bubbles: true,
      pointerId: 1,
    }),
  );

  assertEquals(data.getFloatingImages?.()[0]?.x, 25);
  assertEquals(data.getFloatingImages?.()[0]?.y, 28);
  assertEquals(el.style.left, '73px');
  assertEquals(handle.getFloatingImages()[0]?.x, 25);

  const viewport = container.querySelector('.sheet-viewport');
  viewport?.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assertEquals(data.getFloatingImages?.(), []);
  assertEquals(container.querySelector('.sheet-floating-image'), null);

  assertEquals(handle.undo(), true);
  assertEquals(data.getFloatingImages?.()[0]?.id, 'pic');
  assertEquals(container.querySelector<HTMLElement>('.sheet-floating-image')?.style.left, '73px');
});
