"""Merged-cell rectangles stored on a sheet.

A span is the top-left anchor plus how many rows and columns it covers.
The cell value and style stay on the anchor. Covered coordinates are empty.
Rectangles must not overlap and must stay inside the sheet.
"""

from __future__ import annotations

import json
from typing import Any

MAX_CELL_SPANS = 10_000


class CellSpanError(ValueError):
    """A caller-supplied cellSpans list is not usable."""


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1:
        return None
    return value


def _overlaps(a: dict[str, int], b: dict[str, int]) -> bool:
    a_row2 = a["row"] + a["rowSpan"] - 1
    b_row2 = b["row"] + b["rowSpan"] - 1
    a_col2 = a["col"] + a["colSpan"] - 1
    b_col2 = b["col"] + b["colSpan"] - 1
    return a["row"] <= b_row2 and b["row"] <= a_row2 and a["col"] <= b_col2 and b["col"] <= a_col2


def parse_cell_spans(
    raw: Any,
    *,
    max_rows: int,
    max_cols: int,
) -> list[dict[str, int]]:
    """Validate a cellSpans array. `None` is an empty list.

    Raises CellSpanError on a bad entry, an overlap, or a rectangle outside
    `1..max_rows` by `1..max_cols`. A 1×1 rectangle is not a merge.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise CellSpanError("cellSpans must be an array")
    if len(raw) > MAX_CELL_SPANS:
        raise CellSpanError(f"cellSpans must not exceed {MAX_CELL_SPANS}")
    out: list[dict[str, int]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise CellSpanError("each cell span must be an object")
        row = _positive_int(item.get("row"))
        col = _positive_int(item.get("col"))
        row_span = _positive_int(item.get("rowSpan"))
        col_span = _positive_int(item.get("colSpan"))
        if row is None or col is None or row_span is None or col_span is None:
            raise CellSpanError("cell span row, col, rowSpan, and colSpan must be integers >= 1")
        if row_span == 1 and col_span == 1:
            raise CellSpanError("cell span must cover at least two cells")
        if row > max_rows or col > max_cols:
            raise CellSpanError("cell span is outside the sheet")
        if row + row_span - 1 > max_rows or col + col_span - 1 > max_cols:
            raise CellSpanError("cell span is outside the sheet")
        span = {"row": row, "col": col, "rowSpan": row_span, "colSpan": col_span}
        for prev in out:
            if _overlaps(prev, span):
                raise CellSpanError("cell spans must not overlap")
        out.append(span)
    return out


def load_cell_spans(raw: str | None, *, max_rows: int, max_cols: int) -> list[dict[str, int]]:
    """Read a stored JSON list. Corrupt or out-of-range payloads become empty."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    try:
        return parse_cell_spans(data, max_rows=max_rows, max_cols=max_cols)
    except CellSpanError:
        return []


def spans_after_clearing_row(spans: list[dict[str, int]], row: int) -> list[dict[str, int]]:
    """Drop spans that include `row`. Row delete clears cells and does not shift."""
    return [span for span in spans if row < span["row"] or row >= span["row"] + span["rowSpan"]]
