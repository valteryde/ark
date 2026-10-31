import { assertEquals, assertExists } from '@std/assert';
import { setupDom, teardownDom, type DomEnv } from './setup.ts';
import { mountSheetHeaderActions } from '../../src/partner/export-pdf.ts';

function domTest(name: string, fn: (env: DomEnv) => void): void {
  Deno.test(name, () => {
    const env = setupDom();
    try {
      fn(env);
    } finally {
      teardownDom();
    }
  });
}

domTest('export pdf button is present by default and absent when disabled', (env) => {
  const host = env.makeContainer();
  mountSheetHeaderActions(host, {
    path: 'clients/21',
    chromeActions: [{ label: 'Open', href: '/records' }],
  });
  const button = host.querySelector('button');
  assertExists(button);
  assertEquals(button.textContent, 'Export PDF');
  assertEquals(button.getAttribute('aria-label'), 'Export PDF');
  assertExists(host.querySelector('a'));

  mountSheetHeaderActions(host, { path: 'clients/21', pdfExport: false });
  assertEquals(host.querySelector('button'), null);
});
