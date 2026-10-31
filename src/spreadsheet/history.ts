import { cellSpansEqual, cloneCellSpans } from './cell-span.ts';
import type { CellSpan, SpreadsheetCellInit } from './types.ts';

/** Map key is `row:col`. Value `undefined` means the cell key is absent from the store. */
export type HistoryCellMap = Map<string, SpreadsheetCellInit | undefined>;

export type HistorySpanChange = {
  before: readonly CellSpan[];
  after: readonly CellSpan[];
};

export type HistoryRecord = {
  before: HistoryCellMap;
  after: HistoryCellMap;
  /** Present only when this step changed the sheet's merge list. */
  spansBefore?: CellSpan[];
  spansAfter?: CellSpan[];
};

const DEFAULT_MAX_DEPTH = 100;

function cloneCellMap(m: HistoryCellMap): HistoryCellMap {
  const out = new Map<string, SpreadsheetCellInit | undefined>();
  for (const [k, v] of m) {
    if (v === undefined) {
      out.set(k, undefined);
      continue;
    }
    out.set(k, {
      value: v.value,
      ...(v.style !== undefined ? { style: { ...v.style } } : {}),
      ...(v.comment !== undefined && v.comment.trim() !== ''
        ? { comment: v.comment }
        : {}),
    });
  }
  return out;
}

export function cellMapsEqual(a: HistoryCellMap, b: HistoryCellMap): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    if (!b.has(k)) return false;
    if (!cellStatesEqual(va, b.get(k))) return false;
  }
  return true;
}

export function cellStatesEqual(
  a: SpreadsheetCellInit | undefined,
  b: SpreadsheetCellInit | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.value !== b.value) return false;
  const sa = a.style;
  const sb = b.style;
  if (sa === undefined && sb === undefined) return true;
  if (sa === undefined || sb === undefined) return false;
  const ka = Object.keys(sa).sort();
  const kb = Object.keys(sb).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
  }
  for (const key of ka) {
    if (sa[key] !== sb[key]) return false;
  }
  const ca = (a.comment ?? '').trim();
  const cb = (b.comment ?? '').trim();
  if (ca !== cb) return false;
  return true;
}

export type SpreadsheetHistoryApi = {
  pushRecord(before: HistoryCellMap, after: HistoryCellMap, spans?: HistorySpanChange): void;
  /** Pop undo stack; returns record so caller applies `before` to the store. */
  undo(): HistoryRecord | null;
  /** Pop redo stack; returns record so caller applies `after` to the store. */
  redo(): HistoryRecord | null;
  canUndo(): boolean;
  canRedo(): boolean;
  subscribe(cb: () => void): () => void;
  beginBatch(): void;
  endBatch(): void;
  /** Nested batches collapse to one pushed record when the outermost batch ends. */
  runBatch(fn: () => void): void;
};

export function createSpreadsheetHistory(
  maxDepth: number = DEFAULT_MAX_DEPTH,
): SpreadsheetHistoryApi {
  const undoStack: HistoryRecord[] = [];
  const redoStack: HistoryRecord[] = [];
  const listeners = new Set<() => void>();

  let batchDepth = 0;
  let batchBefore: HistoryCellMap | null = null;
  let batchAfter: HistoryCellMap | null = null;
  let batchSpansBefore: CellSpan[] | null = null;
  let batchSpansAfter: CellSpan[] | null = null;

  function notify(): void {
    for (const fn of listeners) fn();
  }

  function trimUndo(): void {
    while (undoStack.length > maxDepth) undoStack.shift();
  }

  function mergeMaps(into: HistoryCellMap, from: HistoryCellMap): void {
    for (const [k, v] of from) {
      into.set(k, v);
    }
  }

  function pushRecordInternal(
    before: HistoryCellMap,
    after: HistoryCellMap,
    spans?: HistorySpanChange,
  ): void {
    const spanChange = spans !== undefined && !cellSpansEqual(spans.before, spans.after);
    if (!spanChange && before.size === 0 && after.size === 0) return;
    if (!spanChange && cellMapsEqual(before, after)) return;
    undoStack.push({
      before: cloneCellMap(before),
      after: cloneCellMap(after),
      ...(spanChange
        ? {
            spansBefore: cloneCellSpans(spans!.before),
            spansAfter: cloneCellSpans(spans!.after),
          }
        : {}),
    });
    redoStack.length = 0;
    trimUndo();
    notify();
  }

  return {
    pushRecord(before: HistoryCellMap, after: HistoryCellMap, spans?: HistorySpanChange) {
      if (batchDepth > 0) {
        if (batchBefore === null) batchBefore = new Map();
        if (batchAfter === null) batchAfter = new Map();
        for (const [k, v] of before) {
          if (!batchBefore!.has(k)) batchBefore!.set(k, v);
        }
        mergeMaps(batchAfter!, after);
        if (spans) {
          if (batchSpansBefore === null) batchSpansBefore = cloneCellSpans(spans.before);
          batchSpansAfter = cloneCellSpans(spans.after);
        }
        return;
      }
      pushRecordInternal(before, after, spans);
    },

    beginBatch() {
      batchDepth++;
      if (batchDepth === 1) {
        batchBefore = null;
        batchAfter = null;
        batchSpansBefore = null;
        batchSpansAfter = null;
      }
    },

    endBatch() {
      if (batchDepth <= 0) return;
      batchDepth--;
      if (batchDepth === 0 && batchBefore !== null && batchAfter !== null) {
        const b = batchBefore;
        const a = batchAfter;
        const spanChange =
          batchSpansBefore !== null && batchSpansAfter !== null
            ? { before: batchSpansBefore, after: batchSpansAfter }
            : undefined;
        batchBefore = null;
        batchAfter = null;
        batchSpansBefore = null;
        batchSpansAfter = null;
        pushRecordInternal(b, a, spanChange);
      } else if (batchDepth === 0) {
        batchBefore = null;
        batchAfter = null;
        batchSpansBefore = null;
        batchSpansAfter = null;
      }
    },

    runBatch(fn: () => void) {
      this.beginBatch();
      try {
        fn();
      } finally {
        this.endBatch();
      }
    },

    undo(): HistoryRecord | null {
      const rec = undoStack.pop();
      if (!rec) return null;
      redoStack.push(rec);
      notify();
      return rec;
    },

    redo(): HistoryRecord | null {
      const rec = redoStack.pop();
      if (!rec) return null;
      undoStack.push(rec);
      notify();
      return rec;
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    canRedo(): boolean {
      return redoStack.length > 0;
    },

    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
