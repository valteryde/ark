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
import secrets
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .collab import hub
from .store import SheetValidationError, get_store, normalize_sheet_path

router = APIRouter(prefix="/api/partner")


def _api_token() -> str:
    return os.environ.get("ARK_PARTNER_API_TOKEN", "").strip()


def _client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def _partner_actor_id(request: Request) -> str:
    return (
        request.headers.get("x-actor-id")
        or request.headers.get("x-audit-actor")
        or "partner_api"
    )


def _auth_error(request: Request) -> JSONResponse | None:
    token = _api_token()
    if not token:
        return JSONResponse(
            {"detail": "ARK_PARTNER_API_TOKEN is not set on the Ark server"},
            status_code=503,
        )
    auth = (request.headers.get("authorization") or "").strip()
    if not secrets.compare_digest(auth.encode(), f"Bearer {token}".encode()):
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


async def _handle_audit_logs(
    request: Request,
    path: str | None = None,
) -> JSONResponse:
    if err := _auth_error(request):
        return err

    qp = request.query_params
    raw_sheet_path = path or qp.get("sheet_path") or qp.get("path")
    action = qp.get("action")
    actor_type = qp.get("actor_type") or qp.get("actorType")
    actor_id = qp.get("actor_id") or qp.get("actorId")
    since = qp.get("since") or qp.get("from")
    until = qp.get("until") or qp.get("to")
    prefix = qp.get("prefix")
    order = qp.get("order", "desc")

    try:
        limit = int(qp.get("limit", 100))
        offset = int(qp.get("offset", 0))
    except ValueError:
        return JSONResponse({"detail": "limit and offset must be integers"}, status_code=400)

    try:
        items, total = get_store().get_audit_logs(
            sheet_path=raw_sheet_path,
            action=action,
            actor_type=actor_type,
            actor_id=actor_id,
            since=since,
            until=until,
            limit=limit,
            offset=offset,
            order=order,
            prefix=prefix,
        )
    except SheetValidationError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)

    return JSONResponse(
        {
            "auditLogs": items,
            "audit_logs": items,
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


# Audit log routes
@router.get("/audit-logs")
@router.get("/audit_logs")
async def list_audit_logs(request: Request) -> JSONResponse:
    return await _handle_audit_logs(request)


@router.get("/audit-logs/{log_id:int}")
@router.get("/audit_logs/{log_id:int}")
async def get_audit_log(log_id: int, request: Request) -> JSONResponse:
    if err := _auth_error(request):
        return err
    item = get_store().get_audit_log_by_id(log_id)
    if item is None:
        return JSONResponse({"detail": "audit log entry not found"}, status_code=404)
    return JSONResponse(item)


@router.get("/sheets/{path:path}/audit-logs")
@router.get("/sheets/{path:path}/audit_logs")
async def get_sheet_audit_logs(path: str, request: Request) -> JSONResponse:
    return await _handle_audit_logs(request, path=path)


@router.get("/sheets/{path:path}")
async def get_sheet(path: str, request: Request) -> JSONResponse:
    if err := _auth_error(request):
        return err
    if path.endswith("/audit-logs"):
        target_path = path[:-len("/audit-logs")]
        return await _handle_audit_logs(request, path=target_path)
    if path.endswith("/audit_logs"):
        target_path = path[:-len("/audit_logs")]
        return await _handle_audit_logs(request, path=target_path)
    try:
        payload = get_store().get_sheet_payload(path)
    except SheetValidationError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)
    if payload is None:
        return JSONResponse({"detail": "sheet not found"}, status_code=404)
    get_store().log_audit_event(
        sheet_path=path,
        action="sheet.read",
        actor_type="partner",
        actor_id=_partner_actor_id(request),
        ip_address=_client_ip(request),
        revision=payload.get("revision"),
        details={"client": "partner_api"},
    )
    return JSONResponse(payload)


@router.put("/sheets/{path:path}")
async def put_sheet(path: str, request: Request) -> JSONResponse:
    """Create or fully replace a sheet; pushes sheet.truth to connected browsers."""
    if err := _auth_error(request):
        return err
    body = await _json_object(request)
    if isinstance(body, JSONResponse):
        return body
    actor_id = _partner_actor_id(request)
    client_ip = _client_ip(request)
    try:
        payload = get_store().replace_sheet(
            path,
            body,
            actor_type="partner",
            actor_id=actor_id,
            ip_address=client_ip,
        )
    except SheetValidationError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)
    normalized = normalize_sheet_path(path)
    truth: dict[str, Any] = {
        "type": "sheet.truth",
        "sheetPath": normalized,
        "rows": payload["rows"],
        "rowCount": payload["rowCount"],
        "columns": payload["columns"],
    }
    for k in ("title", "description", "ghostRowCount", "defaultRowHeightPx",
              "enabledUiCapabilities", "chromeActions"):
        if k in payload:
            truth[k] = payload[k]
    await hub.broadcast(truth, normalized)
    return JSONResponse(payload)


@router.patch("/sheets/{path:path}")
async def patch_sheet(path: str, request: Request) -> JSONResponse:
    """Partial update (cells and/or metadata); pushes cell updates to browsers live."""
    if err := _auth_error(request):
        return err
    body = await _json_object(request)
    if isinstance(body, JSONResponse):
        return body
    try:
        normalized = normalize_sheet_path(path)
    except SheetValidationError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)
    actor_id = _partner_actor_id(request)
    client_ip = _client_ip(request)
    try:
        result = get_store().patch_sheet(
            normalized,
            body,
            actor_type="partner",
            actor_id=actor_id,
            ip_address=client_ip,
        )
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
            },
            normalized,
        )
    return JSONResponse({"status": "ok", "revision": result["revision"]})


@router.delete("/sheets/{path:path}")
async def delete_sheet(path: str, request: Request) -> JSONResponse:
    if err := _auth_error(request):
        return err
    actor_id = _partner_actor_id(request)
    client_ip = _client_ip(request)
    try:
        deleted = get_store().delete_sheet(
            path,
            actor_type="partner",
            actor_id=actor_id,
            ip_address=client_ip,
        )
    except SheetValidationError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)
    if not deleted:
        return JSONResponse({"detail": "sheet not found"}, status_code=404)
    return JSONResponse({"status": "ok"})

