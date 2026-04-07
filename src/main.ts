import { getCollabClientIdentity } from './partner/collab-session.ts';
import { PartnerFetchError, fetchRoutingJson } from './partner/fetch-routing.ts';
import { initPartnerTokenFromLocation } from './partner/partner-token.ts';
import {
  normalizePartnerSheetPayload,
  partnerEffectiveRowCount,
  rowsToInitialMap,
  sheetPayloadToConfig,
} from './partner/map-sheet-payload.ts';
import type { PartnerSheetPayload } from './partner/types.ts';
import { openCollabWs } from './partner/collab-ws.ts';
import {
  createPartnerNotifyDataStore,
  type PartnerNotifyDataStore,
} from './partner/wrap-data-store.ts';
import {
  createRoadmapArchivePreset,
  createRoadmapBacklogPreset,
  createRoadmapPreset,
  mountFormattingToolbar,
  mountSpreadsheet,
  resolveEnabledUiCapabilities,
  type SpreadsheetMountHandle,
} from './spreadsheet';

const sheetMountEl = document.getElementById('sheet-mount');
const toolbarMountEl = document.getElementById('formatting-toolbar-mount');
const sheetPanelEl = document.getElementById('sheet-panel');
const sheetTabsEl = document.getElementById('sheet-tabs');
const chromeTitleEl = document.getElementById('app-chrome-title');
const partnerErrorEl = document.getElementById('partner-error');

if (!sheetMountEl) {
  throw new Error('Missing #sheet-mount');
}
if (!toolbarMountEl) {
  throw new Error('Missing #formatting-toolbar-mount');
}
if (!sheetPanelEl) {
  throw new Error('Missing #sheet-panel');
}
if (!sheetTabsEl) {
  throw new Error('Missing #sheet-tabs');
}
const sheetTabList: HTMLElement = sheetTabsEl;

const sheetHost: HTMLElement = sheetMountEl;
const toolbarHost: HTMLElement = toolbarMountEl;
const sheetPanel: HTMLElement = sheetPanelEl;

const SHEET_VIEWS = [
  { id: 'quarterly', label: 'Quarterly plan', create: createRoadmapPreset },
  { id: 'backlog', label: 'Backlog', create: createRoadmapBacklogPreset },
  { id: 'archive', label: 'Archive', create: createRoadmapArchivePreset },
] as const;

let tabButtons: HTMLElement[] = [];
let activeViewIndex = -1;

function hidePartnerError(): void {
  if (partnerErrorEl) {
    partnerErrorEl.hidden = true;
    partnerErrorEl.replaceChildren();
  }
}

function showPartnerError(err: unknown): void {
  if (!partnerErrorEl) return;
  partnerErrorEl.replaceChildren();
  const p = document.createElement('p');
  p.className = 'app-partner-error__text';
  p.textContent =
    err instanceof PartnerFetchError
      ? err.message
      : err instanceof Error
        ? err.message
        : 'Could not load partner app.';
  partnerErrorEl.appendChild(p);
  const hint = document.createElement('p');
  hint.className = 'app-partner-error__hint';
  hint.textContent =
    'Set ARK_BACKEND_URL on the Ark server. Open this UI at a sheet URL whose first path segment matches GET /ark/routing/{segment} on your partner (e.g. /clients). That segment must be listed in ARK_UI_ROUTES on the Ark server so the SPA is served.';
  partnerErrorEl.appendChild(hint);
  const a = document.createElement('a');
  a.className = 'app-partner-error__demo-link';
  a.href = `${window.location.pathname}?demo=1`;
  a.textContent = 'Run demo mode (local presets, no partner)';
  partnerErrorEl.appendChild(a);
  partnerErrorEl.hidden = false;
  sheetHost.replaceChildren();
  toolbarHost.replaceChildren();
  sheetTabList.replaceChildren();
  tabButtons = [];
}

function wireTabKeyboard(onSelect: (index: number) => void): void {
  sheetTabList.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    const current = tabButtons.findIndex((el) => el.classList.contains('app-sheet-tabs__tab--active'));
    if (current < 0) return;

    let next = current;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabButtons.length - 1;
    else if (e.key === 'ArrowLeft') next = current <= 0 ? tabButtons.length - 1 : current - 1;
    else if (e.key === 'ArrowRight') next = current >= tabButtons.length - 1 ? 0 : current + 1;

    if (next !== current) {
      e.preventDefault();
      onSelect(next);
      tabButtons[next]?.focus();
    }
  });
}

function setTabVisuals(index: number): void {
  tabButtons.forEach((el, i) => {
    const on = i === index;
    el.classList.toggle('app-sheet-tabs__tab--active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    el.tabIndex = on ? 0 : -1;
    if (on) {
      sheetPanel.setAttribute('aria-labelledby', el.id);
    }
  });
}

function initDemoMode(): void {
  hidePartnerError();
  sheetTabList.hidden = false;
  sheetPanel.setAttribute('role', 'tabpanel');
  if (chromeTitleEl) {
    chromeTitleEl.textContent = 'Product Roadmap 2026';
  }
  document.title = 'Product Roadmap 2026 — Ark';

  sheetTabList.replaceChildren();
  tabButtons = SHEET_VIEWS.map((v, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-sheet-tabs__tab';
    btn.id = `sheet-tab-${v.id}`;
    btn.role = 'tab';
    btn.setAttribute('aria-controls', 'sheet-panel');
    btn.dataset.sheetView = v.id;
    btn.textContent = v.label;
    btn.addEventListener('click', () => setActiveDemoTab(i));
    sheetTabList.appendChild(btn);
    return btn;
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'app-sheet-tabs__tab app-sheet-tabs__tab--add app-sheet-tabs__tab--with-icon';
  addBtn.title = 'Coming soon';
  addBtn.innerHTML = '<i class="ph ph-plus" aria-hidden="true"></i> Add new';
  addBtn.disabled = true;
  sheetTabList.appendChild(addBtn);

  wireTabKeyboard(setActiveDemoTab);

  function remountDemoSheet(viewIndex: number): void {
    const view = SHEET_VIEWS[viewIndex];
    if (!view) return;
    const config = view.create();
    sheetHost.replaceChildren();
    const sheet = mountSpreadsheet(sheetHost, config);
    toolbarHost.replaceChildren();
    mountFormattingToolbar(
      toolbarHost,
      sheet,
      resolveEnabledUiCapabilities(config.enabledUiCapabilities),
    );
  }

  function setActiveDemoTab(index: number): void {
    if (index === activeViewIndex) return;
    activeViewIndex = index;
    setTabVisuals(index);
    remountDemoSheet(index);
  }

  setActiveDemoTab(0);
}

function pathSegmentFromLocation(): string {
  return window.location.pathname.replace(/^\//, '').split('/').filter(Boolean)[0] ?? '';
}

function initPartnerMode(): void {
  initPartnerTokenFromLocation();
  hidePartnerError();
  sheetTabList.hidden = true;
  sheetTabList.replaceChildren();
  tabButtons = [];
  sheetPanel.setAttribute('role', 'region');
  sheetPanel.setAttribute('aria-label', 'Spreadsheet');
  sheetPanel.removeAttribute('aria-labelledby');

  if (chromeTitleEl) {
    chromeTitleEl.textContent = 'Ark';
  }
  document.title = 'Ark';

  const collabIdentity = getCollabClientIdentity();

  let liveHandle: SpreadsheetMountHandle | null = null;
  let liveStore: PartnerNotifyDataStore | null = null;
  let loadSeq = 0;
  let activeSheetPath: string | null = null;
  let loadedRoutingPath: string | null = null;
  let lastPartnerPayload: PartnerSheetPayload | null = null;
  let pendingPastePlain: string | null = null;

  const remotePeers = new Map<
    string,
    { row: number; col: number; mode: 'navigate' | 'edit'; markerHue: number; ts: number }
  >();

  let presenceUnsub: (() => void) | null = null;
  let presenceFocusHandler: (() => void) | null = null;
  let presenceRaf: number | null = null;

  function flushRemotePresenceToGrid(): void {
    if (!liveHandle) return;
    liveHandle.setRemoteCollabPresence(
      [...remotePeers.entries()].map(([clientId, v]) => ({
        clientId,
        row: v.row,
        col: v.col,
        mode: v.mode,
        markerHue: v.markerHue,
      })),
    );
  }

  function clearPresenceWiring(): void {
    if (presenceUnsub) {
      presenceUnsub();
      presenceUnsub = null;
    }
    if (presenceFocusHandler) {
      sheetHost.removeEventListener('focusin', presenceFocusHandler, true);
      sheetHost.removeEventListener('focusout', presenceFocusHandler, true);
      presenceFocusHandler = null;
    }
    if (presenceRaf !== null) {
      cancelAnimationFrame(presenceRaf);
      presenceRaf = null;
    }
  }

  let remountPartnerSheetFromPayload: (
    routingPath: string,
    payload: PartnerSheetPayload,
    resetPresence: boolean,
  ) => void;

  const collab = openCollabWs({
    getActiveSheetPath: () => activeSheetPath,
    getFallbackColumns: () => lastPartnerPayload?.columns ?? null,
    localClientId: collabIdentity.clientId,
    onRemoteCommitted(row, col, value, meta) {
      if (!liveHandle || !liveStore) return;
      liveStore.withRemoteApply(() => {
        liveHandle!.applyExternalValue(
          row,
          col,
          value,
          meta?.markerHue !== undefined ? { remoteMarkerHue: meta.markerHue } : undefined,
        );
      });
    },
    onRemotePresence(msg) {
      if (msg.kind === 'presence_clear') {
        remotePeers.delete(msg.clientId);
      } else {
        remotePeers.set(msg.clientId, {
          row: msg.row,
          col: msg.col,
          mode: msg.mode,
          markerHue: msg.markerHue ?? 210,
          ts: Date.now(),
        });
      }
      flushRemotePresenceToGrid();
    },
    onCellPersistFailed(info) {
      if (!liveHandle) return;
      const path = activeSheetPath;
      if (info.sheetPath !== null && path !== null && info.sheetPath !== path) {
        return;
      }
      const detail = info.message?.trim() || undefined;
      liveHandle.showCellPersistError(info.row, info.col, detail);
    },
    onSheetTruth(truth) {
      const path = loadedRoutingPath;
      if (path === null || truth.sheetPath !== path) return;
      remountPartnerSheetFromPayload(path, truth.payload, true);
    },
  });

  remountPartnerSheetFromPayload = (
    routingPath: string,
    payload: PartnerSheetPayload,
    resetPresence: boolean,
  ): void => {
    lastPartnerPayload = {
      columns: payload.columns.map((c) => ({ ...c })),
      rows: [...payload.rows],
      title: payload.title,
      description: payload.description,
      rowCount: payload.rowCount,
      defaultRowHeightPx: payload.defaultRowHeightPx,
      enabledUiCapabilities: payload.enabledUiCapabilities,
    };
    const initial = rowsToInitialMap(payload.columns, payload.rows);
    const pathForCollab = routingPath;
    clearPresenceWiring();
    if (resetPresence) {
      remotePeers.clear();
    }
    const store = createPartnerNotifyDataStore(payload.columns, initial, (ev) => {
      collab.sendCommitted({
        type: 'cell.value_committed',
        row: ev.row,
        col: ev.col,
        columnId: ev.columnId,
        value: ev.value,
        sheetPath: pathForCollab,
        clientId: collabIdentity.clientId,
        markerHue: collabIdentity.markerHue,
        ...(ev.recordId !== undefined ? { recordId: ev.recordId } : {}),
      });
    }) as PartnerNotifyDataStore;
    const config = sheetPayloadToConfig(payload, store);
    config.growRowCountForPaste = ({ minRowCount, plain }) => {
      if (!lastPartnerPayload) return;
      pendingPastePlain = plain;
      const nextCount = Math.max(partnerEffectiveRowCount(lastPartnerPayload), minRowCount);
      lastPartnerPayload = { ...lastPartnerPayload, rowCount: nextCount };
      remountPartnerSheetFromPayload(routingPath, lastPartnerPayload, false);
    };
    config.suppressOutboundSyncDuring = (fn) => {
      store.withRemoteApply(fn);
    };
    sheetHost.replaceChildren();
    liveHandle = mountSpreadsheet(sheetHost, config);
    liveStore = store;
    toolbarHost.replaceChildren();
    mountFormattingToolbar(
      toolbarHost,
      liveHandle,
      resolveEnabledUiCapabilities(config.enabledUiCapabilities),
    );
    presenceFocusHandler = () => scheduleLocalPresenceSend();
    sheetHost.addEventListener('focusin', presenceFocusHandler, true);
    sheetHost.addEventListener('focusout', presenceFocusHandler, true);
    presenceUnsub = liveHandle.subscribeSelectionChange(scheduleLocalPresenceSend);
    flushRemotePresenceToGrid();
    scheduleLocalPresenceSend();
    if (chromeTitleEl) {
      chromeTitleEl.textContent = payload.title?.trim() ? payload.title : routingPath;
    }
    document.title = payload.title?.trim() ? payload.title : routingPath;
    const replay = pendingPastePlain;
    if (replay && liveHandle) {
      pendingPastePlain = null;
      queueMicrotask(() => {
        liveHandle?.replayClipboardPaste(replay);
      });
    }
  };

  function scheduleLocalPresenceSend(): void {
    if (presenceRaf !== null) return;
    presenceRaf = requestAnimationFrame(() => {
      presenceRaf = null;
      if (activeSheetPath === null || liveHandle === null) return;
      const p = liveHandle.getCollabPresencePayload();
      if (!p) return;
      collab.sendPresence({
        type: 'cell.presence',
        row: p.row,
        col: p.col,
        mode: p.mode,
        sheetPath: activeSheetPath,
        clientId: collabIdentity.clientId,
        markerHue: collabIdentity.markerHue,
      });
    });
  }

  window.setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, v] of remotePeers) {
      if (now - v.ts > 12000) {
        remotePeers.delete(id);
        changed = true;
      }
    }
    if (changed) flushRemotePresenceToGrid();
  }, 3000);

  /* Keep local cursor visible to peers while idle on a cell (presence TTL is 12s). */
  window.setInterval(() => {
    if (document.visibilityState !== 'visible' || activeSheetPath === null || liveHandle === null) return;
    scheduleLocalPresenceSend();
  }, 4000);

  window.addEventListener('pagehide', () => {
    const path = activeSheetPath;
    if (path === null) return;
    collab.sendPresenceClear({
      type: 'cell.presence_clear',
      sheetPath: path,
      clientId: collabIdentity.clientId,
    });
  });

  async function loadPartnerSheet(routingPath: string): Promise<void> {
    if (routingPath === loadedRoutingPath && liveHandle) {
      return;
    }

    const seq = ++loadSeq;

    try {
      activeSheetPath = null;
      const raw = await fetchRoutingJson<unknown>(routingPath);
      if (seq !== loadSeq) return;
      const payload = normalizePartnerSheetPayload(raw);
      if (!payload) {
        throw new Error(`Invalid sheet payload for "${routingPath}"`);
      }
      remountPartnerSheetFromPayload(routingPath, payload, true);
      activeSheetPath = routingPath;
      loadedRoutingPath = routingPath;
    } catch (e) {
      if (seq !== loadSeq) return;
      loadedRoutingPath = null;
      lastPartnerPayload = null;
      showPartnerError(e);
      collab.close();
    }
  }

  function boot(): void {
    const seg = pathSegmentFromLocation();
    if (!seg) {
      collab.close();
      showPartnerError(
        new PartnerFetchError(
          'No sheet in the URL. Open a path such as /clients — one spreadsheet per URL; there is no app-wide navigation.',
          404,
        ),
      );
      return;
    }
    void loadPartnerSheet(seg);
  }

  window.addEventListener('popstate', () => {
    const seg = pathSegmentFromLocation();
    if (!seg) {
      loadedRoutingPath = null;
      showPartnerError(
        new PartnerFetchError(
          'No sheet in the URL. Open a path such as /clients — one spreadsheet per URL.',
          404,
        ),
      );
      return;
    }
    void loadPartnerSheet(seg);
  });

  boot();
}

function init(): void {
  const demo = new URLSearchParams(window.location.search).has('demo');
  if (demo) {
    initDemoMode();
    return;
  }

  try {
    initPartnerMode();
  } catch (e) {
    showPartnerError(e);
  }
}

void init();
