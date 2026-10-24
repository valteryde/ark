import { getCollabClientIdentity } from './partner/collab-session.ts';
import { PartnerFetchError, fetchRoutingJson } from './partner/fetch-routing.ts';
import { initPartnerTokenFromLocation } from './partner/partner-token.ts';
import {
  normalizePartnerSheetPayload,
  partnerEffectiveRowCount,
  rowsToInitialMap,
  sheetPayloadToConfig,
} from './partner/map-sheet-payload.ts';
import { mountPartnerChromeActions } from './partner/chrome-actions.ts';
import type { PartnerSheetPayload } from './partner/types.ts';
import { openCollabWs, type CollabConnectionState } from './partner/collab-ws.ts';
import { peerDisplayFromClientId } from './partner/presence-persona.ts';
import {
  createPartnerNotifyDataStore,
  type PartnerNotifyDataStore,
} from './partner/wrap-data-store.ts';
import {
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
const chromeActionsEl = document.getElementById('app-chrome-actions');
const chromeSearchHostEl = document.getElementById('app-chrome-search');
const chromeConnectionEl = document.getElementById('app-chrome-connection');
const chromeAboutToggleEl = document.getElementById('app-chrome-about-toggle') as
  | HTMLButtonElement
  | null;
const chromeAboutEl = document.getElementById('app-chrome-about');
const partnerErrorEl = document.getElementById('partner-error');

let currentSheetHandle: SpreadsheetMountHandle | null = null;

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

/** Disconnect ghost-column ResizeObserver before clearing #sheet-mount. */
let disconnectSheetLayout: (() => void) | null = null;

function hidePartnerError(): void {
  if (partnerErrorEl) {
    partnerErrorEl.hidden = true;
    partnerErrorEl.replaceChildren();
  }
}

const CONNECTION_CHIP_CONFIG: Record<
  CollabConnectionState,
  { label: string; modifier: string }
> = {
  connecting: { label: 'Connecting…', modifier: 'app-chrome__connection--connecting' },
  open: { label: 'Live', modifier: 'app-chrome__connection--open' },
  disconnected: {
    label: 'Offline — reconnecting…',
    modifier: 'app-chrome__connection--disconnected',
  },
};

function renderConnectionChip(state: CollabConnectionState): void {
  if (!chromeConnectionEl) return;
  const cfg = CONNECTION_CHIP_CONFIG[state];
  chromeConnectionEl.hidden = false;
  chromeConnectionEl.replaceChildren();
  for (const cls of Object.values(CONNECTION_CHIP_CONFIG)) {
    chromeConnectionEl.classList.remove(cls.modifier);
  }
  chromeConnectionEl.classList.add(cfg.modifier);
  const dot = document.createElement('span');
  dot.className = 'app-chrome__connection-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'app-chrome__connection-label';
  label.textContent = cfg.label;
  chromeConnectionEl.append(dot, label);
}

function clearConnectionChip(): void {
  if (!chromeConnectionEl) return;
  chromeConnectionEl.hidden = true;
  chromeConnectionEl.replaceChildren();
  for (const cls of Object.values(CONNECTION_CHIP_CONFIG)) {
    chromeConnectionEl.classList.remove(cls.modifier);
  }
}

function setAboutDescription(description: string | null): void {
  if (!chromeAboutEl || !chromeAboutToggleEl) return;
  const trimmed = description?.trim() ?? '';
  if (chromeTitleEl) {
    if (trimmed) {
      chromeTitleEl.title = trimmed;
    } else {
      chromeTitleEl.removeAttribute('title');
    }
  }
  if (!trimmed) {
    chromeAboutToggleEl.hidden = true;
    chromeAboutToggleEl.setAttribute('aria-expanded', 'false');
    chromeAboutEl.hidden = true;
    chromeAboutEl.textContent = '';
    return;
  }
  chromeAboutToggleEl.hidden = false;
  const para = document.createElement('p');
  para.className = 'app-chrome__about-text';
  para.textContent = trimmed;
  chromeAboutEl.replaceChildren(para);
}

function wireAboutToggle(): void {
  if (!chromeAboutToggleEl || !chromeAboutEl) return;
  chromeAboutToggleEl.addEventListener('click', () => {
    const open = chromeAboutToggleEl.getAttribute('aria-expanded') === 'true';
    const next = !open;
    chromeAboutToggleEl.setAttribute('aria-expanded', next ? 'true' : 'false');
    chromeAboutEl.hidden = !next;
  });
}

function showPartnerError(err: unknown): void {
  if (!partnerErrorEl) return;
  partnerErrorEl.replaceChildren();

  let iconClass = 'ph-warning-circle';
  let iconModifier = '';
  let title = 'Unable to Load Spreadsheet';
  let message =
    'An unexpected error occurred while loading the spreadsheet. Please verify your connection or try again.';

  if (err instanceof PartnerFetchError) {
    if (err.status === 401) {
      iconClass = 'ph-lock-key';
      iconModifier = 'app-partner-error__icon--warning';
      title = 'Authentication Required';
      message =
        'Your session has expired or you are not authenticated. Please log in through your institution’s portal to access this sheet.';
    } else if (err.status === 403) {
      iconClass = 'ph-shield-warning';
      iconModifier = 'app-partner-error__icon--danger';
      title = 'Access Denied';
      message =
        'You do not have permission to access this spreadsheet. If you require access, please contact your administrator or instructor.';
    } else if (err.status === 404) {
      iconClass = 'ph-file-dashed';
      title = 'Sheet Not Found';
      message = 'The requested spreadsheet does not exist or has been removed.';
    } else if (err.status === 502 || err.status === 503) {
      iconClass = 'ph-plugs-connected';
      title = 'Service Unavailable';
      message = 'The spreadsheet service is temporarily unavailable. Please try again shortly.';
    }
  }

  const icon = document.createElement('i');
  icon.className = `ph ${iconClass} app-partner-error__icon ${iconModifier}`.trim();
  icon.setAttribute('aria-hidden', 'true');

  const titleEl = document.createElement('h2');
  titleEl.className = 'app-partner-error__title';
  titleEl.textContent = title;

  const messageEl = document.createElement('p');
  messageEl.className = 'app-partner-error__message';
  messageEl.textContent = message;

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'app-partner-error__retry-btn';
  retryBtn.innerHTML = '<i class="ph ph-arrow-clockwise" aria-hidden="true"></i> Try Again';
  retryBtn.addEventListener('click', () => {
    window.location.reload();
  });

  partnerErrorEl.append(icon, titleEl, messageEl, retryBtn);
  partnerErrorEl.hidden = false;

  currentSheetHandle = null;
  disconnectSheetLayout?.();
  disconnectSheetLayout = null;
  sheetHost.replaceChildren();
  toolbarHost.replaceChildren();
  if (chromeActionsEl) {
    mountPartnerChromeActions(chromeActionsEl, undefined);
  }
  setAboutDescription(null);
  clearConnectionChip();
  sheetTabList.replaceChildren();
  sheetTabList.hidden = true;
}

function runFindInSheet(
  forward: boolean,
  searchInput: HTMLInputElement,
  statusEl: HTMLElement,
): void {
  const q = searchInput.value;
  const trimmed = q.trim();
  if (!currentSheetHandle) return;
  const ok = currentSheetHandle.findInSheet({ query: q, forward });
  if (ok) {
    statusEl.textContent = '';
    return;
  }
  if (trimmed.length > 0) {
    statusEl.textContent = 'No matches';
    window.setTimeout(() => {
      if (statusEl.textContent === 'No matches') statusEl.textContent = '';
    }, 2000);
  }
}

function mountSheetFindChrome(): void {
  if (!chromeSearchHostEl) return;

  const wrap = document.createElement('div');
  wrap.className = 'app-search';

  const statusEl = document.createElement('span');
  statusEl.className = 'app-search__status';
  statusEl.setAttribute('aria-live', 'polite');

  const icon = document.createElement('i');
  icon.className = 'ph ph-magnifying-glass app-search__icon';
  icon.setAttribute('aria-hidden', 'true');

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'app-search__input';
  searchInput.placeholder = 'Find in sheet';
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'Find in sheet');

  const btnPrev = document.createElement('button');
  btnPrev.type = 'button';
  btnPrev.className = 'app-search__btn';
  btnPrev.title = 'Find previous';
  btnPrev.setAttribute('aria-label', 'Find previous');
  const prevIc = document.createElement('i');
  prevIc.className = 'ph ph-caret-left';
  prevIc.setAttribute('aria-hidden', 'true');
  btnPrev.appendChild(prevIc);

  const btnNext = document.createElement('button');
  btnNext.type = 'button';
  btnNext.className = 'app-search__btn';
  btnNext.title = 'Find next';
  btnNext.setAttribute('aria-label', 'Find next');
  const nextIc = document.createElement('i');
  nextIc.className = 'ph ph-caret-right';
  nextIc.setAttribute('aria-hidden', 'true');
  btnNext.appendChild(nextIc);

  btnPrev.addEventListener('click', () => runFindInSheet(false, searchInput, statusEl));
  btnNext.addEventListener('click', () => runFindInSheet(true, searchInput, statusEl));

  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    runFindInSheet(!e.shiftKey, searchInput, statusEl);
  });

  wrap.append(icon, searchInput, btnPrev, btnNext, statusEl);
  chromeSearchHostEl.replaceChildren(wrap);

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (!e.metaKey && !e.ctrlKey) return;
      if (currentSheetHandle === null) return;
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    },
    true,
  );
}



/** Path after leading slash, segments joined (partner routing key). */
function routingPathFromLocation(): string {
  return window.location.pathname.replace(/^\//, '').split('/').filter(Boolean).join('/');
}

function initPartnerMode(): void {
  initPartnerTokenFromLocation();
  hidePartnerError();
  sheetTabList.hidden = true;
  sheetTabList.replaceChildren();
  sheetPanel.setAttribute('role', 'region');
  sheetPanel.setAttribute('aria-label', 'Spreadsheet');
  sheetPanel.removeAttribute('aria-labelledby');

  if (chromeTitleEl) {
    chromeTitleEl.textContent = 'Ark';
  }
  document.title = 'Ark';
  if (chromeActionsEl) {
    mountPartnerChromeActions(chromeActionsEl, undefined);
  }

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
      [...remotePeers.entries()].map(([clientId, v]) => {
        const persona = peerDisplayFromClientId(clientId);
        return {
          clientId,
          row: v.row,
          col: v.col,
          mode: v.mode,
          markerHue: v.markerHue,
          peerIcon: persona.icon,
          peerLabel: persona.label,
        };
      }),
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
    onConnectionState(state) {
      renderConnectionChip(state);
    },
    onAuthError(code) {
      collab.close();
      showPartnerError(
        new PartnerFetchError(
          'Access denied',
          code === 4403 ? 403 : 401,
        ),
      );
    },
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
    onRemoteRowDeleted(row) {
      if (!liveHandle || !liveStore) return;
      liveStore.withRemoteApply(() => {
        liveHandle!.applyRemoteRowClear(row);
      });
    },
  });

  remountPartnerSheetFromPayload = (
    routingPath: string,
    payload: PartnerSheetPayload,
    resetPresence: boolean,
  ): void => {
    const sameSheetRemount =
      loadedRoutingPath !== null && routingPath === loadedRoutingPath && liveHandle !== null;
    let initialViewportScroll: { scrollTop: number; scrollLeft: number } | undefined;
    if (sameSheetRemount) {
      const vp = sheetHost.querySelector('.sheet-viewport');
      if (vp) {
        initialViewportScroll = { scrollTop: vp.scrollTop, scrollLeft: vp.scrollLeft };
      }
    }

    const presence = liveHandle?.getCollabPresencePayload();
    const initialSelection =
      presence &&
      Number.isFinite(presence.row) &&
      Number.isFinite(presence.col) &&
      presence.row >= 1 &&
      presence.col >= 1
        ? { row: presence.row, col: presence.col }
        : undefined;

    lastPartnerPayload = {
      columns: payload.columns.map((c) => ({ ...c })),
      rows: [...payload.rows],
      title: payload.title,
      description: payload.description,
      rowCount: payload.rowCount,
      ...(payload.ghostRowCount !== undefined ? { ghostRowCount: payload.ghostRowCount } : {}),
      defaultRowHeightPx: payload.defaultRowHeightPx,
      enabledUiCapabilities: payload.enabledUiCapabilities,
      ...(payload.chromeActions !== undefined
        ? { chromeActions: payload.chromeActions.map((a) => ({ ...a })) }
        : {}),
      ...(payload.revision !== undefined ? { revision: payload.revision } : {}),
      ...(payload.template !== undefined ? { template: { ...payload.template } } : {}),
      ...(payload.cells !== undefined ? { cells: { ...payload.cells } } : {}),
    };
    const initial = rowsToInitialMap(payload.columns, payload.rows, payload.cells);
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
    config.columnWidthPersistenceKey = `ark:colw:${routingPath}`;
    if (initialSelection) {
      config.initialSelection = initialSelection;
    }
    if (initialViewportScroll) {
      config.initialViewportScroll = initialViewportScroll;
    }
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
    config.onRowDeleted = (row) => {
      const idIdx = payload.columns.findIndex((c) => c.readOnly);
      let recordId: string | number | undefined;
      if (idIdx >= 0) {
        const v = store.get(row, idIdx + 1);
        if (v !== undefined && v !== '') recordId = v;
      }
      collab.sendRowDeleted({
        type: 'row.deleted',
        row,
        sheetPath: pathForCollab,
        clientId: collabIdentity.clientId,
        markerHue: collabIdentity.markerHue,
        ...(recordId !== undefined ? { recordId } : {}),
      });
    };
    disconnectSheetLayout?.();
    disconnectSheetLayout = null;
    sheetHost.replaceChildren();
    liveHandle = mountSpreadsheet(sheetHost, config);
    currentSheetHandle = liveHandle;
    disconnectSheetLayout = liveHandle.disconnectLayout ?? null;
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
    setAboutDescription(payload.description ?? null);
    if (chromeActionsEl) {
      mountPartnerChromeActions(chromeActionsEl, payload.chromeActions);
    }
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
      collab.subscribeSheet(routingPath);
    } catch (e) {
      if (seq !== loadSeq) return;
      loadedRoutingPath = null;
      lastPartnerPayload = null;
      showPartnerError(e);
      collab.close();
    }
  }

  function boot(): void {
    const routingPath = routingPathFromLocation();
    if (!routingPath) {
      collab.close();
      showPartnerError(
        new PartnerFetchError(
          'No spreadsheet specified.',
          404,
        ),
      );
      return;
    }
    void loadPartnerSheet(routingPath);
  }

  window.addEventListener('popstate', () => {
    const routingPath = routingPathFromLocation();
    if (!routingPath) {
      loadedRoutingPath = null;
      showPartnerError(
        new PartnerFetchError(
          'No spreadsheet specified.',
          404,
        ),
      );
      return;
    }
    void loadPartnerSheet(routingPath);
  });

  boot();
}

function init(): void {
  mountSheetFindChrome();
  wireAboutToggle();

  try {
    initPartnerMode();
  } catch (e) {
    showPartnerError(e);
  }
}

void init();
