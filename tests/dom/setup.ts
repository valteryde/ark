// deno-lint-ignore-file no-explicit-any
import { JSDOM } from 'jsdom';

/**
 * Minimal browser environment for testing DOM-mounting modules under Deno.
 *
 * The spreadsheet code reads browser globals (`document`, `window`,
 * `requestAnimationFrame`, `HTMLElement`, …) lazily at call time, so we install
 * a JSDOM window on `globalThis` before mounting and restore the originals after.
 */

/** Globals we swap in from the JSDOM window; restored on teardown. */
const MANAGED_GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'Node',
  'Element',
  'KeyboardEvent',
  'MouseEvent',
  'ClipboardEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

const saved = new Map<string, { present: boolean; value: unknown }>();

export interface DomEnv {
  dom: JSDOM;
  window: any;
  document: Document;
  /** Create a container already attached to `document.body`. */
  makeContainer(): HTMLElement;
}

export function setupDom(html = '<!doctype html><html><body></body></html>'): DomEnv {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window as any;
  const g = globalThis as any;

  const values: Record<string, unknown> = {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLDivElement: w.HTMLDivElement,
    HTMLSpanElement: w.HTMLSpanElement,
    Node: w.Node,
    Element: w.Element,
    KeyboardEvent: w.KeyboardEvent,
    MouseEvent: w.MouseEvent,
    ClipboardEvent: w.ClipboardEvent,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame:
      w.requestAnimationFrame?.bind(w) ??
      ((cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0)),
    cancelAnimationFrame:
      w.cancelAnimationFrame?.bind(w) ?? ((id: number) => clearTimeout(id)),
  };

  saved.clear();
  for (const key of MANAGED_GLOBALS) {
    saved.set(key, { present: key in g, value: g[key] });
    g[key] = values[key];
  }

  // JSDOM does not implement layout-driven scrolling; the grid calls these when
  // moving the active cell. No-op stubs keep navigation logic exercisable.
  if (typeof w.Element.prototype.scrollIntoView !== 'function') {
    w.Element.prototype.scrollIntoView = () => {};
  }

  return {
    dom,
    window: w,
    document: w.document as Document,
    makeContainer() {
      const el = w.document.createElement('div');
      w.document.body.appendChild(el);
      return el as HTMLElement;
    },
  };
}

export function teardownDom(): void {
  const g = globalThis as any;
  for (const [key, prev] of saved) {
    if (prev.present) g[key] = prev.value;
    else delete g[key];
  }
  saved.clear();
}

/** Run `fn` with a fresh DOM env, tearing down afterwards even on failure. */
export function withDom(fn: (env: DomEnv) => void): void {
  const env = setupDom();
  try {
    fn(env);
  } finally {
    teardownDom();
  }
}
