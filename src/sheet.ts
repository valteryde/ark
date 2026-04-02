import './sheet.css';

const mockColumnHeaders = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE',
  'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP',
];

const mockRows: Record<string, { value: string | number }> = {
  '1:1': { value: 'John Doe' },
  '1:2': { value: 25 },
  '1:3': { value: 'Male' },
  '1:4': { value: 'john.doe@example.com' },
  '1:5': { value: '1234567890' },
  '1:6': { value: '123 Main St, Anytown, USA' },
  '3:5': { value: 'Jane Smith' },
  '3:6': { value: 30 },
  '3:7': { value: 'Female' },
  '3:8': { value: 'jane.smith@example.com' },
  '3:9': { value: '9876543210' },
  '3:10': { value: '456 Elm St, Anytown, USA' },
};

const rowCountTotal = 100;
const columnCountTotal = mockColumnHeaders.length;

const rowHeights = Array.from({ length: rowCountTotal }, () => 20);
const columnWidths = Array.from({ length: columnCountTotal }, () => 100);

const cumulativeRowHeights: number[] = Array.from({ length: rowCountTotal }, () => 0);
for (let i = 1; i < rowCountTotal; i++) {
  cumulativeRowHeights[i] = cumulativeRowHeights[i - 1] + rowHeights[i - 1]!;
}

const cumulativeColumnWidths: number[] = Array.from({ length: columnCountTotal }, () => 0);
for (let i = 1; i < columnCountTotal; i++) {
  cumulativeColumnWidths[i] = cumulativeColumnWidths[i - 1] + columnWidths[i - 1]!;
}

const sheetTotalWidth = columnWidths.reduce((a, b) => a + b, 0);
const sheetTotalHeight = rowHeights.reduce((a, b) => a + b, 0);

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

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function persistActiveInput(
  cells: Map<string, HTMLDivElement>,
  active: { row: number; col: number },
): void {
  const el = cells.get(cellKey(active.row, active.col));
  if (!el) return;
  const input = el.querySelector<HTMLInputElement>('.sheet-cell-input');
  const content = el.querySelector<HTMLDivElement>('.sheet-cell-content');
  if (!input || !content) return;
  const key = cellKey(active.row, active.col);
  mockRows[key] = { value: input.value };
  content.textContent = input.value;
}


function renderSelectArea(
  viewport: HTMLElement,
  cells: Map<string, HTMLDivElement>,
): void {
  viewport.querySelectorAll('.sheet-cell-select-area').forEach((el) => {
    el.classList.remove('sheet-cell-select-area');
  });

  if (!selectArea.active) return;

  const minRow = Math.min(selectArea.row, selectArea.rowEnd);
  const maxRow = Math.max(selectArea.row, selectArea.rowEnd);
  const minCol = Math.min(selectArea.col, selectArea.colEnd);
  const maxCol = Math.max(selectArea.col, selectArea.colEnd);

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const cell = cells.get(cellKey(row, col));
      if (!cell) continue;
      cell.classList.add('sheet-cell-select-area');
    }
  }
}


function clampRow(row: number): number {
  return Math.max(1, Math.min(rowCountTotal, row));
}

function clampCol(col: number): number {
  return Math.max(1, Math.min(columnCountTotal, col));
}

/** Build grid once; delegated pointer + keyboard; active cell + optional range selection. */
export function mountSheet(container: HTMLElement): void {
  const cells = new Map<string, HTMLDivElement>();
  let active = { row: 1, col: 1 };

  let dragPointerId: number | null = null;
  let dragging = false;
  let dragAnchor = { row: 1, col: 1 };
  let dragMoved = false;

  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.id = 'sheet-container';

  const headerRow = document.createElement('div');
  headerRow.className = 'sheet-header-row';
  headerRow.style.width = `${sheetTotalWidth}px`;

  for (let c = 0; c < mockColumnHeaders.length; c++) {
    const h = document.createElement('div');
    h.className = 'sheet-column-header';
    h.style.width = `${columnWidths[c]}px`;
    h.textContent = mockColumnHeaders[c]!;
    headerRow.appendChild(h);
  }

  const viewport = document.createElement('div');
  viewport.className = 'sheet-viewport';
  viewport.tabIndex = 0;
  viewport.style.width = `${sheetTotalWidth}px`;
  viewport.style.height = `${sheetTotalHeight}px`;

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
      const raw = mockRows[key]?.value;
      const display = raw !== undefined ? String(raw) : '';

      const content = document.createElement('div');
      content.className = 'sheet-cell-content';
      content.textContent = display;

      const input = document.createElement('input');
      input.className = 'sheet-cell-input';
      input.type = 'text';
      input.value = display;

      if (row === active.row && col === active.col) {
        cell.classList.add('sheet-cell-active');
      }

      cell.append(content, input);
      cells.set(key, cell);
      rowEl.appendChild(cell);
    }
    viewport.appendChild(rowEl);
  }

  root.append(headerRow, viewport);
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

  /** Blur the cell editor and move focus to the viewport so arrows / Shift+arrows still work. */
  function leaveEditorFocusSheet(): void {
    blurActiveInput();
    viewport.focus();
  }

  /** Collapse range highlight to anchor; keep `active` cell. */
  function collapseRange(): void {
    selectArea.row = active.row;
    selectArea.col = active.col;
    selectArea.rowEnd = active.row;
    selectArea.colEnd = active.col;
    selectArea.active = false;
    renderSelectArea(viewport, cells);
  }

  function setActive(row: number, col: number): void {
    row = clampRow(row);
    col = clampCol(col);

    if (active.row === row && active.col === col && !selectArea.active) {
      queueMicrotask(() => {
        cells.get(cellKey(row, col))?.querySelector<HTMLInputElement>('.sheet-cell-input')?.focus();
      });
      return;
    }

    selectArea.active = false;
    selectArea.row = row;
    selectArea.col = col;
    selectArea.rowEnd = row;
    selectArea.colEnd = col;
    renderSelectArea(viewport, cells);

    persistActiveInput(cells, active);

    const prev = cells.get(cellKey(active.row, active.col));
    prev?.classList.remove('sheet-cell-active');

    active = { row, col };
    const next = cells.get(cellKey(row, col));
    next?.classList.add('sheet-cell-active');

    const inp = next?.querySelector<HTMLInputElement>('.sheet-cell-input');
    if (inp) {
      const k = cellKey(row, col);
      inp.value = mockRows[k] !== undefined ? String(mockRows[k]!.value) : '';
      setTimeout(() => inp.focus(), 0);
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
    renderSelectArea(viewport, cells);
    if (multi) leaveEditorFocusSheet();
  }

  function endPointerDrag(focusIfClick: boolean): void {
    viewport.classList.remove('sheet-viewport--dragging');
    dragging = false;
    dragPointerId = null;

    if (!dragMoved) {
      collapseRange();
      if (focusIfClick) focusActiveInput();
    } else if (selectArea.active) {
      leaveEditorFocusSheet();
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
    renderSelectArea(viewport, cells);

    persistActiveInput(cells, active);
    cells.get(cellKey(active.row, active.col))?.classList.remove('sheet-cell-active');

    active = { row, col };
    const next = cells.get(cellKey(row, col));
    next?.classList.add('sheet-cell-active');
    const inp = next?.querySelector<HTMLInputElement>('.sheet-cell-input');
    if (inp) {
      const k = cellKey(row, col);
      inp.value = mockRows[k] !== undefined ? String(mockRows[k]!.value) : '';
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    const hit = cellFromPoint(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.row !== dragAnchor.row || hit.col !== dragAnchor.col) dragMoved = true;
    applyDragRange(hit.row, hit.col);
  });

  viewport.addEventListener('pointerup', (e) => {
    if (e.pointerId !== dragPointerId) return;
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
    endPointerDrag(true);
  });

  viewport.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== dragPointerId) return;
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
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
      // Anchor (row,col) must stay fixed while extending; only move rowEnd/colEnd (like pre-drag behavior).
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
        renderSelectArea(viewport, cells);
        focusActiveInput();
        return;
      }

      renderSelectArea(viewport, cells);
      leaveEditorFocusSheet();
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

  // Capture so Shift+Arrow and arrows are handled before the cell <input> uses them (caret / text selection).
  viewport.addEventListener('keydown', handleSheetKeydown, true);
}
