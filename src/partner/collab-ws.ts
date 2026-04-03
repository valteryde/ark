import type { CellValueCommittedEvent } from './types.ts';

export function collabWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/ark`;
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

export interface CollabConnection {
  sendCommitted(ev: CellValueCommittedEvent): void;
  close(): void;
}

export interface RemoteCommittedMeta {
  markerHue?: number;
}

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
    const parsed = parseCommitted(data as Record<string, unknown>);
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

  function sendCommitted(ev: CellValueCommittedEvent): void {
    const s = JSON.stringify(ev);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(s);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      pending.push(s);
    }
  }

  return {
    sendCommitted,
    close: () => {
      pending.length = 0;
      ws.close();
    },
  };
}
