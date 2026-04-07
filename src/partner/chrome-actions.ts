import type { PartnerChromeAction } from './types.ts';

const MAX_CHROME_ACTIONS = 8;

function isSafePartnerHref(href: string): boolean {
  const t = href.trim();
  if (!t || t.length > 2048) return false;
  if (t.startsWith('/')) {
    return !t.startsWith('//') && !t.includes('\\');
  }
  try {
    const u = new URL(t);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function sanitizePhosphorIconName(icon: string): string | null {
  const s = icon.trim().toLowerCase();
  if (!s || s.length > 64) return null;
  if (!/^[a-z0-9-]+$/.test(s)) return null;
  return s;
}

/** Parse and validate `chromeActions` from sheet JSON. Invalid entries are dropped. */
export function normalizePartnerChromeActions(raw: unknown): PartnerChromeAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PartnerChromeAction[] = [];
  for (const item of raw) {
    if (out.length >= MAX_CHROME_ACTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label) continue;
    if (typeof o.href !== 'string' || !isSafePartnerHref(o.href)) continue;
    const action: PartnerChromeAction = { label, href: o.href.trim() };
    if (o.variant === 'primary' || o.variant === 'ghost') {
      action.variant = o.variant;
    }
    if (typeof o.icon === 'string') {
      const ic = sanitizePhosphorIconName(o.icon);
      if (ic) action.icon = ic;
    }
    if (o.openInNewTab === true) {
      action.openInNewTab = true;
    }
    out.push(action);
  }
  return out.length > 0 ? out : undefined;
}

export function mountPartnerChromeActions(
  host: HTMLElement,
  actions: PartnerChromeAction[] | undefined,
): void {
  host.replaceChildren();
  if (!actions?.length) return;
  for (const a of actions) {
    const el = document.createElement('a');
    el.href = a.href;
    el.classList.add('app-btn', a.variant === 'primary' ? 'app-btn--share' : 'app-btn--ghost');
    if (a.openInNewTab) {
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    if (a.icon) {
      el.classList.add('app-btn--with-icon');
      const i = document.createElement('i');
      i.className = `ph ph-${a.icon}`;
      i.setAttribute('aria-hidden', 'true');
      el.appendChild(i);
      el.appendChild(document.createTextNode(a.label));
    } else {
      el.textContent = a.label;
    }
    host.appendChild(el);
  }
}
