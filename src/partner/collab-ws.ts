import type { CellPresenceClearEvent, CellPresenceEvent, CellValueCommittedEvent } from './types.ts';
import { PARTNER_TOKEN_PARAM, getPartnerToken } from './partner-token.ts';

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

export interface CollabConnection {
  sendCommitted(ev: CellValueCommittedEvent): void;
  sendPresence(ev: CellPresenceEvent): void;
  sendPresenceClear(ev: CellPresenceClearEvent): void;
  close(): void;
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
export function openCollabWs(opts: {
  getActiveSheetPath: () => string | null;
  localClientId: string;
  onRemoteCommitted: (
    row: number,
    col: number,
    value: string | number,
    meta?: RemoteCommittedMeta,
  ) => void;
  onRemotePresence: (msg: RemotePresenceUpdate) => void;
}): CollabConnection {
  const ws = new WebSocket(collabWsUrl());
  const pending: string[] = [];

  ws.addEventListener('open', () => {
    for (const s of pending) {
      ws.send(s);
    }
    pending.length = 0;
  });

  ws.addEventListener('message', (e) => {
    let data: unknown;
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : null;
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const rec = data as Record<string, unknown>;

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
  });

  function queueSend(s: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(s);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      pending.push(s);
    }
  }

  function sendCommitted(ev: CellValueCommittedEvent): void {
    queueSend(JSON.stringify(ev));
  }

  function sendPresence(ev: CellPresenceEvent): void {
    queueSend(JSON.stringify(ev));
  }

  function sendPresenceClear(ev: CellPresenceClearEvent): void {
    queueSend(JSON.stringify(ev));
  }

  return {
    sendCommitted,
    sendPresence,
    sendPresenceClear,
    close: () => {
      pending.length = 0;
      ws.close();
    },
  };
}
