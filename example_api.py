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
TEMPLATE_VERSION = 2


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
    # Columns chosen so the text-overflow behaviour is visible without any setup:
    # long values spill across empty neighbours and stop at a filled one.
    "columns": [
        {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True},
        {"id": "name", "header": "Name", "widthPx": 180},
        {"id": "notes", "header": "Notes", "widthPx": 200},
        {
            "id": "status",
            "header": "Status",
            "widthPx": 130,
            "valueType": "select",
            "selectOptions": [
                {"value": "prospect", "label": "Prospect", "backgroundColor": "#eef2ff", "color": "#3730a3"},
                {"value": "active", "label": "Active", "backgroundColor": "#d8f3dc", "color": "#1b4332"},
                {"value": "churned", "label": "Churned", "backgroundColor": "#fde2e1", "color": "#7f1d1d"},
            ],
        },
    ],
    "rows": [
        {
            "id": 1,
            "name": "Acme Industrial",
            # Empty Status next to it -> this note spills across that column.
            "notes": "Renewed after the Q3 review; expansion into the Nordics is pending legal sign-off.",
        },
        {
            "id": 2,
            "name": "Beta Logistics",
            # Status holds a chip -> the note clips with an ellipsis at that edge.
            "notes": "Multi-site rollout scheduled for spring, contingent on the new depot lease.",
            "status": "active",
        },
        {
            "id": 3,
            "name": "Cobalt Studios",
            "notes": "Renewal at 90% of list; ask for a two-year term.",
            "status": "prospect",
        },
        {
            # Row 4 asks for wrapped text in a single 28px row: it does not fit, so the
            # cell falls back to a single line that spills. Row 5 is part of the merge
            # below, so its Name stays empty.
            "id": 4,
            "name": "Delta Foods Group International Ltd",
            "notes": "Contact moved to the procurement team; the old account manager email bounces.",
            "status": "churned",
        },
        {"id": 5},
    ],
    # Wrap on: row 4's Notes (spills, not enough row height) and the merged Name
    # below, which has two rows of height and therefore does wrap.
    "cellStyles": {
        "4:3": {"white-space": "pre-wrap"},
        "4:2": {"white-space": "pre-wrap"},
    },
    "cellSpans": [{"row": 4, "col": 2, "rowSpan": 2, "colSpan": 1}],
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
