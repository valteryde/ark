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
import re
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from .cell_span import CellSpanError, load_cell_spans, parse_cell_spans, spans_after_clearing_row
from .floating_image import (
    FloatingImageError,
    dump_floating_images,
    floating_image_geometry,
    load_floating_images,
    merge_floating_images,
    parse_floating_images,
)
from .cell_style import (
    CellStyleError,
    dump_style,
    load_style,
    parse_cell_style,
    parse_cell_styles_map,
)

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
    pdf_export INTEGER,
    template_name TEXT,
    template_version TEXT,
    cell_spans TEXT,
    cell_overflow TEXT,
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
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_path TEXT NOT NULL,
    sheet_id INTEGER,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    ip_address TEXT,
    revision INTEGER,
    details TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_sheet_path ON audit_logs(sheet_path, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
"""

_BLANK_COLUMN_HEADERS = ["A", "B", "C", "D", "E", "F", "G", "H"]
_BLANK_ROW_COUNT = 100
_BLANK_COLUMN_WIDTH_PX = 160

MAX_ROWS = 50_000
MAX_COLS = 500
MAX_CELL_STRING_LENGTH = 32_768  # 32 KB per cell
MAX_COLUMN_ID_LENGTH = 128
MAX_COLUMN_HEADER_LENGTH = 500
MAX_TITLE_LENGTH = 1_000
MAX_DESCRIPTION_LENGTH = 10_000

_SEGMENT_RE = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")


def blank_sheet_columns() -> list[dict[str, Any]]:
    return [
        {"id": h.lower(), "header": h, "widthPx": _BLANK_COLUMN_WIDTH_PX}
        for h in _BLANK_COLUMN_HEADERS
    ]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump_value(value: str | int | float) -> str:
    return json.dumps(value)


def _style_error(exc: CellStyleError) -> SheetValidationError:
    return SheetValidationError(str(exc))


def _load_value(raw: str) -> str | int | float:
    try:
        v = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw
    if isinstance(v, (str, int, float)) and not isinstance(v, bool):
        return v
    return raw


def _write_cell(
    conn: sqlite3.Connection,
    sheet_id: int,
    row: int,
    col: int,
    value: str | int | float,
    style: dict[str, str] | None,
) -> None:
    """Insert or replace one cell. An empty value with no style deletes the row."""
    if value == "" and not style:
        conn.execute(
            "DELETE FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
            (sheet_id, row, col),
        )
        return
    conn.execute(
        """
        INSERT INTO cells (sheet_id, row, col, value, style) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (sheet_id, row, col) DO UPDATE SET
            value = excluded.value,
            style = excluded.style
        """,
        (sheet_id, row, col, _dump_value(value), dump_style(style)),
    )


def _apply_seed_styles(
    conn: sqlite3.Connection,
    sheet_id: int,
    styles: dict[tuple[int, int], dict[str, str]],
) -> None:
    for (row, col), style in styles.items():
        existing = conn.execute(
            "SELECT value FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
            (sheet_id, row, col),
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO cells (sheet_id, row, col, value, style) VALUES (?, ?, ?, ?, ?)",
                (sheet_id, row, col, _dump_value(""), dump_style(style)),
            )
        else:
            conn.execute(
                "UPDATE cells SET style = ? WHERE sheet_id = ? AND row = ? AND col = ?",
                (dump_style(style), sheet_id, row, col),
            )


def _dump_spans(spans: list[dict[str, int]]) -> str | None:
    if not spans:
        return None
    return json.dumps(spans)


def _spans_or_raise(raw: Any, *, max_rows: int, max_cols: int) -> list[dict[str, int]]:
    try:
        return parse_cell_spans(raw, max_rows=max_rows, max_cols=max_cols)
    except CellSpanError as e:
        raise SheetValidationError(str(e)) from e


def _images_or_raise(raw: Any, *, require_src: bool) -> list[dict[str, Any]]:
    try:
        return parse_floating_images(raw, require_src=require_src)
    except FloatingImageError as e:
        raise SheetValidationError(str(e)) from e


def _parse_styles_or_raise(
    raw: Any,
) -> dict[tuple[int, int], dict[str, str]]:
    try:
        return parse_cell_styles_map(raw, max_rows=MAX_ROWS, max_cols=MAX_COLS)
    except CellStyleError as e:
        raise _style_error(e) from e


def _json_or_none(v: Any) -> str | None:
    return json.dumps(v) if v is not None else None


def _coerce_pdf_export(payload: dict[str, Any] | None) -> int | None:
    """NULL means export is allowed. 0 means the browser export is off.

    Omitted and explicit true both store NULL. Only an explicit false disables.
    """
    if not payload or "pdfExport" not in payload:
        return None
    value = payload["pdfExport"]
    if isinstance(value, bool):
        return 0 if value is False else None
    raise SheetValidationError("pdfExport must be a boolean")


CELL_OVERFLOW_MODES = frozenset({"spill", "clip"})


def _coerce_cell_overflow(payload: dict[str, Any] | None) -> str | None:
    """NULL means the frontend default (`spill`): long text runs across empty columns.

    Only `clip` is stored, because that is the one non-default value the UI needs.
    """
    if not payload or "cellOverflow" not in payload:
        return None
    value = payload["cellOverflow"]
    if value is None:
        return None
    if isinstance(value, str):
        mode = value.strip().lower()
        if mode in CELL_OVERFLOW_MODES:
            return None if mode == "spill" else mode
    raise SheetValidationError("cellOverflow must be 'spill' or 'clip'")


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
    if not isinstance(path, str):
        raise SheetValidationError("sheet path must be a string")
    clean = path.strip().strip("/")
    if not clean:
        raise SheetValidationError("sheet path must not be empty")
    segments = [s for s in clean.split("/") if s]
    if not segments:
        raise SheetValidationError("sheet path must not be empty")
    for s in segments:
        if not _SEGMENT_RE.fullmatch(s):
            raise SheetValidationError(
                f"invalid path segment: '{s}'. Segments must contain only alphanumeric characters, dashes, and underscores."
            )
    return "/".join(segments)


def validate_cell_value(value: Any) -> str | int | float:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise SheetValidationError("value must be a string or a number")
    if isinstance(value, str) and len(value) > MAX_CELL_STRING_LENGTH:
        raise SheetValidationError(
            f"cell value exceeds maximum length of {MAX_CELL_STRING_LENGTH} characters"
        )
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        raise SheetValidationError("value must be a finite number")
    return value


def _validate_title(title: Any) -> str | None:
    if title is None:
        return None
    if not isinstance(title, str) or len(title) > MAX_TITLE_LENGTH:
        raise SheetValidationError(f"title must be a string up to {MAX_TITLE_LENGTH} characters")
    return title


def _validate_description(description: Any) -> str | None:
    if description is None:
        return None
    if not isinstance(description, str) or len(description) > MAX_DESCRIPTION_LENGTH:
        raise SheetValidationError(f"description must be a string up to {MAX_DESCRIPTION_LENGTH} characters")
    return description


def _validate_columns(columns: Any) -> list[dict[str, Any]]:
    if not isinstance(columns, list) or not columns:
        raise SheetValidationError("columns must be a non-empty array")
    if len(columns) > MAX_COLS:
        raise SheetValidationError(f"columns must not exceed {MAX_COLS}")
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for c in columns:
        if not isinstance(c, dict):
            raise SheetValidationError("each column must be an object")
        cid = c.get("id")
        header = c.get("header")
        if not isinstance(cid, str) or not cid:
            raise SheetValidationError("column id must be a non-empty string")
        if len(cid) > MAX_COLUMN_ID_LENGTH:
            raise SheetValidationError(f"column id exceeds maximum length of {MAX_COLUMN_ID_LENGTH} characters")
        if cid in seen_ids:
            raise SheetValidationError(f"duplicate column id: {cid}")
        seen_ids.add(cid)
        if not isinstance(header, str):
            raise SheetValidationError("column header must be a string")
        if len(header) > MAX_COLUMN_HEADER_LENGTH:
            raise SheetValidationError(f"column header exceeds maximum length of {MAX_COLUMN_HEADER_LENGTH} characters")
        out.append(dict(c))
    return out


class SheetStore:
    """Thread-safe SQLite-backed sheet document store."""

    def __init__(self, db_path: str) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        if db_path != ":memory:":
            self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.execute("PRAGMA synchronous = NORMAL")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self._conn.executescript(_SCHEMA)
        self._ensure_cell_style_column()
        self._ensure_pdf_export_column()
        self._ensure_cell_spans_column()
        self._ensure_floating_images_column()
        self._ensure_cell_overflow_column()
        self._conn.commit()

    def _ensure_pdf_export_column(self) -> None:
        cols = {row[1] for row in self._conn.execute("PRAGMA table_info(sheets)")}
        if "pdf_export" not in cols:
            self._conn.execute("ALTER TABLE sheets ADD COLUMN pdf_export INTEGER")

    def _ensure_cell_spans_column(self) -> None:
        cols = {row[1] for row in self._conn.execute("PRAGMA table_info(sheets)")}
        if "cell_spans" not in cols:
            self._conn.execute("ALTER TABLE sheets ADD COLUMN cell_spans TEXT")

    def _ensure_floating_images_column(self) -> None:
        cols = {row[1] for row in self._conn.execute("PRAGMA table_info(sheets)")}
        if "floating_images" not in cols:
            self._conn.execute("ALTER TABLE sheets ADD COLUMN floating_images TEXT")

    def _ensure_cell_overflow_column(self) -> None:
        cols = {row[1] for row in self._conn.execute("PRAGMA table_info(sheets)")}
        if "cell_overflow" not in cols:
            self._conn.execute("ALTER TABLE sheets ADD COLUMN cell_overflow TEXT")

    def _ensure_cell_style_column(self) -> None:
        cols = {row[1] for row in self._conn.execute("PRAGMA table_info(cells)")}
        if "style" not in cols:
            self._conn.execute("ALTER TABLE cells ADD COLUMN style TEXT")

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
        self,
        path: str,
        template: dict[str, Any] | None = None,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        ip_address: str | None = None,
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
            if len(raw_rows) > MAX_ROWS:
                raise SheetValidationError(f"template rows must not exceed {MAX_ROWS}")
            for r in raw_rows:
                if not isinstance(r, dict):
                    raise SheetValidationError("each template row must be an object")
            rows = raw_rows
            cell_styles = _parse_styles_or_raise(template.get("cellStyles"))
            rc = template.get("rowCount")
            if rc is not None and (not isinstance(rc, int) or rc < 1):
                raise SheetValidationError("template rowCount must be an integer >= 1")
            if rc is not None and rc > MAX_ROWS:
                raise SheetValidationError(f"template rowCount must not exceed {MAX_ROWS}")
            # Documents always start with at least the blank-sheet room (same
            # floor as replace_sheet): templates seed data, they don't cap the
            # grid — Ark should feel like a spreadsheet, not a fixed form.
            style_max_row = max((r for r, _c in cell_styles), default=0)
            row_count = max(rc or 0, len(rows), style_max_row, _BLANK_ROW_COUNT)
            cell_spans = _spans_or_raise(
                template.get("cellSpans"),
                max_rows=row_count,
                max_cols=len(columns),
            )
            floating_images = _images_or_raise(template.get("floatingImages"), require_src=True)
            fields = {
                "title": _validate_title(template.get("title")),
                "description": _validate_description(template.get("description")),
                "columns": json.dumps(columns),
                "row_count": row_count,
                "ghost_row_count": template.get("ghostRowCount"),
                "default_row_height_px": template.get("defaultRowHeightPx"),
                "enabled_ui_capabilities": _json_or_none(template.get("enabledUiCapabilities")),
                "chrome_actions": _json_or_none(template.get("chromeActions")),
                "pdf_export": _coerce_pdf_export(template),
                "cell_overflow": _coerce_cell_overflow(template),
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
                "pdf_export": None,
                "cell_overflow": None,
            }
            col_index_by_id = {}
            cell_styles = {}
            cell_spans = []
            floating_images = []
        with self._lock:
            try:
                cur = self._conn.execute(
                    """
                    INSERT INTO sheets (path, title, description, columns, row_count,
                        ghost_row_count, default_row_height_px, enabled_ui_capabilities,
                        chrome_actions, pdf_export, cell_overflow, template_name, template_version,
                        revision, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
                        fields["pdf_export"],
                        fields["cell_overflow"],
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
                _apply_seed_styles(self._conn, sheet_id, cell_styles)
                if cell_spans:
                    self._conn.execute(
                        "UPDATE sheets SET cell_spans = ? WHERE id = ?",
                        (_dump_spans(cell_spans), sheet_id),
                    )
                if floating_images:
                    self._conn.execute(
                        "UPDATE sheets SET floating_images = ? WHERE id = ?",
                        (dump_floating_images(floating_images), sheet_id),
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
                self._conn.execute(
                    """
                    INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        path,
                        sheet_id,
                        "sheet.create",
                        actor_type,
                        actor_id,
                        ip_address,
                        1,
                        json.dumps({
                            "title": fields["title"],
                            "rowCount": fields["row_count"],
                            **(
                                {"template": {"name": template_name, "version": template_version}}
                                if template_version is not None
                                else {}
                            ),
                        }),
                        now,
                    ),
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
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        ip_address: str | None = None,
        column_id: str | None = None,
    ) -> int:
        """Write one cell on an existing sheet. Returns new revision.

        Sheets are created through `get_or_create_sheet` (browser GET) so the
        partner template is consulted; edits on unknown sheets are rejected.
        """
        if not isinstance(row, int) or not isinstance(col, int) or row < 1 or col < 1:
            raise SheetValidationError("row and col must be integers >= 1")
        if row > MAX_ROWS:
            raise SheetValidationError(f"row must not exceed {MAX_ROWS}")
        if col > MAX_COLS:
            raise SheetValidationError(f"col must not exceed {MAX_COLS}")
        value = validate_cell_value(value)
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision, row_count, columns FROM sheets WHERE path = ?", (path,)
            ).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            columns = _parse_json(sheet["columns"])
            if isinstance(columns, list) and 1 <= col <= len(columns):
                col_def = columns[col - 1]
                if isinstance(col_def, dict) and col_def.get("readOnly") is True:
                    raise SheetValidationError(
                        f"column '{col_def.get('id', col)}' is read-only"
                    )

            existing_cell = self._conn.execute(
                "SELECT value, style FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
                (sheet["id"], row, col),
            ).fetchone()
            old_value = _load_value(existing_cell["value"]) if existing_cell else None
            kept_style = load_style(existing_cell["style"]) if existing_cell else None

            resolved_col_id = column_id
            if not resolved_col_id and isinstance(columns, list) and 1 <= col <= len(columns):
                col_def = columns[col - 1]
                if isinstance(col_def, dict):
                    resolved_col_id = col_def.get("id")

            revision = sheet["revision"] + 1
            now = _now()
            action = "cell.clear" if value == "" else "cell.update"
            # Clearing the value keeps formatting. The row goes away only when
            # both the value and the style are empty.
            if value == "" and not kept_style:
                self._conn.execute(
                    "DELETE FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
                    (sheet["id"], row, col),
                )
            elif value == "" and existing_cell is not None:
                self._conn.execute(
                    "UPDATE cells SET value = ? WHERE sheet_id = ? AND row = ? AND col = ?",
                    (_dump_value(""), sheet["id"], row, col),
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
                (revision, new_row_count, now, sheet["id"]),
            )
            self._log_event(
                sheet["id"], revision, "cell", {"row": row, "col": col, "value": value}
            )
            details = {
                "row": row,
                "col": col,
                "columnId": resolved_col_id,
                "oldValue": old_value,
                "newValue": value,
            }
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet["id"],
                    action,
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps(details),
                    now,
                ),
            )
            self._conn.commit()
        return revision

    def apply_cell_style(
        self,
        path: str,
        row: int,
        col: int,
        style: Any,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        ip_address: str | None = None,
        column_id: str | None = None,
    ) -> tuple[int, dict[str, str] | None]:
        """Replace one cell's style. Returns (revision, stored style).

        `None` or `{}` clears formatting. An empty value with no style deletes
        the cell. The cell value is left unchanged. Read-only columns are rejected.
        """
        if not isinstance(row, int) or not isinstance(col, int) or row < 1 or col < 1:
            raise SheetValidationError("row and col must be integers >= 1")
        if row > MAX_ROWS:
            raise SheetValidationError(f"row must not exceed {MAX_ROWS}")
        if col > MAX_COLS:
            raise SheetValidationError(f"col must not exceed {MAX_COLS}")
        try:
            parsed = parse_cell_style(style)
        except CellStyleError as e:
            raise _style_error(e) from e
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision, row_count, columns FROM sheets WHERE path = ?", (path,)
            ).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            columns = _parse_json(sheet["columns"])
            if isinstance(columns, list) and 1 <= col <= len(columns):
                col_def = columns[col - 1]
                if isinstance(col_def, dict) and col_def.get("readOnly") is True:
                    raise SheetValidationError(
                        f"column '{col_def.get('id', col)}' is read-only"
                    )
            existing_cell = self._conn.execute(
                "SELECT value, style FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
                (sheet["id"], row, col),
            ).fetchone()
            old_style = load_style(existing_cell["style"]) if existing_cell else None
            stored_value: str | int | float = (
                _load_value(existing_cell["value"]) if existing_cell else ""
            )
            resolved_col_id = column_id
            if not resolved_col_id and isinstance(columns, list) and 1 <= col <= len(columns):
                col_def = columns[col - 1]
                if isinstance(col_def, dict):
                    resolved_col_id = col_def.get("id")
            revision = sheet["revision"] + 1
            now = _now()
            _write_cell(self._conn, sheet["id"], row, col, stored_value, parsed)
            new_row_count = max(sheet["row_count"], row)
            self._conn.execute(
                "UPDATE sheets SET revision = ?, row_count = ?, updated_at = ? WHERE id = ?",
                (revision, new_row_count, now, sheet["id"]),
            )
            self._log_event(
                sheet["id"],
                revision,
                "cell_style",
                {"row": row, "col": col, "style": parsed or {}},
            )
            details = {
                "row": row,
                "col": col,
                "columnId": resolved_col_id,
                "oldStyle": old_style,
                "newStyle": parsed,
            }
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet["id"],
                    "cell.style",
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps(details),
                    now,
                ),
            )
            self._conn.commit()
        return revision, parsed

    def apply_row_delete(
        self,
        path: str,
        row: int,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        ip_address: str | None = None,
    ) -> int:
        """Clear all cells in a row (grid semantics: no shift). Returns new revision."""
        if not isinstance(row, int) or row < 1:
            raise SheetValidationError("row must be an integer >= 1")
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision, cell_spans FROM sheets WHERE path = ?", (path,)
            ).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            old_cells = self._conn.execute(
                "SELECT col, value, style FROM cells WHERE sheet_id = ? AND row = ?",
                (sheet["id"], row),
            ).fetchall()
            cleared = []
            for r in old_cells:
                item: dict[str, Any] = {"col": r["col"], "value": _load_value(r["value"])}
                style = load_style(r["style"])
                if style:
                    item["style"] = style
                cleared.append(item)
            revision = sheet["revision"] + 1
            now = _now()
            self._conn.execute(
                "DELETE FROM cells WHERE sheet_id = ? AND row = ?", (sheet["id"], row)
            )
            kept_spans = spans_after_clearing_row(
                load_cell_spans(sheet["cell_spans"], max_rows=MAX_ROWS, max_cols=MAX_COLS),
                row,
            )
            self._conn.execute(
                "UPDATE sheets SET revision = ?, updated_at = ?, cell_spans = ? WHERE id = ?",
                (revision, now, _dump_spans(kept_spans), sheet["id"]),
            )
            self._log_event(sheet["id"], revision, "row_deleted", {"row": row})
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet["id"],
                    "row.delete",
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps({"row": row, "clearedCells": cleared}),
                    now,
                ),
            )
            self._conn.commit()
        return revision

    def apply_cell_spans(
        self,
        path: str,
        spans: Any,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        ip_address: str | None = None,
    ) -> tuple[int, list[dict[str, int]]]:
        """Replace the sheet's merge list. Returns (revision, stored spans).

        An empty list clears every merge. Covered cell values are not changed
        here; the grid clears them before sending the new list.
        """
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision, row_count, columns FROM sheets WHERE path = ?",
                (path,),
            ).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            columns = _parse_json(sheet["columns"])
            max_cols = len(columns) if isinstance(columns, list) and columns else 1
            stored = _spans_or_raise(
                spans,
                max_rows=sheet["row_count"],
                max_cols=max_cols,
            )
            revision = sheet["revision"] + 1
            now = _now()
            self._conn.execute(
                "UPDATE sheets SET cell_spans = ?, revision = ?, updated_at = ? WHERE id = ?",
                (_dump_spans(stored), revision, now, sheet["id"]),
            )
            self._log_event(sheet["id"], revision, "cell_spans", {"cellSpans": stored})
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet["id"],
                    "cell.spans",
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps({"cellSpans": stored}),
                    now,
                ),
            )
            self._conn.commit()
        return revision, stored

    def apply_floating_images(
        self,
        path: str,
        images: Any,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        ip_address: str | None = None,
    ) -> tuple[int, list[dict[str, Any]], list[dict[str, Any]]]:
        """Replace the sheet's pictures. Returns (revision, stored, wire).

        `wire` includes `src` only when the caller sent it. An omitted `src`
        keeps the bytes already stored for that id. An empty list clears them.
        """
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision, floating_images FROM sheets WHERE path = ?",
                (path,),
            ).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            previous = load_floating_images(
                sheet["floating_images"] if "floating_images" in sheet.keys() else None
            )
            incoming = _images_or_raise(images, require_src=False)
            try:
                stored, wire = merge_floating_images(previous, incoming)
            except FloatingImageError as e:
                raise SheetValidationError(str(e)) from e
            revision = sheet["revision"] + 1
            now = _now()
            geometry = floating_image_geometry(stored)
            self._conn.execute(
                "UPDATE sheets SET floating_images = ?, revision = ?, updated_at = ? WHERE id = ?",
                (dump_floating_images(stored), revision, now, sheet["id"]),
            )
            self._log_event(sheet["id"], revision, "floating_images", {"floatingImages": geometry})
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet["id"],
                    "floating_images.replace",
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps({"floatingImages": geometry}),
                    now,
                ),
            )
            self._conn.commit()
        return revision, stored, wire

    def replace_sheet(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        actor_type: str = "partner",
        actor_id: str | None = None,
        ip_address: str | None = None,
    ) -> dict[str, Any]:
        """Create or fully replace a sheet from a partner payload. Returns new payload."""
        path = normalize_sheet_path(path)
        if not path:
            raise SheetValidationError("sheet path must not be empty")
        columns = _validate_columns(payload.get("columns"))
        rows = payload.get("rows", [])
        if not isinstance(rows, list):
            raise SheetValidationError("rows must be an array")
        if len(rows) > MAX_ROWS:
            raise SheetValidationError(f"rows must not exceed {MAX_ROWS}")
        for r in rows:
            if not isinstance(r, dict):
                raise SheetValidationError("each row must be an object")
        row_count = payload.get("rowCount")
        if row_count is not None and (not isinstance(row_count, int) or row_count < 1):
            raise SheetValidationError("rowCount must be an integer >= 1")
        if row_count is not None and row_count > MAX_ROWS:
            raise SheetValidationError(f"rowCount must not exceed {MAX_ROWS}")
        cell_styles = _parse_styles_or_raise(payload.get("cellStyles"))
        pdf_export = _coerce_pdf_export(payload)
        cell_overflow = _coerce_cell_overflow(payload)
        style_max_row = max((r for r, _c in cell_styles), default=0)
        effective_row_count = max(row_count or 0, len(rows), style_max_row, _BLANK_ROW_COUNT)
        cell_spans = _spans_or_raise(
            payload.get("cellSpans"),
            max_rows=effective_row_count,
            max_cols=len(columns),
        )
        floating_images = _images_or_raise(payload.get("floatingImages"), require_src=True)
        col_index_by_id = {c["id"]: i + 1 for i, c in enumerate(columns)}
        title = _validate_title(payload.get("title"))
        description = _validate_description(payload.get("description"))
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
                action = "sheet.create"
            else:
                sheet_id = sheet["id"]
                revision = sheet["revision"] + 1
                action = "sheet.replace"
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
            _apply_seed_styles(self._conn, sheet_id, cell_styles)
            self._conn.execute(
                """
                UPDATE sheets SET title = ?, description = ?, columns = ?, row_count = ?,
                    ghost_row_count = ?, default_row_height_px = ?,
                    enabled_ui_capabilities = ?, chrome_actions = ?, pdf_export = ?,
                    cell_overflow = ?, cell_spans = ?, floating_images = ?, revision = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    title,
                    description,
                    json.dumps(columns),
                    effective_row_count,
                    payload.get("ghostRowCount"),
                    payload.get("defaultRowHeightPx"),
                    _json_or_none(payload.get("enabledUiCapabilities")),
                    _json_or_none(payload.get("chromeActions")),
                    pdf_export,
                    cell_overflow,
                    _dump_spans(cell_spans),
                    dump_floating_images(floating_images),
                    revision,
                    now,
                    sheet_id,
                ),
            )
            self._log_event(sheet_id, revision, "sheet_replaced", {"path": path})
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet_id,
                    action,
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps({
                        "title": title,
                        "rowCount": effective_row_count,
                        "columnCount": len(columns),
                        "seededRows": len(rows),
                    }),
                    now,
                ),
            )
            self._conn.commit()
        result = self.get_sheet_payload(path)
        assert result is not None
        return result

    def patch_sheet(
        self,
        path: str,
        patch: dict[str, Any],
        *,
        actor_type: str = "partner",
        actor_id: str | None = None,
        ip_address: str | None = None,
    ) -> dict[str, Any]:
        """Partial update: metadata fields and/or a list of cell updates.

        Returns dict with `revision` and `appliedCells` (resolved row/col/columnId/value
        per cell update, usable for browser broadcasts).
        """
        path = normalize_sheet_path(path)
        applied: list[dict[str, Any]] = []
        audit_cells: list[dict[str, Any]] = []
        applied_spans: list[dict[str, int]] | None = None
        applied_image_wire: list[dict[str, Any]] | None = None
        with self._lock:
            sheet = self._conn.execute("SELECT * FROM sheets WHERE path = ?", (path,)).fetchone()
            if sheet is None:
                raise SheetValidationError(f"sheet not found: {path}")
            columns = _parse_json(sheet["columns"]) or []
            image_dump: str | None = None
            replace_images = False
            if "floatingImages" in patch:
                previous_images = load_floating_images(
                    sheet["floating_images"] if "floating_images" in sheet.keys() else None
                )
                incoming_images = _images_or_raise(patch.get("floatingImages"), require_src=False)
                try:
                    stored_images, applied_image_wire = merge_floating_images(
                        previous_images, incoming_images
                    )
                except FloatingImageError as e:
                    raise SheetValidationError(str(e)) from e
                image_dump = dump_floating_images(stored_images)
                replace_images = True
            col_index_by_id = {c["id"]: i + 1 for i, c in enumerate(columns)}
            revision = sheet["revision"] + 1
            row_count = sheet["row_count"]

            cell_updates = patch.get("cells", [])
            if not isinstance(cell_updates, list):
                raise SheetValidationError("cells must be an array")
            for upd in cell_updates:
                if not isinstance(upd, dict):
                    raise SheetValidationError("each cell update must be an object")
                has_value = "value" in upd
                has_style = "style" in upd
                if not has_value and not has_style:
                    raise SheetValidationError("cell update needs value and/or style")
                row, col, column_id = self._resolve_cell_address(
                    sheet["id"], columns, col_index_by_id, upd
                )
                if col > MAX_COLS:
                    raise SheetValidationError(f"col must not exceed {MAX_COLS}")
                existing_cell = self._conn.execute(
                    "SELECT value, style FROM cells WHERE sheet_id = ? AND row = ? AND col = ?",
                    (sheet["id"], row, col),
                ).fetchone()
                old_val = _load_value(existing_cell["value"]) if existing_cell else None
                old_style = load_style(existing_cell["style"]) if existing_cell else None
                if has_value:
                    value = validate_cell_value(upd.get("value"))
                else:
                    value = old_val if old_val is not None else ""
                if has_style:
                    try:
                        style = parse_cell_style(upd.get("style"))
                    except CellStyleError as e:
                        raise _style_error(e) from e
                else:
                    style = old_style
                _write_cell(self._conn, sheet["id"], row, col, value, style)
                row_count = max(row_count, row)
                applied_cell: dict[str, Any] = {
                    "row": row,
                    "col": col,
                    "columnId": column_id,
                }
                audit_cell: dict[str, Any] = {
                    "row": row,
                    "col": col,
                    "columnId": column_id,
                }
                if has_value:
                    applied_cell["value"] = value
                    audit_cell["oldValue"] = old_val
                    audit_cell["newValue"] = value
                if has_style:
                    applied_cell["style"] = style
                    audit_cell["oldStyle"] = old_style
                    audit_cell["newStyle"] = style
                applied.append(applied_cell)
                audit_cells.append(audit_cell)

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
                        if rc > MAX_ROWS:
                            raise SheetValidationError(f"rowCount must not exceed {MAX_ROWS}")
                        params[2] = max(rc, row_count)
                    elif key == "title":
                        sets.append("title = ?")
                        params.append(_validate_title(patch["title"]))
                    elif key == "description":
                        sets.append("description = ?")
                        params.append(_validate_description(patch["description"]))
            if "cellSpans" in patch:
                applied_spans = _spans_or_raise(
                    patch.get("cellSpans"),
                    max_rows=params[2],
                    max_cols=len(columns) if isinstance(columns, list) and columns else 1,
                )
                sets.append("cell_spans = ?")
                params.append(_dump_spans(applied_spans))
            if replace_images:
                sets.append("floating_images = ?")
                params.append(image_dump)
            params.append(sheet["id"])
            self._conn.execute(f"UPDATE sheets SET {', '.join(sets)} WHERE id = ?", params)
            self._log_event(
                sheet["id"],
                revision,
                "sheet_patched",
                {
                    "cells": len(applied),
                    "fields": [
                        k
                        for k in ("title", "description", "rowCount", "cellSpans", "floatingImages")
                        if k in patch
                    ],
                },
            )
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet["id"],
                    "sheet.patch",
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps({
                        "appliedCells": audit_cells,
                        "fields": [
                            k
                            for k in ("title", "description", "rowCount", "cellSpans", "floatingImages")
                            if k in patch
                        ],
                        **(
                            {"floatingImages": floating_image_geometry(stored_images)}
                            if replace_images
                            else {}
                        ),
                    }),
                    _now(),
                ),
            )
            self._conn.commit()
        result: dict[str, Any] = {"revision": revision, "appliedCells": applied}
        if applied_spans is not None:
            result["cellSpans"] = applied_spans
        if applied_image_wire is not None:
            result["floatingImages"] = applied_image_wire
        return result

    def delete_sheet(
        self,
        path: str,
        *,
        actor_type: str = "partner",
        actor_id: str | None = None,
        ip_address: str | None = None,
    ) -> bool:
        path = normalize_sheet_path(path)
        with self._lock:
            sheet = self._conn.execute(
                "SELECT id, revision, title FROM sheets WHERE path = ?", (path,)
            ).fetchone()
            if sheet is None:
                return False
            sheet_id = sheet["id"]
            revision = sheet["revision"]
            title = sheet["title"]
            now = _now()
            cur = self._conn.execute("DELETE FROM sheets WHERE path = ?", (path,))
            self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    path,
                    sheet_id,
                    "sheet.delete",
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    json.dumps({"title": title, "lastRevision": revision}),
                    now,
                ),
            )
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
        if row > MAX_ROWS:
            raise SheetValidationError(f"row must not exceed {MAX_ROWS}")
        if isinstance(col, int) and col > MAX_COLS:
            raise SheetValidationError(f"col must not exceed {MAX_COLS}")
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
        cell_styles: dict[str, dict[str, str]] = {}
        for c in cells:
            v = _load_value(c["value"])
            style = load_style(c["style"])
            if style:
                cell_styles[f"{c['row']}:{c['col']}"] = style
            if v == "":
                continue
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
        if sheet["pdf_export"] == 0:
            payload["pdfExport"] = False
        if sheet["cell_overflow"]:
            payload["cellOverflow"] = sheet["cell_overflow"]
        if sheet["template_version"] is not None:
            template: dict[str, Any] = {"version": sheet["template_version"]}
            if sheet["template_name"] is not None:
                template["name"] = sheet["template_name"]
            payload["template"] = template
        if sparse:
            payload["cells"] = sparse
        if cell_styles:
            payload["cellStyles"] = cell_styles
        cell_spans = load_cell_spans(
            sheet["cell_spans"] if "cell_spans" in sheet.keys() else None,
            max_rows=MAX_ROWS,
            max_cols=MAX_COLS,
        )
        if cell_spans:
            payload["cellSpans"] = cell_spans
        floating_images = load_floating_images(
            sheet["floating_images"] if "floating_images" in sheet.keys() else None
        )
        if floating_images:
            payload["floatingImages"] = floating_images
        return payload

    # ------------------------------------------------------------ audit logs

    def log_audit_event(
        self,
        sheet_path: str,
        action: str,
        actor_type: str = "user",
        actor_id: str | None = None,
        ip_address: str | None = None,
        revision: int | None = None,
        details: dict[str, Any] | None = None,
        sheet_id: int | None = None,
    ) -> int:
        norm_path = normalize_sheet_path(sheet_path) if sheet_path else ""
        now = _now()
        details_json = json.dumps(details) if details is not None else None
        with self._lock:
            if sheet_id is None and norm_path:
                row = self._conn.execute(
                    "SELECT id, revision FROM sheets WHERE path = ?", (norm_path,)
                ).fetchone()
                if row is not None:
                    sheet_id = row["id"]
                    if revision is None:
                        revision = row["revision"]
            cur = self._conn.execute(
                """
                INSERT INTO audit_logs (sheet_path, sheet_id, action, actor_type, actor_id, ip_address, revision, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    norm_path,
                    sheet_id,
                    action,
                    actor_type,
                    actor_id,
                    ip_address,
                    revision,
                    details_json,
                    now,
                ),
            )
            self._conn.commit()
            return cur.lastrowid

    def get_audit_logs(
        self,
        sheet_path: str | None = None,
        action: str | None = None,
        actor_type: str | None = None,
        actor_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 100,
        offset: int = 0,
        order: str = "desc",
        prefix: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        limit = max(1, min(int(limit), 1000))
        offset = max(0, int(offset))
        sort_order = "ASC" if str(order).lower() == "asc" else "DESC"

        clauses: list[str] = ["1=1"]
        params: list[Any] = []

        if sheet_path:
            norm_path = normalize_sheet_path(sheet_path)
            clauses.append("sheet_path = ?")
            params.append(norm_path)
        elif prefix:
            norm_prefix = normalize_sheet_path(prefix)
            escaped_prefix = (
                norm_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            )
            clauses.append("(sheet_path = ? OR sheet_path LIKE ? ESCAPE '\\')")
            params.extend([norm_prefix, f"{escaped_prefix}/%"])

        if action:
            actions = [a.strip() for a in action.split(",") if a.strip()]
            if len(actions) == 1:
                clauses.append("action = ?")
                params.append(actions[0])
            elif len(actions) > 1:
                placeholders = ",".join("?" for _ in actions)
                clauses.append(f"action IN ({placeholders})")
                params.extend(actions)

        if actor_type:
            clauses.append("actor_type = ?")
            params.append(actor_type)

        if actor_id:
            clauses.append("actor_id = ?")
            params.append(actor_id)

        if since:
            clauses.append("created_at >= ?")
            params.append(since)

        if until:
            clauses.append("created_at <= ?")
            params.append(until)

        where_sql = " AND ".join(clauses)

        with self._lock:
            total = self._conn.execute(
                f"SELECT COUNT(*) AS total FROM audit_logs WHERE {where_sql}", params
            ).fetchone()["total"]

            query_sql = f"""
                SELECT * FROM audit_logs
                WHERE {where_sql}
                ORDER BY created_at {sort_order}, id {sort_order}
                LIMIT ? OFFSET ?
            """
            rows = self._conn.execute(query_sql, params + [limit, offset]).fetchall()

        items: list[dict[str, Any]] = []
        for r in rows:
            details = _parse_json(r["details"]) if r["details"] is not None else None
            item = {
                "id": r["id"],
                "sheetPath": r["sheet_path"],
                "sheet_path": r["sheet_path"],
                "action": r["action"],
                "actorType": r["actor_type"],
                "actor_type": r["actor_type"],
                "actorId": r["actor_id"],
                "actor_id": r["actor_id"],
                "ipAddress": r["ip_address"],
                "ip_address": r["ip_address"],
                "revision": r["revision"],
                "details": details,
                "createdAt": r["created_at"],
                "created_at": r["created_at"],
            }
            if r["sheet_id"] is not None:
                item["sheetId"] = r["sheet_id"]
                item["sheet_id"] = r["sheet_id"]
            items.append(item)

        return items, total

    def get_audit_log_by_id(self, log_id: int) -> dict[str, Any] | None:
        with self._lock:
            r = self._conn.execute("SELECT * FROM audit_logs WHERE id = ?", (log_id,)).fetchone()
            if r is None:
                return None
            details = _parse_json(r["details"]) if r["details"] is not None else None
            item = {
                "id": r["id"],
                "sheetPath": r["sheet_path"],
                "sheet_path": r["sheet_path"],
                "action": r["action"],
                "actorType": r["actor_type"],
                "actor_type": r["actor_type"],
                "actorId": r["actor_id"],
                "actor_id": r["actor_id"],
                "ipAddress": r["ip_address"],
                "ip_address": r["ip_address"],
                "revision": r["revision"],
                "details": details,
                "createdAt": r["created_at"],
                "created_at": r["created_at"],
            }
            if r["sheet_id"] is not None:
                item["sheetId"] = r["sheet_id"]
                item["sheet_id"] = r["sheet_id"]
            return item


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
