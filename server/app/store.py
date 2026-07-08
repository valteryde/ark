"""SQLite document store for Ark sheets.

Ark owns sheet documents: sparse cells addressed by 1-based (row, col) grid
indices plus sheet metadata (columns, title, capabilities). Sheets are
auto-created on first access from a partner-provided template (fetched live at
creation time; the caller passes it in), or as a blank generic spreadsheet
when the partner has none. Each document records the template name and version
it was created from, since partners may change their templates over time.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    title TEXT,
    description TEXT,
    columns TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 100,
    ghost_row_count INTEGER,
    default_row_height_px REAL,
    enabled_ui_capabilities TEXT,
    chrome_actions TEXT,
    template_name TEXT,
    template_version TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cells (
    sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    value TEXT NOT NULL,
    style TEXT,
    PRIMARY KEY (sheet_id, row, col)
);
CREATE TABLE IF NOT EXISTS sheet_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sheet_events_sheet ON sheet_events(sheet_id, revision);
"""

_BLANK_COLUMN_HEADERS = ["A", "B", "C", "D", "E", "F", "G", "H"]
_BLANK_ROW_COUNT = 100
_BLANK_COLUMN_WIDTH_PX = 160


def blank_sheet_columns() -> list[dict[str, Any]]:
    return [
        {"id": h.lower(), "header": h, "widthPx": _BLANK_COLUMN_WIDTH_PX}
        for h in _BLANK_COLUMN_HEADERS
    ]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump_value(value: str | int | float) -> str:
    return json.dumps(value)


def _load_value(raw: str) -> str | int | float:
    try:
        v = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw
    if isinstance(v, (str, int, float)) and not isinstance(v, bool):
        return v
    return raw


def _json_or_none(v: Any) -> str | None:
    return json.dumps(v) if v is not None else None


def _parse_json(raw: str | None) -> Any:
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


class SheetValidationError(ValueError):
    """Raised when a sheet payload / mutation is structurally invalid."""


def normalize_sheet_path(path: str) -> str:
    segments = [s for s in path.split("/") if s]
    return "/".join(segments)


def validate_cell_value(value: Any) -> str | int | float:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise SheetValidationError("value must be a string or a number")
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        raise SheetValidationError("value must be a finite number")
    return value


def _validate_columns(columns: Any) -> list[dict[str, Any]]:
    if not isinstance(columns, list) or not columns:
        raise SheetValidationError("columns must be a non-empty array")
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for c in columns:
        if not isinstance(c, dict):
            raise SheetValidationError("each column must be an object")
        cid = c.get("id")
        header = c.get("header")
        if not isinstance(cid, str) or not cid:
            raise SheetValidationError("column id must be a non-empty string")
        if cid in seen_ids:
            raise SheetValidationError(f"duplicate column id: {cid}")
        seen_ids.add(cid)
        if not isinstance(header, str):
            raise SheetValidationError("column header must be a string")
        out.append(dict(c))
    return out


class SheetStore:
    """Thread-safe SQLite-backed sheet document store."""

    def __init__(self, db_path: str) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ reads

    def sheet_exists(self, path: str) -> bool:
        path = normalize_sheet_path(path)
        with self._lock:
            row = self._conn.execute("SELECT id FROM sheets WHERE path = ?", (path,)).fetchone()
        return row is not None

    def list_sheets(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT path, title, revision, updated_at FROM sheets ORDER BY path"
            ).fetchall()
        return [
            {
                "path": r["path"],
                "title": r["title"],
                "revision": r["revision"],
                "updatedAt": r["updated_at"],
            }
            for r in rows
        ]

    def get_sheet_payload(self, path: str) -> dict[str, Any] | None:
        """Serialize a sheet to the payload shape the frontend consumes."""
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute("SELECT * FROM sheets WHERE path = ?", (path,)).fetchone()
            if sheet is None:
                return None
            cells = self._conn.execute(
                "SELECT row, col, value, style FROM cells WHERE sheet_id = ?", (sheet["id"],)
            ).fetchall()
        return self._serialize(sheet, cells)

    def get_or_create_sheet(
        self, path: str, template: dict[str, Any] | None = None
    ) -> tuple[dict[str, Any], bool]:
        """Return (payload, created).

        `template` is a partner-provided template (already validated by the
        caller via `partner_template.parse_template_response`): a sheet payload
        with a mandatory `version` and optional `name` / `rows`. The created
        document records which template name/version it was built from. Without
        a template, a blank generic sheet is created. Templates are only
        consulted at creation time; existing sheets ignore the argument.
        """
        path = normalize_sheet_path(path)
        if not path:
            raise SheetValidationError("sheet path must not be empty")
        existing = self.get_sheet_payload(path)
        if existing is not None:
            return existing, False
        now = _now()
        template_name: str | None = None
        template_version: str | None = None
        rows: list[dict[str, Any]] = []
        if template is not None:
            columns = _validate_columns(template.get("columns"))
            version = template.get("version")
            if version is None:
                raise SheetValidationError("template must include a version")
            template_version = str(version)
            name = template.get("name")
            template_name = name if isinstance(name, str) and name else None
            raw_rows = template.get("rows") or []
            if not isinstance(raw_rows, list):
                raise SheetValidationError("template rows must be an array")
            for r in raw_rows:
                if not isinstance(r, dict):
                    raise SheetValidationError("each template row must be an object")
            rows = raw_rows
            rc = template.get("rowCount")
            if rc is not None and (not isinstance(rc, int) or rc < 1):
                raise SheetValidationError("template rowCount must be an integer >= 1")
            # Documents always start with at least the blank-sheet room (same
            # floor as replace_sheet): templates seed data, they don't cap the
            # grid — Ark should feel like a spreadsheet, not a fixed form.
            row_count = max(rc or 0, len(rows), _BLANK_ROW_COUNT)
            fields = {
                "title": template.get("title"),
                "description": template.get("description"),
                "columns": json.dumps(columns),
                "row_count": row_count,
                "ghost_row_count": template.get("ghostRowCount"),
                "default_row_height_px": template.get("defaultRowHeightPx"),
                "enabled_ui_capabilities": _json_or_none(template.get("enabledUiCapabilities")),
                "chrome_actions": _json_or_none(template.get("chromeActions")),
            }
            col_index_by_id = {c["id"]: i + 1 for i, c in enumerate(columns)}
        else:
            fields = {
                "title": None,
                "description": None,
                "columns": json.dumps(blank_sheet_columns()),
                "row_count": _BLANK_ROW_COUNT,
                "ghost_row_count": None,
                "default_row_height_px": None,
                "enabled_ui_capabilities": None,
                "chrome_actions": None,
            }
            col_index_by_id = {}
        with self._lock:
            try:
                cur = self._conn.execute(
                    """
                    INSERT INTO sheets (path, title, description, columns, row_count,
                        ghost_row_count, default_row_height_px, enabled_ui_capabilities,
                        chrome_actions, template_name, template_version,
                        revision, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        path,
                        fields["title"],
                        fields["description"],
                        fields["columns"],
                        fields["row_count"],
                        fields["ghost_row_count"],
                        fields["default_row_height_px"],
                        fields["enabled_ui_capabilities"],
                        fields["chrome_actions"],
                        template_name,
                        template_version,
                        now,
                        now,
                    ),
                )
                sheet_id = cur.lastrowid
                for r_idx, row_obj in enumerate(rows):
                    for cid, v in row_obj.items():
                        col = col_index_by_id.get(cid)
                        if col is None or v is None:
                            continue
                        v = (
                            v
                            if isinstance(v, (str, int, float)) and not isinstance(v, bool)
                            else str(v)
                        )
                        if v == "":
                            continue
                        self._conn.execute(
                            "INSERT INTO cells (sheet_id, row, col, value) VALUES (?, ?, ?, ?)",
                            (sheet_id, r_idx + 1, col, _dump_value(v)),
                        )
                self._log_event(
                    sheet_id,
                    1,
                    "sheet_created",
                    {
                        "path": path,
                        **(
                            {"template": {"name": template_name, "version": template_version}}
                            if template_version is not None
                            else {}
                        ),
                    },
                )
                self._conn.commit()
            except sqlite3.IntegrityError:
                # Concurrent create for the same path; the other writer won.
                self._conn.rollback()
        payload = self.get_sheet_payload(path)
        assert payload is not None
        return payload, True

    # -------------------------------------------------------------- mutations

    def apply_cell(
        self,
        path: str,
        row: int,
        col: int,
        value: str | int | float,
    ) -> int:
        """Write one cell on an existing sheet. Returns new revision.

        Sheets are created through `get_or_create_sheet` (browser GET) so the
        partner template is consulted; edits on unknown sheets are rejected.
        """
        if not isinstance(row, int) or not isinstance(col, int) or row < 1 or col < 1:
            raise SheetValidationError("row and col must be integers >= 1")
        value = validate_cell_value(value)
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision, row_count FROM sheets WHERE path = ?", (path,)
            ).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            revision = sheet["revision"] + 1
            if value == "":
                self._conn.execute(
                    "DELETE FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
                    (sheet["id"], row, col),
                )
            else:
                self._conn.execute(
                    """
                    INSERT INTO cells (sheet_id, row, col, value) VALUES (?, ?, ?, ?)
                    ON CONFLICT (sheet_id, row, col) DO UPDATE SET value = excluded.value
                    """,
                    (sheet["id"], row, col, _dump_value(value)),
                )
            new_row_count = max(sheet["row_count"], row)
            self._conn.execute(
                "UPDATE sheets SET revision = ?, row_count = ?, updated_at = ? WHERE id = ?",
                (revision, new_row_count, _now(), sheet["id"]),
            )
            self._log_event(
                sheet["id"], revision, "cell", {"row": row, "col": col, "value": value}
            )
            self._conn.commit()
        return revision

    def apply_row_delete(self, path: str, row: int) -> int:
        """Clear all cells in a row (grid semantics: no shift). Returns new revision."""
        if not isinstance(row, int) or row < 1:
            raise SheetValidationError("row must be an integer >= 1")
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision FROM sheets WHERE path = ?", (path,)
            ).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            revision = sheet["revision"] + 1
            self._conn.execute(
                "DELETE FROM cells WHERE sheet_id = ? AND row = ?", (sheet["id"], row)
            )
            self._conn.execute(
                "UPDATE sheets SET revision = ?, updated_at = ? WHERE id = ?",
                (revision, _now(), sheet["id"]),
            )
            self._log_event(sheet["id"], revision, "row_deleted", {"row": row})
            self._conn.commit()
        return revision

    def replace_sheet(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Create or fully replace a sheet from a partner payload. Returns new payload."""
        path = normalize_sheet_path(path)
        if not path:
            raise SheetValidationError("sheet path must not be empty")
        columns = _validate_columns(payload.get("columns"))
        rows = payload.get("rows", [])
        if not isinstance(rows, list):
            raise SheetValidationError("rows must be an array")
        for r in rows:
            if not isinstance(r, dict):
                raise SheetValidationError("each row must be an object")
        row_count = payload.get("rowCount")
        if row_count is not None and (not isinstance(row_count, int) or row_count < 1):
            raise SheetValidationError("rowCount must be an integer >= 1")
        effective_row_count = max(row_count or 0, len(rows), _BLANK_ROW_COUNT)
        col_index_by_id = {c["id"]: i + 1 for i, c in enumerate(columns)}
        now = _now()
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision FROM sheets WHERE path = ?", (path,)
            ).fetchone()
            if sheet is None:
                cur = self._conn.execute(
                    """
                    INSERT INTO sheets (path, columns, row_count, revision, created_at, updated_at)
                    VALUES (?, ?, ?, 0, ?, ?)
                    """,
                    (path, json.dumps(columns), effective_row_count, now, now),
                )
                sheet_id = cur.lastrowid
                revision = 1
            else:
                sheet_id = sheet["id"]
                revision = sheet["revision"] + 1
            self._conn.execute("DELETE FROM cells WHERE sheet_id = ?", (sheet_id,))
            for r_idx, row_obj in enumerate(rows):
                for cid, v in row_obj.items():
                    col = col_index_by_id.get(cid)
                    if col is None or v is None:
                        continue
                    v = v if isinstance(v, (str, int, float)) and not isinstance(v, bool) else str(v)
                    if v == "":
                        continue
                    self._conn.execute(
                        "INSERT INTO cells (sheet_id, row, col, value) VALUES (?, ?, ?, ?)",
                        (sheet_id, r_idx + 1, col, _dump_value(v)),
                    )
            self._conn.execute(
                """
                UPDATE sheets SET title = ?, description = ?, columns = ?, row_count = ?,
                    ghost_row_count = ?, default_row_height_px = ?,
                    enabled_ui_capabilities = ?, chrome_actions = ?,
                    revision = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.get("title"),
                    payload.get("description"),
                    json.dumps(columns),
                    effective_row_count,
                    payload.get("ghostRowCount"),
                    payload.get("defaultRowHeightPx"),
                    _json_or_none(payload.get("enabledUiCapabilities")),
                    _json_or_none(payload.get("chromeActions")),
                    revision,
                    now,
                    sheet_id,
                ),
            )
            self._log_event(sheet_id, revision, "sheet_replaced", {"path": path})
            self._conn.commit()
        result = self.get_sheet_payload(path)
        assert result is not None
        return result

    def patch_sheet(self, path: str, patch: dict[str, Any]) -> dict[str, Any]:
        """Partial update: metadata fields and/or a list of cell updates.

        Returns dict with `revision` and `appliedCells` (resolved row/col/columnId/value
        per cell update, usable for browser broadcasts).
        """
        path = normalize_sheet_path(path)
        applied: list[dict[str, Any]] = []
        with self._lock:
            sheet = self._conn.execute("SELECT * FROM sheets WHERE path = ?", (path,)).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            columns = _parse_json(sheet["columns"]) or []
            col_index_by_id = {c["id"]: i + 1 for i, c in enumerate(columns)}
            revision = sheet["revision"] + 1
            row_count = sheet["row_count"]

            cell_updates = patch.get("cells", [])
            if not isinstance(cell_updates, list):
                raise SheetValidationError("cells must be an array")
            for upd in cell_updates:
                if not isinstance(upd, dict):
                    raise SheetValidationError("each cell update must be an object")
                value = validate_cell_value(upd.get("value"))
                row, col, column_id = self._resolve_cell_address(
                    sheet["id"], columns, col_index_by_id, upd
                )
                if value == "":
                    self._conn.execute(
                        "DELETE FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
                        (sheet["id"], row, col),
                    )
                else:
                    self._conn.execute(
                        """
                        INSERT INTO cells (sheet_id, row, col, value) VALUES (?, ?, ?, ?)
                        ON CONFLICT (sheet_id, row, col) DO UPDATE SET value = excluded.value
                        """,
                        (sheet["id"], row, col, _dump_value(value)),
                    )
                row_count = max(row_count, row)
                applied.append({"row": row, "col": col, "columnId": column_id, "value": value})

            sets: list[str] = ["revision = ?", "updated_at = ?", "row_count = ?"]
            params: list[Any] = [revision, _now(), row_count]
            for key, column in (
                ("title", "title"),
                ("description", "description"),
                ("rowCount", "row_count"),
            ):
                if key in patch:
                    if key == "rowCount":
                        rc = patch[key]
                        if not isinstance(rc, int) or rc < 1:
                            raise SheetValidationError("rowCount must be an integer >= 1")
                        params[2] = max(rc, row_count)
                    else:
                        sets.append(f"{column} = ?")
                        params.append(patch[key])
            params.append(sheet["id"])
            self._conn.execute(f"UPDATE sheets SET {', '.join(sets)} WHERE id = ?", params)
            self._log_event(
                sheet["id"],
                revision,
                "sheet_patched",
                {"cells": len(applied), "fields": [k for k in ("title", "description", "rowCount") if k in patch]},
            )
            self._conn.commit()
        return {"revision": revision, "appliedCells": applied}

    def delete_sheet(self, path: str) -> bool:
        path = normalize_sheet_path(path)
        with self._lock:
            cur = self._conn.execute("DELETE FROM sheets WHERE path = ?", (path,))
            self._conn.commit()
        return cur.rowcount > 0

    # -------------------------------------------------------------- internals

    def _resolve_cell_address(
        self,
        sheet_id: int,
        columns: list[dict[str, Any]],
        col_index_by_id: dict[str, int],
        upd: dict[str, Any],
    ) -> tuple[int, int, str | None]:
        """Resolve a cell update to (row, col, columnId)."""
        column_id = upd.get("columnId")
        col = upd.get("col")
        row = upd.get("row")
        if column_id is not None:
            if column_id not in col_index_by_id:
                raise SheetValidationError(f"unknown columnId: {column_id}")
            col = col_index_by_id[column_id]
        elif isinstance(col, int) and col >= 1:
            column_id = columns[col - 1]["id"] if col <= len(columns) else None
        else:
            raise SheetValidationError("cell update needs columnId or col")

        record_id = upd.get("recordId")
        if row is None and record_id is not None:
            row = self._find_row_by_record_id(sheet_id, columns, col_index_by_id, record_id)
            if row is None:
                raise SheetValidationError(f"recordId not found: {record_id}")
        if not isinstance(row, int) or row < 1:
            raise SheetValidationError("cell update needs row (integer >= 1) or a known recordId")
        return row, col, column_id

    def _find_row_by_record_id(
        self,
        sheet_id: int,
        columns: list[dict[str, Any]],
        col_index_by_id: dict[str, int],
        record_id: Any,
    ) -> int | None:
        id_col: int | None = None
        for c in columns:
            if c.get("readOnly"):
                id_col = col_index_by_id[c["id"]]
                break
        if id_col is None:
            return None
        rows = self._conn.execute(
            "SELECT row, value FROM cells WHERE sheet_id = ? AND col = ?", (sheet_id, id_col)
        ).fetchall()
        wanted = str(record_id)
        for r in rows:
            if str(_load_value(r["value"])) == wanted:
                return r["row"]
        return None

    def _log_event(self, sheet_id: int, revision: int, kind: str, payload: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT INTO sheet_events (sheet_id, revision, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (sheet_id, revision, kind, json.dumps(payload), _now()),
        )

    def _serialize(self, sheet: sqlite3.Row, cells: list[sqlite3.Row]) -> dict[str, Any]:
        columns = _parse_json(sheet["columns"]) or []
        n_cols = len(columns)
        col_ids = [c["id"] for c in columns]
        max_row = 0
        in_schema: dict[tuple[int, int], str | int | float] = {}
        sparse: dict[str, str | int | float] = {}
        for c in cells:
            v = _load_value(c["value"])
            if 1 <= c["col"] <= n_cols:
                in_schema[(c["row"], c["col"])] = v
                max_row = max(max_row, c["row"])
            else:
                sparse[f"{c['row']}:{c['col']}"] = v
        rows: list[dict[str, Any]] = []
        for r in range(1, max_row + 1):
            obj: dict[str, Any] = {}
            for ci in range(1, n_cols + 1):
                v = in_schema.get((r, ci))
                if v is not None:
                    obj[col_ids[ci - 1]] = v
            rows.append(obj)
        payload: dict[str, Any] = {
            "columns": columns,
            "rows": rows,
            "rowCount": max(sheet["row_count"], max_row),
            "revision": sheet["revision"],
            "path": sheet["path"],
        }
        if sheet["title"] is not None:
            payload["title"] = sheet["title"]
        if sheet["description"] is not None:
            payload["description"] = sheet["description"]
        if sheet["ghost_row_count"] is not None:
            payload["ghostRowCount"] = sheet["ghost_row_count"]
        if sheet["default_row_height_px"] is not None:
            payload["defaultRowHeightPx"] = sheet["default_row_height_px"]
        caps = _parse_json(sheet["enabled_ui_capabilities"])
        if caps is not None:
            payload["enabledUiCapabilities"] = caps
        actions = _parse_json(sheet["chrome_actions"])
        if actions is not None:
            payload["chromeActions"] = actions
        if sheet["template_version"] is not None:
            template: dict[str, Any] = {"version": sheet["template_version"]}
            if sheet["template_name"] is not None:
                template["name"] = sheet["template_name"]
            payload["template"] = template
        if sparse:
            payload["cells"] = sparse
        return payload


_store: SheetStore | None = None
_store_lock = threading.Lock()


def get_store() -> SheetStore:
    """Process-wide store singleton; DB path from ARK_DB_PATH (default ./ark.db)."""
    global _store
    with _store_lock:
        if _store is None:
            _store = SheetStore(os.environ.get("ARK_DB_PATH", "ark.db"))
        return _store


def reset_store() -> None:
    """Close and drop the singleton (tests re-read ARK_DB_PATH on next get_store)."""
    global _store
    with _store_lock:
        if _store is not None:
            _store.close()
            _store = None
