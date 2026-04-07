from __future__ import annotations

import asyncio
import json
import logging
import os
import dotenv
import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .tunnel_map import map_to_tunnel

logger = logging.getLogger("ark")

dotenv.load_dotenv()

BACKEND = os.environ.get("ARK_BACKEND_URL", "").rstrip("/")

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_DIST = _REPO_ROOT / "dist"
STATIC_DIR = Path(os.environ.get("STATIC_ROOT", str(_DEFAULT_DIST))).resolve()

app = FastAPI(title="Ark", description="UI + BFF for Ark spreadsheet")


class CollabHub:
    def __init__(self) -> None:
        self._clients: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self._clients:
            self._clients.remove(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for c in self._clients:
            try:
                await c.send_json(message)
            except Exception:
                dead.append(c)
        for c in dead:
            self.disconnect(c)


hub = CollabHub()

# Ephemeral WebSocket-only messages; do not POST to partner tunnel.
_TUNNEL_SKIP_TYPES = frozenset({"cell.presence", "cell.presence_clear"})
# Partner-authoritative grid sync; only allowed via POST /api/ark/broadcast (not from browsers).
_FORBIDDEN_WS_TYPES = frozenset({"sheet.truth"})

# Browser WebSocket passes the partner token as a query param (same name as the SPA).
_PARTNER_TOKEN_QUERY = "ark_token"

# Server-to-server: partner calls BFF to fan out sheet snapshots. If unset, POST is disabled.
_BROADCAST_TOKEN = os.environ.get("ARK_BROADCAST_TOKEN", "").strip()


def _tunnel_headers_from_ws(websocket: WebSocket) -> dict[str, str]:
    token = websocket.query_params.get(_PARTNER_TOKEN_QUERY)
    if token:
        return {"authorization": f"Bearer {token}"}
    return {}


def _tunnel_error_message(exc: BaseException, response: httpx.Response | None) -> str:
    if response is not None:
        try:
            data = response.json()
        except Exception:
            return f"HTTP {response.status_code}"
        if isinstance(data, dict):
            detail = data.get("message")
            if detail is None:
                detail = data.get("detail")
            if isinstance(detail, str) and detail.strip():
                return detail.strip()[:240]
            if isinstance(detail, list) and detail:
                first = detail[0]
                if isinstance(first, dict) and isinstance(first.get("msg"), str):
                    return str(first["msg"]).strip()[:240]
                return str(first)[:240]
        return f"HTTP {response.status_code}"
    return str(exc)[:240] if str(exc) else "Request failed"


async def post_tunnel_async(
    body: dict[str, Any],
    partner_headers: dict[str, str] | None = None,
) -> tuple[bool, str | None]:
    """POST mapped body to partner tunnel. Returns (success, user_message_on_failure)."""
    if not BACKEND:
        return (True, None)
    payload = map_to_tunnel(body)
    url = f"{BACKEND}/ark/tunnel"
    headers = dict(partner_headers) if partner_headers else {}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
        return (True, None)
    except httpx.HTTPStatusError as e:
        logger.warning("ark tunnel POST failed: %s", e)
        return (False, _tunnel_error_message(e, e.response))
    except Exception as e:
        logger.warning("ark tunnel POST failed: %s", e)
        return (False, _tunnel_error_message(e, None))


async def _tunnel_task_notify_sender(
    websocket: WebSocket,
    data: dict[str, Any],
    tunnel_headers: dict[str, str] | None,
) -> None:
    """Notify originating client when a cell commit fails to persist (tunnel)."""
    ok, err = await post_tunnel_async(data, tunnel_headers)
    if ok or not BACKEND:
        return
    if data.get("type") != "cell.value_committed":
        return
    row, col = data.get("row"), data.get("col")
    if not isinstance(row, int) or not isinstance(col, int):
        return
    try:
        await websocket.send_json(
            {
                "type": "cell.persist_status",
                "ok": False,
                "row": row,
                "col": col,
                "columnId": data.get("columnId"),
                "sheetPath": data.get("sheetPath"),
                "message": err,
            }
        )
    except Exception:
        pass


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/ark/broadcast")
async def partner_broadcast_sheet_truth(request: Request) -> JSONResponse:
    """Partner pushes authoritative grid state; BFF broadcasts to all /ws/ark clients (no tunnel)."""
    if not _BROADCAST_TOKEN:
        return JSONResponse(
            {"detail": "ARK_BROADCAST_TOKEN is not set on the Ark server"},
            status_code=503,
        )
    auth = (request.headers.get("authorization") or "").strip()
    if auth != f"Bearer {_BROADCAST_TOKEN}":
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse({"detail": "invalid_json"}, status=400)
    if not isinstance(body, dict):
        return JSONResponse({"detail": "expected_object"}, status=400)
    if body.get("type") != "sheet.truth":
        return JSONResponse({"detail": "expected type sheet.truth"}, status=400)
    sheet_path = body.get("sheetPath")
    if not isinstance(sheet_path, str) or not sheet_path.strip():
        return JSONResponse({"detail": "sheetPath must be a non-empty string"}, status=400)
    if not isinstance(body.get("rows"), list):
        return JSONResponse({"detail": "rows must be an array"}, status=400)
    rc = body.get("rowCount")
    if not isinstance(rc, int) or rc < 1:
        return JSONResponse({"detail": "rowCount must be an integer >= 1"}, status=400)
    cols = body.get("columns")
    if cols is not None and not isinstance(cols, list):
        return JSONResponse({"detail": "columns must be an array when present"}, status=400)
    await hub.broadcast(body)
    return JSONResponse({"status": "ok"})


@app.api_route("/api/ark/routing/{path:path}", methods=["GET", "HEAD"])
async def proxy_routing(path: str, request: Request) -> Response:
    if not BACKEND:
        return JSONResponse(
            {"detail": "ARK_BACKEND_URL is not set"},
            status_code=503,
        )
    url = f"{BACKEND}/ark/routing/{path}"
    headers: dict[str, str] = {}
    for h in ("authorization", "cookie", "accept", "accept-language"):
        v = request.headers.get(h)
        if v:
            headers[h] = v
    params = list(request.query_params.multi_items())
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        r = await client.request(request.method, url, headers=headers, params=params)
    ct = r.headers.get("content-type")
    out_headers: dict[str, str] = {}
    if ct:
        out_headers["content-type"] = ct
    return Response(content=r.content, status_code=r.status_code, headers=out_headers)


@app.websocket("/ws/ark")
async def collab_ws(websocket: WebSocket) -> None:
    tunnel_headers = _tunnel_headers_from_ws(websocket)
    await hub.connect(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"error": "invalid_json"})
                continue
            if not isinstance(data, dict):
                await websocket.send_json({"error": "expected_object"})
                continue
            if data.get("type") in _FORBIDDEN_WS_TYPES:
                await websocket.send_json({"error": "forbidden_message_type"})
                continue
            await hub.broadcast(data)
            if data.get("type") not in _TUNNEL_SKIP_TYPES:
                asyncio.create_task(
                    _tunnel_task_notify_sender(
                        websocket,
                        data,
                        tunnel_headers if tunnel_headers else None,
                    ),
                )
    except WebSocketDisconnect:
        hub.disconnect(websocket)


_UI_SEGMENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$", re.IGNORECASE)


def _ui_route_specs() -> tuple[list[str], list[tuple[str, ...]]]:
    """Parse ARK_UI_ROUTES into (exact single-segment paths, prefix bases).

    Exact entries are one segment (letters, digits, hyphen). Wildcard entries
    look like ``prefix/*`` where each path segment in prefix matches the same rules.
    Prefix routes are sorted longest-first so more specific bases win over shorter ones.
    """
    raw = os.environ.get("ARK_UI_ROUTES", "clients,records")
    exact_order: list[str] = []
    exact_seen: set[str] = set()
    prefixes: list[tuple[str, ...]] = []
    prefix_seen: set[tuple[str, ...]] = set()

    for s in raw.split(","):
        tok = s.strip()
        if not tok:
            continue
        if "*" in tok:
            if tok.count("*") != 1 or not tok.endswith("/*"):
                continue
            base = tok[:-2].strip()
            if not base or base.endswith("/") or "//" in base:
                continue
            split_parts = base.split("/")
            if any(not p for p in split_parts):
                continue
            parts = tuple(split_parts)
            if not parts:
                continue
            if any(not _UI_SEGMENT_RE.fullmatch(p) for p in parts):
                continue
            if parts not in prefix_seen:
                prefix_seen.add(parts)
                prefixes.append(parts)
            continue
        if _UI_SEGMENT_RE.fullmatch(tok) and tok not in exact_seen:
            exact_seen.add(tok)
            exact_order.append(tok)

    prefix_bases_slash = {"/".join(t) for t in prefixes}
    exact_filtered = [e for e in exact_order if e not in prefix_bases_slash]
    prefixes.sort(key=lambda t: (-len(t), t))
    return exact_filtered, prefixes


if STATIC_DIR.is_dir():
    _index_html = STATIC_DIR / "index.html"

    def _spa_shell() -> FileResponse:
        return FileResponse(_index_html)

    _exact_segs, _prefix_parts = _ui_route_specs()
    for _parts in _prefix_parts:
        _base = "/" + "/".join(_parts)
        app.add_api_route(
            _base,
            _spa_shell,
            methods=["GET"],
            include_in_schema=False,
        )
        app.add_api_route(
            f"{_base}/{{rest:path}}",
            _spa_shell,
            methods=["GET"],
            include_in_schema=False,
        )
    for _seg in _exact_segs:
        app.add_api_route(
            f"/{_seg}",
            _spa_shell,
            methods=["GET"],
            include_in_schema=False,
        )

    app.mount(
        "/",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="static",
    )
else:

    @app.get("/")
    def missing_dist() -> JSONResponse:
        return JSONResponse(
            {
                "detail": "Static UI not built. From repo root run: npm install && npm run build",
            },
            status_code=503,
        )
