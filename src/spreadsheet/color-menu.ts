import { canonicalCssColor } from './cell-display.ts';
import type { SpreadsheetMountHandle } from './types.ts';

/** Document palette used by Google Sheets / Docs (10 columns, light to dark). */
const PALETTE: readonly (readonly string[])[] = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
  ['#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47'],
  ['#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'],
];

const MENU_ID = 'toolbar-color-menu';
const MAX_RECENT = 10;

type CssColorProperty = 'color' | 'background-color';

type OpenColorMenu = {
  menu: HTMLElement;
  anchor: HTMLElement;
  close: () => void;
};

let openControl: OpenColorMenu | null = null;

const recentBySheet = new WeakMap<SpreadsheetMountHandle, Map<CssColorProperty, string[]>>();

function onDocumentPointerDown(event: Event): void {
  if (!openControl) return;
  if ('button' in event && (event as MouseEvent).button !== 0) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (openControl.menu.contains(target) || openControl.anchor.contains(target)) return;
  openControl.close();
}

function onDocumentKeyDown(event: Event): void {
  if (!openControl || !(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  openControl.close();
}

function onDocumentResize(): void {
  if (!openControl) return;
  if (!openControl.anchor.isConnected) {
    openControl.close();
    return;
  }
  placeMenu(openControl.menu, openControl.anchor);
}

function placeMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const left = Math.min(Math.max(rect.left, margin), maxLeft);
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - margin) {
    const above = rect.top - height - 4;
    if (above >= margin) top = above;
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function sessionRecent(sheet: SpreadsheetMountHandle, property: CssColorProperty): string[] {
  let byProp = recentBySheet.get(sheet);
  if (!byProp) {
    byProp = new Map();
    recentBySheet.set(sheet, byProp);
  }
  let list = byProp.get(property);
  if (!list) {
    list = [];
    byProp.set(property, list);
  }
  return list;
}

function remember(sheet: SpreadsheetMountHandle, property: CssColorProperty, color: string): void {
  const list = sessionRecent(sheet, property);
  const existing = list.indexOf(color);
  if (existing >= 0) list.splice(existing, 1);
  list.unshift(color);
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
}

function committedHex(text: string, allowShort: boolean): string | null {
  const trimmed = text.trim();
  const body = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const long = /^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(body);
  const short = allowShort && /^[0-9a-fA-F]{3}$/.test(body);
  if (!long && !short) return null;
  return canonicalCssColor(`#${body}`);
}

/** Close a toolbar color menu left open across a toolbar remount. */
export function dismissOpenColorMenu(): void {
  openControl?.close();
}

/**
 * Fill or text color button. Clicking opens a palette; the native color input
 * stays inside that menu as the custom picker.
 */
export function mountToolbarColorMenu(options: {
  host: HTMLElement;
  sheet: SpreadsheetMountHandle;
  icon: string;
  title: string;
  cssProperty: CssColorProperty;
  resetLabel: string;
  fallbackColor: string;
}): void {
  const { host, sheet, icon, title, cssProperty, resetLabel, fallbackColor } = options;
  const fallback = canonicalCssColor(fallbackColor) ?? '#000000';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-toolbar__icon app-toolbar__color-btn';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');

  const glyph = document.createElement('span');
  glyph.className = 'app-toolbar__color-glyph';
  const main = document.createElement('span');
  main.className = 'app-toolbar__color-main';
  const iconEl = document.createElement('i');
  iconEl.className = `ph ${icon}`;
  iconEl.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('span');
  bar.className = 'app-toolbar__color-bar';
  bar.setAttribute('aria-hidden', 'true');
  main.append(iconEl, bar);
  const caret = document.createElement('i');
  caret.className = 'ph ph-caret-down app-toolbar__color-caret';
  caret.setAttribute('aria-hidden', 'true');
  glyph.append(main, caret);
  btn.appendChild(glyph);

  const menu = document.createElement('div');
  menu.className = 'app-color-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', title);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'app-color-menu__reset';
  const none = document.createElement('span');
  none.className = 'app-color-menu__none';
  none.setAttribute('aria-hidden', 'true');
  resetBtn.append(none, document.createTextNode(resetLabel));

  const grid = document.createElement('div');
  grid.className = 'app-color-menu__grid';

  const recent = document.createElement('div');
  recent.className = 'app-color-menu__recent';
  recent.hidden = true;
  const recentLabel = document.createElement('div');
  recentLabel.className = 'app-color-menu__label';
  recentLabel.textContent = 'Recent';
  const recentRow = document.createElement('div');
  recentRow.className = 'app-color-menu__recent-row';
  recent.append(recentLabel, recentRow);

  const custom = document.createElement('div');
  custom.className = 'app-color-menu__custom';
  const customLabel = document.createElement('div');
  customLabel.className = 'app-color-menu__label';
  customLabel.textContent = 'Custom';
  const customRow = document.createElement('div');
  customRow.className = 'app-color-menu__custom-row';
  const native = document.createElement('input');
  native.type = 'color';
  native.className = 'app-color-menu__native';
  native.value = fallback;
  native.setAttribute('aria-label', 'Custom color');
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'app-color-menu__hex';
  hexInput.value = fallback;
  hexInput.maxLength = 9;
  hexInput.spellcheck = false;
  hexInput.autocomplete = 'off';
  hexInput.setAttribute('aria-label', 'Hex color');
  hexInput.setAttribute('autocapitalize', 'off');
  hexInput.setAttribute('autocorrect', 'off');
  customRow.append(native, hexInput);
  custom.append(customLabel, customRow);
  menu.append(resetBtn, grid, recent, custom);

  let batching = false;
  let pendingRemember: string | null = null;
  let nativeGesture = false;

  function endBatch(): void {
    if (!batching) return;
    const color = pendingRemember;
    pendingRemember = null;
    batching = false;
    if (color) remember(sheet, cssProperty, color);
    if (sheet.historyEnabled) sheet.endHistoryBatch();
  }

  function beginBatch(): void {
    if (batching || !sheet.historyEnabled) return;
    sheet.beginHistoryBatch();
    batching = true;
  }

  function currentColor(): string | null {
    const raw = sheet.uniformTargetCellStyle(cssProperty);
    if (!raw) return null;
    return canonicalCssColor(raw) ?? raw;
  }

  function syncBar(): void {
    const color = currentColor();
    if (cssProperty === 'background-color') {
      if (color) {
        bar.style.background = color;
        bar.classList.remove('app-toolbar__color-bar--empty');
      } else {
        bar.style.background = '';
        bar.classList.add('app-toolbar__color-bar--empty');
      }
      return;
    }
    bar.style.background = color ?? '#1a1a1a';
    bar.classList.remove('app-toolbar__color-bar--empty');
  }

  function markPressed(): void {
    const color = currentColor();
    for (const el of menu.querySelectorAll<HTMLButtonElement>('.app-color-menu__swatch')) {
      el.setAttribute('aria-pressed', el.dataset.color === color ? 'true' : 'false');
    }
    const cleared = sheet.everyTargetCellStyle(cssProperty, (value) => !value);
    resetBtn.setAttribute('aria-pressed', cleared ? 'true' : 'false');
  }

  function syncCustomControls(): void {
    const color = currentColor();
    const hex = color && /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
    native.value = hex;
    if (document.activeElement !== hexInput) hexInput.value = hex;
  }

  function apply(raw: string, mode: 'commit' | 'preview'): void {
    const color = canonicalCssColor(raw);
    if (!color) return;
    if (mode === 'preview') pendingRemember = color;
    else {
      pendingRemember = null;
      remember(sheet, cssProperty, color);
    }
    sheet.mergeCellStyleOnSelection({ [cssProperty]: color });
    syncBar();
    if (menu.isConnected) markPressed();
  }

  function collectRecent(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
      const color = canonicalCssColor(raw);
      if (!color || seen.has(color)) return;
      seen.add(color);
      out.push(color);
    };
    for (const color of sessionRecent(sheet, cssProperty)) push(color);
    for (const color of sheet.colorsUsedInSheet(cssProperty)) push(color);
    return out.slice(0, MAX_RECENT);
  }

  function makeSwatch(color: string): HTMLButtonElement {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'app-color-menu__swatch';
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.title = color;
    swatch.setAttribute('aria-label', color);
    swatch.setAttribute('aria-pressed', 'false');
    swatch.addEventListener('click', () => {
      endBatch();
      apply(color, 'commit');
      close();
    });
    return swatch;
  }

  function renderRecent(): void {
    const colors = collectRecent();
    recentRow.replaceChildren();
    if (colors.length === 0) {
      recent.hidden = true;
      return;
    }
    recent.hidden = false;
    for (const color of colors) recentRow.appendChild(makeSwatch(color));
  }

  for (const row of PALETTE) {
    for (const color of row) grid.appendChild(makeSwatch(color));
  }

  function close(): void {
    endBatch();
    nativeGesture = false;
    menu.remove();
    menu.removeAttribute('id');
    menu.style.visibility = 'hidden';
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-controls');
    if (openControl?.menu === menu) {
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      window.removeEventListener('resize', onDocumentResize);
      openControl = null;
    }
  }

  function open(): void {
    if (openControl?.menu === menu) return;
    openControl?.close();
    renderRecent();
    syncCustomControls();
    markPressed();
    menu.id = MENU_ID;
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    placeMenu(menu, btn);
    menu.style.visibility = 'visible';
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-controls', MENU_ID);
    openControl = { menu, anchor: btn, close };
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    window.addEventListener('resize', onDocumentResize);
  }

  btn.addEventListener('click', () => {
    if (openControl?.menu === menu) close();
    else open();
  });

  resetBtn.addEventListener('click', () => {
    endBatch();
    sheet.mergeCellStyleOnSelection({ [cssProperty]: undefined });
    syncBar();
    close();
  });

  native.addEventListener('input', () => {
    nativeGesture = true;
    beginBatch();
    if (document.activeElement !== hexInput) hexInput.value = native.value;
    apply(native.value, 'preview');
  });
  native.addEventListener('change', () => {
    const edited = nativeGesture;
    nativeGesture = false;
    if (edited) {
      if (document.activeElement !== hexInput) hexInput.value = native.value;
      apply(native.value, 'commit');
    }
    endBatch();
    if (edited && menu.isConnected) {
      renderRecent();
      markPressed();
    }
  });

  hexInput.addEventListener('input', () => {
    const color = committedHex(hexInput.value, false);
    if (!color) return;
    beginBatch();
    native.value = color;
    apply(color, 'preview');
  });
  hexInput.addEventListener('change', () => {
    const color = committedHex(hexInput.value, true);
    if (!color) {
      syncCustomControls();
      endBatch();
      return;
    }
    hexInput.value = color;
    native.value = color;
    apply(color, 'commit');
    endBatch();
    if (menu.isConnected) {
      renderRecent();
      markPressed();
    }
  });
  hexInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    hexInput.blur();
  });

  sheet.subscribeSelectionChange(() => {
    syncBar();
    if (!menu.isConnected) return;
    markPressed();
    if (document.activeElement !== native && document.activeElement !== hexInput) {
      syncCustomControls();
    }
  });

  syncBar();
  host.appendChild(btn);
}
