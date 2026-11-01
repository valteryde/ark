import { assertEquals } from '@std/assert';
import {
  SHEET_CELL_PAD_X_PX,
  SHEET_SELECT_CARET_INSET_PX,
  blocksSpill,
  spillContentWidth,
  spillDirectionFor,
  spillRoom,
  spills,
} from '../../src/spreadsheet/cell-overflow.ts';

Deno.test('blocksSpill: a stored value, style, comment, or merge stops a spill', () => {
  assertEquals(blocksSpill({ displayText: '' }), false);
  assertEquals(blocksSpill({ displayText: '   ' }), false);
  assertEquals(blocksSpill({ displayText: 'x' }), true);
  assertEquals(blocksSpill({ displayText: '', hasStyle: true }), true);
  assertEquals(blocksSpill({ displayText: '', hasComment: true }), true);
  assertEquals(blocksSpill({ displayText: '', inSpan: true }), true);
});

Deno.test('spillRoom consumes neighbours up to the first blocker', () => {
  assertEquals(spillRoom([]), 0);
  assertEquals(spillRoom([{ widthPx: 100, blocks: false }]), 100);
  assertEquals(
    spillRoom([
      { widthPx: 100, blocks: false },
      { widthPx: 50, blocks: true },
      { widthPx: 80, blocks: false },
    ]),
    100,
  );
  assertEquals(
    spillRoom([
      { widthPx: 100, blocks: false },
      { widthPx: 50, blocks: false },
    ]),
    150,
  );
});

Deno.test('spillDirectionFor follows the cell alignment, numbers default right', () => {
  assertEquals(spillDirectionFor({}), 'left');
  assertEquals(spillDirectionFor({ numberColumn: true }), 'right');
  assertEquals(spillDirectionFor({ style: { 'justify-content': 'center' } }), 'center');
  assertEquals(spillDirectionFor({ style: { 'justify-content': 'flex-end' } }), 'right');
  assertEquals(spillDirectionFor({ style: { 'text-align': 'left' } }), 'left');
  // Explicit alignment wins over the number default.
  assertEquals(spillDirectionFor({ style: { 'justify-content': 'center' }, numberColumn: true }), 'center');
});

Deno.test('spillContentWidth widens the content box by the room in its direction', () => {
  const inset = SHEET_CELL_PAD_X_PX * 2;

  // Left-aligned: room to the right only.
  assertEquals(
    spillContentWidth({ ownWidthPx: 160, direction: 'left', rightPx: 220, leftPx: 200, contentInsetPx: inset }),
    160 + 220 - inset,
  );
  // Right-aligned: room to the left only.
  assertEquals(
    spillContentWidth({ ownWidthPx: 100, direction: 'right', rightPx: 300, leftPx: 100, contentInsetPx: inset }),
    100 + 100 - inset,
  );
  // Centered: the smaller side twice, so text stays centered on its own box.
  assertEquals(
    spillContentWidth({ ownWidthPx: 100, direction: 'center', rightPx: 300, leftPx: 100, contentInsetPx: inset }),
    100 + 200 - inset,
  );
  // No room at all means no spill.
  assertEquals(
    spillContentWidth({ ownWidthPx: 100, direction: 'left', rightPx: 0, leftPx: 400, contentInsetPx: inset }),
    0,
  );
});

Deno.test('spills() only reports a change when the box actually grows', () => {
  const inset = SHEET_CELL_PAD_X_PX * 2;
  assertEquals(spills(160, 160 - inset, inset), false);
  assertEquals(spills(160, 160 - inset + 1, inset), true);
  assertEquals(spills(160, 0, inset), false);
});

Deno.test('select cells reserve the caret inset from their spill budget', () => {
  const base = SHEET_CELL_PAD_X_PX * 2;
  const withCaret = base + SHEET_SELECT_CARET_INSET_PX;
  assertEquals(
    spillContentWidth({ ownWidthPx: 120, direction: 'left', rightPx: 100, leftPx: 0, contentInsetPx: withCaret }) +
      SHEET_SELECT_CARET_INSET_PX,
    spillContentWidth({ ownWidthPx: 120, direction: 'left', rightPx: 100, leftPx: 0, contentInsetPx: base }),
  );
});
