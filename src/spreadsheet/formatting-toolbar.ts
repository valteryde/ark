import type { SpreadsheetMountHandle, UiToolbarCapability } from './types.ts';

const BORDER_INSET = 'inset 0 0 0 1px #64748b';

const CAP_ICONS: Record<UiToolbarCapability, string> = {
  undo: 'ph-arrow-counter-clockwise',
  redo: 'ph-arrow-clockwise',
  'format-bold': 'ph-text-b',
  'format-italic': 'ph-text-italic',
  'format-strikethrough': 'ph-text-strikethrough',
  fill: 'ph-paint-bucket',
  borders: 'ph-grid-four',
  merge: 'ph-columns',
  align: 'ph-text-align-left',
  link: 'ph-link',
  filter: 'ph-funnel',
  functions: 'ph-sigma',
};

/** Capability groups: each group is preceded by a separator (after zoom). */
const TOOLBAR_GROUPS: UiToolbarCapability[][] = [
  ['undo', 'redo'],
  ['format-bold', 'format-italic', 'format-strikethrough'],
  ['fill', 'borders', 'merge'],
  ['align'],
  ['link'],
  ['filter', 'functions'],
];

function sep(): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'app-toolbar__sep';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function isBoldValue(v: string | undefined): boolean {
  if (!v) return false;
  const x = v.trim().toLowerCase();
  return x === 'bold' || x === 'bolder' || x === '700' || x === '600';
}

function toggleDecorationToken(current: string | undefined, token: string): string | undefined {
  const parts = (current ?? '').split(/\s+/).filter(Boolean);
  const has = parts.includes(token);
  const next = has ? parts.filter((p) => p !== token) : [...parts, token];
  if (next.length === 0) return undefined;
  return next.join(' ');
}

function iconButton(iconPh: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'app-toolbar__icon';
  b.title = title;
  const i = document.createElement('i');
  i.className = `ph ${iconPh}`;
  i.setAttribute('aria-hidden', 'true');
  b.appendChild(i);
  return b;
}

/**
 * Renders formatting controls from `capabilities` and wires them to `sheet`.
 * Non-styling capabilities (undo, redo, filter, functions) render disabled stubs; merge shows a notice.
 */
export function mountFormattingToolbar(
  host: HTMLElement,
  sheet: SpreadsheetMountHandle,
  capabilities: Set<UiToolbarCapability>,
): void {
  host.replaceChildren();
  host.classList.add('app-toolbar__dynamic');

  const zoom = document.createElement('span');
  zoom.className = 'app-toolbar__zoom';
  zoom.textContent = '100%';
  host.appendChild(zoom);
  host.appendChild(sep());

  const ui: {
    bold?: HTMLButtonElement;
    italic?: HTMLButtonElement;
    strike?: HTMLButtonElement;
    borders?: HTMLButtonElement;
    alignL?: HTMLButtonElement;
    alignC?: HTMLButtonElement;
    alignR?: HTMLButtonElement;
  } = {};

  let firstGroup = true;

  for (const group of TOOLBAR_GROUPS) {
    const caps = group.filter((c) => capabilities.has(c));
    if (caps.length === 0) continue;

    if (!firstGroup) host.appendChild(sep());
    firstGroup = false;

    for (const cap of caps) {
      if (cap === 'align') {
        const wrap = document.createElement('span');
        wrap.className = 'app-toolbar__align-group';
        const mk = (
          icon: string,
          title: string,
          value: string | undefined,
          ref: 'alignL' | 'alignC' | 'alignR',
        ) => {
          const b = iconButton(icon, title);
          b.addEventListener('click', () => {
            sheet.mergeCellStyleOnSelection(
              value === undefined ? { 'justify-content': undefined } : { 'justify-content': value },
            );
          });
          ui[ref] = b;
          wrap.appendChild(b);
        };
        mk('ph-text-align-left', 'Align left', undefined, 'alignL');
        mk('ph-text-align-center', 'Align center', 'center', 'alignC');
        mk('ph-text-align-right', 'Align right', 'flex-end', 'alignR');
        host.appendChild(wrap);
        continue;
      }

      if (cap === 'undo' || cap === 'redo' || cap === 'filter' || cap === 'functions') {
        const b =
          cap === 'functions'
            ? (() => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'app-toolbar__fx';
                btn.disabled = true;
                btn.title = 'Functions';
                const i = document.createElement('i');
                i.className = `ph ${CAP_ICONS[cap]}`;
                i.setAttribute('aria-hidden', 'true');
                btn.appendChild(i);
                return btn;
              })()
            : (() => {
                const btn = iconButton(CAP_ICONS[cap], cap === 'undo' ? 'Undo' : cap === 'redo' ? 'Redo' : 'Filter');
                btn.disabled = true;
                return btn;
              })();
        host.appendChild(b);
        continue;
      }

      if (cap === 'format-bold') {
        const b = iconButton(CAP_ICONS[cap], 'Bold');
        b.addEventListener('click', () => {
          const on = sheet.everyTargetCellStyle('font-weight', isBoldValue);
          sheet.mergeCellStyleOnSelection({ 'font-weight': on ? undefined : '700' });
        });
        ui.bold = b;
        host.appendChild(b);
        continue;
      }

      if (cap === 'format-italic') {
        const b = iconButton(CAP_ICONS[cap], 'Italic');
        b.addEventListener('click', () => {
          const on = sheet.everyTargetCellStyle('font-style', (v) => (v ?? '').toLowerCase() === 'italic');
          sheet.mergeCellStyleOnSelection({ 'font-style': on ? undefined : 'italic' });
        });
        ui.italic = b;
        host.appendChild(b);
        continue;
      }

      if (cap === 'format-strikethrough') {
        const b = iconButton(CAP_ICONS[cap], 'Strikethrough');
        b.addEventListener('click', () => {
          sheet.mergeCellStyleOnEachTarget((row, col) => {
            const cur = sheet.getCellStyleAt(row, col)?.['text-decoration-line'];
            const next = toggleDecorationToken(cur, 'line-through');
            return { 'text-decoration-line': next };
          });
        });
        ui.strike = b;
        host.appendChild(b);
        continue;
      }

      if (cap === 'fill') {
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'app-toolbar__color-input';
        colorInput.value = '#fff59d';
        colorInput.setAttribute('aria-hidden', 'true');
        colorInput.tabIndex = -1;
        colorInput.addEventListener('input', () => {
          sheet.mergeCellStyleOnSelection({ 'background-color': colorInput.value });
        });
        const b = iconButton(CAP_ICONS[cap], 'Fill color');
        b.addEventListener('click', () => colorInput.click());
        host.appendChild(colorInput);
        host.appendChild(b);
        continue;
      }

      if (cap === 'borders') {
        const b = iconButton(CAP_ICONS[cap], 'Cell borders');
        b.addEventListener('click', () => {
          const on = sheet.everyTargetCellStyle(
            'box-shadow',
            (v) => (v ?? '').trim() === BORDER_INSET,
          );
          sheet.mergeCellStyleOnSelection({ 'box-shadow': on ? undefined : BORDER_INSET });
        });
        ui.borders = b;
        host.appendChild(b);
        continue;
      }

      if (cap === 'merge') {
        const b = iconButton(CAP_ICONS[cap], 'Merge cells');
        b.addEventListener('click', () => {
          window.alert('Merge cells is not supported in this grid yet.');
        });
        host.appendChild(b);
        continue;
      }

      if (cap === 'link') {
        const b = iconButton(CAP_ICONS[cap], 'Link');
        b.addEventListener('click', () => {
          const url = window.prompt('Link URL', 'https://');
          if (url === null) return;
          const trimmed = url.trim();
          if (trimmed === '') {
            sheet.mergeCellStyleOnEachTarget((row, col) => {
              const cur = sheet.getCellStyleAt(row, col)?.['text-decoration-line'];
              const next = toggleDecorationToken(cur, 'underline');
              const patch: Record<string, string | undefined> = {
                color: undefined,
                'text-decoration-line': next,
              };
              return patch;
            });
            return;
          }
          sheet.mergeCellStyleOnEachTarget((row, col) => {
            const cur = sheet.getCellStyleAt(row, col)?.['text-decoration-line'];
            const nextLine = toggleDecorationToken(cur, 'underline');
            return {
              'text-decoration-line': nextLine,
              color: '#2563eb',
            };
          });
        });
        host.appendChild(b);
        continue;
      }
    }
  }

  function refreshToggleStates(): void {
    if (ui.bold) {
      const on = sheet.everyTargetCellStyle('font-weight', isBoldValue);
      ui.bold.classList.toggle('app-toolbar__icon--active', on);
      ui.bold.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (ui.italic) {
      const on = sheet.everyTargetCellStyle('font-style', (v) => (v ?? '').toLowerCase() === 'italic');
      ui.italic.classList.toggle('app-toolbar__icon--active', on);
      ui.italic.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (ui.strike) {
      const on = sheet.everyTargetCellStyle('text-decoration-line', (v) =>
        (v ?? '').split(/\s+/).includes('line-through'),
      );
      ui.strike.classList.toggle('app-toolbar__icon--active', on);
      ui.strike.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (ui.borders) {
      const on = sheet.everyTargetCellStyle(
        'box-shadow',
        (v) => (v ?? '').trim() === BORDER_INSET,
      );
      ui.borders.classList.toggle('app-toolbar__icon--active', on);
      ui.borders.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const aj = (v: string | undefined) => (v ?? '').toLowerCase();
    if (ui.alignL) {
      const on = sheet.everyTargetCellStyle('justify-content', (v) => !v || aj(v) === 'flex-start' || aj(v) === 'start');
      ui.alignL.classList.toggle('app-toolbar__icon--active', on);
      ui.alignL.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (ui.alignC) {
      const on = sheet.everyTargetCellStyle('justify-content', (v) => aj(v) === 'center');
      ui.alignC.classList.toggle('app-toolbar__icon--active', on);
      ui.alignC.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (ui.alignR) {
      const on = sheet.everyTargetCellStyle('justify-content', (v) =>
        aj(v) === 'flex-end' || aj(v) === 'end',
      );
      ui.alignR.classList.toggle('app-toolbar__icon--active', on);
      ui.alignR.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  refreshToggleStates();
  sheet.subscribeSelectionChange(refreshToggleStates);
}
