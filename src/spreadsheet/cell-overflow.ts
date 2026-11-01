/**
 * Cell text overflow ("spill") math.
 *
 * A cell whose text is wider than its box may paint across the columns to its
 * right while those neighbours hold nothing. This module is pure: it turns
 * model state (widths, what a neighbour holds, alignment) into the content width
 * a cell is allowed to use. The DOM side lives in `mount-spreadsheet.ts` and
 * only sets `--sheet-spill-w` plus the `sheet-cell--spill*` classes, so the
 * whole decision is unit-testable without a layout engine.
 */
import type { SpreadsheetCellStyleDeclarations } from './types.ts';

/** Horizontal padding of `.sheet-cell`; keep in sync with `--sheet-cell-pad-x` in sheet.css. */
export const SHEET_CELL_PAD_X_PX = 8;

/** Right inset `.sheet-cell--select .sheet-cell-content` reserves for the dropdown caret. */
export const SHEET_SELECT_CARET_INSET_PX = 14;

/** Which way a cell's text grows when it is wider than its box. */
export type SpillDirection = 'left' | 'right' | 'center';

/** One mounted neighbour column. Hidden columns are omitted (they have zero width). */
export interface SpillSlot {
  widthPx: number;
  /** True when the neighbour paints over the spill or holds something. */
  blocks: boolean;
}

/**
 * Does this neighbour stop a spill?
 *
 * Any stored content counts — a value, a style (fill, borders, font), or a
 * comment — as does anything inside a merged rectangle, because the anchor
 * paints its own box over the coordinates it covers.
 */
export function blocksSpill(cell: {
  displayText: string;
  hasStyle?: boolean;
  hasComment?: boolean;
  /** Coordinate sits inside a merged rectangle (anchor or covered). */
  inSpan?: boolean;
}): boolean {
  if (cell.inSpan) return true;
  if (cell.displayText.trim().length > 0) return true;
  if (cell.hasStyle) return true;
  if (cell.hasComment) return true;
  return false;
}

/**
 * Direction the text escapes in, from the cell's own alignment. The formatting
 * toolbar writes `justify-content`; `text-align` is accepted too because
 * partner payloads and the PDF export use it. Number columns default to right.
 */
export function spillDirectionFor(opts: {
  style?: SpreadsheetCellStyleDeclarations;
  numberColumn?: boolean;
}): SpillDirection {
  const tokens = [opts.style?.['justify-content'], opts.style?.['text-align']]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  for (const token of tokens) {
    if (token === 'center') return 'center';
    if (token === 'flex-end' || token === 'end' || token === 'right') return 'right';
    if (token === 'flex-start' || token === 'start' || token === 'left') return 'left';
  }
  return opts.numberColumn ? 'right' : 'left';
}

/** Extra room, in CSS px, consumed from a run of neighbours before the first blocker. */
export function spillRoom(slots: readonly SpillSlot[]): number {
  let room = 0;
  for (const slot of slots) {
    if (slot.blocks) break;
    room += slot.widthPx;
  }
  return room;
}

/**
 * Content-box width a cell may use for its text, in CSS px.
 * `0` means "do not spill": the caller keeps the default clip + ellipsis.
 *
 * `direction` is the cell's *alignment*, which decides which way the text
 * escapes: left-aligned text runs rightwards (`rightPx`), right-aligned text
 * runs leftwards (`leftPx`), centered text needs room on both sides. Both room
 * values are already blocker-clipped and capped to the mounted grid; `contentInsetPx`
 * removes the cell's horizontal padding (plus the select caret inset).
 */
export function spillContentWidth(opts: {
  ownWidthPx: number;
  direction: SpillDirection;
  rightPx: number;
  leftPx: number;
  contentInsetPx: number;
}): number {
  const extra =
    opts.direction === 'left'
      ? opts.rightPx
      : opts.direction === 'right'
        ? opts.leftPx
        : 2 * Math.min(opts.leftPx, opts.rightPx);
  if (extra <= 0) return 0;
  return Math.max(0, opts.ownWidthPx + extra - opts.contentInsetPx);
}

/** True when `contentWidthPx` actually exceeds what the cell's own box allows. */
export function spills(ownWidthPx: number, contentWidthPx: number, contentInsetPx: number): boolean {
  return contentWidthPx > ownWidthPx - contentInsetPx;
}
