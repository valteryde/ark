import '../sheet.css';

import { formatCellHtml, formatSelectOptionMarkup } from './cell-display.ts';
import {
  columnValueType,
  filterSelectOptions,
  isSelectColumn,
  parseCommittedCellValue,
} from './cell-value.ts';
import { cellKey } from './data-store.ts';
import { cellMapsEqual, createSpreadsheetHistory, type HistoryCellMap } from './history.ts';
import type {
  CollabPresenceMode,
  CollabPresencePayload,
  RemoteCollabPeer,
  SpreadsheetColumn,
  SpreadsheetConfig,
  SpreadsheetCellInit,
  SpreadsheetMountHandle,
  SpreadsheetSelectOption,
} from './types.ts';
import { resolveEnabledUiCapabilities } from './types.ts';

let persistTooltipEl: HTMLDivElement | null = null;
let persistTooltipAnchor: HTMLElement | null = null;
let persistTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
let persistTooltipViewportWired = false;

function getPersistTooltipEl(): HTMLDivElement {
  if (!persistTooltipEl) {
    persistTooltipEl = document.createElement('div');
    persistTooltipEl.className = 'sheet-persist-tooltip';
    persistTooltipEl.setAttribute('role', 'tooltip');
    persistTooltipEl.hidden = true;
    document.body.appendChild(persistTooltipEl);
  }
  return persistTooltipEl;
}

function positionPersistTooltip(anchor: HTMLElement): void {
  const tip = persistTooltipEl;
  if (!tip) return;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  let top = rect.top - th - margin;
  if (top < margin) top = rect.bottom + margin;
  left = Math.max(margin, Math.min(left, vw - tw - margin));
  top = Math.max(margin, Math.min(top, vh - th - margin));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function wirePersistTooltipViewport(): void {
  if (persistTooltipViewportWired) return;
  persistTooltipViewportWired = true;
  const reposition = (): void => {
    if (
      persistTooltipAnchor &&
      persistTooltipEl &&
      !persistTooltipEl.hidden &&
      persistTooltipEl.classList.contains('sheet-persist-tooltip--visible')
    ) {
      positionPersistTooltip(persistTooltipAnchor);
    }
  };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
}

function hidePersistTooltip(): void {
  persistTooltipAnchor = null;
  if (persistTooltipHideTimer !== null) {
    clearTimeout(persistTooltipHideTimer);
    persistTooltipHideTimer = null;
  }
  if (persistTooltipEl) {
    persistTooltipEl.classList.remove('sheet-persist-tooltip--visible');
    persistTooltipEl.hidden = true;
  }
}

function scheduleHidePersistTooltip(): void {
  if (persistTooltipHideTimer !== null) clearTimeout(persistTooltipHideTimer);
  persistTooltipHideTimer = window.setTimeout(() => {
    persistTooltipHideTimer = null;
    hidePersistTooltip();
  }, 100);
}

function cancelHidePersistTooltip(): void {
  if (persistTooltipHideTimer !== null) {
    clearTimeout(persistTooltipHideTimer);
    persistTooltipHideTimer = null;
  }
}

function showPersistTooltipForDot(anchor: HTMLElement, text: string): void {
  wirePersistTooltipViewport();
  const tip = getPersistTooltipEl();
  persistTooltipAnchor = anchor;
  cancelHidePersistTooltip();
  tip.textContent = text;
  tip.hidden = false;
  tip.classList.add('sheet-persist-tooltip--visible');
  requestAnimationFrame(() => {
    if (persistTooltipAnchor !== anchor) return;
    positionPersistTooltip(anchor);
  });
}

function getCellEditor(cell: HTMLElement): HTMLInputElement | null {
  return cell.querySelector<HTMLInputElement>('.sheet-cell-input');
}

function applyCellDisplay(
  content: HTMLDivElement,
  column: SpreadsheetColumn | undefined,
  value: string,
): void {
  content.innerHTML = formatCellHtml(column, value);
}

const SHEET_STYLE_PROPS_ATTR = 'data-sheet-style-props';

/** Apply kebab-case CSS declarations; clears previously applied keys tracked on the element. */
function applyCellInlineStyleRecord(
  el: HTMLDivElement,
  style: Record<string, string> | undefined,
): void {
  const prev = el.getAttribute(SHEET_STYLE_PROPS_ATTR)?.split(',').filter(Boolean) ?? [];
  for (const prop of prev) {
    el.style.removeProperty(prop);
  }
  if (!style || Object.keys(style).length === 0) {
    el.removeAttribute(SHEET_STYLE_PROPS_ATTR);
    return;
  }
  const keys: string[] = [];
  for (const [k, v] of Object.entries(style)) {
    const name = k.trim();
    if (!name || v === undefined || v === '') continue;
    el.style.setProperty(name, v);
    keys.push(name);
  }
  if (keys.length === 0) {
    el.removeAttribute(SHEET_STYLE_PROPS_ATTR);
    return;
  }
  el.setAttribute(SHEET_STYLE_PROPS_ATTR, keys.join(','));
}

/** Mount a configurable spreadsheet. Tear down by removing `container` children if remounting. */
export function mountSpreadsheet(
  container: HTMLElement,
  config: SpreadsheetConfig,
): SpreadsheetMountHandle {
  const columns = config.columns;
  const columnCountTotal = columns.length;
  const rowCountTotal = config.rowCount;
  const defaultRowHeight = config.defaultRowHeightPx ?? 28;
  const rowHeights = Array.from({ length: rowCountTotal }, () => defaultRowHeight);
  const columnWidths = columns.map((c) => c.widthPx);

  const cumulativeRowHeights: number[] = Array.from({ length: rowCountTotal }, () => 0);
  for (let i = 1; i < rowCountTotal; i++) {
    cumulativeRowHeights[i] = cumulativeRowHeights[i - 1]! + rowHeights[i - 1]!;
  }

  const cumulativeColumnWidths: number[] = Array.from({ length: columnCountTotal }, () => 0);
  for (let i = 1; i < columnCountTotal; i++) {
    cumulativeColumnWidths[i] = cumulativeColumnWidths[i - 1]! + columnWidths[i - 1]!;
  }

  const sheetTotalWidth = columnWidths.reduce((a, b) => a + b, 0);
  const sheetTotalHeight = rowHeights.reduce((a, b) => a + b, 0);
  /** Fixed gutter for row indices; added to horizontal extent and cell `left` offsets. */
  const rowHeaderWidthPx = 48;

  const data = config.data;
  const { growRowCountForPaste } = config;

  const historyEnabled =
    typeof data.replaceCell === 'function' &&
    typeof data.hasCell === 'function' &&
    typeof data.getStoredCell === 'function';

  const history = historyEnabled ? createSpreadsheetHistory() : null;

  const commentsUiEnabled = resolveEnabledUiCapabilities(config.enabledUiCapabilities).has(
    'comment',
  );
  const commentsEnabled = commentsUiEnabled && historyEnabled;

  function keyToRowCol(k: string): { row: number; col: number } {
    const [rs, cs] = k.split(':');
    return { row: Number(rs), col: Number(cs) };
  }

  function captureSnapshot(keys: readonly string[]): HistoryCellMap {
    const m: HistoryCellMap = new Map();
    for (const k of keys) {
      const { row, col } = keyToRowCol(k);
      if (data.hasCell?.(row, col)) {
        m.set(k, data.getStoredCell?.(row, col));
      } else {
        m.set(k, undefined);
      }
    }
    return m;
  }

  function applySnapshot(snapshot: HistoryCellMap): void {
    if (!data.replaceCell) return;
    const run = (): void => {
      for (const [k, state] of snapshot) {
        const { row, col } = keyToRowCol(k);
        data.replaceCell!(row, col, state === undefined ? null : state);
      }
    };
    if (config.suppressOutboundSyncDuring) {
      config.suppressOutboundSyncDuring(run);
    } else {
      run();
    }
  }

  function hydrateCellFromStore(row: number, col: number): void {
    const el = cells.get(cellKey(row, col));
    if (!el) return;
    const colDef = columnAt(col);
    const raw = data.get(row, col);
    const display = raw !== undefined ? String(raw) : '';
    const content = el.querySelector<HTMLDivElement>('.sheet-cell-content');
    if (content) applyCellDisplay(content, colDef, display);
    syncCellChrome(row, col);
    const inp = getCellEditor(el);
    if (inp) inp.value = raw !== undefined ? String(raw) : '';
  }

  function flashRemoteMarker(row: number, col: number, hue: number): void {
    const el = cells.get(cellKey(row, col));
    if (!el) return;
    const h = ((hue % 360) + 360) % 360;
    el.style.setProperty('--collab-flash-hue', String(h));
    el.classList.add('sheet-cell--collab-remote-flash');
    window.setTimeout(() => {
      el.classList.remove('sheet-cell--collab-remote-flash');
      el.style.removeProperty('--collab-flash-hue');
    }, 800);
  }

  function applyExternalValue(
    row: number,
    col: number,
    value: string | number,
    options?: { remoteMarkerHue?: number },
  ): boolean {
    if (row < 1 || row > rowCountTotal || col < 1 || col > columnCountTotal) return false;
    if (!cells.has(cellKey(row, col))) return false;
    data.set(row, col, value);
    hydrateCellFromStore(row, col);
    clearCellPersistError(row, col);
    if (options?.remoteMarkerHue !== undefined) {
      flashRemoteMarker(row, col, options.remoteMarkerHue);
    }
    return true;
  }

  function hydrateFromHistoryRecord(before: HistoryCellMap, after: HistoryCellMap): void {
    const keys = new Set<string>([...before.keys(), ...after.keys()]);
    for (const k of keys) {
      const { row, col } = keyToRowCol(k);
      hydrateCellFromStore(row, col);
    }
  }

  function pushHistoryIfChanged(before: HistoryCellMap, after: HistoryCellMap): void {
    if (!history) return;
    if (cellMapsEqual(before, after)) return;
    history.pushRecord(before, after);
  }

  const selectArea: {
    active: boolean;
    row: number;
    col: number;
    rowEnd: number;
    colEnd: number;
  } = {
    active: false,
    row: 1,
    col: 1,
    rowEnd: 1,
    colEnd: 1,
  };

  const cells = new Map<string, HTMLDivElement>();
  let active = { row: 1, col: 1 };

  const persistErrorClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearCellPersistError(row: number, col: number): void {
    const k = cellKey(row, col);
    const t = persistErrorClearTimers.get(k);
    if (t !== undefined) {
      clearTimeout(t);
      persistErrorClearTimers.delete(k);
    }
    const el = cells.get(k);
    if (el) {
      const dot = el.querySelector('.sheet-cell-persist-dot');
      if (dot && persistTooltipAnchor === dot) hidePersistTooltip();
      dot?.remove();
    }
  }

  function showCellPersistError(row: number, col: number, message?: string): void {
    if (row < 1 || row > rowCountTotal || col < 1 || col > columnCountTotal) return;
    const k = cellKey(row, col);
    const el = cells.get(k);
    if (!el) return;
    clearCellPersistError(row, col);
    const hint = message?.trim()
      ? message.trim()
      : 'Could not save — check your connection or try again';
    const hintForTip = hint.length > 4000 ? `${hint.slice(0, 3997)}…` : hint;
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'sheet-cell-persist-dot';
    dot.tabIndex = 0;
    dot.setAttribute('aria-label', 'Save failed');
    dot.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    dot.addEventListener('click', (e) => e.stopPropagation());
    dot.addEventListener('mouseenter', () => {
      cancelHidePersistTooltip();
      showPersistTooltipForDot(dot, hintForTip);
    });
    dot.addEventListener('mouseleave', () => scheduleHidePersistTooltip());
    dot.addEventListener('focus', () => showPersistTooltipForDot(dot, hintForTip));
    dot.addEventListener('blur', () => hidePersistTooltip());
    el.appendChild(dot);
    const tid = window.setTimeout(() => clearCellPersistError(row, col), 8000);
    persistErrorClearTimers.set(k, tid);
  }

  let remotePresenceList: RemoteCollabPeer[] = [];

  function clearRemotePresenceDecor(): void {
    for (const el of cells.values()) {
      el.classList.remove('sheet-cell--remote-presence');
      el.style.removeProperty('--remote-collab-hue');
    }
  }

  function paintRemotePresenceOverlays(): void {
    clearRemotePresenceDecor();
    const byKey = new Map<string, RemoteCollabPeer[]>();
    for (const p of remotePresenceList) {
      const k = cellKey(p.row, p.col);
      const arr = byKey.get(k);
      if (arr) arr.push(p);
      else byKey.set(k, [p]);
    }
    for (const [k, plist] of byKey) {
      const el = cells.get(k);
      if (!el) continue;
      el.classList.add('sheet-cell--remote-presence');
      el.style.setProperty('--remote-collab-hue', String(plist[0]!.markerHue));
    }
  }

  function getCollabPresencePayload(): CollabPresencePayload | null {
    if (rowCountTotal < 1 || columnCountTotal < 1) return null;
    const row = active.row;
    const col = active.col;
    let mode: CollabPresenceMode = 'navigate';
    if (!selectArea.active) {
      const cell = cells.get(cellKey(row, col));
      const inp = cell ? getCellEditor(cell) : null;
      if (inp && document.activeElement === inp) {
        mode = 'edit';
      }
    }
    return { row, col, mode };
  }

  function setRemoteCollabPresence(peers: readonly RemoteCollabPeer[]): void {
    remotePresenceList = peers.map((p) => ({
      ...p,
      markerHue: Number.isFinite(p.markerHue) ? (((p.markerHue % 360) + 360) % 360) : 210,
    }));
    paintRemotePresenceOverlays();
  }

  const selectionChangeListeners = new Set<() => void>();
  const historyChangeListeners = new Set<() => void>();

  function notifySelectionChange(): void {
    for (const fn of selectionChangeListeners) {
      fn();
    }
  }

  function notifyHistoryChange(): void {
    for (const fn of historyChangeListeners) {
      fn();
    }
  }

  let persistActiveInputSkipHistory = false;

  let dragPointerId: number | null = null;
  let dragging = false;
  let dragAnchor = { row: 1, col: 1 };
  let dragMoved = false;
  let dragRaf: number | null = null;
  let dragPendingEnd: { row: number; col: number } | null = null;

  function clampRow(row: number): number {
    return Math.max(1, Math.min(rowCountTotal, row));
  }

  function clampCol(col: number): number {
    return Math.max(1, Math.min(columnCountTotal, col));
  }

  const initSel = config.initialSelection;
  if (
    initSel &&
    typeof initSel.row === 'number' &&
    Number.isFinite(initSel.row) &&
    typeof initSel.col === 'number' &&
    Number.isFinite(initSel.col)
  ) {
    active.row = clampRow(Math.trunc(initSel.row));
    active.col = clampCol(Math.trunc(initSel.col));
  }
  selectArea.row = active.row;
  selectArea.col = active.col;
  selectArea.rowEnd = active.row;
  selectArea.colEnd = active.col;
  selectArea.active = false;

  function columnAt(col: number): SpreadsheetColumn | undefined {
    return columns[col - 1];
  }

  function isReadOnlyCol(col: number): boolean {
    return columnAt(col)?.readOnly === true;
  }

  function persistActiveInput(): void {
    if (isReadOnlyCol(active.col)) return;
    const el = cells.get(cellKey(active.row, active.col));
    if (!el) return;
    const input = getCellEditor(el);
    const content = el.querySelector<HTMLDivElement>('.sheet-cell-content');
    if (!input || !content) return;
    const col = columnAt(active.col);
    const parsed = parseCommittedCellValue(col, input.value);
    if (!parsed.ok) {
      const stored = data.get(active.row, active.col);
      input.value = stored !== undefined ? String(stored) : '';
      return;
    }
    const k = cellKey(active.row, active.col);
    const recordHistory = history !== null && !persistActiveInputSkipHistory;
    const before = recordHistory ? captureSnapshot([k]) : null;
    data.set(active.row, active.col, parsed.value);
    applyCellDisplay(content, col, String(parsed.value));
    syncCellChrome(active.row, active.col);
    if (recordHistory && before) {
      const after = captureSnapshot([k]);
      pushHistoryIfChanged(before, after);
    }
  }

  function flushActiveInputSkippingHistory(): void {
    persistActiveInputSkipHistory = true;
    try {
      persistActiveInput();
    } finally {
      persistActiveInputSkipHistory = false;
    }
  }

  function doUndo(): boolean {
    if (!history || !data.replaceCell) return false;
    flushActiveInputSkippingHistory();
    const rec = history.undo();
    if (!rec) return false;
    applySnapshot(rec.before);
    hydrateFromHistoryRecord(rec.before, rec.after);
    notifySelectionChange();
    return true;
  }

  function doRedo(): boolean {
    if (!history || !data.replaceCell) return false;
    flushActiveInputSkippingHistory();
    const rec = history.redo();
    if (!rec) return false;
    applySnapshot(rec.after);
    hydrateFromHistoryRecord(rec.before, rec.after);
    notifySelectionChange();
    return true;
  }

  function updateCommentIndicator(row: number, col: number): void {
    const el = cells.get(cellKey(row, col));
    if (!el) return;
    const k = cellKey(row, col);
    const note = data.getStoredCell?.(row, col)?.comment?.trim();
    el.classList.toggle('sheet-cell--has-comment', Boolean(note));
    if (!note) {
      if (commentPreviewKey === k) hideCommentPreview();
      el.querySelector('.sheet-cell-comment-hit')?.remove();
      return;
    }
    let hit = el.querySelector<HTMLButtonElement>('.sheet-cell-comment-hit');
    if (!hit) {
      hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'sheet-cell-comment-hit';
      hit.setAttribute('aria-label', 'Show comment');
      hit.setAttribute('aria-expanded', 'false');
      hit.setAttribute('aria-controls', 'sheet-comment-preview');
      el.appendChild(hit);
    }
    hit.dataset.row = String(row);
    hit.dataset.col = String(col);
  }

  function syncCellChrome(row: number, col: number): void {
    const el = cells.get(cellKey(row, col));
    if (!el) return;
    applyCellInlineStyleRecord(el, data.getCellStyle?.(row, col));
    updateCommentIndicator(row, col);
  }

  let commentEditorAnchor: { row: number; col: number } | null = null;

  function cellInitIsVacuous(cell: { value: string | number; style?: object; comment?: string }): boolean {
    const v = cell.value;
    const hasValue =
      typeof v === 'number'
        ? Number.isFinite(v)
        : String(v).trim().length > 0;
    const hasStyle = Boolean(cell.style && Object.keys(cell.style).length > 0);
    const hasComment = Boolean(cell.comment && cell.comment.trim());
    return !hasValue && !hasStyle && !hasComment;
  }

  function commitCommentAt(row: number, col: number, text: string | undefined): void {
    if (!data.replaceCell || !data.getStoredCell) return;
    const key = cellKey(row, col);
    const before = history ? captureSnapshot([key]) : null;
    const prev = data.getStoredCell(row, col);
    const raw = data.get(row, col);
    const value = prev !== undefined ? prev.value : (raw !== undefined ? raw : '');
    const style = prev?.style;
    const trimmed = (text ?? '').trim();
    const comment = trimmed === '' ? undefined : trimmed;
    const next: SpreadsheetCellInit = { value };
    if (style !== undefined && Object.keys(style).length > 0) next.style = { ...style };
    if (comment !== undefined) next.comment = comment;
    data.replaceCell(row, col, cellInitIsVacuous(next) ? null : next);
    hydrateCellFromStore(row, col);
    if (history && before) {
      const after = captureSnapshot([key]);
      pushHistoryIfChanged(before, after);
    }
  }

  let commentPopover: HTMLDivElement | null = null;
  let commentTextarea: HTMLTextAreaElement | null = null;

  function positionCommentPopover(row: number, col: number): void {
    if (!commentPopover) return;
    const cell = cells.get(cellKey(row, col));
    if (!cell) return;
    const cr = cell.getBoundingClientRect();
    const margin = 8;
    const w = Math.min(320, window.innerWidth - margin * 2);
    let left = cr.left;
    if (left + w > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - w);
    }
    commentPopover.style.width = `${w}px`;
    commentPopover.style.left = `${left}px`;
    commentPopover.style.top = `${Math.min(cr.bottom + 4, window.innerHeight - margin - 160)}px`;
  }

  function closeCommentEditor(apply: boolean): void {
    hideCommentPreview();
    if (!commentPopover || !commentTextarea || !commentEditorAnchor) {
      commentEditorAnchor = null;
      if (commentPopover) commentPopover.hidden = true;
      return;
    }
    const { row, col } = commentEditorAnchor;
    if (apply) {
      commitCommentAt(row, col, commentTextarea.value);
    }
    commentTextarea.value = '';
    commentPopover.hidden = true;
    commentEditorAnchor = null;
    viewport.focus();
  }

  function openCommentEditor(): void {
    if (!commentsEnabled || !commentPopover || !commentTextarea) return;
    hideCommentPreview();
    persistActiveInput();
    hideSuggestions();
    const anchor = getPasteAnchor();
    commentEditorAnchor = { row: anchor.row, col: anchor.col };
    const existing = data.getStoredCell?.(anchor.row, anchor.col)?.comment ?? '';
    commentTextarea.value = existing;
    commentPopover.hidden = false;
    positionCommentPopover(anchor.row, anchor.col);
    commentTextarea.focus();
  }

  function getFormattingTargets(): { row: number; col: number }[] {
    const out: { row: number; col: number }[] = [];
    if (selectArea.active) {
      const minRow = Math.min(selectArea.row, selectArea.rowEnd);
      const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
      const minCol = Math.min(selectArea.col, selectArea.colEnd);
      const maxCol = Math.max(selectArea.col, selectArea.colEnd);
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          if (!isReadOnlyCol(col)) out.push({ row, col });
        }
      }
      return out;
    }
    if (!isReadOnlyCol(active.col)) out.push({ row: active.row, col: active.col });
    return out;
  }

  function mergeCellStyleOnSelection(patch: Record<string, string | undefined>): void {
    if (!data.mergeCellStyle) return;
    persistActiveInput();
    const targets = getFormattingTargets();
    if (targets.length === 0) return;
    const keys = targets.map(({ row, col }) => cellKey(row, col));
    const before = history ? captureSnapshot(keys) : null;
    for (const { row, col } of targets) {
      data.mergeCellStyle(row, col, patch);
      syncCellChrome(row, col);
    }
    if (history && before) {
      const after = captureSnapshot(keys);
      pushHistoryIfChanged(before, after);
    }
    notifySelectionChange();
  }

  function mergeCellStyleOnEachTarget(
    patchForCell: (row: number, col: number) => Record<string, string | undefined>,
  ): void {
    if (!data.mergeCellStyle) return;
    persistActiveInput();
    const targets = getFormattingTargets();
    if (targets.length === 0) return;
    const keys = targets.map(({ row, col }) => cellKey(row, col));
    const before = history ? captureSnapshot(keys) : null;
    for (const { row, col } of targets) {
      data.mergeCellStyle(row, col, patchForCell(row, col));
      syncCellChrome(row, col);
    }
    if (history && before) {
      const after = captureSnapshot(keys);
      pushHistoryIfChanged(before, after);
    }
    notifySelectionChange();
  }

  function everyTargetCellStyle(
    cssProperty: string,
    predicate: (value: string | undefined) => boolean,
  ): boolean {
    const targets = getFormattingTargets();
    if (targets.length === 0) return false;
    return targets.every(({ row, col }) => {
      const v = data.getCellStyle?.(row, col)?.[cssProperty];
      return predicate(v);
    });
  }

  function doOnEverySelectedCell(callback: (cell: HTMLDivElement) => void): void {
    const minRow = Math.min(selectArea.row, selectArea.rowEnd);
    const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
    const minCol = Math.min(selectArea.col, selectArea.colEnd);
    const maxCol = Math.max(selectArea.col, selectArea.colEnd);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = cells.get(cellKey(row, col));
        if (!cell) continue;
        callback(cell);
      }
    }
  }

  function escapeTsvField(value: string): string {
    if (/[\t\n\r"]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  function parsePastedCellField(raw: string): string {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      return raw.slice(1, -1).replace(/""/g, '"');
    }
    return raw;
  }

  function parseClipboardRows(text: string): string[][] {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.map((line) => line.split('\t').map(parsePastedCellField));
  }

  function getPasteAnchor(): { row: number; col: number } {
    if (selectArea.active) {
      return {
        row: Math.min(selectArea.row, selectArea.rowEnd),
        col: Math.min(selectArea.col, selectArea.colEnd),
      };
    }
    return { row: active.row, col: active.col };
  }

  function buildCopyPlainText(): string {
    persistActiveInput();
    if (selectArea.active) {
      const minRow = Math.min(selectArea.row, selectArea.rowEnd);
      const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
      const minCol = Math.min(selectArea.col, selectArea.colEnd);
      const maxCol = Math.max(selectArea.col, selectArea.colEnd);
      const lines: string[] = [];
      for (let r = minRow; r <= maxRow; r++) {
        const parts: string[] = [];
        for (let c = minCol; c <= maxCol; c++) {
          const v = data.get(r, c);
          const s = v === undefined ? '' : String(v);
          parts.push(escapeTsvField(s));
        }
        lines.push(parts.join('\t'));
      }
      return lines.join('\n');
    }
    const v = data.get(active.row, active.col);
    return v === undefined ? '' : String(v);
  }

  function buildRowPlainText(targetRow: number): string {
    const r = clampRow(targetRow);
    const parts: string[] = [];
    for (let c = 1; c <= columnCountTotal; c++) {
      const v = data.get(r, c);
      const s = v === undefined ? '' : String(v);
      parts.push(escapeTsvField(s));
    }
    return parts.join('\t');
  }

  function clearSheetRow(targetRow: number): void {
    if (!data.replaceCell) return;
    const row = clampRow(targetRow);
    persistActiveInput();
    const keys: string[] = [];
    for (let col = 1; col <= columnCountTotal; col++) {
      if (!isReadOnlyCol(col)) keys.push(cellKey(row, col));
    }
    if (keys.length === 0) return;
    const before = history ? captureSnapshot(keys) : null;
    for (const k of keys) {
      const { row: rr, col } = keyToRowCol(k);
      data.replaceCell(rr, col, null);
      hydrateCellFromStore(rr, col);
    }
    if (history && before) {
      const after = captureSnapshot(keys);
      pushHistoryIfChanged(before, after);
    }
    notifySelectionChange();
  }

  function shouldLetInputHandleCopy(evTarget: EventTarget | null): boolean {
    if (!(evTarget instanceof HTMLInputElement)) return false;
    if (!evTarget.classList.contains('sheet-cell-input')) return false;
    if (selectArea.active) return false;
    const a = evTarget.selectionStart ?? 0;
    const b = evTarget.selectionEnd ?? 0;
    return a !== b;
  }

  function shouldLetInputHandlePaste(evTarget: EventTarget | null, plain: string): boolean {
    if (!(evTarget instanceof HTMLInputElement)) return false;
    if (!evTarget.classList.contains('sheet-cell-input')) return false;
    if (selectArea.active) return false;
    const gridLike = plain.includes('\t') || plain.includes('\n');
    return !gridLike;
  }

  function collectPasteTargetKeys(
    anchorRow: number,
    anchorCol: number,
    grid: string[][],
  ): string[] {
    const keys: string[] = [];
    for (let dr = 0; dr < grid.length; dr++) {
      const row = grid[dr]!;
      for (let dc = 0; dc < row.length; dc++) {
        const r = anchorRow + dr;
        const c = anchorCol + dc;
        if (r < 1 || r > rowCountTotal || c < 1 || c > columnCountTotal) continue;
        if (isReadOnlyCol(c)) continue;
        keys.push(cellKey(r, c));
      }
    }
    return keys;
  }

  function applyPastedGrid(plain: string): void {
    const grid = parseClipboardRows(plain);
    if (grid.length === 0) return;

    hideSuggestions();
    persistActiveInput();

    const anchor = getPasteAnchor();
    const maxR = anchor.row + grid.length - 1;
    if (maxR > rowCountTotal && growRowCountForPaste) {
      growRowCountForPaste({ minRowCount: maxR, plain });
      return;
    }

    const keys = collectPasteTargetKeys(anchor.row, anchor.col, grid);
    const before = history && keys.length > 0 ? captureSnapshot(keys) : null;

    for (let dr = 0; dr < grid.length; dr++) {
      const row = grid[dr]!;
      for (let dc = 0; dc < row.length; dc++) {
        const r = anchor.row + dr;
        const c = anchor.col + dc;
        if (r < 1 || r > rowCountTotal || c < 1 || c > columnCountTotal) continue;
        if (isReadOnlyCol(c)) continue;
        const raw = row[dc] ?? '';
        const colDef = columnAt(c);
        const parsed = parseCommittedCellValue(colDef, raw);
        if (!parsed.ok) continue;
        data.set(r, c, parsed.value);
        hydrateCellFromStore(r, c);
      }
    }

    if (history && before) {
      const after = captureSnapshot(keys);
      pushHistoryIfChanged(before, after);
    }
    notifySelectionChange();
  }

  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.id = 'sheet-container';

  const viewport = document.createElement('div');
  viewport.className = 'sheet-viewport';
  viewport.tabIndex = 0;

  const commentPreviewPop = document.createElement('div');
  commentPreviewPop.className = 'sheet-comment-preview';
  commentPreviewPop.id = 'sheet-comment-preview';
  commentPreviewPop.hidden = true;
  commentPreviewPop.setAttribute('role', 'tooltip');

  let commentPreviewHideTimer: ReturnType<typeof setTimeout> | null = null;
  let commentPreviewKey: string | null = null;
  let commentPreviewSourceHit: HTMLButtonElement | null = null;

  function hideCommentPreview(): void {
    if (commentPreviewHideTimer !== null) {
      clearTimeout(commentPreviewHideTimer);
      commentPreviewHideTimer = null;
    }
    commentPreviewPop.hidden = true;
    commentPreviewKey = null;
    commentPreviewPop.textContent = '';
    if (commentPreviewSourceHit) {
      commentPreviewSourceHit.setAttribute('aria-expanded', 'false');
      commentPreviewSourceHit = null;
    }
  }

  function positionCommentPreview(anchor: HTMLElement): void {
    const ar = anchor.getBoundingClientRect();
    const margin = 8;
    const maxW = Math.min(360, window.innerWidth - margin * 2);
    const maxH = Math.min(280, window.innerHeight - margin * 2);
    commentPreviewPop.style.maxWidth = `${maxW}px`;
    commentPreviewPop.style.maxHeight = `${maxH}px`;
    commentPreviewPop.style.left = '0px';
    commentPreviewPop.style.top = '0px';
    void commentPreviewPop.offsetWidth;
    const ph = commentPreviewPop.getBoundingClientRect().height;
    const pw = Math.min(maxW, commentPreviewPop.getBoundingClientRect().width);
    let top = ar.bottom + 4;
    let left = ar.left;
    if (top + ph > window.innerHeight - margin) {
      top = Math.max(margin, ar.top - ph - 4);
    }
    if (left + pw > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - pw);
    }
    commentPreviewPop.style.left = `${left}px`;
    commentPreviewPop.style.top = `${top}px`;
  }

  function scheduleHideCommentPreview(): void {
    if (commentPreviewHideTimer !== null) clearTimeout(commentPreviewHideTimer);
    commentPreviewHideTimer = setTimeout(() => {
      commentPreviewHideTimer = null;
      hideCommentPreview();
    }, 200);
  }

  function showCommentPreviewFromHit(hit: HTMLButtonElement): void {
    if (commentPopover && !commentPopover.hidden) return;
    const row = clampRow(Number(hit.dataset.row));
    const col = clampCol(Number(hit.dataset.col));
    const note = data.getStoredCell?.(row, col)?.comment?.trim();
    if (!note) {
      hideCommentPreview();
      return;
    }
    if (commentPreviewHideTimer !== null) {
      clearTimeout(commentPreviewHideTimer);
      commentPreviewHideTimer = null;
    }
    commentPreviewPop.textContent = note;
    commentPreviewPop.hidden = false;
    commentPreviewKey = cellKey(row, col);
    if (commentPreviewSourceHit && commentPreviewSourceHit !== hit) {
      commentPreviewSourceHit.setAttribute('aria-expanded', 'false');
    }
    commentPreviewSourceHit = hit;
    hit.setAttribute('aria-expanded', 'true');
    positionCommentPreview(hit);
    requestAnimationFrame(() => positionCommentPreview(hit));
  }

  function onCopyCapture(e: ClipboardEvent): void {
    if (!viewport.contains(e.target as Node)) return;
    if (shouldLetInputHandleCopy(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.clipboardData?.setData('text/plain', buildCopyPlainText());
  }

  function onPasteCapture(e: ClipboardEvent): void {
    if (!viewport.contains(e.target as Node)) return;
    const plain = e.clipboardData?.getData('text/plain') ?? '';
    if (shouldLetInputHandlePaste(e.target, plain)) return;
    if (plain === '') return;
    e.preventDefault();
    e.stopPropagation();
    applyPastedGrid(plain);
  }

  const gridInner = document.createElement('div');
  gridInner.className = 'sheet-grid-inner';
  gridInner.style.width = `${rowHeaderWidthPx + sheetTotalWidth}px`;

  const headerRow = document.createElement('div');
  headerRow.className = 'sheet-header-row';
  headerRow.style.width = '100%';

  const headerCorner = document.createElement('div');
  headerCorner.className = 'sheet-header-corner';
  headerCorner.style.width = `${rowHeaderWidthPx}px`;
  headerCorner.setAttribute('aria-hidden', 'true');
  headerRow.appendChild(headerCorner);

  for (let c = 0; c < columns.length; c++) {
    const h = document.createElement('div');
    h.className = 'sheet-column-header';
    if (columns[c]!.readOnly) h.classList.add('sheet-column-header--readonly');
    h.style.width = `${columnWidths[c]}px`;
    h.textContent = columns[c]!.header;
    headerRow.appendChild(h);
  }

  const gridBody = document.createElement('div');
  gridBody.className = 'sheet-grid-body';
  gridBody.style.height = `${sheetTotalHeight}px`;

  for (let row = 1; row <= rowCountTotal; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'sheet-row';
    rowEl.style.height = `${rowHeights[row - 1]}px`;
    rowEl.style.top = `${cumulativeRowHeights[row - 1]}px`;

    const rowGutter = document.createElement('div');
    rowGutter.className = 'sheet-row-gutter';
    rowGutter.style.flex = `0 0 ${rowHeaderWidthPx}px`;
    rowGutter.style.width = `${rowHeaderWidthPx}px`;
    rowGutter.textContent = String(row);
    rowGutter.dataset.row = String(row);
    rowGutter.setAttribute('aria-hidden', 'true');

    const rowCells = document.createElement('div');
    rowCells.className = 'sheet-row-cells';
    rowCells.style.width = `${sheetTotalWidth}px`;

    for (let col = 1; col <= columnCountTotal; col++) {
      const cell = document.createElement('div');
      cell.className = 'sheet-cell';
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.style.width = `${columnWidths[col - 1]}px`;
      cell.style.left = `${cumulativeColumnWidths[col - 1]}px`;

      const key = cellKey(row, col);
      const raw = data.get(row, col);
      const display = raw !== undefined ? String(raw) : '';

      const content = document.createElement('div');
      content.className = 'sheet-cell-content';
      applyCellDisplay(content, columnAt(col), display);

      const input = document.createElement('input');
      input.className = 'sheet-cell-input';
      input.type = 'text';
      input.autocomplete = 'off';
      const colDef = columnAt(col);
      if (columnValueType(colDef) === 'number') {
        input.inputMode = 'decimal';
      }
      if (isSelectColumn(colDef)) {
        input.dataset.sheetValueType = 'select';
      }
      input.value = display;
      if (colDef?.readOnly) {
        cell.classList.add('sheet-cell-readonly');
        input.readOnly = true;
        input.tabIndex = -1;
        input.setAttribute('aria-readonly', 'true');
      }

      applyCellInlineStyleRecord(cell, data.getCellStyle?.(row, col));

      if (row === active.row && col === active.col) {
        cell.classList.add('sheet-cell-active');
      }

      cell.append(content, input);
      cells.set(key, cell);
      updateCommentIndicator(row, col);
      rowCells.appendChild(cell);
    }
    rowEl.append(rowGutter, rowCells);
    gridBody.appendChild(rowEl);
  }

  const suggestPopover = document.createElement('div');
  suggestPopover.className = 'sheet-suggest-popover';
  suggestPopover.hidden = true;
  suggestPopover.setAttribute('role', 'listbox');
  const suggestScroll = document.createElement('div');
  suggestScroll.className = 'sheet-suggest-scroll';
  suggestPopover.appendChild(suggestScroll);

  let suggestionMatches: SpreadsheetSelectOption[] = [];
  let suggestionHighlight = -1;
  let blurHideTimer: ReturnType<typeof setTimeout> | null = null;

  function hideSuggestions(): void {
    if (blurHideTimer !== null) {
      clearTimeout(blurHideTimer);
      blurHideTimer = null;
    }
    suggestionHighlight = -1;
    suggestionMatches = [];
    suggestScroll.replaceChildren();
    suggestPopover.hidden = true;
    suggestPopover.classList.remove('sheet-suggest-popover--open');
  }

  function positionSuggestPopover(): void {
    const cell = cells.get(cellKey(active.row, active.col));
    if (!cell) return;
    const r = cell.getBoundingClientRect();
    suggestPopover.style.top = `${r.bottom + 2}px`;
    suggestPopover.style.left = `${r.left}px`;
    suggestPopover.style.minWidth = `${Math.max(r.width, 100)}px`;
  }

  function updateSuggestionHighlightClass(): void {
    const rows = suggestScroll.querySelectorAll('.sheet-suggest-row');
    rows.forEach((row, i) => {
      row.classList.toggle('sheet-suggest-row--active', i === suggestionHighlight);
      if (i === suggestionHighlight) {
        row.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function renderSuggestionRows(matches: SpreadsheetSelectOption[]): void {
    suggestScroll.replaceChildren();
    suggestionMatches = matches;
    for (let i = 0; i < matches.length; i++) {
      const row = document.createElement('div');
      row.className = 'sheet-suggest-row';
      row.setAttribute('role', 'option');
      row.dataset.index = String(i);
      const opt = matches[i]!;
      row.innerHTML = formatSelectOptionMarkup(opt, opt.label ?? opt.value);
      row.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        if (blurHideTimer !== null) {
          clearTimeout(blurHideTimer);
          blurHideTimer = null;
        }
        applySuggestionByIndex(i);
      });
      suggestScroll.appendChild(row);
    }
    updateSuggestionHighlightClass();
  }

  function showSuggestionsFromQuery(query: string): void {
    const col = columnAt(active.col);
    if (!isSelectColumn(col) || isReadOnlyCol(active.col)) {
      hideSuggestions();
      return;
    }
    const matches = filterSelectOptions(col, query);
    if (matches.length === 0) {
      hideSuggestions();
      return;
    }
    renderSuggestionRows(matches);
    positionSuggestPopover();
    suggestPopover.hidden = false;
    suggestPopover.classList.add('sheet-suggest-popover--open');
    updateSuggestionHighlightClass();
  }

  function applySuggestionByIndex(i: number): void {
    if (i < 0 || i >= suggestionMatches.length) return;
    const opt = suggestionMatches[i]!;
    const cell = cells.get(cellKey(active.row, active.col));
    const input = cell ? getCellEditor(cell) : null;
    if (!input) return;
    input.value = opt.value;
    hideSuggestions();
    input.focus();
  }

  function openFullSuggestionList(): void {
    const col = columnAt(active.col);
    if (!isSelectColumn(col) || isReadOnlyCol(active.col)) return;
    showSuggestionsFromQuery('');
    suggestionHighlight = suggestionMatches.length > 0 ? 0 : -1;
    updateSuggestionHighlightClass();
  }

  function suggestionKeysConsumed(e: KeyboardEvent): boolean {
    const ae = document.activeElement;
    if (!(ae instanceof HTMLInputElement) || ae.dataset.sheetValueType !== 'select') {
      return false;
    }
    const cellEl = ae.closest('.sheet-cell');
    if (!cellEl || !viewport.contains(cellEl)) return false;
    const r = clampRow(Number((cellEl as HTMLElement).dataset.row));
    const c = clampCol(Number((cellEl as HTMLElement).dataset.col));
    if (r !== active.row || c !== active.col) return false;

    const sheetMod = e.metaKey || e.ctrlKey;

    if (e.altKey && e.key === 'ArrowDown' && !sheetMod && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      openFullSuggestionList();
      return true;
    }

    if (suggestPopover.hidden) return false;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideSuggestions();
      return true;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (suggestionMatches.length > 0) {
        const i = suggestionHighlight >= 0 ? suggestionHighlight : 0;
        applySuggestionByIndex(i);
      }
      return true;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (suggestionHighlight >= 0) {
        applySuggestionByIndex(suggestionHighlight);
      } else {
        hideSuggestions();
      }
      setActive(active.row + 1, active.col);
      return true;
    }

    if (e.key === 'ArrowDown' && !sheetMod && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (suggestionMatches.length === 0) return true;
      if (suggestionHighlight < suggestionMatches.length - 1) suggestionHighlight++;
      else suggestionHighlight = 0;
      updateSuggestionHighlightClass();
      return true;
    }

    if (e.key === 'ArrowUp' && !sheetMod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (suggestionMatches.length === 0) return true;
      if (suggestionHighlight > 0) suggestionHighlight--;
      else suggestionHighlight = suggestionMatches.length - 1;
      updateSuggestionHighlightClass();
      return true;
    }

    return false;
  }

  commentPopover = document.createElement('div');
  commentPopover.className = 'sheet-comment-popover';
  commentPopover.hidden = true;
  commentPopover.setAttribute('role', 'dialog');
  commentPopover.setAttribute('aria-label', 'Cell comment');

  const commentHead = document.createElement('div');
  commentHead.className = 'sheet-comment-popover__head';
  commentHead.textContent = 'Comment';

  commentTextarea = document.createElement('textarea');
  commentTextarea.className = 'sheet-comment-popover__input';
  commentTextarea.rows = 4;
  commentTextarea.setAttribute('aria-multiline', 'true');

  const commentActions = document.createElement('div');
  commentActions.className = 'sheet-comment-popover__actions';

  const btnCommentRemove = document.createElement('button');
  btnCommentRemove.type = 'button';
  btnCommentRemove.className = 'sheet-comment-popover__btn sheet-comment-popover__btn--muted';
  btnCommentRemove.textContent = 'Remove';

  const btnCommentCancel = document.createElement('button');
  btnCommentCancel.type = 'button';
  btnCommentCancel.className = 'sheet-comment-popover__btn sheet-comment-popover__btn--muted';
  btnCommentCancel.textContent = 'Cancel';

  const btnCommentSave = document.createElement('button');
  btnCommentSave.type = 'button';
  btnCommentSave.className = 'sheet-comment-popover__btn sheet-comment-popover__btn--primary';
  btnCommentSave.textContent = 'Save';

  btnCommentRemove.addEventListener('click', () => {
    const anchor = commentEditorAnchor;
    if (!anchor) return;
    commitCommentAt(anchor.row, anchor.col, '');
    if (commentTextarea) commentTextarea.value = '';
    if (commentPopover) commentPopover.hidden = true;
    commentEditorAnchor = null;
    viewport.focus();
  });

  btnCommentCancel.addEventListener('click', () => closeCommentEditor(false));
  btnCommentSave.addEventListener('click', () => closeCommentEditor(true));

  commentTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCommentEditor(false);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      closeCommentEditor(true);
    }
  });

  commentActions.append(btnCommentRemove, btnCommentCancel, btnCommentSave);
  commentPopover.append(commentHead, commentTextarea, commentActions);
  commentPopover.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCommentEditor(false);
    }
  });

  gridInner.append(headerRow, gridBody);
  viewport.append(gridInner);
  root.append(viewport, suggestPopover, commentPopover, commentPreviewPop);
  container.appendChild(root);

  commentPreviewPop.addEventListener('pointerenter', () => {
    if (commentPreviewHideTimer !== null) {
      clearTimeout(commentPreviewHideTimer);
      commentPreviewHideTimer = null;
    }
  });
  commentPreviewPop.addEventListener('pointerleave', (e) => {
    const rel = e.relatedTarget as Node | null;
    if (rel && commentPreviewSourceHit && (rel === commentPreviewSourceHit || commentPreviewSourceHit.contains(rel))) {
      return;
    }
    scheduleHideCommentPreview();
  });

  viewport.addEventListener(
    'pointerover',
    (e) => {
      const hit = (e.target as HTMLElement).closest?.('.sheet-cell-comment-hit');
      if (!hit || !viewport.contains(hit)) return;
      showCommentPreviewFromHit(hit as HTMLButtonElement);
    },
    true,
  );

  viewport.addEventListener(
    'pointerout',
    (e) => {
      const hit = (e.target as HTMLElement).closest?.('.sheet-cell-comment-hit');
      if (!hit || !viewport.contains(hit)) return;
      const rel = e.relatedTarget as Node | null;
      if (rel && (hit.contains(rel) || commentPreviewPop.contains(rel))) return;
      scheduleHideCommentPreview();
    },
    true,
  );

  viewport.addEventListener(
    'click',
    (e) => {
      const hit = (e.target as HTMLElement).closest?.('.sheet-cell-comment-hit') as
        | HTMLButtonElement
        | null;
      if (!hit || !viewport.contains(hit)) return;
      if (!commentsEnabled) return;
      e.preventDefault();
      e.stopPropagation();
      const row = clampRow(Number(hit.dataset.row));
      const col = clampCol(Number(hit.dataset.col));
      hideCommentPreview();
      setActive(row, col);
      openCommentEditor();
    },
    true,
  );

  viewport.addEventListener('copy', onCopyCapture, true);
  viewport.addEventListener('paste', onPasteCapture, true);

  viewport.addEventListener('scroll', () => {
    if (!suggestPopover.hidden) positionSuggestPopover();
    if (commentPopover && !commentPopover.hidden && commentEditorAnchor) {
      positionCommentPopover(commentEditorAnchor.row, commentEditorAnchor.col);
    }
    if (!commentPreviewPop.hidden && commentPreviewSourceHit) {
      positionCommentPreview(commentPreviewSourceHit);
    }
  });

  viewport.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.sheetValueType !== 'select') return;
    const cellEl = t.closest('.sheet-cell');
    if (!cellEl) return;
    const row = clampRow(Number((cellEl as HTMLElement).dataset.row));
    const col = clampCol(Number((cellEl as HTMLElement).dataset.col));
    if (row !== active.row || col !== active.col) return;
    suggestionHighlight = -1;
    showSuggestionsFromQuery(t.value);
  });

  viewport.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.sheetValueType !== 'select') return;
    const cellEl = t.closest('.sheet-cell');
    if (!cellEl) return;
    const row = clampRow(Number((cellEl as HTMLElement).dataset.row));
    const col = clampCol(Number((cellEl as HTMLElement).dataset.col));
    if (row !== active.row || col !== active.col) return;
    showSuggestionsFromQuery(t.value);
  });

  viewport.addEventListener('focusout', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.sheetValueType !== 'select') return;
    const rt = e.relatedTarget as Node | null;
    if (rt && suggestPopover.contains(rt)) return;
    if (rt && commentPopover?.contains(rt)) return;
    if (rt && commentPreviewPop.contains(rt)) return;
    blurHideTimer = setTimeout(() => hideSuggestions(), 120);
  });

  function cellFromPoint(clientX: number, clientY: number): { row: number; col: number } | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const hit = el?.closest('.sheet-cell');
    if (!hit || !viewport.contains(hit)) return null;
    const cell = hit as HTMLElement;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
    return { row: clampRow(row), col: clampCol(col) };
  }

  function focusActiveInput(): void {
    if (isReadOnlyCol(active.col)) {
      setTimeout(() => viewport.focus(), 0);
      return;
    }
    const cell = cells.get(cellKey(active.row, active.col));
    const inp = cell ? getCellEditor(cell) : null;
    setTimeout(() => inp?.focus(), 0);
  }

  function blurActiveInput(): void {
    const cell = cells.get(cellKey(active.row, active.col));
    if (cell) getCellEditor(cell)?.blur();
  }

  function leaveEditorFocusSheet(): void {
    blurActiveInput();
    viewport.focus();
  }

  let lastSelectKeys = new Set<string>();
  let rangeConsumedEditorFocus = false;

  function exitRangeSelectionUi(): void {
    rangeConsumedEditorFocus = false;
  }

  function enterRangeSelectionUi(): void {
    if (!rangeConsumedEditorFocus) {
      leaveEditorFocusSheet();
      rangeConsumedEditorFocus = true;
    }
  }

  function syncSelectionHighlight(): void {
    const nextKeys = new Set<string>();
    if (selectArea.active) {
      const minRow = Math.min(selectArea.row, selectArea.rowEnd);
      const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
      const minCol = Math.min(selectArea.col, selectArea.colEnd);
      const maxCol = Math.max(selectArea.col, selectArea.colEnd);
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          nextKeys.add(cellKey(row, col));
        }
      }
    }
    for (const key of lastSelectKeys) {
      if (!nextKeys.has(key)) {
        cells.get(key)?.classList.remove('sheet-cell-select-area');
      }
    }
    for (const key of nextKeys) {
      if (!lastSelectKeys.has(key)) {
        cells.get(key)?.classList.add('sheet-cell-select-area');
      }
    }
    lastSelectKeys = nextKeys;
    notifySelectionChange();
  }

  function flushDragPaint(): void {
    if (dragRaf !== null) {
      cancelAnimationFrame(dragRaf);
      dragRaf = null;
    }
    if (dragPendingEnd !== null) {
      const p = dragPendingEnd;
      dragPendingEnd = null;
      applyDragRange(p.row, p.col);
    }
  }

  function scheduleDragPaint(): void {
    if (dragRaf !== null) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = null;
      if (!dragging) return;
      const p = dragPendingEnd;
      if (p === null) return;
      dragPendingEnd = null;
      applyDragRange(p.row, p.col);
      if (dragPendingEnd !== null) scheduleDragPaint();
    });
  }

  function collapseRange(): void {
    selectArea.row = active.row;
    selectArea.col = active.col;
    selectArea.rowEnd = active.row;
    selectArea.colEnd = active.col;
    selectArea.active = false;
    exitRangeSelectionUi();
    syncSelectionHighlight();
  }

  function setActive(row: number, col: number): void {
    row = clampRow(row);
    col = clampCol(col);

    if (active.row === row && active.col === col && !selectArea.active) {
      queueMicrotask(() => {
        if (isReadOnlyCol(col)) viewport.focus();
        else {
          const c = cells.get(cellKey(row, col));
          if (c) getCellEditor(c)?.focus();
        }
      });
      return;
    }

    hideSuggestions();
    exitRangeSelectionUi();
    selectArea.active = false;
    selectArea.row = row;
    selectArea.col = col;
    selectArea.rowEnd = row;
    selectArea.colEnd = col;
    syncSelectionHighlight();

    persistActiveInput();

    const prev = cells.get(cellKey(active.row, active.col));
    prev?.classList.remove('sheet-cell-active');

    active = { row, col };
    const next = cells.get(cellKey(row, col));
    next?.classList.add('sheet-cell-active');

    const inp = next ? getCellEditor(next) : null;
    if (inp) {
      const stored = data.get(row, col);
      inp.value = stored !== undefined ? String(stored) : '';
      if (isReadOnlyCol(col)) setTimeout(() => viewport.focus(), 0);
      else setTimeout(() => inp.focus(), 0);
    }
  }

  function applyDragRange(endRow: number, endCol: number): void {
    endRow = clampRow(endRow);
    endCol = clampCol(endCol);
    selectArea.row = dragAnchor.row;
    selectArea.col = dragAnchor.col;
    selectArea.rowEnd = endRow;
    selectArea.colEnd = endCol;
    const multi =
      selectArea.row !== selectArea.rowEnd || selectArea.col !== selectArea.colEnd;
    selectArea.active = multi;
    syncSelectionHighlight();
    if (multi) enterRangeSelectionUi();
  }

  function selectSheetRow(targetRow: number): void {
    const row = clampRow(targetRow);
    persistActiveInput();
    hideSuggestions();
    cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active');
    active = { row, col: 1 };
    const next = cells.get(cellKey(row, 1));
    next?.classList.add('sheet-cell-active');
    const inp = next ? getCellEditor(next) : null;
    if (inp) {
      const stored = data.get(row, 1);
      inp.value = stored !== undefined ? String(stored) : '';
    }
    selectArea.row = row;
    selectArea.col = 1;
    selectArea.rowEnd = row;
    selectArea.colEnd = columnCountTotal;
    selectArea.active = columnCountTotal > 1;
    syncSelectionHighlight();
    if (selectArea.active) {
      enterRangeSelectionUi();
    } else {
      exitRangeSelectionUi();
      if (isReadOnlyCol(1)) setTimeout(() => viewport.focus(), 0);
      else if (inp) setTimeout(() => inp.focus(), 0);
    }
    notifySelectionChange();
  }

  const contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'sheet-context-menu';
  contextMenuEl.setAttribute('role', 'menu');
  contextMenuEl.setAttribute('aria-label', 'Row actions');
  contextMenuEl.hidden = true;

  let contextMenuRow: number | null = null;

  function hideContextMenu(): void {
    contextMenuEl.hidden = true;
    contextMenuRow = null;
    document.removeEventListener('pointerdown', onContextMenuDocPointerDown, true);
    document.removeEventListener('keydown', onContextMenuDocKeydown, true);
    viewport.removeEventListener('scroll', hideContextMenu);
  }

  function onContextMenuDocPointerDown(ev: PointerEvent): void {
    if (contextMenuEl.contains(ev.target as Node)) return;
    hideContextMenu();
  }

  function onContextMenuDocKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') hideContextMenu();
  }

  function showContextMenu(clientX: number, clientY: number, row: number): void {
    hideContextMenu();
    contextMenuRow = row;
    contextMenuEl.hidden = false;
    const pad = 6;
    contextMenuEl.style.left = `${clientX}px`;
    contextMenuEl.style.top = `${clientY}px`;
    const r = contextMenuEl.getBoundingClientRect();
    let left = clientX;
    let top = clientY;
    if (left + r.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - r.width - pad);
    }
    if (top + r.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - r.height - pad);
    }
    contextMenuEl.style.left = `${left}px`;
    contextMenuEl.style.top = `${top}px`;
    document.addEventListener('pointerdown', onContextMenuDocPointerDown, true);
    document.addEventListener('keydown', onContextMenuDocKeydown, true);
    viewport.addEventListener('scroll', hideContextMenu, { passive: true });
  }

  function makeContextMenuItem(
    label: string,
    onActivate: () => void,
    iconPh: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sheet-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    const icon = document.createElement('i');
    icon.className = `ph ${iconPh}`;
    icon.setAttribute('aria-hidden', 'true');
    const labelEl = document.createElement('span');
    labelEl.className = 'sheet-context-menu__label';
    labelEl.textContent = label;
    btn.append(icon, labelEl);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onActivate();
      hideContextMenu();
    });
    return btn;
  }

  contextMenuEl.append(
    makeContextMenuItem('Delete row', () => {
      if (contextMenuRow !== null) clearSheetRow(contextMenuRow);
    }, 'ph-trash'),
    makeContextMenuItem('Copy row', () => {
      if (contextMenuRow === null) return;
      persistActiveInput();
      const text = buildRowPlainText(contextMenuRow);
      void navigator.clipboard?.writeText(text);
    }, 'ph-copy'),
    makeContextMenuItem('Select row', () => {
      if (contextMenuRow !== null) selectSheetRow(contextMenuRow);
    }, 'ph-rows'),
  );

  root.appendChild(contextMenuEl);

  viewport.addEventListener(
    'contextmenu',
    (e) => {
      const t = e.target as HTMLElement;
      const cell = t.closest('.sheet-cell');
      const gutter = t.closest('.sheet-row-gutter');
      let row: number | null = null;
      if (cell && viewport.contains(cell)) {
        row = clampRow(Number((cell as HTMLElement).dataset.row));
      } else if (gutter && viewport.contains(gutter)) {
        row = clampRow(Number((gutter as HTMLElement).dataset.row));
      }
      if (row === null || !Number.isFinite(row)) return;
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, row);
    },
    true,
  );

  function endPointerDrag(focusIfClick: boolean): void {
    viewport.classList.remove('sheet-viewport--dragging');
    dragging = false;
    dragPointerId = null;

    if (!dragMoved) {
      collapseRange();
      if (focusIfClick) focusActiveInput();
    } else if (selectArea.active) {
      /* focus already moved to viewport on first multi frame */
    } else {
      focusActiveInput();
    }
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const hit = target.closest('.sheet-cell');
    if (!hit || !viewport.contains(hit)) return;
    const cell = hit as HTMLElement;
    let row = Number(cell.dataset.row);
    let col = Number(cell.dataset.col);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    row = clampRow(row);
    col = clampCol(col);

    e.preventDefault();
    if (dragRaf !== null) {
      cancelAnimationFrame(dragRaf);
      dragRaf = null;
    }
    dragPendingEnd = null;
    exitRangeSelectionUi();

    dragging = true;
    dragMoved = false;
    dragPointerId = e.pointerId;
    dragAnchor = { row, col };
    viewport.classList.add('sheet-viewport--dragging');
    viewport.setPointerCapture(e.pointerId);

    selectArea.active = false;
    selectArea.row = row;
    selectArea.col = col;
    selectArea.rowEnd = row;
    selectArea.colEnd = col;
    syncSelectionHighlight();

    hideSuggestions();
    persistActiveInput();
    cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active');

    active = { row, col };
    const next = cells.get(cellKey(row, col));
    next?.classList.add('sheet-cell-active');
    const inp = next ? getCellEditor(next) : null;
    if (inp) {
      const stored = data.get(row, col);
      inp.value = stored !== undefined ? String(stored) : '';
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    const hit = cellFromPoint(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.row !== dragAnchor.row || hit.col !== dragAnchor.col) dragMoved = true;
    dragPendingEnd = hit;
    scheduleDragPaint();
  });

  viewport.addEventListener('pointerup', (e) => {
    if (e.pointerId !== dragPointerId) return;
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
    flushDragPaint();
    endPointerDrag(true);
  });

  viewport.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== dragPointerId) return;
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
    flushDragPaint();
    endPointerDrag(false);
  });

  function isOccupied(r: number, c: number): boolean {
    const v = data.get(r, c);
    if (v === undefined) return false;
    if (typeof v === 'number') return true;
    return String(v).trim().length > 0;
  }

  function jumpCol(r: number, c: number, directionRight: boolean): number {
    r = clampRow(r);
    c = clampCol(c);
    const step = directionRight ? 1 : -1;
    const limit = directionRight ? columnCountTotal : 1;

    if (!isOccupied(r, c)) {
      let j = c + step;
      while (directionRight ? j <= limit : j >= limit) {
        if (isOccupied(r, j)) return j;
        j += step;
      }
      return limit;
    }

    const neighbor = c + step;
    const outOfBounds = directionRight ? neighbor > limit : neighbor < limit;
    if (outOfBounds) return c;

    if (isOccupied(r, neighbor)) {
      let j = neighbor;
      while (true) {
        const next = j + step;
        const past = directionRight ? next > limit : next < limit;
        if (past) return j;
        if (!isOccupied(r, next)) return j;
        j = next;
      }
    }

    let j = neighbor;
    while (directionRight ? j <= limit : j >= limit) {
      if (isOccupied(r, j)) return j;
      j += step;
    }
    return limit;
  }

  function jumpRow(r: number, c: number, directionDown: boolean): number {
    r = clampRow(r);
    c = clampCol(c);
    const step = directionDown ? 1 : -1;
    const limit = directionDown ? rowCountTotal : 1;

    if (!isOccupied(r, c)) {
      let i = r + step;
      while (directionDown ? i <= limit : i >= limit) {
        if (isOccupied(i, c)) return i;
        i += step;
      }
      return limit;
    }

    const neighbor = r + step;
    const outOfBounds = directionDown ? neighbor > limit : neighbor < limit;
    if (outOfBounds) return r;

    if (isOccupied(neighbor, c)) {
      let i = neighbor;
      while (true) {
        const next = i + step;
        const past = directionDown ? next > limit : next < limit;
        if (past) return i;
        if (!isOccupied(next, c)) return i;
        i = next;
      }
    }

    let i = neighbor;
    while (directionDown ? i <= limit : i >= limit) {
      if (isOccupied(i, c)) return i;
      i += step;
    }
    return limit;
  }

  function handleSheetKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target || !viewport.contains(target)) return;

    if (suggestionKeysConsumed(e)) return;

    if (!commentPreviewPop.hidden && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideCommentPreview();
      return;
    }

    const sheetModEarly = e.metaKey || e.ctrlKey;
    if (commentsEnabled && e.key === 'F2' && e.shiftKey && !sheetModEarly && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openCommentEditor();
      return;
    }

    const hit = target.closest('.sheet-cell');
    const focusRowCol = hit
      ? {
          row: clampRow(Number((hit as HTMLElement).dataset.row)),
          col: clampCol(Number((hit as HTMLElement).dataset.col)),
        }
      : { row: active.row, col: active.col };

    const { row, col } = focusRowCol;
    const sheetMod = e.metaKey || e.ctrlKey;

    if (history && sheetMod && (e.key === 'z' || e.key === 'Z') && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (history && e.ctrlKey && !e.metaKey && (e.key === 'y' || e.key === 'Y') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      doRedo();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      hideSuggestions();
      collapseRange();
      focusActiveInput();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      hideSuggestions();
      setActive(row + 1, col);
      return;
    }

    if (e.key === 'Backspace' && selectArea.active) {
      e.preventDefault();
      const keys: string[] = [];
      doOnEverySelectedCell((cell) => {
        const r = clampRow(Number(cell.dataset.row));
        const c = clampCol(Number(cell.dataset.col));
        if (!isReadOnlyCol(c)) keys.push(cellKey(r, c));
      });
      const before = history && keys.length > 0 ? captureSnapshot(keys) : null;
      doOnEverySelectedCell((cell) => {
        const r = clampRow(Number(cell.dataset.row));
        const c = clampCol(Number(cell.dataset.col));
        if (isReadOnlyCol(c)) return;
        data.set(r, c, '');
        const contentEl = cell.querySelector<HTMLDivElement>('.sheet-cell-content')!;
        applyCellDisplay(contentEl, columnAt(c), '');
        getCellEditor(cell)!.value = '';
        syncCellChrome(r, c);
      });
      if (history && before) {
        const after = captureSnapshot(keys);
        pushHistoryIfChanged(before, after);
      }
      exitRangeSelectionUi();
      syncSelectionHighlight();
      return;
    }

    if (sheetMod && e.shiftKey) {
      if (
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowLeft' &&
        e.key !== 'ArrowRight'
      ) {
        return;
      }
      e.preventDefault();
      if (!selectArea.active) {
        const ar = row;
        const ac = col;
        selectArea.row = ar;
        selectArea.col = ac;
        selectArea.rowEnd = ar;
        selectArea.colEnd = ac;
      }
      selectArea.active = true;
      const cr = selectArea.rowEnd;
      const cc = selectArea.colEnd;
      if (e.key === 'ArrowUp') selectArea.rowEnd = jumpRow(cr, cc, false);
      else if (e.key === 'ArrowDown') selectArea.rowEnd = jumpRow(cr, cc, true);
      else if (e.key === 'ArrowLeft') selectArea.colEnd = jumpCol(cr, cc, false);
      else if (e.key === 'ArrowRight') selectArea.colEnd = jumpCol(cr, cc, true);

      const minRow = Math.min(selectArea.row, selectArea.rowEnd);
      const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
      const minCol = Math.min(selectArea.col, selectArea.colEnd);
      const maxCol = Math.max(selectArea.col, selectArea.colEnd);
      const multi = minRow !== maxRow || minCol !== maxCol;

      if (!multi) {
        selectArea.active = false;
        selectArea.row = minRow;
        selectArea.col = minCol;
        selectArea.rowEnd = minRow;
        selectArea.colEnd = minCol;
        exitRangeSelectionUi();
        syncSelectionHighlight();
        focusActiveInput();
        return;
      }

      syncSelectionHighlight();
      enterRangeSelectionUi();
      return;
    }

    if (e.shiftKey) {
      if (
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowLeft' &&
        e.key !== 'ArrowRight'
      ) {
        return;
      }
      e.preventDefault();
      if (!selectArea.active) {
        const ar = row;
        const ac = col;
        selectArea.row = ar;
        selectArea.col = ac;
        selectArea.rowEnd = ar;
        selectArea.colEnd = ac;
      }
      selectArea.active = true;
      if (e.key === 'ArrowUp') selectArea.rowEnd = clampRow(selectArea.rowEnd - 1);
      else if (e.key === 'ArrowDown') selectArea.rowEnd = clampRow(selectArea.rowEnd + 1);
      else if (e.key === 'ArrowLeft') selectArea.colEnd = clampCol(selectArea.colEnd - 1);
      else if (e.key === 'ArrowRight') selectArea.colEnd = clampCol(selectArea.colEnd + 1);

      const minRow = Math.min(selectArea.row, selectArea.rowEnd);
      const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
      const minCol = Math.min(selectArea.col, selectArea.colEnd);
      const maxCol = Math.max(selectArea.col, selectArea.colEnd);
      const multi = minRow !== maxRow || minCol !== maxCol;

      if (!multi) {
        selectArea.active = false;
        selectArea.row = minRow;
        selectArea.col = minCol;
        selectArea.rowEnd = minRow;
        selectArea.colEnd = minCol;
        exitRangeSelectionUi();
        syncSelectionHighlight();
        focusActiveInput();
        return;
      }

      syncSelectionHighlight();
      enterRangeSelectionUi();
      return;
    }

    if (sheetMod) {
      if (
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowLeft' &&
        e.key !== 'ArrowRight'
      ) {
        return;
      }
      e.preventDefault();
      let nr = row;
      let nc = col;
      if (e.key === 'ArrowUp') nr = jumpRow(row, col, false);
      else if (e.key === 'ArrowDown') nr = jumpRow(row, col, true);
      else if (e.key === 'ArrowLeft') nc = jumpCol(row, col, false);
      else if (e.key === 'ArrowRight') nc = jumpCol(row, col, true);
      setActive(nr, nc);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(row - 1, col);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(row + 1, col);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive(row, col - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setActive(row, col + 1);
    }
  }

  viewport.addEventListener('keydown', handleSheetKeydown, true);

  viewport.addEventListener(
    'input',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !t.classList.contains('sheet-cell-input')) return;
      const cell = t.closest('.sheet-cell');
      if (!cell) return;
      const row = Number((cell as HTMLElement).dataset.row);
      const col = Number((cell as HTMLElement).dataset.col);
      if (!Number.isFinite(row) || !Number.isFinite(col)) return;
      clearCellPersistError(row, col);
    },
    true,
  );

  if (history) {
    history.subscribe(notifyHistoryChange);
  }

  if (config.initialSelection) {
    syncSelectionHighlight();
    focusActiveInput();
    queueMicrotask(() => {
      cells.get(cellKey(active.row, active.col))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  const handle: SpreadsheetMountHandle = {
    historyEnabled,
    commentsEnabled,
    openCommentEditor,
    mergeCellStyleOnSelection,
    mergeCellStyleOnEachTarget,
    everyTargetCellStyle,
    getCellStyleAt(row, col) {
      return data.getCellStyle?.(row, col);
    },
    subscribeSelectionChange(cb) {
      selectionChangeListeners.add(cb);
      return () => selectionChangeListeners.delete(cb);
    },
    undo: () => doUndo(),
    redo: () => doRedo(),
    canUndo: () => history?.canUndo() ?? false,
    canRedo: () => history?.canRedo() ?? false,
    subscribeHistoryChange(cb) {
      historyChangeListeners.add(cb);
      return () => historyChangeListeners.delete(cb);
    },
    runHistoryBatch(fn) {
      if (history) history.runBatch(fn);
      else fn();
    },
    beginHistoryBatch() {
      history?.beginBatch();
    },
    endHistoryBatch() {
      history?.endBatch();
    },
    applyExternalValue,
    getCollabPresencePayload,
    setRemoteCollabPresence,
    showCellPersistError,
    replayClipboardPaste: applyPastedGrid,
  };

  return handle;
}
