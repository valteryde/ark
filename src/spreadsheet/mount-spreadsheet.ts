import '../sheet.css';

import { applyCellDisplay, applyCellInlineStyleRecord, getCellEditor } from './cell-dom.ts';
import { formatSelectOptionMarkup } from './cell-display.ts';
import {
  cellPlainTextForSearch,
  columnValueType,
  filterSelectOptions,
  isSelectColumn,
  parseCommittedCellValue,
  resolveSelectLabel,
} from './cell-value.ts';
import {
  escapeTsvField,
  getInternalClipboardPlain,
  parseClipboardRows,
  parseHtmlClipboardTable,
  setInternalClipboardPlain,
} from './clipboard.ts';
import {
  clampColumnWidth,
  persistColumnWidths,
  readPersistedColumnWidths,
} from './column-width.ts';
import {
  clampToVisibleColumn,
  firstVisibleColumnIndex,
  isHiddenColumn,
  isVisibleColumn,
  lastVisibleColumnIndex,
  stepVisibleColumn,
  sumVisibleColumnWidths,
  visibleColumnCount,
} from './column-visibility.ts';
import { cellKey } from './data-store.ts';
import { cellMapsEqual, createSpreadsheetHistory, type HistoryCellMap } from './history.ts';
import { jumpToEdge } from './navigation.ts';
import { createPersistErrorController } from './persist-error.ts';
import { createRowContextMenu } from './row-context-menu.ts';
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

/** Mount a configurable spreadsheet. Tear down by removing `container` children if remounting. */
export function mountSpreadsheet(
  container: HTMLElement,
  config: SpreadsheetConfig,
): SpreadsheetMountHandle {
  const columns = config.columns;
  const dataColumnCount = columns.length;
  const dataRowCount = config.rowCount;
  const ghostRowCount = Math.max(
    0,
    Math.min(
      10_000,
      Math.floor(
        typeof config.ghostRowCount === 'number' && Number.isFinite(config.ghostRowCount)
          ? config.ghostRowCount
          : 0,
      ),
    ),
  );
  const mountedRowCount = dataRowCount + ghostRowCount;
  function isGhostRow(row: number): boolean {
    return row > dataRowCount;
  }
  const defaultRowHeight = config.defaultRowHeightPx ?? 28;
  const rowHeights = Array.from({ length: mountedRowCount }, () => defaultRowHeight);
  const columnWidthPersistenceKey = config.columnWidthPersistenceKey;
  const columnWidths = columns.map((c) => clampColumnWidth(c.widthPx));
  const persistedWidths = readPersistedColumnWidths(columnWidthPersistenceKey, columns.length);
  if (persistedWidths) {
    for (let i = 0; i < columnWidths.length; i++) {
      columnWidths[i] = persistedWidths[i]!;
    }
  }
  let dataSheetTotalWidth = sumVisibleColumnWidths(columns, columnWidths);

  const ghostColumnsEnabled =
    dataColumnCount > 0 &&
    config.enableGhostColumns !== false &&
    typeof ResizeObserver === 'function';
  const ghostColumnWidthPx = Math.round(
    Math.min(400, Math.max(24, config.ghostColumnWidthPx ?? 72)),
  );
  const maxGhostColumns = Math.min(
    500,
    Math.max(0, Math.floor(config.maxGhostColumns ?? 80)),
  );

  let ghostColumnCount = 0;
  let cumulativeColumnWidths: number[] = [];
  let mountedSheetCellsWidth = dataSheetTotalWidth;

  function widthOfMountedCol1Based(i: number): number {
    if (i <= dataColumnCount) {
      if (isHiddenColumn(columns, i)) return 0;
      return columnWidths[i - 1]!;
    }
    return ghostColumnWidthPx;
  }

  function rebuildCumulativeColumnWidthsAndMountedWidth(): void {
    const m = dataColumnCount + ghostColumnCount;
    cumulativeColumnWidths = Array.from({ length: m }, () => 0);
    for (let i = 1; i < m; i++) {
      cumulativeColumnWidths[i] = cumulativeColumnWidths[i - 1]! + widthOfMountedCol1Based(i);
    }
    let t = 0;
    for (let i = 1; i <= m; i++) t += widthOfMountedCol1Based(i);
    mountedSheetCellsWidth = t;
  }

  rebuildCumulativeColumnWidthsAndMountedWidth();

  const cumulativeRowHeights: number[] = Array.from({ length: mountedRowCount }, () => 0);
  for (let i = 1; i < mountedRowCount; i++) {
    cumulativeRowHeights[i] = cumulativeRowHeights[i - 1]! + rowHeights[i - 1]!;
  }
  const sheetTotalHeight = rowHeights.reduce((a, b) => a + b, 0);
  /** Fixed gutter for row indices; added to horizontal extent and cell `left` offsets. */
  const rowHeaderWidthPx = 48;

  const data = config.data;
  const { growRowCountForPaste, suppressOutboundSyncDuring, onRowDeleted } = config;

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
    if (isGhostRow(row)) return;
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
    if (row < 1 || row > dataRowCount || col < 1 || col > dataColumnCount) return false;
    if (isHiddenCol(col)) {
      data.set(row, col, value);
      return true;
    }
    if (!cells.has(cellKey(row, col))) return false;
    data.set(row, col, value);
    hydrateCellFromStore(row, col);
    persistError.clear(row, col);
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

  type CopyMarqueeBounds = {
    minRow: number;
    maxRow: number;
    minCol: number;
    maxCol: number;
  };
  let copyMarquee: CopyMarqueeBounds | null = null;
  let copyMarqueeEl: HTMLDivElement | null = null;
  /** Solid border drawn around the whole active multi-cell selection. */
  let selectionOutlineEl: HTMLDivElement | null = null;
  /** Visually-hidden polite live region announcing the active cell for screen readers. */
  let srAnnounceEl: HTMLDivElement | null = null;

  function syncCopyMarqueeLayout(): void {
    if (!copyMarqueeEl || !copyMarquee) {
      if (copyMarqueeEl) copyMarqueeEl.hidden = true;
      return;
    }
    const { minRow, maxRow, minCol, maxCol } = copyMarquee;
    const top = cumulativeRowHeights[minRow - 1]!;
    const left = rowHeaderWidthPx + cumulativeColumnWidths[minCol - 1]!;
    const right =
      rowHeaderWidthPx + cumulativeColumnWidths[maxCol - 1]! + columnWidths[maxCol - 1]!;
    const bottom = cumulativeRowHeights[maxRow - 1]! + rowHeights[maxRow - 1]!;
    copyMarqueeEl.style.top = `${top}px`;
    copyMarqueeEl.style.left = `${left}px`;
    copyMarqueeEl.style.width = `${Math.max(0, right - left)}px`;
    copyMarqueeEl.style.height = `${Math.max(0, bottom - top)}px`;
    copyMarqueeEl.hidden = false;
  }

  function syncSelectionOutlineLayout(): void {
    if (!selectionOutlineEl) return;
    if (!selectArea.active) {
      selectionOutlineEl.hidden = true;
      return;
    }
    const minRow = Math.min(selectArea.row, selectArea.rowEnd);
    const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
    const minCol = Math.min(selectArea.col, selectArea.colEnd);
    const maxCol = Math.max(selectArea.col, selectArea.colEnd);
    // When a copy marquee covers the exact same range, let its marching-ants
    // animation show through instead of painting a static border over it.
    if (
      copyMarquee &&
      copyMarquee.minRow === minRow &&
      copyMarquee.maxRow === maxRow &&
      copyMarquee.minCol === minCol &&
      copyMarquee.maxCol === maxCol
    ) {
      selectionOutlineEl.hidden = true;
      return;
    }
    const top = cumulativeRowHeights[minRow - 1]!;
    const left = rowHeaderWidthPx + cumulativeColumnWidths[minCol - 1]!;
    const right =
      rowHeaderWidthPx + cumulativeColumnWidths[maxCol - 1]! + columnWidths[maxCol - 1]!;
    const bottom = cumulativeRowHeights[maxRow - 1]! + rowHeights[maxRow - 1]!;
    selectionOutlineEl.style.top = `${top}px`;
    selectionOutlineEl.style.left = `${left}px`;
    selectionOutlineEl.style.width = `${Math.max(0, right - left)}px`;
    selectionOutlineEl.style.height = `${Math.max(0, bottom - top)}px`;
    selectionOutlineEl.hidden = false;
  }

  function setCopyMarquee(bounds: CopyMarqueeBounds): void {
    copyMarquee = bounds;
    syncCopyMarqueeLayout();
    syncSelectionOutlineLayout();
  }

  function setCopyMarqueeFromSelection(): void {
    if (selectArea.active) {
      setCopyMarquee({
        minRow: Math.min(selectArea.row, selectArea.rowEnd),
        maxRow: Math.max(selectArea.row, selectArea.rowEnd),
        minCol: Math.min(selectArea.col, selectArea.colEnd),
        maxCol: Math.max(selectArea.col, selectArea.colEnd),
      });
      return;
    }
    setCopyMarquee({
      minRow: active.row,
      maxRow: active.row,
      minCol: active.col,
      maxCol: active.col,
    });
  }

  function clearCopyMarquee(): void {
    copyMarquee = null;
    if (copyMarqueeEl) copyMarqueeEl.hidden = true;
    syncSelectionOutlineLayout();
  }

  const cells = new Map<string, HTMLDivElement>();
  let active = { row: 1, col: 1 };
  /**
   * Excel/Sheets-style navigation-vs-edit toggle. Navigation mode (false) is
   * the default after movement: the active cell renders its display content,
   * keyboard focus stays on the viewport, and copy/paste/range gestures behave
   * as if no editor were open. Edit mode (true) is entered via F2,
   * double-click, or typing a printable key — the active cell swaps to its
   * `<input>` (via the `sheet-cell-editing` class), gets focus, and edits the
   * text buffer until Escape/Tab/Enter commit or cancel.
   */
  let editMode = false;
  /**
   * When the user moves with Tab/Shift+Tab, we remember the column they started
   * in so a subsequent Enter returns to it on the next row (standard
   * spreadsheet behavior). Any non-Tab navigation clears this anchor.
   */
  let tabAnchorCol: number | null = null;

  const persistError = createPersistErrorController({ cells, dataRowCount, dataColumnCount });

  let remotePresenceList: RemoteCollabPeer[] = [];
  const presenceChipEls = new Map<string, HTMLDivElement>();
  /** Cap chips per cell; remaining peers collapse into a "+N" badge. */
  const PRESENCE_CHIP_MAX = 3;
  const PHOSPHOR_NAME_RX = /^[a-z0-9-]+$/;

  function clearRemotePresenceDecor(): void {
    for (const el of cells.values()) {
      el.classList.remove('sheet-cell--remote-presence');
      el.style.removeProperty('--remote-collab-hue');
    }
    for (const chip of presenceChipEls.values()) {
      chip.remove();
    }
    presenceChipEls.clear();
  }

  function renderPresenceChips(peers: readonly RemoteCollabPeer[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-cell-presence-chips';
    wrap.setAttribute('aria-hidden', 'true');
    const shown = peers.slice(0, PRESENCE_CHIP_MAX);
    for (const p of shown) {
      const chip = document.createElement('span');
      chip.className = 'sheet-cell-presence-chip';
      chip.style.setProperty('--peer-hue', String(p.markerHue));
      const label = p.peerLabel?.trim();
      if (label) chip.title = label;
      const iconName = p.peerIcon?.trim().toLowerCase();
      if (iconName && PHOSPHOR_NAME_RX.test(iconName) && iconName.length <= 48) {
        const i = document.createElement('i');
        i.className = `ph ph-${iconName}`;
        i.setAttribute('aria-hidden', 'true');
        chip.appendChild(i);
      } else if (label) {
        chip.textContent = label.charAt(0).toUpperCase();
      }
      wrap.appendChild(chip);
    }
    const overflow = peers.length - shown.length;
    if (overflow > 0) {
      const more = document.createElement('span');
      more.className = 'sheet-cell-presence-chip sheet-cell-presence-chip--more';
      more.textContent = `+${overflow}`;
      wrap.appendChild(more);
    }
    return wrap;
  }

  function paintRemotePresenceOverlays(): void {
    clearRemotePresenceDecor();
    const byKey = new Map<string, RemoteCollabPeer[]>();
    for (const p of remotePresenceList) {
      if (p.row > dataRowCount || p.col > dataColumnCount) continue;
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
      const chips = renderPresenceChips(plist);
      el.appendChild(chips);
      presenceChipEls.set(k, chips);
    }
  }

  function getCollabPresencePayload(): CollabPresencePayload | null {
    if (dataRowCount < 1 || dataColumnCount < 1) return null;
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
  /** Last pointer position observed during an active drag, in client coords;
   *  used by the edge-autoscroll loop to keep growing the selection while the
   *  cursor sits past the viewport. */
  let dragLastPointer: { clientX: number; clientY: number } | null = null;
  let autoScrollRaf: number | null = null;

  function clampRow(row: number): number {
    return Math.max(1, Math.min(dataRowCount, row));
  }

  function clampCol(col: number): number {
    return Math.max(1, Math.min(dataColumnCount, col));
  }

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;
  let zoomFactor = 1;
  const zoomChangeListeners = new Set<() => void>();

  function notifyZoomChange(): void {
    for (const fn of zoomChangeListeners) fn();
  }

  function getZoom(): number {
    return zoomFactor;
  }

  function setZoom(factor: number): number {
    const clamped = Number.isFinite(factor)
      ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor))
      : 1;
    const rounded = Math.round(clamped * 100) / 100;
    if (rounded === zoomFactor) return zoomFactor;
    zoomFactor = rounded;
    // Scale the grid content only; popovers are siblings positioned via scaled rects.
    gridInner.style.setProperty('zoom', String(zoomFactor));
    syncGhostColumnsToViewport();
    notifyZoomChange();
    return zoomFactor;
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

  function isHiddenCol(col: number): boolean {
    return isHiddenColumn(columns, col);
  }

  function isVisibleCol(col: number): boolean {
    return isVisibleColumn(columns, col);
  }

  function firstVisibleCol(): number {
    return firstVisibleColumnIndex(columns);
  }

  function lastVisibleCol(): number {
    return lastVisibleColumnIndex(columns);
  }

  function clampColVisible(col: number): number {
    return clampToVisibleColumn(columns, clampCol(col));
  }

  function stepVisibleCol(col: number, delta: number): number {
    return stepVisibleColumn(columns, clampCol(col), delta);
  }

  active.col = clampColVisible(active.col);
  selectArea.col = active.col;
  selectArea.colEnd = active.col;

  function isReadOnlyCol(col: number): boolean {
    if (col > dataColumnCount) return true;
    return columnAt(col)?.readOnly === true;
  }

  function persistActiveInput(): void {
    if (!editMode) return;
    if (isGhostRow(active.row) || isReadOnlyCol(active.col)) return;
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
      const vt = columnValueType(col);
      showInputRejectedHint(
        active.row,
        active.col,
        vt === 'number' ? 'Enter a number' : 'Pick a value from the list',
      );
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
        if (isGhostRow(row)) continue;
        for (let col = minCol; col <= maxCol; col++) {
          if (!isReadOnlyCol(col)) out.push({ row, col });
        }
      }
      return out;
    }
    if (!isGhostRow(active.row) && !isReadOnlyCol(active.col)) out.push({ row: active.row, col: active.col });
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

  function getPasteAnchor(): { row: number; col: number } {
    if (selectArea.active) {
      return {
        row: Math.min(selectArea.row, selectArea.rowEnd),
        col: Math.min(selectArea.col, selectArea.colEnd),
      };
    }
    return { row: active.row, col: active.col };
  }

  function formatCellValueForClipboard(row: number, col: number): string {
    const v = data.get(row, col);
    if (v === undefined) return '';
    const colDef = columnAt(col);
    if (isSelectColumn(colDef)) {
      return resolveSelectLabel(colDef, String(v));
    }
    return String(v);
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
          if (isHiddenCol(c)) continue;
          parts.push(escapeTsvField(formatCellValueForClipboard(r, c)));
        }
        lines.push(parts.join('\t'));
      }
      return lines.join('\n');
    }
    return formatCellValueForClipboard(active.row, active.col);
  }

  function buildRowPlainText(targetRow: number): string {
    const r = clampRow(targetRow);
    const parts: string[] = [];
    for (let c = 1; c <= dataColumnCount; c++) {
      if (isHiddenCol(c)) continue;
      parts.push(escapeTsvField(formatCellValueForClipboard(r, c)));
    }
    return parts.join('\t');
  }

  function mutateClearWritableCellsInRow(targetRow: number): void {
    if (!data.replaceCell) return;
    const row = clampRow(targetRow);
    const keys: string[] = [];
    for (let col = 1; col <= dataColumnCount; col++) {
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
  }

  function clearSheetRow(targetRow: number): void {
    if (!data.replaceCell) return;
    const tr = Math.trunc(targetRow);
    if (!Number.isFinite(tr) || tr < 1 || tr > dataRowCount) return;
    const row = tr;
    persistActiveInput();
    let anyWritable = false;
    for (let col = 1; col <= dataColumnCount; col++) {
      if (!isReadOnlyCol(col)) {
        anyWritable = true;
        break;
      }
    }
    if (!anyWritable) return;
    const runMutate = () => mutateClearWritableCellsInRow(row);
    if (suppressOutboundSyncDuring) {
      suppressOutboundSyncDuring(runMutate);
    } else {
      runMutate();
    }
    onRowDeleted?.(row);
    notifySelectionChange();
  }

  function applyRemoteRowClear(targetRow: number): void {
    if (!data.replaceCell) return;
    const r = Math.trunc(targetRow);
    if (!Number.isFinite(r) || r < 1 || r > dataRowCount) return;
    persistActiveInput();
    mutateClearWritableCellsInRow(r);
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
        if (r < 1 || r > dataRowCount || c < 1 || c > dataColumnCount) continue;
        if (isReadOnlyCol(c)) continue;
        keys.push(cellKey(r, c));
      }
    }
    return keys;
  }

  function applyPastedGrid(plain: string): void {
    const grid = parseClipboardRows(plain);
    if (grid.length === 0) return;

    clearCopyMarquee();
    hideSuggestions();
    persistActiveInput();

    const anchor = getPasteAnchor();
    const maxR = anchor.row + grid.length - 1;
    if (maxR > dataRowCount && growRowCountForPaste) {
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
        if (r < 1 || r > dataRowCount || c < 1 || c > dataColumnCount) continue;
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
  viewport.setAttribute('role', 'grid');
  viewport.setAttribute('aria-label', 'Spreadsheet');
  viewport.setAttribute('aria-rowcount', String(dataRowCount + 1));
  viewport.setAttribute('aria-colcount', String(visibleColumnCount(columns)));

  srAnnounceEl = document.createElement('div');
  srAnnounceEl.className = 'sheet-sr-live';
  srAnnounceEl.setAttribute('aria-live', 'polite');
  srAnnounceEl.setAttribute('aria-atomic', 'true');

  const inputHintEl = document.createElement('div');
  inputHintEl.className = 'sheet-input-hint';
  inputHintEl.setAttribute('role', 'status');
  inputHintEl.hidden = true;
  let inputHintTimer: ReturnType<typeof setTimeout> | null = null;

  function hideInputHint(): void {
    if (inputHintTimer !== null) {
      clearTimeout(inputHintTimer);
      inputHintTimer = null;
    }
    inputHintEl.hidden = true;
    inputHintEl.classList.remove('sheet-input-hint--visible');
  }

  function showInputRejectedHint(row: number, col: number, message: string): void {
    const cell = cells.get(cellKey(row, col));
    if (!cell) return;
    if (inputHintTimer !== null) clearTimeout(inputHintTimer);
    inputHintEl.textContent = message;
    inputHintEl.hidden = false;
    inputHintEl.classList.add('sheet-input-hint--visible');
    const r = cell.getBoundingClientRect();
    const margin = 8;
    inputHintEl.style.left = '0px';
    inputHintEl.style.top = '0px';
    const hw = inputHintEl.offsetWidth;
    let left = r.left;
    if (left + hw > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - hw);
    }
    inputHintEl.style.left = `${Math.round(left)}px`;
    inputHintEl.style.top = `${Math.round(r.bottom + 4)}px`;
    inputHintTimer = window.setTimeout(hideInputHint, 2200);
  }

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
    const text = buildCopyPlainText();
    e.clipboardData?.setData('text/plain', text);
    setInternalClipboardPlain(text);
    setCopyMarqueeFromSelection();
  }

  function onPasteCapture(e: ClipboardEvent): void {
    if (!viewport.contains(e.target as Node)) return;
    const plain = e.clipboardData?.getData('text/plain') ?? '';
    if (shouldLetInputHandlePaste(e.target, plain)) return;
    let payload = plain;
    if (payload === '') {
      const html = e.clipboardData?.getData('text/html') ?? '';
      const fromHtml = parseHtmlClipboardTable(html);
      if (fromHtml) payload = fromHtml;
    }
    if (payload === '') payload = getInternalClipboardPlain();
    if (payload === '') return;
    e.preventDefault();
    e.stopPropagation();
    applyPastedGrid(payload);
  }

  function clearWritableCellsInActiveRange(): void {
    const keys: string[] = [];
    if (selectArea.active) {
      const minRow = Math.min(selectArea.row, selectArea.rowEnd);
      const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
      const minCol = Math.min(selectArea.col, selectArea.colEnd);
      const maxCol = Math.max(selectArea.col, selectArea.colEnd);
      for (let r = minRow; r <= maxRow; r++) {
        if (r < 1 || r > dataRowCount) continue;
        for (let c = minCol; c <= maxCol; c++) {
          if (c < 1 || c > dataColumnCount) continue;
          if (isReadOnlyCol(c)) continue;
          keys.push(cellKey(r, c));
        }
      }
    } else if (!isReadOnlyCol(active.col) && !isGhostRow(active.row)) {
      keys.push(cellKey(active.row, active.col));
    }
    if (keys.length === 0) return;
    const before = history ? captureSnapshot(keys) : null;
    for (const k of keys) {
      const { row: r, col: c } = keyToRowCol(k);
      data.set(r, c, '');
      const cellEl = cells.get(k);
      if (cellEl) {
        const contentEl = cellEl.querySelector<HTMLDivElement>('.sheet-cell-content');
        if (contentEl) applyCellDisplay(contentEl, columnAt(c), '');
        const inp = getCellEditor(cellEl);
        if (inp) inp.value = '';
        syncCellChrome(r, c);
      }
    }
    if (history && before) {
      const after = captureSnapshot(keys);
      pushHistoryIfChanged(before, after);
    }
  }

  function onCutCapture(e: ClipboardEvent): void {
    if (!viewport.contains(e.target as Node)) return;
    if (shouldLetInputHandleCopy(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const text = buildCopyPlainText();
    e.clipboardData?.setData('text/plain', text);
    setInternalClipboardPlain(text);
    setCopyMarqueeFromSelection();
    clearWritableCellsInActiveRange();
    syncSelectionHighlight();
  }

  function writeClipboardText(text: string): void {
    // Always keep an in-app buffer so copy/paste still works when the system
    // clipboard is blocked (permission denied, iframe policy, etc.).
    setInternalClipboardPlain(text);
    // Prefer a synchronous execCommand copy while we still have the user gesture.
    // Chrome often exposes clipboard.writeText but rejects it (cross-origin iframes
    // without allow="clipboard-write", Permissions-Policy, etc.); Firefox is more
    // permissive. Falling back after a rejected Promise is too late — the gesture
    // is already gone — so try the sync path first.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.setAttribute('aria-hidden', 'true');
    ta.dataset.arkClipboard = '1';
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      /* unsupported */
    }
    ta.remove();
    if (previouslyFocused && previouslyFocused.isConnected) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        previouslyFocused.focus();
      }
    }
    if (copied) return;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  async function readClipboardPayloadForPaste(): Promise<string> {
    const clip = navigator.clipboard;
    if (clip?.read) {
      try {
        const items = await clip.read();
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            const plain = await (await item.getType('text/plain')).text();
            if (plain) return plain;
          }
        }
        for (const item of items) {
          if (item.types.includes('text/html')) {
            const html = await (await item.getType('text/html')).text();
            const fromHtml = parseHtmlClipboardTable(html);
            if (fromHtml) return fromHtml;
          }
        }
      } catch {
        /* fall through to readText */
      }
    }
    if (clip?.readText) {
      try {
        const plain = await clip.readText();
        if (plain) return plain;
      } catch {
        /* unsupported or denied */
      }
    }
    return getInternalClipboardPlain();
  }

  const gridInner = document.createElement('div');
  gridInner.className = 'sheet-grid-inner';
  gridInner.style.width = `${rowHeaderWidthPx + mountedSheetCellsWidth}px`;

  const headerRow = document.createElement('div');
  headerRow.className = 'sheet-header-row';
  headerRow.style.width = '100%';
  headerRow.setAttribute('role', 'row');
  headerRow.setAttribute('aria-rowindex', '1');

  const headerCorner = document.createElement('div');
  headerCorner.className = 'sheet-header-corner';
  headerCorner.style.width = `${rowHeaderWidthPx}px`;
  headerCorner.setAttribute('aria-hidden', 'true');
  headerRow.appendChild(headerCorner);

  const dataColumnHeaderEls: (HTMLDivElement | undefined)[] = [];
  const columnResizeEnabled = columnWidthPersistenceKey !== undefined;
  for (let c = 0; c < columns.length; c++) {
    if (columns[c]!.hidden) {
      dataColumnHeaderEls[c] = undefined;
      continue;
    }
    const h = document.createElement('div');
    h.className = 'sheet-column-header';
    if (columns[c]!.readOnly) h.classList.add('sheet-column-header--readonly');
    h.style.width = `${columnWidths[c]}px`;
    h.dataset.col = String(c + 1);
    h.setAttribute('role', 'columnheader');
    h.setAttribute('aria-colindex', String(c + 1));

    const headerLabel = document.createElement('span');
    headerLabel.className = 'sheet-column-header-label';
    headerLabel.textContent = columns[c]!.header;
    h.appendChild(headerLabel);

    if (columnResizeEnabled) {
      const grip = document.createElement('div');
      grip.className = 'sheet-column-resize-handle';
      grip.dataset.col = String(c + 1);
      grip.setAttribute('aria-hidden', 'true');
      h.appendChild(grip);
    }

    headerRow.appendChild(h);
    dataColumnHeaderEls[c] = h;
  }

  const gridBody = document.createElement('div');
  gridBody.className = 'sheet-grid-body';
  gridBody.style.height = `${sheetTotalHeight}px`;

  const rowCellsEls: HTMLDivElement[] = [];

  for (let row = 1; row <= mountedRowCount; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'sheet-row';
    rowEl.style.height = `${rowHeights[row - 1]}px`;
    rowEl.style.top = `${cumulativeRowHeights[row - 1]}px`;
    if (!isGhostRow(row)) {
      rowEl.setAttribute('role', 'row');
      rowEl.setAttribute('aria-rowindex', String(row + 1));
    }

    const rowGutter = document.createElement('div');
    rowGutter.className = 'sheet-row-gutter';
    rowGutter.style.flex = `0 0 ${rowHeaderWidthPx}px`;
    rowGutter.style.width = `${rowHeaderWidthPx}px`;
    if (isGhostRow(row)) {
      rowGutter.classList.add('sheet-row-gutter--ghost');
      rowGutter.textContent = '';
    } else {
      rowGutter.textContent = String(row);
    }
    rowGutter.dataset.row = String(row);
    rowGutter.setAttribute('aria-hidden', 'true');

    const rowCells = document.createElement('div');
    rowCells.className = 'sheet-row-cells';
    rowCells.style.width = `${mountedSheetCellsWidth}px`;

    const ghost = isGhostRow(row);

    for (let col = 1; col <= dataColumnCount; col++) {
      if (isHiddenCol(col)) continue;
      const cell = document.createElement('div');
      cell.className = 'sheet-cell';
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.style.width = `${columnWidths[col - 1]}px`;
      cell.style.left = `${cumulativeColumnWidths[col - 1]}px`;
      if (!ghost) {
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-rowindex', String(row + 1));
        cell.setAttribute('aria-colindex', String(col + 1));
      }

      const key = cellKey(row, col);
      const raw = ghost ? undefined : data.get(row, col);
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
        cell.classList.add('sheet-cell--number');
      }
      if (isSelectColumn(colDef)) {
        input.dataset.sheetValueType = 'select';
        cell.classList.add('sheet-cell--select');
      }
      input.value = display;
      if (ghost || colDef?.readOnly) {
        cell.classList.add('sheet-cell-readonly');
        if (ghost) cell.classList.add('sheet-cell--ghost');
        input.readOnly = true;
        input.tabIndex = -1;
        input.setAttribute('aria-readonly', 'true');
      }

      // Dropdown affordance for editable select cells (shown on hover / active).
      if (!ghost && !colDef?.readOnly && isSelectColumn(colDef)) {
        const caret = document.createElement('span');
        caret.className = 'sheet-cell-select-caret';
        caret.setAttribute('aria-hidden', 'true');
        const ci = document.createElement('i');
        ci.className = 'ph ph-caret-down';
        caret.appendChild(ci);
        cell.appendChild(caret);
      }

      applyCellInlineStyleRecord(cell, ghost ? undefined : data.getCellStyle?.(row, col));

      if (!ghost && row === active.row && col === active.col) {
        cell.classList.add('sheet-cell-active');
        cell.setAttribute('aria-selected', 'true');
      }

      cell.append(content, input);
      cells.set(key, cell);
      if (!ghost) updateCommentIndicator(row, col);
      rowCells.appendChild(cell);
    }
    rowCellsEls.push(rowCells);
    rowEl.append(rowGutter, rowCells);
    gridBody.appendChild(rowEl);
  }

  copyMarqueeEl = document.createElement('div');
  copyMarqueeEl.className = 'sheet-copy-marquee';
  copyMarqueeEl.hidden = true;
  copyMarqueeEl.setAttribute('aria-hidden', 'true');
  gridBody.appendChild(copyMarqueeEl);

  selectionOutlineEl = document.createElement('div');
  selectionOutlineEl.className = 'sheet-selection-outline';
  selectionOutlineEl.hidden = true;
  selectionOutlineEl.setAttribute('aria-hidden', 'true');
  gridBody.appendChild(selectionOutlineEl);

  const ghostColumnHeaderEls: HTMLDivElement[] = [];

  function createGhostColumnHeader(col: number): HTMLDivElement {
    const h = document.createElement('div');
    h.className = 'sheet-column-header sheet-column-header--ghost';
    h.style.width = `${widthOfMountedCol1Based(col)}px`;
    h.setAttribute('aria-hidden', 'true');
    return h;
  }

  function createGhostColumnCell(row: number, col: number): HTMLDivElement {
    const cell = document.createElement('div');
    cell.className = 'sheet-cell sheet-cell--ghost-column';
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    cell.style.width = `${widthOfMountedCol1Based(col)}px`;
    cell.style.left = `${cumulativeColumnWidths[col - 1]}px`;
    cell.style.pointerEvents = 'none';

    const content = document.createElement('div');
    content.className = 'sheet-cell-content';
    content.textContent = '';

    const input = document.createElement('input');
    input.className = 'sheet-cell-input';
    input.type = 'text';
    input.readOnly = true;
    input.tabIndex = -1;
    input.value = '';
    input.setAttribute('aria-hidden', 'true');

    const gr = isGhostRow(row);
    cell.classList.add('sheet-cell-readonly');
    if (gr) cell.classList.add('sheet-cell--ghost');

    cell.append(content, input);
    return cell;
  }

  function setGhostColumnCount(next: number): void {
    if (!ghostColumnsEnabled) return;
    const capped = Math.max(0, Math.min(maxGhostColumns, next));
    if (capped === ghostColumnCount) return;
    const prev = ghostColumnCount;
    ghostColumnCount = capped;
    rebuildCumulativeColumnWidthsAndMountedWidth();

    gridInner.style.width = `${rowHeaderWidthPx + mountedSheetCellsWidth}px`;

    if (capped > prev) {
      for (let g = prev + 1; g <= capped; g++) {
        const col = dataColumnCount + g;
        const h = createGhostColumnHeader(col);
        headerRow.appendChild(h);
        ghostColumnHeaderEls.push(h);
      }
      for (let row = 1; row <= mountedRowCount; row++) {
        const rowCells = rowCellsEls[row - 1]!;
        rowCells.style.width = `${mountedSheetCellsWidth}px`;
        for (let g = prev + 1; g <= capped; g++) {
          const col = dataColumnCount + g;
          const cell = createGhostColumnCell(row, col);
          rowCells.appendChild(cell);
          cells.set(cellKey(row, col), cell);
        }
      }
    } else {
      for (let g = prev; g > capped; g--) {
        ghostColumnHeaderEls.pop()?.remove();
      }
      for (let row = 1; row <= mountedRowCount; row++) {
        const rowCells = rowCellsEls[row - 1]!;
        rowCells.style.width = `${mountedSheetCellsWidth}px`;
        for (let g = prev; g > capped; g--) {
          const col = dataColumnCount + g;
          const k = cellKey(row, col);
          cells.get(k)?.remove();
          cells.delete(k);
        }
      }
    }
  }

  function syncGhostColumnsToViewport(): void {
    if (!ghostColumnsEnabled) return;
    // Grid content is scaled by `zoomFactor`; convert viewport px to content px.
    const vpW = viewport.clientWidth / (zoomFactor || 1);
    const need = Math.ceil((vpW - rowHeaderWidthPx - dataSheetTotalWidth) / ghostColumnWidthPx);
    setGhostColumnCount(need);
  }

  /**
   * Re-apply column layout after `columnWidths[]` mutates. Updates header widths, the cumulative
   * left-offset table, every cell's `width`/`left` (data and ghost), and the grid envelope, then
   * recomputes ghost-column padding. Pass `persist: true` to write to `sessionStorage` once the
   * gesture settles.
   */
  function applyColumnLayout(opts?: { persist?: boolean }): void {
    dataSheetTotalWidth = sumVisibleColumnWidths(columns, columnWidths);
    rebuildCumulativeColumnWidthsAndMountedWidth();
    gridInner.style.width = `${rowHeaderWidthPx + mountedSheetCellsWidth}px`;
    for (let c = 0; c < dataColumnCount; c++) {
      const h = dataColumnHeaderEls[c];
      if (h) h.style.width = `${columnWidths[c]}px`;
    }
    const totalMountedCols = dataColumnCount + ghostColumnCount;
    for (let row = 1; row <= mountedRowCount; row++) {
      const rowCells = rowCellsEls[row - 1];
      if (rowCells) {
        rowCells.style.width = `${mountedSheetCellsWidth}px`;
      }
      for (let col = 1; col <= totalMountedCols; col++) {
        const cell = cells.get(cellKey(row, col));
        if (!cell) continue;
        cell.style.width = `${widthOfMountedCol1Based(col)}px`;
        cell.style.left = `${cumulativeColumnWidths[col - 1]}px`;
      }
    }
    syncGhostColumnsToViewport();
    syncCopyMarqueeLayout();
    syncSelectionOutlineLayout();
    if (opts?.persist) {
      persistColumnWidths(columnWidthPersistenceKey, columnWidths);
    }
  }

  function setColumnWidth(colIndex: number, nextWidth: number, opts?: { persist?: boolean }): void {
    if (colIndex < 1 || colIndex > dataColumnCount) return;
    const clamped = clampColumnWidth(nextWidth);
    if (columnWidths[colIndex - 1] === clamped) return;
    columnWidths[colIndex - 1] = clamped;
    applyColumnLayout({ persist: opts?.persist === true });
  }

  /** Fit a column's width to the widest rendered content (header + data cells). */
  function autofitColumn(col: number): void {
    if (col < 1 || col > dataColumnCount || isHiddenCol(col)) return;
    let max = 0;
    const headerLabel = dataColumnHeaderEls[col - 1]?.querySelector<HTMLElement>(
      '.sheet-column-header-label',
    );
    if (headerLabel) max = Math.max(max, headerLabel.scrollWidth);
    for (let row = 1; row <= dataRowCount; row++) {
      const cell = cells.get(cellKey(row, col));
      if (!cell) continue;
      const content = cell.querySelector<HTMLElement>('.sheet-cell-content');
      if (content) max = Math.max(max, content.scrollWidth);
    }
    const padding = isSelectColumn(columnAt(col)) ? 44 : 28;
    setColumnWidth(col, max + padding, { persist: true });
  }

  if (columnResizeEnabled) {
    let resizeCol = 0;
    let resizeStartX = 0;
    let resizeStartWidth = 0;
    let activeGrip: HTMLElement | null = null;
    let resizePointerId: number | null = null;
    let resizeRaf: number | null = null;
    let resizePendingWidth: number | null = null;

    const flushPendingResize = (): void => {
      resizeRaf = null;
      if (resizePendingWidth === null || resizeCol === 0) return;
      const desired = resizePendingWidth;
      resizePendingWidth = null;
      setColumnWidth(resizeCol, desired, { persist: false });
    };

    const onGripPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const grip = e.currentTarget as HTMLElement;
      const col = Number(grip.dataset.col);
      if (!Number.isFinite(col) || col < 1 || col > dataColumnCount) return;
      e.preventDefault();
      e.stopPropagation();
      resizeCol = col;
      resizeStartX = e.clientX;
      resizeStartWidth = columnWidths[col - 1]!;
      resizePointerId = e.pointerId;
      activeGrip = grip;
      grip.classList.add('sheet-column-resize-handle--dragging');
      grip.setPointerCapture(e.pointerId);
    };

    const onGripPointerMove = (e: PointerEvent): void => {
      if (resizePointerId === null || e.pointerId !== resizePointerId) return;
      const next = resizeStartWidth + (e.clientX - resizeStartX) / (zoomFactor || 1);
      resizePendingWidth = next;
      if (resizeRaf === null) {
        resizeRaf = requestAnimationFrame(flushPendingResize);
      }
    };

    const onGripPointerUp = (e: PointerEvent): void => {
      if (resizePointerId === null || e.pointerId !== resizePointerId) return;
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = null;
      }
      flushPendingResize();
      if (activeGrip) {
        activeGrip.classList.remove('sheet-column-resize-handle--dragging');
        if (activeGrip.hasPointerCapture(e.pointerId)) {
          activeGrip.releasePointerCapture(e.pointerId);
        }
      }
      resizePointerId = null;
      activeGrip = null;
      resizeCol = 0;
      resizePendingWidth = null;
      persistColumnWidths(columnWidthPersistenceKey, columnWidths);
    };

    const onGripDblClick = (e: MouseEvent): void => {
      const grip = e.currentTarget as HTMLElement;
      const col = Number(grip.dataset.col);
      if (!Number.isFinite(col) || col < 1 || col > dataColumnCount) return;
      e.preventDefault();
      e.stopPropagation();
      autofitColumn(col);
    };

    for (const h of dataColumnHeaderEls) {
      if (!h) continue;
      const grip = h.querySelector<HTMLElement>('.sheet-column-resize-handle');
      if (!grip) continue;
      grip.addEventListener('pointerdown', onGripPointerDown);
      grip.addEventListener('pointermove', onGripPointerMove);
      grip.addEventListener('pointerup', onGripPointerUp);
      grip.addEventListener('pointercancel', onGripPointerUp);
      grip.addEventListener('dblclick', onGripDblClick);
    }
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
  root.append(viewport, suggestPopover, commentPopover, commentPreviewPop, srAnnounceEl, inputHintEl);
  container.appendChild(root);

  let disconnectLayout: (() => void) | undefined;
  if (ghostColumnsEnabled) {
    const ro = new ResizeObserver(() => {
      syncGhostColumnsToViewport();
    });
    ro.observe(viewport);
    queueMicrotask(() => syncGhostColumnsToViewport());
    disconnectLayout = () => ro.disconnect();
  }

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
  viewport.addEventListener('cut', onCutCapture, true);

  // Reveal the full value as a native tooltip only when the cell text is clipped.
  viewport.addEventListener('pointerover', (e) => {
    const cellEl = (e.target as HTMLElement).closest?.('.sheet-cell') as HTMLElement | null;
    if (!cellEl || !viewport.contains(cellEl)) return;
    if (cellEl.classList.contains('sheet-cell--ghost-column')) return;
    const content = cellEl.querySelector<HTMLElement>('.sheet-cell-content');
    if (!content) {
      cellEl.removeAttribute('title');
      return;
    }
    const clipped = content.scrollWidth > content.clientWidth + 1;
    if (!clipped) {
      if (cellEl.hasAttribute('title')) cellEl.removeAttribute('title');
      return;
    }
    const r = Number(cellEl.dataset.row);
    const c = Number(cellEl.dataset.col);
    const text = isGhostRow(r) ? '' : cellPlainTextForSearch(columnAt(c), data.get(r, c));
    if (text) {
      if (cellEl.getAttribute('title') !== text) cellEl.setAttribute('title', text);
    } else if (cellEl.hasAttribute('title')) {
      cellEl.removeAttribute('title');
    }
  });

  viewport.addEventListener('scroll', () => {
    hideInputHint();
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

  function setEditingOnActive(on: boolean): void {
    cells.get(cellKey(active.row, active.col))?.classList.toggle('sheet-cell-editing', on);
  }

  function focusActiveCell(): void {
    if (editMode) return;
    setTimeout(() => viewport.focus({ preventScroll: true }), 0);
  }

  function enterNavigationMode(): void {
    setEditingOnActive(false);
    editMode = false;
    const cell = cells.get(cellKey(active.row, active.col));
    const inp = cell ? getCellEditor(cell) : null;
    if (inp && document.activeElement === inp) inp.blur();
    viewport.focus({ preventScroll: true });
  }

  function enterEditMode(opts?: { seed?: string }): void {
    if (isReadOnlyCol(active.col) || isGhostRow(active.row)) return;
    const cell = cells.get(cellKey(active.row, active.col));
    const inp = cell ? getCellEditor(cell) : null;
    if (!inp || !cell) return;
    cell.classList.add('sheet-cell-editing');
    if (opts && opts.seed !== undefined) {
      inp.value = opts.seed;
    } else {
      const stored = data.get(active.row, active.col);
      inp.value = stored !== undefined ? String(stored) : '';
    }
    editMode = true;
    inp.focus();
    try {
      const len = inp.value.length;
      inp.setSelectionRange(len, len);
    } catch {
      /* setSelectionRange may throw for non-text inputs; safe to ignore */
    }
  }

  function blurActiveInput(): void {
    const cell = cells.get(cellKey(active.row, active.col));
    if (cell) getCellEditor(cell)?.blur();
  }

  function leaveEditorFocusSheet(): void {
    blurActiveInput();
    viewport.focus({ preventScroll: true });
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
    syncSelectionOutlineLayout();
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
    col = clampColVisible(col);

    if (active.row === row && active.col === col && !selectArea.active) {
      queueMicrotask(() => {
        viewport.focus({ preventScroll: true });
        scrollActiveIntoView();
      });
      return;
    }

    hideSuggestions();
    hideInputHint();
    exitRangeSelectionUi();
    selectArea.active = false;
    selectArea.row = row;
    selectArea.col = col;
    selectArea.rowEnd = row;
    selectArea.colEnd = col;
    syncSelectionHighlight();

    persistActiveInput();

    const prev = cells.get(cellKey(active.row, active.col));
    prev?.classList.remove('sheet-cell-active', 'sheet-cell-editing');
    prev?.removeAttribute('aria-selected');

    active = { row, col };
    editMode = false;
    const next = cells.get(cellKey(row, col));
    next?.classList.add('sheet-cell-active');
    next?.setAttribute('aria-selected', 'true');

    const inp = next ? getCellEditor(next) : null;
    if (inp) {
      const stored = data.get(row, col);
      inp.value = stored !== undefined ? String(stored) : '';
    }
    announceActiveCell();
    focusActiveCell();
    scrollActiveIntoView();
  }

  function scrollActiveIntoView(): void {
    const cell = cells.get(cellKey(active.row, active.col));
    if (!cell) return;
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function announceActiveCell(): void {
    if (!srAnnounceEl) return;
    if (isGhostRow(active.row)) return;
    const colDef = columnAt(active.col);
    const header = colDef?.header?.trim() || `Column ${active.col}`;
    const text = cellPlainTextForSearch(colDef, data.get(active.row, active.col));
    srAnnounceEl.textContent = `${header}, row ${active.row}: ${text || 'empty'}`;
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

  function selectSheetRow(targetRow: number, extend = false): void {
    const row = clampRow(targetRow);
    persistActiveInput();
    hideSuggestions();
    tabAnchorCol = null;
    editMode = false;
    cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active', 'sheet-cell-editing');
    const anchorRow = extend && selectArea.active ? selectArea.row : row;
    active = { row, col: firstVisibleCol() };
    const next = cells.get(cellKey(row, firstVisibleCol()));
    next?.classList.add('sheet-cell-active');
    const inp = next ? getCellEditor(next) : null;
    if (inp) {
      const stored = data.get(row, firstVisibleCol());
      inp.value = stored !== undefined ? String(stored) : '';
    }
    selectArea.row = anchorRow;
    selectArea.col = firstVisibleCol();
    selectArea.rowEnd = row;
    selectArea.colEnd = lastVisibleCol();
    selectArea.active =
      dataRowCount > 1 ||
      firstVisibleCol() !== lastVisibleCol() ||
      anchorRow !== row;
    syncSelectionHighlight();
    if (selectArea.active) {
      enterRangeSelectionUi();
    } else {
      exitRangeSelectionUi();
      focusActiveCell();
    }
    notifySelectionChange();
  }

  function selectSheetColumn(targetCol: number, extend = false): void {
    const col = clampCol(targetCol);
    if (dataRowCount < 1) return;
    persistActiveInput();
    hideSuggestions();
    tabAnchorCol = null;
    editMode = false;
    cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active', 'sheet-cell-editing');
    const anchorCol = extend && selectArea.active ? selectArea.col : col;
    active = { row: 1, col };
    const next = cells.get(cellKey(1, col));
    next?.classList.add('sheet-cell-active');
    const inp = next ? getCellEditor(next) : null;
    if (inp) {
      const stored = data.get(1, col);
      inp.value = stored !== undefined ? String(stored) : '';
    }
    selectArea.row = 1;
    selectArea.col = anchorCol;
    selectArea.rowEnd = dataRowCount;
    selectArea.colEnd = col;
    selectArea.active = dataRowCount > 1 || anchorCol !== col;
    syncSelectionHighlight();
    if (selectArea.active) {
      enterRangeSelectionUi();
    } else {
      exitRangeSelectionUi();
      focusActiveCell();
    }
    notifySelectionChange();
  }

  createRowContextMenu({
    root,
    viewport,
    dataRowCount,
    clampRow,
    onClearRow: (row) => clearSheetRow(row),
    onSelectRow: (row) => selectSheetRow(row),
    onCopyRow: (row) => {
      persistActiveInput();
      writeClipboardText(buildRowPlainText(row));
      setCopyMarquee({
        minRow: row,
        maxRow: row,
        minCol: firstVisibleCol(),
        maxCol: lastVisibleCol(),
      });
    },
  });

  function endPointerDrag(focusIfClick: boolean): void {
    viewport.classList.remove('sheet-viewport--dragging');
    dragging = false;
    dragPointerId = null;

    if (!dragMoved) {
      collapseRange();
      if (focusIfClick) focusActiveCell();
    } else if (selectArea.active) {
      /* focus already moved to viewport on first multi frame */
    } else {
      focusActiveCell();
    }
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;

    const caretHit = target.closest('.sheet-cell-select-caret') as HTMLElement | null;
    if (caretHit && viewport.contains(caretHit)) {
      const caretCell = caretHit.closest('.sheet-cell') as HTMLElement | null;
      if (caretCell) {
        const cr = clampRow(Number(caretCell.dataset.row));
        const cc = clampCol(Number(caretCell.dataset.col));
        e.preventDefault();
        if (cr !== active.row || cc !== active.col) setActive(cr, cc);
        if (!isReadOnlyCol(cc) && !isGhostRow(cr) && isSelectColumn(columnAt(cc))) {
          enterEditMode();
          openFullSuggestionList();
        }
        return;
      }
    }

    const headerHit = target.closest('.sheet-column-header') as HTMLElement | null;
    if (headerHit && viewport.contains(headerHit) && !headerHit.classList.contains('sheet-column-header--ghost')) {
      const col = Number(headerHit.dataset.col);
      if (!Number.isFinite(col) || col < 1 || col > dataColumnCount) return;
      e.preventDefault();
      selectSheetColumn(col, e.shiftKey);
      return;
    }

    const gutterHit = target.closest('.sheet-row-gutter') as HTMLElement | null;
    if (gutterHit && viewport.contains(gutterHit) && !gutterHit.classList.contains('sheet-row-gutter--ghost')) {
      const gRow = Number(gutterHit.dataset.row);
      if (!Number.isFinite(gRow) || gRow < 1 || gRow > dataRowCount) return;
      e.preventDefault();
      selectSheetRow(gRow, e.shiftKey);
      return;
    }

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

    // Shift-click extends the existing range from the current anchor instead
    // of starting a fresh drag. The anchor is `selectArea.row/col` when a
    // range is already active, otherwise the current `active` cell.
    if (e.shiftKey) {
      hideSuggestions();
      persistActiveInput();
      const anchorRow = selectArea.active ? selectArea.row : active.row;
      const anchorCol = selectArea.active ? selectArea.col : active.col;
      cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active', 'sheet-cell-editing');
      active = { row, col };
      editMode = false;
      tabAnchorCol = null;
      const nextCell = cells.get(cellKey(row, col));
      nextCell?.classList.add('sheet-cell-active');
      const inpExtend = nextCell ? getCellEditor(nextCell) : null;
      if (inpExtend) {
        const stored = data.get(row, col);
        inpExtend.value = stored !== undefined ? String(stored) : '';
      }
      selectArea.row = anchorRow;
      selectArea.col = anchorCol;
      selectArea.rowEnd = row;
      selectArea.colEnd = col;
      selectArea.active = anchorRow !== row || anchorCol !== col;
      syncSelectionHighlight();
      if (selectArea.active) enterRangeSelectionUi();
      else {
        exitRangeSelectionUi();
        focusActiveCell();
      }
      return;
    }

    exitRangeSelectionUi();

    dragging = true;
    dragMoved = false;
    dragPointerId = e.pointerId;
    dragAnchor = { row, col };
    tabAnchorCol = null;
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
    editMode = false;
    cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active', 'sheet-cell-editing');

    active = { row, col };
    const next = cells.get(cellKey(row, col));
    next?.classList.add('sheet-cell-active');
    const inp = next ? getCellEditor(next) : null;
    if (inp) {
      const stored = data.get(row, col);
      inp.value = stored !== undefined ? String(stored) : '';
    }

    // Second click of a double-click: enter edit mode here because
    // preventDefault() on pointerdown suppresses the dblclick event in most browsers.
    if (e.detail === 2 && !isReadOnlyCol(col) && !isGhostRow(row)) {
      enterEditMode();
    }
  });

  function computeAutoScrollDelta(clientX: number, clientY: number): { dx: number; dy: number } {
    const rect = viewport.getBoundingClientRect();
    const edge = 30;
    const maxSpeed = 24;
    let dx = 0;
    let dy = 0;
    if (clientX < rect.left + edge) {
      dx = -Math.min(maxSpeed, Math.ceil((rect.left + edge - clientX) / 2));
    } else if (clientX > rect.right - edge) {
      dx = Math.min(maxSpeed, Math.ceil((clientX - (rect.right - edge)) / 2));
    }
    if (clientY < rect.top + edge) {
      dy = -Math.min(maxSpeed, Math.ceil((rect.top + edge - clientY) / 2));
    } else if (clientY > rect.bottom - edge) {
      dy = Math.min(maxSpeed, Math.ceil((clientY - (rect.bottom - edge)) / 2));
    }
    return { dx, dy };
  }

  function stopAutoScroll(): void {
    if (autoScrollRaf !== null) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }
  }

  function autoScrollTick(): void {
    autoScrollRaf = null;
    if (!dragging || !dragLastPointer) return;
    const { clientX, clientY } = dragLastPointer;
    const { dx, dy } = computeAutoScrollDelta(clientX, clientY);
    if (dx === 0 && dy === 0) return;
    viewport.scrollBy(dx, dy);
    const hit = cellFromPoint(clientX, clientY);
    if (hit) {
      if (hit.row !== dragAnchor.row || hit.col !== dragAnchor.col) dragMoved = true;
      dragPendingEnd = hit;
      scheduleDragPaint();
    }
    autoScrollRaf = requestAnimationFrame(autoScrollTick);
  }

  function ensureAutoScroll(clientX: number, clientY: number): void {
    dragLastPointer = { clientX, clientY };
    const { dx, dy } = computeAutoScrollDelta(clientX, clientY);
    if (dx === 0 && dy === 0) {
      stopAutoScroll();
      return;
    }
    if (autoScrollRaf === null) {
      autoScrollRaf = requestAnimationFrame(autoScrollTick);
    }
  }

  viewport.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    dragLastPointer = { clientX: e.clientX, clientY: e.clientY };
    const hit = cellFromPoint(e.clientX, e.clientY);
    if (hit) {
      if (hit.row !== dragAnchor.row || hit.col !== dragAnchor.col) dragMoved = true;
      dragPendingEnd = hit;
      scheduleDragPaint();
    }
    ensureAutoScroll(e.clientX, e.clientY);
  });

  viewport.addEventListener('pointerup', (e) => {
    if (e.pointerId !== dragPointerId) return;
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
    stopAutoScroll();
    dragLastPointer = null;
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
    stopAutoScroll();
    dragLastPointer = null;
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
    const row = clampRow(r);
    const start = clampColVisible(c);
    const first = firstVisibleCol();
    const last = lastVisibleCol();
    if (first > last) return start;
    return jumpToEdge(
      start,
      directionRight ? last : first,
      directionRight ? 1 : -1,
      (col) => isVisibleCol(col) && isOccupied(row, col),
    );
  }

  function jumpRow(r: number, c: number, directionDown: boolean): number {
    const col = clampCol(c);
    return jumpToEdge(
      clampRow(r),
      directionDown ? dataRowCount : 1,
      directionDown ? 1 : -1,
      (row) => isOccupied(row, col),
    );
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

    if (e.key === 'F2' && !e.shiftKey && !sheetModEarly && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      enterEditMode();
      return;
    }

    if (
      !editMode &&
      e.altKey &&
      e.key === 'ArrowDown' &&
      !sheetModEarly &&
      !e.shiftKey &&
      !selectArea.active &&
      isSelectColumn(columnAt(active.col)) &&
      !isReadOnlyCol(active.col) &&
      !isGhostRow(active.row)
    ) {
      e.preventDefault();
      e.stopPropagation();
      enterEditMode();
      openFullSuggestionList();
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

    if (editMode) {
      // Escape / Tab / Enter fall through to shared handlers below. Plain arrow
      // keys commit and move to the adjacent cell (movement intent). Everything
      // else (Home/End, Cmd+A, Cmd+Z, typing, Backspace, Delete, modified
      // arrows) is left to the browser so the user can edit text naturally.
      if (
        (e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight') &&
        !sheetMod &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        hideSuggestions();
        tabAnchorCol = null;
        if (e.key === 'ArrowUp') setActive(row - 1, col);
        else if (e.key === 'ArrowDown') setActive(row + 1, col);
        else if (e.key === 'ArrowLeft') setActive(row, col - 1);
        else if (e.key === 'ArrowRight') setActive(row, col + 1);
        return;
      }
      if (e.key !== 'Escape' && e.key !== 'Tab' && e.key !== 'Enter') {
        return;
      }
    }

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

    // Navigation mode keeps focus on the viewport (a non-editable div). Browsers
    // do not fire copy/cut/paste for keyboard shortcuts on those elements.
    if (
      !editMode &&
      sheetMod &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key === 'c' ||
        e.key === 'C' ||
        e.key === 'x' ||
        e.key === 'X' ||
        e.key === 'v' ||
        e.key === 'V')
    ) {
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        e.stopPropagation();
        writeClipboardText(buildCopyPlainText());
        setCopyMarqueeFromSelection();
        return;
      }
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        e.stopPropagation();
        writeClipboardText(buildCopyPlainText());
        setCopyMarqueeFromSelection();
        clearWritableCellsInActiveRange();
        syncSelectionHighlight();
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        e.stopPropagation();
        void readClipboardPayloadForPaste().then((payload) => {
          if (payload) applyPastedGrid(payload);
        });
        return;
      }
    }

    if (sheetMod && (e.key === 'a' || e.key === 'A') && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      tabAnchorCol = null;
      if (dataRowCount > 0 && visibleColumnCount(columns) > 0) {
        persistActiveInput();
        selectArea.row = 1;
        selectArea.col = firstVisibleCol();
        selectArea.rowEnd = dataRowCount;
        selectArea.colEnd = lastVisibleCol();
        selectArea.active =
          dataRowCount > 1 || firstVisibleCol() !== lastVisibleCol();
        syncSelectionHighlight();
        if (selectArea.active) enterRangeSelectionUi();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      hideSuggestions();
      if (editMode) {
        const cellEl = cells.get(cellKey(active.row, active.col));
        const inp = cellEl ? getCellEditor(cellEl) : null;
        if (inp) {
          const stored = data.get(active.row, active.col);
          inp.value = stored !== undefined ? String(stored) : '';
        }
      }
      clearCopyMarquee();
      collapseRange();
      tabAnchorCol = null;
      enterNavigationMode();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      hideSuggestions();
      if (tabAnchorCol === null) tabAnchorCol = active.col;
      const dir = e.shiftKey ? -1 : 1;
      setActive(row, col + dir);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      hideSuggestions();
      const targetCol = clampColVisible(tabAnchorCol ?? col);
      tabAnchorCol = null;
      const dir = e.shiftKey ? -1 : 1;
      setActive(row + dir, targetCol);
      return;
    }

    if (e.key === 'Home' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      tabAnchorCol = null;
      setActive(sheetMod ? 1 : row, firstVisibleCol());
      return;
    }

    if (e.key === 'End' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      tabAnchorCol = null;
      setActive(sheetMod ? dataRowCount : row, lastVisibleCol());
      return;
    }

    if (e.key === 'PageDown' && !sheetMod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      tabAnchorCol = null;
      const visibleRows = Math.max(1, Math.floor(viewport.clientHeight / defaultRowHeight));
      setActive(row + visibleRows, col);
      return;
    }

    if (e.key === 'PageUp' && !sheetMod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      tabAnchorCol = null;
      const visibleRows = Math.max(1, Math.floor(viewport.clientHeight / defaultRowHeight));
      setActive(row - visibleRows, col);
      return;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && selectArea.active) {
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

    if (
      !editMode &&
      !sheetMod &&
      !e.altKey &&
      e.key.length === 1 &&
      !isReadOnlyCol(active.col) &&
      !isGhostRow(active.row)
    ) {
      e.preventDefault();
      if (selectArea.active) collapseRange();
      enterEditMode({ seed: e.key });
      return;
    }

    if (
      (e.key === 'Backspace' || e.key === 'Delete') &&
      !selectArea.active &&
      !editMode &&
      !isReadOnlyCol(active.col) &&
      !isGhostRow(active.row)
    ) {
      e.preventDefault();
      const k = cellKey(active.row, active.col);
      const before = history ? captureSnapshot([k]) : null;
      data.set(active.row, active.col, '');
      const cellEl = cells.get(k);
      if (cellEl) {
        const contentEl = cellEl.querySelector<HTMLDivElement>('.sheet-cell-content');
        if (contentEl) applyCellDisplay(contentEl, columnAt(active.col), '');
        const inp = getCellEditor(cellEl);
        if (inp) inp.value = '';
        syncCellChrome(active.row, active.col);
      }
      if (history && before) {
        const after = captureSnapshot([k]);
        pushHistoryIfChanged(before, after);
      }
      focusActiveCell();
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
        focusActiveCell();
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
      else if (e.key === 'ArrowLeft') selectArea.colEnd = stepVisibleCol(selectArea.colEnd, -1);
      else if (e.key === 'ArrowRight') selectArea.colEnd = stepVisibleCol(selectArea.colEnd, 1);

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
        focusActiveCell();
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
      tabAnchorCol = null;
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
      tabAnchorCol = null;
      setActive(row - 1, col);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      tabAnchorCol = null;
      setActive(row + 1, col);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      tabAnchorCol = null;
      setActive(row, col - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      tabAnchorCol = null;
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
      editMode = true;
      persistError.clear(row, col);
    },
    true,
  );

  viewport.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
    const hit = target.closest('.sheet-cell');
    if (!hit || !viewport.contains(hit)) return;
    const cell = hit as HTMLElement;
    const row = clampRow(Number(cell.dataset.row));
    const col = clampCol(Number(cell.dataset.col));
    if (isReadOnlyCol(col) || isGhostRow(row)) return;
    e.preventDefault();
    if (row !== active.row || col !== active.col) {
      setActive(row, col);
    }
    enterEditMode();
  });

  if (history) {
    history.subscribe(notifyHistoryChange);
  }

  if (config.initialSelection) {
    syncSelectionHighlight();
    focusActiveCell();
  }

  const scrollRestore = config.initialViewportScroll;
  if (scrollRestore) {
    const top = Number.isFinite(scrollRestore.scrollTop) ? scrollRestore.scrollTop : 0;
    const left = Number.isFinite(scrollRestore.scrollLeft) ? scrollRestore.scrollLeft : 0;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        const maxY = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const maxX = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        viewport.scrollTop = Math.max(0, Math.min(top, maxY));
        viewport.scrollLeft = Math.max(0, Math.min(left, maxX));
      });
    });
  } else if (config.initialSelection) {
    queueMicrotask(() => {
      cells.get(cellKey(active.row, active.col))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function findInSheet(options: { query: string; forward: boolean }): boolean {
    const q = options.query.trim();
    if (!q) return false;
    const total = dataRowCount * dataColumnCount;
    if (total < 1) return false;
    const needle = q.toLowerCase();
    const activeFlat = (active.row - 1) * dataColumnCount + (active.col - 1);
    for (let step = 1; step < total; step++) {
      const flat = options.forward
        ? (activeFlat + step) % total
        : ((activeFlat - step) % total + total) % total;
      const row = Math.floor(flat / dataColumnCount) + 1;
      const col = (flat % dataColumnCount) + 1;
      if (isHiddenCol(col)) continue;
      const colDef = columnAt(col);
      const raw = data.get(row, col);
      const text = cellPlainTextForSearch(colDef, raw).toLowerCase();
      if (text.includes(needle)) {
        setActive(row, col);
        requestAnimationFrame(() => {
          cells.get(cellKey(row, col))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
        return true;
      }
    }
    return false;
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
    showCellPersistError: (row, col, message) => persistError.show(row, col, message),
    replayClipboardPaste: applyPastedGrid,
    applyRemoteRowClear,
    findInSheet,
    getZoom,
    setZoom,
    subscribeZoomChange(cb) {
      zoomChangeListeners.add(cb);
      return () => zoomChangeListeners.delete(cb);
    },
    ...(disconnectLayout ? { disconnectLayout } : {}),
  };

  return handle;
}
