"""
SQLite-backed partner for Ark. Sheet payloads may nest grid config under `sheets[]` with a page-level `title`.

Routing suffixes `clients` / `records` (no `api/` prefix). Each URL path loads one sheet only — no bootstrap.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request

DB_PATH = Path(os.environ.get("PARTNER_DB", "/data/partner.db"))


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


app = FastAPI(title="Ark partner (SQLite demo)")


@app.on_event("startup")
def _startup() -> None:
    init_db()


def clients_sheet() -> dict:
    with db() as conn:
        rows = [
            dict(r)
            for r in conn.execute("SELECT id, name FROM clients ORDER BY id").fetchall()
        ]
    return {
        "title": "Client list for marketing team",
        "description": "Stored in SQLite",
        "sheets": [
            {
                "title": "Clients",
                "columns": [
                    {"id": "id", "header": "ID", "widthPx": 72, "readOnly": True},
                    {"id": "name", "header": "Name", "widthPx": 260},
                ],
                "rows": rows,
                "rowCount": len(rows) + 1,
            }
        ],
    }


def records_sheet() -> dict:
    with db() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT id, name, client_id FROM records ORDER BY id"
            ).fetchall()
        ]
    return {
        "title": "Business records for customer support team",
        "description": "Edits persist via POST /ark/tunnel",
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


def _coerce_client_id(value) -> int:
    if isinstance(value, bool):
        raise ValueError
    if isinstance(value, int):
        return value
    s = str(value).strip()
    if s.isdigit() or (s.startswith("-") and s[1:].isdigit()):
        return int(s)
    raise ValueError


def _coerce_sqlite_id(record_id) -> int | None:
    if record_id is None:
        return None
    if isinstance(record_id, bool):
        return None
    if isinstance(record_id, int):
        return record_id
    s = str(record_id).strip()
    if s.isdigit() or (s.startswith("-") and s[1:].isdigit()):
        return int(s)
    return None


def apply_tunnel_update(data: dict) -> None:
    t = data.get("type")
    if t == "delete_row":
        _apply_delete_row(data)
        return
    if t != "update_cell":
        return
    _apply_update_cell(data)


def _apply_delete_row(data: dict) -> None:
    meta = data.get("meta") or {}
    sheet = meta.get("sheetPath")
    row = data.get("row")
    if sheet is None or row is None:
        return
    if not isinstance(row, int) or row < 1:
        return
    record_id = data.get("recordId")
    if record_id is None and isinstance(meta, dict):
        record_id = meta.get("recordId")
    rid_by_key = _coerce_sqlite_id(record_id)

    with db() as conn:
        if sheet in ("clients", "api/clients"):
            rid = rid_by_key
            if rid is None:
                ids = [r[0] for r in conn.execute("SELECT id FROM clients ORDER BY id").fetchall()]
                if row > len(ids):
                    return
                rid = ids[row - 1]
            conn.execute("DELETE FROM records WHERE client_id = ?", (rid,))
            conn.execute("DELETE FROM clients WHERE id = ?", (rid,))
        elif sheet in ("records", "api/records"):
            rid = rid_by_key
            if rid is None:
                ids = [r[0] for r in conn.execute("SELECT id FROM records ORDER BY id").fetchall()]
                if row > len(ids):
                    return
                rid = ids[row - 1]
            conn.execute("DELETE FROM records WHERE id = ?", (rid,))


def _apply_update_cell(data: dict) -> None:
    meta = data.get("meta") or {}
    sheet = meta.get("sheetPath")
    row = data.get("row")
    col_id = data.get("columnId")
    value = data.get("value")
    if sheet is None or row is None or col_id is None:
        return
    if not isinstance(row, int) or row < 1:
        return

    record_id = data.get("recordId")
    if record_id is None and isinstance(meta, dict):
        record_id = meta.get("recordId")
    rid_by_key = _coerce_sqlite_id(record_id)

    with db() as conn:
        if sheet in ("clients", "api/clients"):
            if col_id != "name":
                return
            rid = rid_by_key
            if rid is None:
                ids = [r[0] for r in conn.execute("SELECT id FROM clients ORDER BY id").fetchall()]
                if row > len(ids):
                    return
                rid = ids[row - 1]
            conn.execute("UPDATE clients SET name = ? WHERE id = ?", (str(value), rid))
        elif sheet in ("records", "api/records"):
            if col_id not in ("name", "client_id"):
                return
            rid = rid_by_key
            if rid is None:
                ids = [r[0] for r in conn.execute("SELECT id FROM records ORDER BY id").fetchall()]
                if row > len(ids):
                    return
                rid = ids[row - 1]
            if col_id == "name":
                conn.execute("UPDATE records SET name = ? WHERE id = ?", (str(value), rid))
            else:
                try:
                    cid = _coerce_client_id(value)
                except ValueError:
                    return
                conn.execute("UPDATE records SET client_id = ? WHERE id = ?", (cid, rid))


@app.post("/ark/tunnel")
async def ark_tunnel(request: Request):
    _optional_example_partner_token(request)
    data = await request.json()
    try:
        apply_tunnel_update(data)
    except Exception:
        return {"status": "error", "message": "persist failed"}
    return {"status": "success"}
