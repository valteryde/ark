import { assertEquals } from '@std/assert';
import { sanitizeCellStyle } from '../../src/spreadsheet/cell-style.ts';

Deno.test('sanitizeCellStyle keeps toolbar styles and named colors', () => {
  assertEquals(
    sanitizeCellStyle({
      color: 'Red',
      'background-color': 'rgb(1, 2, 3)',
      'font-weight': 'bold',
      'font-style': 'italic',
      'text-decoration-line': 'underline line-through',
      'justify-content': 'flex-end',
      'box-shadow': 'inset 0 0 0 1px #64748b',
    }),
    {
      color: 'red',
      'background-color': 'rgb(1, 2, 3)',
      'font-weight': 'bold',
      'font-style': 'italic',
      'text-decoration-line': 'underline line-through',
      'justify-content': 'flex-end',
      'box-shadow': 'inset 0 0 0 1px #64748b',
    },
  );
});

Deno.test('sanitizeCellStyle drops urls and unknown properties', () => {
  assertEquals(
    sanitizeCellStyle({
      color: '#111827',
      'background-image': 'url(https://evil.example/x)',
      position: 'fixed',
    }),
    { color: '#111827' },
  );
  assertEquals(sanitizeCellStyle({ 'background-image': 'url(javascript:alert(1))' }), undefined);
  assertEquals(sanitizeCellStyle(null), undefined);
  assertEquals(sanitizeCellStyle({}), undefined);
});
