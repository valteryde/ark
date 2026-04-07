"""Sample partner API for Ark. BFF proxies GET /api/ark/routing/* → GET /ark/routing/* here.

Run: uvicorn example_api:app --port 9000
Set ARK_BACKEND_URL=http://127.0.0.1:9000 on the Ark server.
Set ARK_UI_ROUTES=clients,records so /clients and /records serve the SPA.

Optional: set EXAMPLE_PARTNER_TOKEN to require Authorization: Bearer <token> on routing and tunnel.

See docs/PARTNER_API.md for the full contract.
"""

import os

from fastapi import FastAPI, HTTPException, Request

app = FastAPI()


def _optional_example_partner_token(request: Request) -> None:
    expected = os.environ.get("EXAMPLE_PARTNER_TOKEN", "").strip()
    if not expected:
        return
    auth = (request.headers.get("authorization") or "").strip()
    if auth != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="invalid or missing partner token")


def clients_sheet() -> dict:
    rows = [
        {"id": 1, "name": "Client 1"},
        {"id": 2, "name": "Client 2"},
    ]
    return {
        "title": "Client list for marketing team",
        "description": "Static sample data",
        "chromeActions": [
            {"label": "Records", "href": "/records", "icon": "table"},
        ],
        "sheets": [
            {
                "title": "Clients",
                "columns": [
                    {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True},
                    {"id": "name", "header": "Name", "widthPx": 240},
                ],
                "rows": rows,
                "rowCount": len(rows) + 1,
            }
        ],
    }


def records_sheet() -> dict:
    rows = [
        {"id": 1, "name": "Record 1", "client_id": 1},
        {"id": 2, "name": "Record 2", "client_id": 1},
    ]
    return {
        "title": "Business records for customer support team",
        "description": "Static sample data",
        "chromeActions": [
            {"label": "Clients", "href": "/clients"},
        ],
        "sheets": [
            {
                "title": "Records",
                "columns": [
                    {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True},
                    {"id": "name", "header": "Name", "widthPx": 220},
                    {"id": "client_id", "header": "Client", "widthPx": 100, "valueType": "number"},
                ],
                "rows": rows,
                "rowCount": len(rows) + 1,
            }
        ],
    }


@app.get("/ark/routing/{path:path}")
async def ark_routing(path: str, request: Request):
    _optional_example_partner_token(request)
    if path == "clients":
        return clients_sheet()
    if path == "records":
        return records_sheet()
    return {"detail": "unknown path"}


@app.post("/ark/tunnel")
async def ark_tunnel(request: Request):
    _optional_example_partner_token(request)
    data = await request.json()
    if data.get("type") == "new_cell":
        return {"status": "success"}
    if data.get("type") == "update_cell":
        return {"status": "success"}
    if data.get("type") == "delete_cell":
        return {"status": "success"}
    if data.get("type") == "delete_row":
        return {"status": "success"}
    return {"status": "error", "message": "Invalid request"}
