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
  active: true,
  row: 2,
  col: 2,
  rowEnd: 10,
  colEnd: 10,
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


function renderSelectArea(cells: Map<string, HTMLDivElement>): void {
  // Clear all select area cells
  document.querySelectorAll('.sheet-cell-select-area').forEach(cell => {
    cell.classList.remove('sheet-cell-select-area');
  });

  if (!selectArea.active) return;

  // Render the new select area
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


/** Build grid once; delegated clicks; imperative active cell + focus. */
export function mountSheet(container: HTMLElement): void {
  const cells = new Map<string, HTMLDivElement>();
  let active = { row: 1, col: 1 };

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

  /* Set the active cell and focus the input */
  function setActive(row: number, col: number): void {
    if (active.row === row && active.col === col) {
      queueMicrotask(() => {
        const el = cells.get(cellKey(row, col));
        el?.querySelector<HTMLInputElement>('.sheet-cell-input')?.focus();
      });
      return;
    }

    selectArea.active = false;
    selectArea.row = row;
    selectArea.col = col;
    selectArea.rowEnd = row;
    selectArea.colEnd = col;
    
    renderSelectArea(cells);

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

  viewport.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const cell = target?.closest('.sheet-cell');
    if (!cell || !viewport.contains(cell)) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    setActive(row, col);
  });
  
  viewport.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const cell = target?.closest('.sheet-cell');
    if (!cell || !viewport.contains(cell)) return;
    const row = Number(cell?.dataset.row);
    const col = Number(cell?.dataset.col);

    
    if (e.key === 'Escape') {
      setActive(-1, -1);
    } else if (e.key === 'Enter') {
      setActive(row + 1, col);
    }
    
    if (e.shiftKey) {
      selectArea.active = true;
      if (e.key === 'ArrowUp') {
        selectArea.rowEnd -= 1;
      } else if (e.key === 'ArrowDown') {
        selectArea.rowEnd += 1;
      } else if (e.key === 'ArrowLeft') {
        selectArea.colEnd -= 1;
      } else if (e.key === 'ArrowRight') {
        selectArea.colEnd += 1;
      }
      renderSelectArea(cells);
    } else {
      if (e.key === 'ArrowUp') {
        setActive(row - 1, col);
      } else if (e.key === 'ArrowDown') {
        setActive(row + 1, col);
      } else if (e.key === 'ArrowLeft') {
        setActive(row, col - 1);
      } else if (e.key === 'ArrowRight') {
        setActive(row, col + 1);
      }
    }
  });

}
