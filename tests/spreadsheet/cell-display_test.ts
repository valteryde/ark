import { assertEquals } from '@std/assert';
import {
  formatCellHtml,
  formatSelectOptionMarkup,
  sanitizeCssColor,
  sanitizePhosphorIconName,
} from '../../src/spreadsheet/cell-display.ts';
import type { SpreadsheetColumn } from '../../src/spreadsheet/types.ts';

Deno.test('sanitizeCssColor accepts valid hex and rgb, rejects the rest', () => {
  assertEquals(sanitizeCssColor('#fff'), '#fff');
  assertEquals(sanitizeCssColor('#AABBCC'), '#AABBCC');
  assertEquals(sanitizeCssColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assertEquals(sanitizeCssColor('rgba(1,2,3,0.5)'), 'rgba(1,2,3,0.5)');
  assertEquals(sanitizeCssColor('rgb(300, 0, 0)'), null);
  assertEquals(sanitizeCssColor('red'), null);
  assertEquals(sanitizeCssColor('url(javascript:alert(1))'), null);
});

Deno.test('sanitizePhosphorIconName allows lowercase slug only', () => {
  assertEquals(sanitizePhosphorIconName('Cat'), 'cat');
  assertEquals(sanitizePhosphorIconName('arrow-right'), 'arrow-right');
  assertEquals(sanitizePhosphorIconName('bad name'), null);
  assertEquals(sanitizePhosphorIconName('under_score'), null);
  assertEquals(sanitizePhosphorIconName(''), null);
});

Deno.test('formatSelectOptionMarkup escapes plain labels', () => {
  assertEquals(
    formatSelectOptionMarkup({ value: 'x' }, '<b>hi</b>'),
    '&lt;b&gt;hi&lt;/b&gt;',
  );
});

Deno.test('formatSelectOptionMarkup renders a pill when presentation is set', () => {
  const html = formatSelectOptionMarkup(
    { value: 'open', color: '#111', icon: 'circle' },
    'Open',
  );
  assertEquals(html.includes('sheet-select-pill'), true);
  assertEquals(html.includes('color: #111'), true);
  assertEquals(html.includes('ph-circle'), true);
  assertEquals(html.includes('Open'), true);
});

Deno.test('formatCellHtml escapes text and trims', () => {
  const c: SpreadsheetColumn = { id: 'c', header: 'C', widthPx: 120 };
  assertEquals(formatCellHtml(c, '  <script>  '), '&lt;script&gt;');
  assertEquals(formatCellHtml(c, '   '), '');
});

Deno.test('formatCellHtml renders a link button with the open-in-new icon by default', () => {
  const c: SpreadsheetColumn = {
    id: 'open',
    header: 'Open',
    widthPx: 56,
    valueType: 'link',
  };
  const html = formatCellHtml(c, 'https://example.com/a?b=1');
  assertEquals(html.includes('sheet-cell-link'), true);
  assertEquals(html.includes('href="https://example.com/a?b=1"'), true);
  assertEquals(html.includes('target="_blank"'), true);
  assertEquals(html.includes('rel="noopener noreferrer"'), true);
  assertEquals(html.includes('ph-arrow-square-out'), true);
  assertEquals(html.includes('draggable="false"'), true);
  assertEquals(html.includes('aria-label="Open"'), true);
  assertEquals(html.includes('sheet-cell-link__text'), true);
  assertEquals(html.includes('>Open</span>'), true);
});

Deno.test('formatCellHtml uses the partner icon and can stay in the same tab', () => {
  const c: SpreadsheetColumn = {
    id: 'open',
    header: '',
    widthPx: 56,
    valueType: 'link',
    icon: 'Pencil',
    openInNewTab: false,
  };
  const html = formatCellHtml(c, '/records/4');
  assertEquals(html.includes('ph-pencil'), true);
  assertEquals(html.includes('target='), false);
  assertEquals(html.includes('aria-label="Open"'), true);
  assertEquals(html.includes('sheet-cell-link__text'), false);
  assertEquals(html.includes('href="/records/4"'), true);
});

Deno.test('formatCellHtml shows label text beside the icon', () => {
  const c: SpreadsheetColumn = {
    id: 'open',
    header: 'Link',
    widthPx: 140,
    valueType: 'link',
    label: 'View <record>',
  };
  const html = formatCellHtml(c, 'https://example.com');
  assertEquals(html.includes('sheet-cell-link__text'), true);
  assertEquals(html.includes('View &lt;record&gt;'), true);
  assertEquals(html.includes('>Link<'), false);
});

Deno.test('formatCellHtml omits the button for an unsafe link', () => {
  const c: SpreadsheetColumn = { id: 'open', header: 'Open', widthPx: 56, valueType: 'link' };
  assertEquals(formatCellHtml(c, 'javascript:alert(1)'), '');
  assertEquals(formatCellHtml(c, '   '), '');
});

Deno.test('formatCellHtml renders select option label', () => {
  const c: SpreadsheetColumn = {
    id: 'c',
    header: 'C',
    widthPx: 120,
    valueType: 'select',
    selectOptions: [{ value: 'done', label: 'Done' }],
  };
  assertEquals(formatCellHtml(c, 'done'), 'Done');
});
