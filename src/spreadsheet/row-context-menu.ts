/**
 * Right-click row actions menu (Clear / Copy / Select). Self-wires the
 * `contextmenu` listener on the viewport; the actual row operations are injected
 * as callbacks so this stays decoupled from grid state.
 */
export interface RowContextMenu {
  /** Hide the menu (also invoked automatically on scroll / outside click / Escape). */
  hide(): void;
}

export function createRowContextMenu(opts: {
  root: HTMLElement;
  viewport: HTMLElement;
  dataRowCount: number;
  clampRow(row: number): number;
  onClearRow(row: number): void;
  onCopyRow(row: number): void;
  onSelectRow(row: number): void;
}): RowContextMenu {
  const { root, viewport, dataRowCount, clampRow, onClearRow, onCopyRow, onSelectRow } = opts;

  const menuEl = document.createElement('div');
  menuEl.className = 'sheet-context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', 'Row actions');
  menuEl.hidden = true;

  let activeRow: number | null = null;

  function hide(): void {
    menuEl.hidden = true;
    activeRow = null;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeydown, true);
    viewport.removeEventListener('scroll', hide);
  }

  function onDocPointerDown(ev: PointerEvent): void {
    if (menuEl.contains(ev.target as Node)) return;
    hide();
  }

  function onDocKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') hide();
  }

  function showAt(clientX: number, clientY: number, row: number): void {
    hide();
    activeRow = row;
    menuEl.hidden = false;
    const pad = 6;
    menuEl.style.left = `${clientX}px`;
    menuEl.style.top = `${clientY}px`;
    const r = menuEl.getBoundingClientRect();
    let left = clientX;
    let top = clientY;
    if (left + r.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - r.width - pad);
    }
    if (top + r.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - r.height - pad);
    }
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown, true);
    viewport.addEventListener('scroll', hide, { passive: true });
  }

  function makeItem(label: string, iconPh: string, onActivate: (row: number) => void): HTMLButtonElement {
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
      const row = activeRow;
      hide();
      if (row !== null) onActivate(row);
    });
    return btn;
  }

  menuEl.append(
    makeItem('Clear row contents', 'ph-eraser', onClearRow),
    makeItem('Copy row', 'ph-copy', onCopyRow),
    makeItem('Select row', 'ph-rows', onSelectRow),
  );
  root.appendChild(menuEl);

  viewport.addEventListener(
    'contextmenu',
    (e) => {
      const t = e.target as HTMLElement;
      const cell = t.closest('.sheet-cell');
      const gutter = t.closest('.sheet-row-gutter');
      let rawRow: number | null = null;
      if (cell && viewport.contains(cell)) {
        rawRow = Number((cell as HTMLElement).dataset.row);
      } else if (gutter && viewport.contains(gutter)) {
        rawRow = Number((gutter as HTMLElement).dataset.row);
      }
      if (rawRow === null || !Number.isFinite(rawRow)) return;
      if (rawRow > dataRowCount) return;
      e.preventDefault();
      e.stopPropagation();
      showAt(e.clientX, e.clientY, clampRow(rawRow));
    },
    true,
  );

  return { hide };
}
