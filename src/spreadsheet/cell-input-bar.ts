/**
 * The value bar: a single-line editor above the grid, mirroring the active cell
 * (Google Sheets / Excel "formula bar", minus formulas). A plain `<input>` is
 * used on purpose so the mouse can place the caret mid-string and native
 * text-selection / undo behave like any form field.
 *
 * All grid state (which cell is active, commits, validation, movement) is
 * injected by `mount-spreadsheet.ts`; this module only owns DOM and key intent.
 */

export type ValueBarMove = 'up' | 'down' | 'left' | 'right';

export interface CellInputBar {
  /** Bar shell; inserted as the first child of `.sheet-root`, above the viewport. */
  el: HTMLDivElement;
  input: HTMLInputElement;
  /** Coordinate label (`C3`, or `A1:C3` for a range). */
  addressEl: HTMLSpanElement;
  /** Column header (or a range summary) shown beside the address. */
  hintEl: HTMLSpanElement;
  /** Inline rejection message (`Enter a number`, `Pick a value from the list`). */
  statusEl: HTMLSpanElement;
  hasFocus(): boolean;
  focus(): void;
  blur(): void;
  /** Replace the bar's text (does not fire `onInput`). */
  setValue(text: string): void;
  getValue(): string;
  /** Address + header hint for the coordinate being edited. */
  setLabel(address: string, hint: string, multi: boolean): void;
  /** Read-only cells (system columns, link buttons, padding rows) disable editing. */
  setEditable(editable: boolean): void;
  /** Marks that an edit is pending (in-cell editor or bar). */
  setPending(pending: boolean): void;
  /** Show or clear the inline rejection message. */
  setStatus(message: string | null): void;
}

export function createCellInputBar(opts: {
  /** `.sheet-root` — the bar is prepended here so it sits above the grid. */
  root: HTMLElement;
  onInput(text: string): void;
  onCommitMove(move: ValueBarMove): void;
  onCommit(): void;
  onRevert(): void;
  onFocusIn(): void;
  onFocusOut(): void;
}): CellInputBar {
  const el = document.createElement('div');
  el.className = 'sheet-input-bar';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Cell value editor');

  const addressEl = document.createElement('span');
  addressEl.className = 'sheet-input-bar__address';
  addressEl.textContent = '';

  const hintEl = document.createElement('span');
  hintEl.className = 'sheet-input-bar__hint';
  hintEl.textContent = '';

  const fieldWrap = document.createElement('div');
  fieldWrap.className = 'sheet-input-bar__field';

  const glyph = document.createElement('i');
  glyph.className = 'ph ph-cursor-text sheet-input-bar__glyph';
  glyph.setAttribute('aria-hidden', 'true');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sheet-input-bar__input';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.setAttribute('aria-label', 'Active cell value');

  const statusEl = document.createElement('span');
  statusEl.className = 'sheet-input-bar__status';
  statusEl.setAttribute('role', 'status');
  statusEl.hidden = true;

  fieldWrap.append(glyph, input);
  el.append(addressEl, hintEl, fieldWrap, statusEl);

  const head = opts.root.firstElementChild;
  if (head) opts.root.insertBefore(el, head);
  else opts.root.appendChild(el);

  input.addEventListener('input', () => {
    opts.onInput(input.value);
  });

  input.addEventListener('focus', () => opts.onFocusIn());

  input.addEventListener('blur', () => {
    opts.onFocusOut();
    opts.onCommit();
  });

  input.addEventListener('keydown', (e) => {
    const key = e.key;

    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      opts.onCommitMove(e.shiftKey ? 'up' : 'down');
      return;
    }
    if (key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      opts.onCommitMove(e.shiftKey ? 'left' : 'right');
      return;
    }
    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      opts.onRevert();
      input.blur();
      return;
    }
    // Arrow keys move the text caret here (unlike in-cell editing, where plain
    // arrows commit and move the selection). Home/End likewise stay local.
  });

  return {
    el,
    input,
    addressEl,
    hintEl,
    statusEl,
    hasFocus: () => document.activeElement === input,
    focus: () => input.focus(),
    blur: () => input.blur(),
    setValue(text: string) {
      if (input.value !== text) input.value = text;
    },
    getValue: () => input.value,
    setLabel(address: string, hint: string, multi: boolean) {
      addressEl.textContent = address;
      hintEl.textContent = hint;
      el.classList.toggle('sheet-input-bar--multi', multi);
    },
    setEditable(editable: boolean) {
      input.readOnly = !editable;
      el.classList.toggle('sheet-input-bar--readonly', !editable);
      input.tabIndex = editable ? 0 : -1;
      if (editable) input.removeAttribute('aria-readonly');
      else input.setAttribute('aria-readonly', 'true');
    },
    setPending(pending: boolean) {
      el.classList.toggle('sheet-input-bar--pending', pending);
    },
    setStatus(message: string | null) {
      if (!message) {
        statusEl.hidden = true;
        statusEl.textContent = '';
        el.classList.remove('sheet-input-bar--invalid');
        return;
      }
      statusEl.hidden = false;
      statusEl.textContent = message;
      el.classList.add('sheet-input-bar--invalid');
    },
  };
}
