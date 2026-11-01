import { assertEquals } from '@std/assert';
import { cellWantsWrap, sanitizeCellStyle } from '../../src/spreadsheet/cell-style.ts';

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

Deno.test('sanitizeCellStyle keeps wrap keywords and rejects layout-breaking ones', () => {
  assertEquals(sanitizeCellStyle({ 'white-space': 'pre-wrap' }), { 'white-space': 'pre-wrap' });
  assertEquals(sanitizeCellStyle({ 'white-space': ' NORMAL ' }), { 'white-space': 'normal' });
  assertEquals(sanitizeCellStyle({ 'white-space': 'pre' }), undefined);
  assertEquals(sanitizeCellStyle({ 'white-space': 'pre-line' }), undefined);
  assertEquals(sanitizeCellStyle({ 'white-space': 'pre-wrap; position: fixed' }), undefined);
});

Deno.test('cellWantsWrap reads the wrap flag off the sanitized style', () => {
  assertEquals(cellWantsWrap({ 'white-space': 'pre-wrap' }), true);
  assertEquals(cellWantsWrap({ 'white-space': 'normal' }), true);
  assertEquals(cellWantsWrap({ 'white-space': 'nowrap' }), false);
  assertEquals(cellWantsWrap({ 'font-weight': '700' }), false);
  assertEquals(cellWantsWrap(undefined), false);
});
