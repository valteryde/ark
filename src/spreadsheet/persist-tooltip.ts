/**
 * Singleton tooltip shown for per-cell "save failed" dots. Positioned as a fixed
 * element against a dot anchor; a single instance is reused across all cells/sheets.
 */

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

export function hidePersistTooltip(): void {
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

/** Hide only if `el` is the current tooltip anchor (used when removing a dot). */
export function hidePersistTooltipIfAnchor(el: Element | null): void {
  if (el && persistTooltipAnchor === el) hidePersistTooltip();
}

export function scheduleHidePersistTooltip(): void {
  if (persistTooltipHideTimer !== null) clearTimeout(persistTooltipHideTimer);
  persistTooltipHideTimer = window.setTimeout(() => {
    persistTooltipHideTimer = null;
    hidePersistTooltip();
  }, 100);
}

export function cancelHidePersistTooltip(): void {
  if (persistTooltipHideTimer !== null) {
    clearTimeout(persistTooltipHideTimer);
    persistTooltipHideTimer = null;
  }
}

export function showPersistTooltipForDot(anchor: HTMLElement, text: string): void {
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
