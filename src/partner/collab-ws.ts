import type {
  CellPresenceClearEvent,
  CellPresenceEvent,
  CellValueCommittedEvent,
  RowDeletedEvent,
} from './types.ts';
import { normalizeSheetTruthPayload, type SheetTruthNormalized } from './map-sheet-payload.ts';
import { PARTNER_TOKEN_PARAM, getPartnerToken } from './partner-token.ts';
import type { SpreadsheetColumn } from '../spreadsheet/types.ts';

export function collabWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws/ark`;
  const token = getPartnerToken();
  if (!token) return base;
  const q = new URLSearchParams({ [PARTNER_TOKEN_PARAM]: token });
  return `${base}?${q}`;
}

function parseCommitted(
  o: Record<string, unknown>,
): {
  row: number;
  col: number;
  value: string | number;
  sheetPath: string | null;
  clientId: string | null;
  markerHue: number | undefined;
} | null {
  if (o.type !== 'cell.value_committed') return null;
  const row = o.row;
  const col = o.col;
  const value = o.value;
  if (typeof row !== 'number' || typeof col !== 'number' || !Number.isFinite(row) || !Number.isFinite(col)) {
    return null;
  }
  const sheetPath = typeof o.sheetPath === 'string' ? o.sheetPath : null;
  const clientId = typeof o.clientId === 'string' ? o.clientId : null;
  let markerHue: number | undefined;
  if (typeof o.markerHue === 'number' && Number.isFinite(o.markerHue)) {
    markerHue = ((o.markerHue % 360) + 360) % 360;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { row, col, value, sheetPath, clientId, markerHue };
  }
  if (typeof value === 'string') {
    return { row, col, value, sheetPath, clientId, markerHue };
  }
  return null;
}

function parsePresence(
  o: Record<string, unknown>,
): {
  row: number;
  col: number;
  mode: 'navigate' | 'edit';
  sheetPath: string | null;
  clientId: string | null;
  markerHue: number | undefined;
} | null {
  if (o.type !== 'cell.presence') return null;
  const row = o.row;
  const col = o.col;
  const mode = o.mode;
  if (typeof row !== 'number' || typeof col !== 'number' || !Number.isFinite(row) || !Number.isFinite(col)) {
    return null;
  }
  if (mode !== 'navigate' && mode !== 'edit') return null;
  const sheetPath = typeof o.sheetPath === 'string' ? o.sheetPath : null;
  const clientId = typeof o.clientId === 'string' ? o.clientId : null;
  let markerHue: number | undefined;
  if (typeof o.markerHue === 'number' && Number.isFinite(o.markerHue)) {
    markerHue = ((o.markerHue % 360) + 360) % 360;
  }
  return { row, col, mode, sheetPath, clientId, markerHue };
}

function parsePresenceClear(o: Record<string, unknown>): { sheetPath: string | null; clientId: string | null } | null {
  if (o.type !== 'cell.presence_clear') return null;
  const sheetPath = typeof o.sheetPath === 'string' ? o.sheetPath : null;
  const clientId = typeof o.clientId === 'string' ? o.clientId : null;
  return { sheetPath, clientId };
}

/** Lifecycle states the chrome can render. */
export type CollabConnectionState = 'connecting' | 'open' | 'disconnected';

export interface CollabConnection {
  sendCommitted(ev: CellValueCommittedEvent): void;
  sendRowDeleted(ev: RowDeletedEvent): void;
  sendPresence(ev: CellPresenceEvent): void;
  sendPresenceClear(ev: CellPresenceClearEvent): void;
  close(): void;
  getConnectionState(): CollabConnectionState;
}

export interface RemoteCommittedMeta {
  markerHue?: number;
}

export type RemotePresenceUpdate =
  | {
      kind: 'presence';
      clientId: string;
      row: number;
      col: number;
      mode: 'navigate' | 'edit';
      markerHue: number | undefined;
      sheetPath: string | null;
    }
  | { kind: 'presence_clear'; clientId: string; sheetPath: string | null };

/**
 * WebSocket to BFF `/ws/ark`: broadcasts JSON; use for outbound edits and inbound collab.
 */
export interface CellPersistFailedInfo {
  row: number;
  col: number;
  sheetPath: string | null;
  columnId?: string;
  message: string | null;
}

function parsePersistFailed(
  rec: Record<string, unknown>,
): CellPersistFailedInfo | null {
  if (rec.type !== 'cell.persist_status') return null;
  if (rec.ok !== false) return null;
  const row = rec.row;
  const col = rec.col;
  if (typeof row !== 'number' || typeof col !== 'number' || !Number.isFinite(row) || !Number.isFinite(col)) {
    return null;
  }
  const sheetPath = typeof rec.sheetPath === 'string' ? rec.sheetPath : null;
  const columnId = typeof rec.columnId === 'string' ? rec.columnId : undefined;
  const message = typeof rec.message === 'string' ? rec.message : null;
  return { row, col, sheetPath, columnId, message };
}

/** Cap on the offline outbound buffer; older messages are dropped first. */
const MAX_QUEUED_OUTBOUND = 256;
/** Base backoff (ms) doubles per attempt up to MAX_BACKOFF_MS, with light jitter. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function computeBackoffMs(attempts: number): number {
  const exp = Math.min(6, Math.max(0, attempts - 1));
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exp);
  const jitter = Math.floor(Math.random() * (base / 4));
  return base + jitter;
}

export function openCollabWs(opts: {
  getActiveSheetPath: () => string | null;
  localClientId: string;
  /** Columns from the last successful routing load; used when `sheet.truth` omits `columns`. */
  getFallbackColumns: () => readonly SpreadsheetColumn[] | null;
  onRemoteCommitted: (
    row: number,
    col: number,
    value: string | number,
    meta?: RemoteCommittedMeta,
  ) => void;
  onRemotePresence: (msg: RemotePresenceUpdate) => void;
  /** Server sends this when persisting a local `cell.value_committed` fails. */
  onCellPersistFailed?: (info: CellPersistFailedInfo) => void;
  /** Partner replaced the sheet via `PUT /api/partner/sheets/{path}`. */
  onSheetTruth?: (truth: SheetTruthNormalized) => void;
  /** Remote peer cleared a row via `row.deleted`. */
  onRemoteRowDeleted?: (row: number) => void;
  /** Connection lifecycle; fired on every state transition (including initial `connecting`). */
  onConnectionState?: (state: CollabConnectionState) => void;
}): CollabConnection {
  let ws: WebSocket | null = null;
  let state: CollabConnectionState = 'connecting';
  let intentionalClose = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const outbound: string[] = [];

  function setState(next: CollabConnectionState): void {
    if (state === next) return;
    state = next;
    opts.onConnectionState?.(next);
  }

  function handleMessage(e: MessageEvent): void {
    let data: unknown;
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : null;
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const rec = data as Record<string, unknown>;

    const persistFailed = parsePersistFailed(rec);
    if (persistFailed) {
      const active = opts.getActiveSheetPath();
      if (persistFailed.sheetPath !== null && active !== null && persistFailed.sheetPath !== active) {
        return;
      }
      opts.onCellPersistFailed?.(persistFailed);
      return;
    }

    const cleared = parsePresenceClear(rec);
    if (cleared) {
      if (cleared.clientId !== null && cleared.clientId === opts.localClientId) {
        return;
      }
      const active = opts.getActiveSheetPath();
      if (active === null) return;
      if (cleared.sheetPath !== null && cleared.sheetPath !== active) {
        return;
      }
      if (cleared.clientId !== null) {
        opts.onRemotePresence({ kind: 'presence_clear', clientId: cleared.clientId, sheetPath: cleared.sheetPath });
      }
      return;
    }

    const presence = parsePresence(rec);
    if (presence) {
      if (presence.clientId !== null && presence.clientId === opts.localClientId) {
        return;
      }
      const active = opts.getActiveSheetPath();
      if (active === null) return;
      if (presence.sheetPath !== null && presence.sheetPath !== active) {
        return;
      }
      if (presence.clientId === null) return;
      opts.onRemotePresence({
        kind: 'presence',
        clientId: presence.clientId,
        row: presence.row,
        col: presence.col,
        mode: presence.mode,
        markerHue: presence.markerHue,
        sheetPath: presence.sheetPath,
      });
      return;
    }

    if (rec.type === 'sheet.truth') {
      const parsed = normalizeSheetTruthPayload(rec, opts.getFallbackColumns());
      if (!parsed) return;
      const active = opts.getActiveSheetPath();
      if (active === null) return;
      if (parsed.sheetPath !== active) return;
      opts.onSheetTruth?.(parsed);
      return;
    }

    if (rec.type === 'row.deleted') {
      const row = rec.row;
      const clientId = typeof rec.clientId === 'string' ? rec.clientId : null;
      if (typeof row !== 'number' || !Number.isFinite(row) || row < 1) return;
      if (clientId !== null && clientId === opts.localClientId) return;
      const active = opts.getActiveSheetPath();
      const sheetPath = typeof rec.sheetPath === 'string' ? rec.sheetPath : null;
      if (sheetPath !== null && active !== null && sheetPath !== active) return;
      opts.onRemoteRowDeleted?.(Math.trunc(row));
      return;
    }

    const parsed = parseCommitted(rec);
    if (!parsed) return;
    if (parsed.clientId !== null && parsed.clientId === opts.localClientId) {
      return;
    }
    const active = opts.getActiveSheetPath();
    if (parsed.sheetPath !== null && active !== null && parsed.sheetPath !== active) {
      return;
    }
    const meta: RemoteCommittedMeta | undefined =
      parsed.markerHue !== undefined ? { markerHue: parsed.markerHue } : undefined;
    opts.onRemoteCommitted(parsed.row, parsed.col, parsed.value, meta);
  }

  function connect(): void {
    if (intentionalClose) return;
    setState('connecting');
    const sock = new WebSocket(collabWsUrl());
    ws = sock;

    sock.addEventListener('open', () => {
      if (sock !== ws) return;
      reconnectAttempts = 0;
      setState('open');
      while (outbound.length > 0) {
        const s = outbound.shift()!;
        try {
          sock.send(s);
        } catch {
          outbound.unshift(s);
          break;
        }
      }
    });

    sock.addEventListener('message', handleMessage);

    sock.addEventListener('close', () => {
      if (sock !== ws) return;
      ws = null;
      if (intentionalClose) return;
      setState('disconnected');
      reconnectAttempts += 1;
      const delay = computeBackoffMs(reconnectAttempts);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    });

    sock.addEventListener('error', () => {
      /* close handler runs next; no-op here so we don't double-schedule. */
    });
  }

  function queueSend(s: string): void {
    if (intentionalClose) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(s);
        return;
      } catch {
        /* fall through to queue; close handler will reconnect. */
      }
    }
    outbound.push(s);
    if (outbound.length > MAX_QUEUED_OUTBOUND) {
      outbound.shift();
    }
  }

  function sendCommitted(ev: CellValueCommittedEvent): void {
    queueSend(JSON.stringify(ev));
  }

  function sendRowDeleted(ev: RowDeletedEvent): void {
    queueSend(JSON.stringify(ev));
  }

  function sendPresence(ev: CellPresenceEvent): void {
    queueSend(JSON.stringify(ev));
  }

  function sendPresenceClear(ev: CellPresenceClearEvent): void {
    queueSend(JSON.stringify(ev));
  }

  connect();
  opts.onConnectionState?.(state);

  return {
    sendCommitted,
    sendRowDeleted,
    sendPresence,
    sendPresenceClear,
    getConnectionState: () => state,
    close: () => {
      intentionalClose = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      outbound.length = 0;
      if (ws) {
        const sock = ws;
        ws = null;
        try {
          sock.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
