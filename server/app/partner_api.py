"""Partner CRUD API for Ark-owned sheet documents.

All routes live under /api/partner and require
`Authorization: Bearer {ARK_PARTNER_API_TOKEN}`. This is the pull side of the
notify-then-pull contract: Ark POSTs lightweight `sheet.changed` notifications
(partner_notify.py) and the partner reads or writes full documents here.
Partner writes are pushed live to connected browsers over the collab hub.

Templates are not managed here: Ark pulls them from the partner's
`GET /ark/template/{path}` endpoint at document-creation time (see
partner_template.py).
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .collab import hub
from .store import SheetValidationError, get_store, normalize_sheet_path

router = APIRouter(prefix="/api/partner")


def _api_token() -> str:
    return os.environ.get("ARK_PARTNER_API_TOKEN", "").strip()


def _auth_error(request: Request) -> JSONResponse | None:
    token = _api_token()
    if not token:
        return JSONResponse(
            {"detail": "ARK_PARTNER_API_TOKEN is not set on the Ark server"},
            status_code=503,
        )
    if (request.headers.get("authorization") or "").strip() != f"Bearer {token}":
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return None


async def _json_object(request: Request) -> dict[str, Any] | JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"detail": "invalid_json"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"detail": "expected_object"}, status_code=400)
    return body


# ------------------------------------------------------------------- sheets


@router.get("/sheets")
async def list_sheets(request: Request) -> JSONResponse:
    if err := _auth_error(request):
        return err
    return JSONResponse({"sheets": get_store().list_sheets()})


@router.get("/sheets/{path:path}")
async def get_sheet(path: str, request: Request) -> JSONResponse:
    if err := _auth_error(request):
        return err
    payload = get_store().get_sheet_payload(path)
    if payload is None:
        return JSONResponse({"detail": "sheet not found"}, status_code=404)
    return JSONResponse(payload)


@router.put("/sheets/{path:path}")
async def put_sheet(path: str, request: Request) -> JSONResponse:
    """Create or fully replace a sheet; pushes sheet.truth to connected browsers."""
    if err := _auth_error(request):
        return err
    body = await _json_object(request)
    if isinstance(body, JSONResponse):
        return body
    try:
        payload = get_store().replace_sheet(path, body)
    except SheetValidationError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)
    truth: dict[str, Any] = {
        "type": "sheet.truth",
        "sheetPath": normalize_sheet_path(path),
        "rows": payload["rows"],
        "rowCount": payload["rowCount"],
        "columns": payload["columns"],
    }
    for k in ("title", "description", "ghostRowCount", "defaultRowHeightPx",
              "enabledUiCapabilities", "chromeActions"):
        if k in payload:
            truth[k] = payload[k]
    await hub.broadcast(truth)
    return JSONResponse(payload)


@router.patch("/sheets/{path:path}")
async def patch_sheet(path: str, request: Request) -> JSONResponse:
    """Partial update (cells and/or metadata); pushes cell updates to browsers live."""
    if err := _auth_error(request):
        return err
    body = await _json_object(request)
    if isinstance(body, JSONResponse):
        return body
    normalized = normalize_sheet_path(path)
    try:
        result = get_store().patch_sheet(normalized, body)
    except SheetValidationError as e:
        status = 404 if "not found" in str(e) else 400
        return JSONResponse({"detail": str(e)}, status_code=status)
    for cell in result["appliedCells"]:
        await hub.broadcast(
            {
                "type": "cell.value_committed",
                "row": cell["row"],
                "col": cell["col"],
                "columnId": cell["columnId"],
                "value": cell["value"],
                "sheetPath": normalized,
            }
        )
    return JSONResponse({"status": "ok", "revision": result["revision"]})


@router.delete("/sheets/{path:path}")
async def delete_sheet(path: str, request: Request) -> JSONResponse:
    if err := _auth_error(request):
        return err
    if not get_store().delete_sheet(path):
        return JSONResponse({"detail": "sheet not found"}, status_code=404)
    return JSONResponse({"status": "ok"})
