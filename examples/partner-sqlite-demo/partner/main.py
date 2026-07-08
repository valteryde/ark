"""SQLite-backed partner for Ark's document backend.

Ark owns the sheet documents; this partner:

1. Validates browser tokens at `GET /ark/auth` (any token accepted unless
   EXAMPLE_PARTNER_TOKEN is set).
2. Serves templates at `GET /ark/template/{path}`: when Ark first creates a
   document it pulls the template live — columns, a version number, and the
   current SQLite rows as prefill. No registration step, no startup-order
   dependency between Ark and the partner.
3. Receives live coalesced `sheet.changed` notifications at `POST /ark/notify`,
   pulls the full sheet back from Ark, and syncs it into SQLite. New grid rows
   get a database id which is patched back into the sheet's read-only column.

Env:
    PARTNER_DB              SQLite file (default /data/partner.db)
    ARK_API_URL             Ark base URL, e.g. http://ark:8000
    ARK_PARTNER_API_TOKEN   Bearer token for Ark's /api/partner routes
    EXAMPLE_PARTNER_TOKEN   Optional: require this exact ark_token from users
"""
from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request

logger = logging.getLogger("partner")

DB_PATH = Path(os.environ.get("PARTNER_DB", "/data/partner.db"))
ARK_API_URL = os.environ.get("ARK_API_URL", "http://ark:8000").rstrip("/")
ARK_PARTNER_API_TOKEN = os.environ.get("ARK_PARTNER_API_TOKEN", "").strip()

_ARK_HEADERS = {"authorization": f"Bearer {ARK_PARTNER_API_TOKEN}"}


def _optional_example_partner_token(request: Request) -> None:
    expected = os.environ.get("EXAMPLE_PARTNER_TOKEN", "").strip()
    if not expected:
        return
    auth = (request.headers.get("authorization") or "").strip()
    if auth != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="invalid or missing partner token")


@contextmanager
def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS clients (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS records (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              client_id INTEGER NOT NULL REFERENCES clients(id)
            );
            """
        )
        n = conn.execute("SELECT COUNT(*) FROM clients").fetchone()[0]
        if n == 0:
            conn.execute("INSERT INTO clients (name) VALUES ('Acme Corp'), ('Beta LLC')")
            c1 = conn.execute("SELECT id FROM clients ORDER BY id LIMIT 1").fetchone()[0]
            c2 = conn.execute("SELECT id FROM clients ORDER BY id LIMIT 1 OFFSET 1").fetchone()[0]
            conn.execute(
                "INSERT INTO records (name, client_id) VALUES (?, ?), (?, ?)",
                ("First record", c1, "Second record", c2),
            )


# Bump when you change the templates below; Ark records the version on each
# new document, so you can tell old documents from new ones later.
TEMPLATE_VERSION = 1

CLIENTS_COLUMNS = [
    {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True, "hidden": True},
    {"id": "name", "header": "Name", "widthPx": 260},
]
RECORDS_COLUMNS = [
    {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True, "hidden": True},
    {"id": "name", "header": "Name", "widthPx": 220},
    {"id": "client_id", "header": "Client", "widthPx": 100, "valueType": "number"},
]


def clients_template() -> dict:
    with db() as conn:
        rows = [dict(r) for r in conn.execute("SELECT id, name FROM clients ORDER BY id")]
    return {
        "name": "clients",
        "version": TEMPLATE_VERSION,
        "title": "Client list for marketing team",
        "description": "Synced with SQLite via sheet.changed notifications",
        "columns": CLIENTS_COLUMNS,
        "rows": rows,
    }


def records_template() -> dict:
    with db() as conn:
        rows = [
            dict(r)
            for r in conn.execute("SELECT id, name, client_id FROM records ORDER BY id")
        ]
    return {
        "name": "records",
        "version": TEMPLATE_VERSION,
        "title": "Business records for customer support team",
        "description": "Synced with SQLite via sheet.changed notifications",
        "columns": RECORDS_COLUMNS,
        "rows": rows,
    }


app = FastAPI(title="Ark partner (SQLite demo)")


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/ark/auth")
async def ark_auth(request: Request) -> dict:
    """Ark verifies browser ark_token here. Accept everything unless a token is configured."""
    _optional_example_partner_token(request)
    return {"status": "ok"}


@app.get("/ark/template/{path:path}")
async def ark_template(path: str, request: Request) -> dict:
    """Ark pulls this when creating a new document; rows prefill from SQLite."""
    _optional_example_partner_token(request)
    if path == "clients" or path.startswith("clients/"):
        return clients_template()
    if path == "records" or path.startswith("records/"):
        return records_template()
    raise HTTPException(status_code=404, detail="no template for this path")


def _int_or_none(v) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    s = str(v).strip()
    if s.isdigit() or (s.startswith("-") and s[1:].isdigit()):
        return int(s)
    return None


def _sync_table(sheet_path: str, sheet: dict) -> list[dict]:
    """Upsert sheet rows into SQLite. Returns Ark cell patches for new row ids."""
    table = "clients" if sheet_path == "clients" else "records"
    id_col_index = 1  # "id" is the first column in both sheets
    patches: list[dict] = []
    with db() as conn:
        seen_ids: set[int] = set()
        for i, row in enumerate(sheet.get("rows", [])):
            grid_row = i + 1
            rid = _int_or_none(row.get("id"))
            name = str(row.get("name") or "").strip()
            if rid is not None:
                seen_ids.add(rid)
                if table == "clients":
                    conn.execute("UPDATE clients SET name = ? WHERE id = ?", (name, rid))
                else:
                    cid = _int_or_none(row.get("client_id"))
                    if cid is not None:
                        conn.execute(
                            "UPDATE records SET name = ?, client_id = ? WHERE id = ?",
                            (name, cid, rid),
                        )
                    else:
                        conn.execute("UPDATE records SET name = ? WHERE id = ?", (name, rid))
            elif name:
                # New row typed into the grid: insert and patch the id back to Ark.
                if table == "clients":
                    cur = conn.execute("INSERT INTO clients (name) VALUES (?)", (name,))
                else:
                    cid = _int_or_none(row.get("client_id")) or 0
                    cur = conn.execute(
                        "INSERT INTO records (name, client_id) VALUES (?, ?)", (name, cid)
                    )
                new_id = cur.lastrowid
                seen_ids.add(new_id)
                patches.append({"row": grid_row, "col": id_col_index, "value": new_id})
        # Rows fully cleared in the grid are removed from SQLite.
        existing = {r[0] for r in conn.execute(f"SELECT id FROM {table}").fetchall()}
        for gone in existing - seen_ids:
            if table == "clients":
                conn.execute("DELETE FROM records WHERE client_id = ?", (gone,))
            conn.execute(f"DELETE FROM {table} WHERE id = ?", (gone,))
    return patches


@app.post("/ark/notify")
async def ark_notify(request: Request) -> dict:
    """Ark pushes lightweight change notifications; pull the full sheet and sync SQLite."""
    body = await request.json()
    sheet_path = body.get("sheetPath")
    if sheet_path not in ("clients", "records"):
        return {"status": "ignored"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            f"{ARK_API_URL}/api/partner/sheets/{sheet_path}", headers=_ARK_HEADERS
        )
        r.raise_for_status()
        sheet = r.json()
        patches = _sync_table(sheet_path, sheet)
        if patches:
            await client.patch(
                f"{ARK_API_URL}/api/partner/sheets/{sheet_path}",
                json={"cells": patches},
                headers=_ARK_HEADERS,
            )
    return {"status": "ok"}
