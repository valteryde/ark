import '../sheet.css';

import { formatCellHtml } from './cell-display.ts';
import { cellKey } from './data-store.ts';
import type { CellDisplayStyle, SpreadsheetColumn, SpreadsheetConfig } from './types.ts';
import { resolveEnabledCellStyles } from './types.ts';

function applyCellDisplay(
  content: HTMLDivElement,
  column: SpreadsheetColumn | undefined,
  value: string,
  enabledStyles: ReadonlySet<CellDisplayStyle>,
): void {
  content.innerHTML = formatCellHtml(column, value, enabledStyles);
}

/** Mount a configurable spreadsheet. Tear down by removing `container` children if remounting. */
export function mountSpreadsheet(container: HTMLElement, config: SpreadsheetConfig): void {
  const columns = config.columns;
  const columnCountTotal = columns.length;
  const rowCountTotal = config.rowCount;
  const defaultRowHeight = config.defaultRowHeightPx ?? 28;
  const rowHeights = Array.from({ length: rowCountTotal }, () => defaultRowHeight);
  const columnWidths = columns.map((c) => c.widthPx);
  const enabledCellStyles = resolveEnabledCellStyles(config.enabledCellStyles);

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

  const data = config.data;

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
    const input = el.querySelector<HTMLInputElement>('.sheet-cell-input');
    const content = el.querySelector<HTMLDivElement>('.sheet-cell-content');
    if (!input || !content) return;
    data.set(active.row, active.col, input.value);
    applyCellDisplay(content, columnAt(active.col), input.value, enabledCellStyles);
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

  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.id = 'sheet-container';

  const viewport = document.createElement('div');
  viewport.className = 'sheet-viewport';
  viewport.tabIndex = 0;

  const gridInner = document.createElement('div');
  gridInner.className = 'sheet-grid-inner';
  gridInner.style.width = `${sheetTotalWidth}px`;

  const headerRow = document.createElement('div');
  headerRow.className = 'sheet-header-row';
  headerRow.style.width = '100%';

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
      applyCellDisplay(content, columnAt(col), display, enabledCellStyles);

      const input = document.createElement('input');
      input.className = 'sheet-cell-input';
      input.type = 'text';
      input.value = display;
      const colDef = columnAt(col);
      if (colDef?.readOnly) {
        cell.classList.add('sheet-cell-readonly');
        input.readOnly = true;
        input.tabIndex = -1;
        input.setAttribute('aria-readonly', 'true');
      }

      if (row === active.row && col === active.col) {
        cell.classList.add('sheet-cell-active');
      }

      cell.append(content, input);
      cells.set(key, cell);
      rowEl.appendChild(cell);
    }
    gridBody.appendChild(rowEl);
  }

  gridInner.append(headerRow, gridBody);
  viewport.append(gridInner);
  root.append(viewport);
  container.appendChild(root);

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
    const inp = cells
      .get(cellKey(active.row, active.col))
      ?.querySelector<HTMLInputElement>('.sheet-cell-input');
    setTimeout(() => inp?.focus(), 0);
  }

  function blurActiveInput(): void {
    cells
      .get(cellKey(active.row, active.col))
      ?.querySelector<HTMLInputElement>('.sheet-cell-input')
      ?.blur();
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
        else cells.get(cellKey(row, col))?.querySelector<HTMLInputElement>('.sheet-cell-input')?.focus();
      });
      return;
    }

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

    const inp = next?.querySelector<HTMLInputElement>('.sheet-cell-input');
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

    persistActiveInput();
    cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active');

    active = { row, col };
    const next = cells.get(cellKey(row, col));
    next?.classList.add('sheet-cell-active');
    const inp = next?.querySelector<HTMLInputElement>('.sheet-cell-input');
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

  function handleSheetKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target || !viewport.contains(target)) return;

    const hit = target.closest('.sheet-cell');
    const focusRowCol = hit
      ? {
          row: clampRow(Number((hit as HTMLElement).dataset.row)),
          col: clampCol(Number((hit as HTMLElement).dataset.col)),
        }
      : { row: active.row, col: active.col };

    const { row, col } = focusRowCol;

    if (e.key === 'Escape') {
      e.preventDefault();
      collapseRange();
      focusActiveInput();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      setActive(row + 1, col);
      return;
    }

    if (e.key === 'Backspace' && selectArea.active) {
      e.preventDefault();
      doOnEverySelectedCell((cell) => {
        const r = clampRow(Number(cell.dataset.row));
        const c = clampCol(Number(cell.dataset.col));
        if (isReadOnlyCol(c)) return;
        data.set(r, c, '');
        const contentEl = cell.querySelector<HTMLDivElement>('.sheet-cell-content')!;
        applyCellDisplay(contentEl, columnAt(c), '', enabledCellStyles);
        cell.querySelector<HTMLInputElement>('.sheet-cell-input')!.value = '';
      });
      exitRangeSelectionUi();
      syncSelectionHighlight();
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
}
