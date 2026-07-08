"""Sample partner app for Ark's document backend.

Ark stores the sheets itself; this partner:
- validates browser tokens at GET /ark/auth (accepts everything unless
  EXAMPLE_PARTNER_TOKEN is set),
- serves sheet templates at GET /ark/template/{path} — Ark pulls the template
  live when a document is first created (no registration, no startup-order
  dependency) and records the returned name + version on the document,
- receives live coalesced sheet.changed notifications at POST /ark/notify.

Run: uvicorn example_api:app --port 9000

On the Ark server set:
    ARK_PARTNER_BASE_URL=http://127.0.0.1:9000
    ARK_UI_ROUTES=clients,records

Optionally (to call Ark's CRUD API under /api/partner/... from this app):
    ARK_PARTNER_API_TOKEN=<shared secret> on both sides

See docs/PARTNER_API.md for the full contract.
"""

import logging
import os

from fastapi import FastAPI, HTTPException, Request

logger = logging.getLogger("example-partner")

app = FastAPI()

# Bump when you change a template below; Ark records it on each new document.
TEMPLATE_VERSION = 1


def _optional_example_partner_token(request: Request) -> None:
    expected = os.environ.get("EXAMPLE_PARTNER_TOKEN", "").strip()
    if not expected:
        return
    auth = (request.headers.get("authorization") or "").strip()
    if auth != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="invalid or missing partner token")


CLIENTS_TEMPLATE = {
    "name": "clients",
    "version": TEMPLATE_VERSION,
    "title": "Client list for marketing team",
    "description": "Template served by example_api.py; the document lives in Ark",
    "chromeActions": [
        {"label": "Records", "href": "/records", "icon": "table"},
    ],
    "columns": [
        {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True},
        {"id": "name", "header": "Name", "widthPx": 240},
    ],
    "rows": [
        {"id": 1, "name": "Client 1"},
        {"id": 2, "name": "Client 2"},
    ],
}

RECORDS_TEMPLATE = {
    "name": "records",
    "version": TEMPLATE_VERSION,
    "title": "Business records for customer support team",
    "description": "Template served by example_api.py; the document lives in Ark",
    "chromeActions": [
        {"label": "Clients", "href": "/clients", "icon": "users"},
    ],
    "columns": [
        {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True},
        {"id": "name", "header": "Name", "widthPx": 220},
        {"id": "client_id", "header": "Client", "widthPx": 100, "valueType": "number"},
    ],
    "rows": [
        {"id": 1, "name": "Record 1", "client_id": 1},
        {"id": 2, "name": "Record 2", "client_id": 1},
    ],
}


@app.get("/ark/auth")
async def ark_auth(request: Request) -> dict:
    """Ark verifies each user's ark_token here; 2xx allows access."""
    _optional_example_partner_token(request)
    return {"status": "ok"}


@app.get("/ark/template/{path:path}")
async def ark_template(path: str, request: Request) -> dict:
    """Ark asks how a new document at `path` should look. 404 = blank sheet."""
    _optional_example_partner_token(request)
    if path == "clients" or path.startswith("clients/"):
        return CLIENTS_TEMPLATE
    if path == "records" or path.startswith("records/"):
        return RECORDS_TEMPLATE
    raise HTTPException(status_code=404, detail="no template for this path")


@app.post("/ark/notify")
async def ark_notify(request: Request) -> dict:
    """Ark pushes coalesced sheet.changed notifications; log them."""
    body = await request.json()
    logger.info(
        "sheet.changed: %s revision=%s events=%s",
        body.get("sheetPath"),
        body.get("revision"),
        body.get("events"),
    )
    return {"status": "ok"}
