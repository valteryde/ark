"""Ark backend: document-owning API + collab hub + static UI host.

Ark is the system of record for sheet documents (SQLite, see store.py).
Browsers load sheets from GET /api/sheets/{path} (auto-created on first
access from the partner's versioned template, see partner_template.py) and
edit over WebSocket /ws/ark; edits are persisted server-side, broadcast to
peers, and forwarded to the partner as lightweight coalesced `sheet.changed`
notifications. Partners manage sheets through the CRUD API under /api/partner
(see partner_api.py).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .collab import hub
from .partner_api import router as partner_router
from .partner_auth import verify_browser_token
from .partner_notify import notifier
from .partner_template import PartnerTemplateError, fetch_partner_template
from .store import SheetValidationError, get_store, normalize_sheet_path

logger = logging.getLogger("ark")

dotenv.load_dotenv()

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_DIST = _REPO_ROOT / "dist"
STATIC_DIR = Path(os.environ.get("STATIC_ROOT", str(_DEFAULT_DIST))).resolve()

app = FastAPI(title="Ark", description="Ark spreadsheet backend (documents + collab + UI)")
app.include_router(partner_router)

# Ephemeral WebSocket-only messages; never persisted or sent to the partner.
_PRESENCE_TYPES = frozenset({"cell.presence", "cell.presence_clear"})
# Server/partner-authoritative messages browsers may not send.
_FORBIDDEN_WS_TYPES = frozenset({"sheet.truth"})

# Browser WebSocket passes the partner token as a query param (same name as the SPA).
_PARTNER_TOKEN_QUERY = "ark_token"

# Embedding Ark inside another site's iframe: optional framing headers from .env.
_IFRAME_X_FRAME_OPTIONS = os.environ.get("ARK_IFRAME_X_FRAME_OPTIONS", "").strip()
_IFRAME_FRAME_ANCESTORS = os.environ.get("ARK_IFRAME_FRAME_ANCESTORS", "").strip()


@app.middleware("http")
async def ark_iframe_embed_headers(request: Request, call_next):
    response = await call_next(request)
    if _IFRAME_X_FRAME_OPTIONS:
        response.headers["X-Frame-Options"] = _IFRAME_X_FRAME_OPTIONS
    if _IFRAME_FRAME_ANCESTORS:
        response.headers["Content-Security-Policy"] = (
            f"frame-ancestors {_IFRAME_FRAME_ANCESTORS}"
        )
    return response


def _bearer_token(value: str | None) -> str | None:
    if not value:
        return None
    parts = value.strip().split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1].strip():
        return parts[1].strip()
    return None


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sheets/{path:path}")
async def get_sheet(path: str, request: Request) -> JSONResponse:
    """Sheet payload for the browser.

    Unknown sheets are auto-created: Ark asks the partner for its template
    (`GET {partner}/ark/template/{path}`, fetched live — no registration step)
    and records the template name/version on the new document. Partner 404 =
    blank sheet; other partner failures abort the request so a temporary
    outage never creates a wrongly-blank document.
    """
    token = _bearer_token(request.headers.get("authorization"))
    if not await verify_browser_token(token):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    normalized = normalize_sheet_path(path)
    if not normalized:
        return JSONResponse({"detail": "sheet path must not be empty"}, status_code=400)
    store = get_store()
    existing = store.get_sheet_payload(normalized)
    if existing is not None:
        return JSONResponse(existing)
    try:
        template = await fetch_partner_template(normalized, token)
    except PartnerTemplateError as e:
        return JSONResponse({"detail": str(e)}, status_code=502)
    try:
        payload, created = store.get_or_create_sheet(normalized, template)
    except SheetValidationError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)
    if created:
        event: dict[str, Any] = {"kind": "sheet_created", "path": normalized}
        if payload.get("template") is not None:
            event["template"] = payload["template"]
        notifier.enqueue(normalized, event, payload.get("revision", 1), token)
    return JSONResponse(payload)


def _persist_ws_event(
    data: dict[str, Any], token: str | None
) -> tuple[bool, str | None, dict[str, Any] | None, int]:
    """Apply a browser WS event to the store (runs in a worker thread).

    Returns (persisted_ok, error_message, partner_event, revision). The caller
    enqueues `partner_event` on the event loop — PartnerNotifier schedules
    asyncio tasks and must not be touched from a thread without a running loop.
    """
    msg_type = data.get("type")
    sheet_path = data.get("sheetPath")
    if not isinstance(sheet_path, str) or not sheet_path.strip():
        return (False, "missing sheetPath", None, 0)
    sheet_path = normalize_sheet_path(sheet_path)
    store = get_store()

    if msg_type == "cell.value_committed":
        try:
            revision = store.apply_cell(
                sheet_path,
                data.get("row"),
                data.get("col"),
                data.get("value"),
            )
        except SheetValidationError as e:
            return (False, str(e), None, 0)
        event: dict[str, Any] = {
            "kind": "cell",
            "row": data.get("row"),
            "col": data.get("col"),
            "columnId": data.get("columnId"),
            "value": data.get("value"),
        }
        if data.get("recordId") is not None:
            event["recordId"] = data.get("recordId")
        return (True, None, event, revision)

    if msg_type == "row.deleted":
        try:
            revision = store.apply_row_delete(sheet_path, data.get("row"))
        except SheetValidationError as e:
            return (False, str(e), None, 0)
        event = {"kind": "row_deleted", "row": data.get("row")}
        if data.get("recordId") is not None:
            event["recordId"] = data.get("recordId")
        return (True, None, event, revision)

    # Unknown types are broadcast-only (forward-compatible).
    return (True, None, None, 0)


async def _send_persist_status(
    websocket: WebSocket, data: dict[str, Any], message: str | None
) -> None:
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
                "message": (message or "Could not save")[:240],
            }
        )
    except Exception:
        pass


@app.websocket("/ws/ark")
async def collab_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get(_PARTNER_TOKEN_QUERY)
    if not await verify_browser_token(token):
        # Policy violation close; browser shows the reconnect state.
        await websocket.close(code=4401)
        return
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
            msg_type = data.get("type")
            if msg_type in _FORBIDDEN_WS_TYPES:
                await websocket.send_json({"error": "forbidden_message_type"})
                continue
            if msg_type in _PRESENCE_TYPES:
                await hub.broadcast(data)
                continue
            # Persist first: Ark is authoritative, peers only see stored state.
            ok, err, partner_event, revision = await asyncio.to_thread(
                _persist_ws_event, data, token
            )
            if not ok:
                if msg_type == "cell.value_committed":
                    await _send_persist_status(websocket, data, err)
                continue
            if partner_event is not None:
                sheet_path = normalize_sheet_path(data["sheetPath"])
                notifier.enqueue(sheet_path, partner_event, revision, token)
            await hub.broadcast(data)
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
