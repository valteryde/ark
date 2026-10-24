"""Room-scoped WebSocket fan-out hub shared by the browser WS handler and the partner API.

Clients are partitioned into per-sheet-path rooms so that broadcasts for one
sheet never leak to connections viewing a different sheet.
"""

from __future__ import annotations

from typing import Any

from fastapi import WebSocket


class CollabHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        # sheet_path -> set of subscribed WebSocket clients
        self._rooms: dict[str, set[WebSocket]] = {}
        # WebSocket id -> set of subscribed sheet paths (for cleanup on disconnect)
        self._client_paths: dict[int, set[str]] = {}

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)
        self._client_paths[id(ws)] = set()

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)
        for path in self._client_paths.pop(id(ws), set()):
            room = self._rooms.get(path)
            if room:
                room.discard(ws)
                if not room:
                    del self._rooms[path]

    def subscribe(self, ws: WebSocket, sheet_path: str) -> None:
        """Subscribe a connected client to receive broadcasts for *sheet_path*."""
        if ws not in self._clients:
            return
        self._rooms.setdefault(sheet_path, set()).add(ws)
        self._client_paths.setdefault(id(ws), set()).add(sheet_path)

    def unsubscribe(self, ws: WebSocket, sheet_path: str) -> None:
        """Unsubscribe a connected client from *sheet_path*."""
        room = self._rooms.get(sheet_path)
        if room:
            room.discard(ws)
            if not room:
                del self._rooms[sheet_path]
        paths = self._client_paths.get(id(ws))
        if paths:
            paths.discard(sheet_path)

    def unsubscribe_all(self, ws: WebSocket) -> None:
        """Unsubscribe a connected client from all subscribed sheet rooms."""
        paths = self._client_paths.pop(id(ws), set())
        for path in paths:
            room = self._rooms.get(path)
            if room:
                room.discard(ws)
                if not room:
                    del self._rooms[path]
        self._client_paths[id(ws)] = set()

    async def broadcast(self, message: dict[str, Any], sheet_path: str) -> None:
        """Send *message* only to clients subscribed to *sheet_path*."""
        targets = list(self._rooms.get(sheet_path, set()))
        dead: list[WebSocket] = []
        for c in targets:
            try:
                await c.send_json(message)
            except Exception:
                dead.append(c)
        for c in dead:
            self.disconnect(c)


hub = CollabHub()
