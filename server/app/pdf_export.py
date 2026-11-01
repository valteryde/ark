"""Render a persisted sheet document to a PDF table.

Reads the same payload the browser and partner GET routes return, including
`cellStyles` (kebab-case CSS). Only the declarations the formatting toolbar
writes are painted. Unknown keys are ignored.

Rows are measured and packed into pages here rather than left to ReportLab's
table splitting, so every page gets exactly one header row and a merge that
crosses a page edge is cut at that edge with its style on both sides.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib.colors import Color, black
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Frame, PageTemplate, Paragraph, Spacer, Table
from reportlab.platypus.doctemplate import BaseDocTemplate, LayoutError

from .cell_span import CellSpanError, parse_cell_spans

MAX_PDF_DATA_ROWS = 10_000
_TOOLBAR_BORDER = "inset 0 0 0 1px #64748b"
_CELL_KEY_RE = re.compile(r"^[1-9]\d*:[1-9]\d*$")
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGB_RE = re.compile(r"^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$")
_RGBA_RE = re.compile(
    r"^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(?:0?\.\d+|1(?:\.0+)?|0)\s*\)$"
)
_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_BOLD = frozenset({"700", "600", "bold", "bolder"})
_ALIGN = {"left": TA_LEFT, "center": TA_CENTER, "right": TA_RIGHT}
_PAGE_MARGIN = 36.0
_PAGE_SIZE = landscape(A4)
# The frame covers exactly the box inside the margins, so one page holds
# `_PAGE_HEIGHT` points and the table can be as wide as the frame.
_PAGE_WIDTH = _PAGE_SIZE[0] - 2 * _PAGE_MARGIN
_PAGE_HEIGHT = _PAGE_SIZE[1] - 2 * _PAGE_MARGIN
_TITLE_GAP = 6.0
_GRID = Color(0.82, 0.82, 0.82)
_HEADER_FILL = Color(0.96, 0.96, 0.96)
_BORDER = Color(100 / 255, 116 / 255, 139 / 255)  # #64748b


class PdfTooLarge(Exception):
    """The sheet has more data rows than a single export allows."""


class PdfLayoutError(Exception):
    """The sheet could not be laid out on paper, even after splitting."""


@dataclass(frozen=True)
class PdfCellModel:
    text: str
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strike: bool = False
    fill: tuple[float, float, float] | None = None
    text_color: tuple[float, float, float] | None = None
    align: str = "left"
    toolbar_border: bool = False


@dataclass(frozen=True)
class PdfModel:
    title: str
    filename: str
    headers: tuple[str, ...]
    col_widths_px: tuple[float, ...]
    rows: tuple[tuple[PdfCellModel, ...], ...]
    # ReportLab SPAN boxes: (col0, table_row, col1, table_row). Header is row 0.
    spans: tuple[tuple[int, int, int, int], ...] = ()
    # Coordinates inside a merge rectangle, anchor included, as (col, table_row).
    # The anchor's style paints the whole rectangle, so these cells carry no
    # fill or border of their own.
    merged_cells: frozenset[tuple[int, int]] = frozenset()
    # False when the caller asked for a file without the column header row.
    show_headers: bool = True


def parse_pdf_color(value: Any) -> tuple[float, float, float] | None:
    """Parse #rgb, #rrggbb, and #rrggbbaa (alpha dropped), plus rgb()/rgba()."""
    if not isinstance(value, str):
        return None
    t = value.strip()
    hex_m = _HEX_RE.fullmatch(t)
    if hex_m:
        h = hex_m.group(1)
        if len(h) in (3, 4):
            h = "".join(ch * 2 for ch in h[:3])
        else:
            h = h[:6]
        return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)
    rgb = _RGB_RE.fullmatch(t)
    if rgb and all(0 <= int(rgb.group(i)) <= 255 for i in (1, 2, 3)):
        return tuple(int(rgb.group(i)) / 255 for i in (1, 2, 3))  # type: ignore[return-value]
    rgba = _RGBA_RE.fullmatch(t)
    if rgba and all(0 <= int(rgba.group(i)) <= 255 for i in (1, 2, 3)):
        return tuple(int(rgba.group(i)) / 255 for i in (1, 2, 3))  # type: ignore[return-value]
    return None


def pdf_filename(payload: dict[str, Any]) -> str:
    title = payload.get("title")
    if isinstance(title, str) and title.strip():
        base = title.strip()
    else:
        path = payload.get("path")
        segment = path.strip("/").split("/")[-1] if isinstance(path, str) else ""
        base = segment or "sheet"
    cleaned = _FILENAME_RE.sub("-", base).strip("-._") or "sheet"
    if len(cleaned) > 80:
        cleaned = cleaned[:80].rstrip("-._") or "sheet"
    return f"{cleaned}.pdf"


def _is_bold(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return value.strip().lower() in _BOLD


def _align(style: dict[str, Any], *, number: bool) -> str:
    if "justify-content" in style:
        justify = str(style.get("justify-content") or "").strip().lower()
        if justify == "center":
            return "center"
        if justify in ("flex-end", "end"):
            return "right"
        return "left"
    if number:
        return "right"
    return "left"


def _decoration_tokens(style: dict[str, Any]) -> set[str]:
    raw = style.get("text-decoration-line")
    if not isinstance(raw, str):
        return set()
    return set(raw.strip().lower().split())


def _select_option(column: dict[str, Any], value: Any) -> dict[str, Any] | None:
    options = column.get("selectOptions")
    if not isinstance(options, list):
        return None
    wanted = str(value).strip()
    for opt in options:
        if isinstance(opt, dict) and str(opt.get("value", "")).strip() == wanted:
            return opt
    return None


def _display_text(column: dict[str, Any], value: Any) -> str:
    if value is None or value == "":
        return ""
    if column.get("valueType") == "select":
        opt = _select_option(column, value)
        if opt is not None:
            label = opt.get("label")
            if isinstance(label, str) and label.strip():
                return label.strip()
            return str(opt.get("value", value))
    return str(value)


def resolve_pdf_cell(
    column: dict[str, Any],
    value: Any,
    style: dict[str, Any] | None,
) -> PdfCellModel:
    """Map one cell's value and stored CSS onto the PDF table model."""
    raw_style = style if isinstance(style, dict) else {}
    text = _display_text(column, value)
    chip: dict[str, Any] | None = None
    if column.get("valueType") == "select" and value not in (None, ""):
        chip = _select_option(column, value)
    fill_fallback = chip.get("backgroundColor") if chip else None
    color_fallback = chip.get("color") if chip else None
    if "background-color" in raw_style:
        fill = parse_pdf_color(raw_style.get("background-color"))
    else:
        fill = parse_pdf_color(fill_fallback)
    if "color" in raw_style:
        text_color = parse_pdf_color(raw_style.get("color"))
    else:
        text_color = parse_pdf_color(color_fallback)
    tokens = _decoration_tokens(raw_style)
    border = (
        isinstance(raw_style.get("box-shadow"), str)
        and raw_style["box-shadow"].strip().lower() == _TOOLBAR_BORDER
    )
    return PdfCellModel(
        text=text,
        bold=_is_bold(raw_style.get("font-weight")),
        italic=str(raw_style.get("font-style") or "").strip().lower() == "italic",
        underline="underline" in tokens,
        strike="line-through" in tokens,
        fill=fill,
        text_color=text_color,
        align=_align(raw_style, number=column.get("valueType") == "number"),
        toolbar_border=border,
    )


def _style_for_key(cell_styles: Any, row: int, col: int) -> dict[str, Any] | None:
    if not isinstance(cell_styles, dict):
        return None
    raw = cell_styles.get(f"{row}:{col}")
    return raw if isinstance(raw, dict) else None


def build_pdf_model(
    payload: dict[str, Any],
    *,
    headers: bool = True,
    empty_columns: bool = True,
    empty_rows: bool = True,
) -> PdfModel:
    """Visible columns and data rows, including cells that only carry a style.

    `headers` is false when the file should leave the column header row out.
    `empty_columns` and `empty_rows` are false to drop the parts of the sheet that
    hold nothing: auto-hide, which is off unless the caller asks for it.
    """
    columns = payload.get("columns") if isinstance(payload.get("columns"), list) else []
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    visible: list[tuple[int, dict[str, Any]]] = []
    for index, column in enumerate(columns, start=1):
        if not isinstance(column, dict) or column.get("hidden") is True:
            continue
        visible.append((index, column))

    cell_styles = payload.get("cellStyles")
    visible_cols = {index for index, _column in visible}
    max_style_row = 0
    if isinstance(cell_styles, dict):
        for key in cell_styles:
            if not isinstance(key, str) or not _CELL_KEY_RE.fullmatch(key):
                continue
            row_s, col_s = key.split(":")
            row, col = int(row_s), int(col_s)
            if col in visible_cols:
                max_style_row = max(max_style_row, row)
    row_count = max(len(rows), max_style_row)
    if row_count > MAX_PDF_DATA_ROWS:
        raise PdfTooLarge(f"pdf export exceeds {MAX_PDF_DATA_ROWS} data rows")

    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        path = payload.get("path")
        title = path.strip() if isinstance(path, str) and path.strip() else "Sheet"

    # Merge rectangles first, in sheet coordinates: they decide what counts as
    # content, because the anchor of a merge paints the whole rectangle.
    spans = _sheet_spans(payload, visible_cols, row_count, len(columns))

    sheet_rows = list(range(1, row_count + 1))
    if not empty_columns or not empty_rows:
        used_cols, used_rows = _sheet_content(payload, columns, visible, spans, row_count)
        if not empty_columns:
            visible = [column for column in visible if used_cols[column[0]]]
        if not empty_rows:
            sheet_rows = [row for row in sheet_rows if used_rows[row]]

    col_map = {index: position for position, (index, _column) in enumerate(visible)}
    # Positions are 0-based here; `_print_spans` puts the header row in front.
    row_map = {row: position for position, row in enumerate(sheet_rows)}
    spans = _print_spans(spans, col_map, row_map)

    headers_out: list[str] = []
    widths: list[float] = []
    for _index, column in visible:
        header = column.get("header")
        headers_out.append(header if isinstance(header, str) else str(column.get("id", "")))
        width = column.get("widthPx")
        widths.append(float(width) if isinstance(width, (int, float)) and width > 0 else 120.0)

    body: list[tuple[PdfCellModel, ...]] = []
    for row_index in sheet_rows:
        source = rows[row_index - 1] if row_index - 1 < len(rows) else {}
        if not isinstance(source, dict):
            source = {}
        cells: list[PdfCellModel] = []
        for col_index, column in visible:
            col_id = column.get("id")
            value = source.get(col_id) if isinstance(col_id, str) else None
            cells.append(
                resolve_pdf_cell(column, value, _style_for_key(cell_styles, row_index, col_index))
            )
        body.append(tuple(cells))

    merged: set[tuple[int, int]] = set()
    for col0, row0, col1, row1 in spans:
        for table_row in range(row0, row1 + 1):
            line = list(body[table_row - 1])
            for col in range(col0, col1 + 1):
                merged.add((col, table_row))
                if table_row == row0 and col == col0:
                    continue
                # Like the grid, a merge takes its look from the anchor, and a
                # covered coordinate keeps no text of its own.
                line[col] = PdfCellModel(text="")
            body[table_row - 1] = tuple(line)

    return PdfModel(
        title=title.strip(),
        filename=pdf_filename(payload),
        headers=tuple(headers_out),
        col_widths_px=tuple(widths),
        rows=tuple(body),
        spans=tuple(spans),
        merged_cells=frozenset(merged),
        show_headers=headers and bool(headers_out),
    )


@dataclass(frozen=True)
class _SheetSpan:
    """One merged rectangle in sheet coordinates: 1-based column and data row."""

    col0: int
    row0: int
    col1: int
    row1: int


def _sheet_spans(
    payload: dict[str, Any],
    visible_cols: set[int],
    row_count: int,
    column_count: int,
) -> list[_SheetSpan]:
    """Merge rectangles that reach the export, in sheet coordinates.

    A rectangle whose anchor sits in a hidden column is left out, as the grid
    leaves it out. The bounds passed to `parse_cell_spans` are only a sanity cap:
    rows are clipped to the printed sheet and columns to the columns the sheet
    has, and a rectangle that runs past the printed rows is left out whole rather
    than drawn over rows that do not exist.
    """
    raw = payload.get("cellSpans")
    if not raw or row_count < 1 or not visible_cols:
        return []
    try:
        parsed = parse_cell_spans(raw, max_rows=1_000_000, max_cols=1_000_000)
    except CellSpanError:
        return []
    out: list[_SheetSpan] = []
    for span in parsed:
        col, row = span["col"], span["row"]
        if col not in visible_cols or row < 1 or row + span["rowSpan"] - 1 > row_count:
            continue
        col1 = min(col + span["colSpan"] - 1, column_count)
        out.append(_SheetSpan(col, row, col1, row + span["rowSpan"] - 1))
    return out


def _span_paints(payload: dict[str, Any], columns: list[Any], span: _SheetSpan) -> bool:
    """Whether a merged rectangle draws anything: text, a fill, or a border.

    The anchor cell decides the look of the whole rectangle, so this decides
    whether the strip of sheet the rectangle covers is worth printing.
    """
    column = columns[span.col0 - 1] if 1 <= span.col0 <= len(columns) else None
    if not isinstance(column, dict):
        return False
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    source = rows[span.row0 - 1] if 1 <= span.row0 <= len(rows) else None
    col_id = column.get("id")
    value = source.get(col_id) if isinstance(source, dict) and isinstance(col_id, str) else None
    cell = resolve_pdf_cell(
        column, value, _style_for_key(payload.get("cellStyles"), span.row0, span.col0)
    )
    return bool(cell.text) or cell.fill is not None or cell.toolbar_border


def _sheet_content(
    payload: dict[str, Any],
    columns: list[Any],
    visible: list[tuple[int, dict[str, Any]]],
    spans: list[_SheetSpan],
    row_count: int,
) -> tuple[bytearray, bytearray]:
    """Which columns and rows hold something, indexed by sheet coordinate.

    A value or a stored style counts, and so does every cell inside a merged
    rectangle that draws something: a band over forty empty rows is content, and
    dropping those rows would erase the work someone did in the sheet. A cell in a
    hidden column is not printed, so it is not content either.
    """
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    cell_styles = payload.get("cellStyles")
    used_cols = bytearray(len(columns) + 1)
    used_rows = bytearray(row_count + 1)
    visible_cols = {index for index, _column in visible}

    for row_index in range(1, row_count + 1):
        source = rows[row_index - 1] if row_index - 1 < len(rows) else None
        if not isinstance(source, dict):
            continue
        for index, column in visible:
            col_id = column.get("id")
            value = source.get(col_id) if isinstance(col_id, str) else None
            if value is None or value == "":
                continue
            used_cols[index] = 1
            used_rows[row_index] = 1

    if isinstance(cell_styles, dict):
        for key, style in cell_styles.items():
            if not isinstance(key, str) or not _CELL_KEY_RE.fullmatch(key):
                continue
            if not isinstance(style, dict) or not style:
                continue
            row_s, col_s = key.split(":")
            row, col = int(row_s), int(col_s)
            if col in visible_cols and row <= row_count:
                used_cols[col] = 1
                used_rows[row] = 1

    for span in spans:
        if not _span_paints(payload, columns, span):
            continue
        for col in range(span.col0, span.col1 + 1):
            used_cols[col] = 1
        for row in range(span.row0, span.row1 + 1):
            used_rows[row] = 1
    return used_cols, used_rows


def _print_spans(
    spans: list[_SheetSpan],
    col_map: dict[int, int],
    row_map: dict[int, int],
) -> list[tuple[int, int, int, int]]:
    """Rectangles in one table's coordinates: header row 0, printed rows from 1.

    A rectangle that crosses a column or a row the export dropped keeps the part
    that is printed, which is what lets a band end at the edge of the printed
    sheet instead of leaving a hole where the dropped strip used to be. A
    rectangle whose own anchor was dropped is left out, because the anchor is
    where its text and its look come from.
    """
    out: list[tuple[int, int, int, int]] = []
    for span in spans:
        anchor_col = col_map.get(span.col0)
        anchor_row = row_map.get(span.row0)
        if anchor_col is None or anchor_row is None:
            continue
        cols = [col_map[col] for col in range(span.col0, span.col1 + 1) if col in col_map]
        rows = [row_map[row] for row in range(span.row0, span.row1 + 1) if row in row_map]
        if not cols or not rows:
            continue
        col0, col1 = min(cols), max(cols)
        row0, row1 = min(rows) + 1, max(rows) + 1
        if col0 == col1 and row0 == row1:
            continue  # one cell needs no rectangle
        out.append((col0, row0, col1, row1))
    return out


def _font_name(cell: PdfCellModel) -> str:
    if cell.bold and cell.italic:
        return "Helvetica-BoldOblique"
    if cell.bold:
        return "Helvetica-Bold"
    if cell.italic:
        return "Helvetica-Oblique"
    return "Helvetica"


def _paragraph(text: str, cell: PdfCellModel, cache: dict[tuple[Any, ...], ParagraphStyle]) -> Paragraph:
    color = Color(*cell.text_color) if cell.text_color else black
    key = (_font_name(cell), cell.align, cell.text_color)
    style = cache.get(key)
    if style is None:
        style = ParagraphStyle(
            name=f"ark-pdf-{len(cache)}",
            fontName=_font_name(cell),
            fontSize=9,
            leading=12,
            textColor=color,
            alignment=_ALIGN[cell.align],
        )
        cache[key] = style
    markup = escape(text) if text else " "
    if cell.underline:
        markup = f"<u>{markup}</u>"
    if cell.strike:
        markup = f"<strike>{markup}</strike>"
    return Paragraph(markup, style)


def _column_widths(widths_px: tuple[float, ...]) -> list[float]:
    if not widths_px:
        return []
    total = sum(widths_px) or 1.0
    widths = [w / total * _PAGE_WIDTH for w in widths_px]
    # Keep the rounding drift out of the last column, so the table is never a
    # hair wider than the frame it is drawn into.
    widths[-1] = _PAGE_WIDTH - sum(widths[:-1])
    return widths


_GRID_COMMANDS: tuple[tuple[Any, ...], ...] = (
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 3),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ("GRID", (0, 0), (-1, -1), 0.3, _GRID),
)
_HEADER_BAND: tuple[Any, ...] = ("BACKGROUND", (0, 0), (-1, 0), _HEADER_FILL)

_PROBE_HEIGHT = 1_000_000.0


def _table_commands(header_row: bool) -> list[tuple[Any, ...]]:
    """Whole-table commands, starting with the header band when it has one."""
    return ([_HEADER_BAND] if header_row else []) + list(_GRID_COMMANDS)


def _model_spans(model: PdfModel, shift: int) -> list[tuple[int, int, int, int]]:
    """Merge rectangles in the row numbers of one table.

    A model row numbers the header 0 and data rows from 1. A table that prints
    no header row, or that only holds part of the sheet, numbers its own rows
    from 0, so its rectangles sit `shift` model rows lower.
    """
    return [(col0, row0 - shift, col1, row1 - shift) for col0, row0, col1, row1 in model.spans]


@dataclass(frozen=True)
class _Page:
    """One printed page: `model.rows[first:last]` and their row heights.

    `heights` starts with the header row when the file prints one. A page whose
    only row is taller than the page may break inside that row.
    """

    first: int
    last: int
    heights: tuple[float, ...]
    height: float
    break_in_row: bool


def _title_flowable(model: PdfModel) -> Paragraph:
    return Paragraph(
        escape(model.title),
        ParagraphStyle(
            name="ark-pdf-title",
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=18,
            textColor=black,
            spaceAfter=8,
        ),
    )


def _flowables(
    model: PdfModel,
    cache: dict[tuple[Any, ...], ParagraphStyle],
) -> tuple[list[Any], list[list[Any]]]:
    """Header and body cells as flowables, built once and reused per page.

    The header list is empty when the file leaves the column headers out.
    """
    header: list[Any] = []
    if model.show_headers:
        header_cell = PdfCellModel(text="", bold=True)
        header = [_paragraph(header, header_cell, cache) for header in model.headers]
    body = [[_paragraph(cell.text, cell, cache) for cell in row] for row in model.rows]
    return header, body


def _measure_heights(
    header: list[Any],
    body: list[list[Any]],
    model: PdfModel,
    widths: list[float],
) -> tuple[float | None, list[float]]:
    """The header row height (or None when it is not printed) and every data row.

    One probe table holds the whole sheet with the real paddings and the real
    merge rectangles, so a merge stretches the rows it covers the same way it
    does on paper and the pages planned from these heights really do fit.
    """
    probe = Table(([header] if header else []) + body, colWidths=widths)
    commands = _table_commands(bool(header))
    for col0, row0, col1, row1 in _model_spans(model, 0 if header else 1):
        commands.append(("SPAN", (col0, row0), (col1, row1)))
    probe.setStyle(commands)
    probe.wrap(_PAGE_WIDTH, _PROBE_HEIGHT)
    # ReportLab keeps the per-row heights it worked out on the table itself.
    heights = list(getattr(probe, "_rowHeights", ()) or ())
    if len(heights) != len(body) + (1 if header else 0) or any(h is None for h in heights):
        raise PdfLayoutError("pdf could not measure the sheet rows")
    values = [float(h) for h in heights]
    if not header:
        return None, values
    return values[0], values[1:]


def _plan_pages(
    header_height: float | None,
    row_heights: list[float],
    first_page_height: float,
    other_page_height: float,
) -> list[_Page]:
    """Pack measured rows into pages. With a header row, every page carries it.

    A merge that straddles a page edge is cut there rather than pushed whole to
    the next page, so a tall band keeps running down the sheet.
    """
    leading: tuple[float, ...] = () if header_height is None else (header_height,)
    header_space = sum(leading)
    pages: list[_Page] = []
    index = 0
    total = len(row_heights)
    available = first_page_height
    while index < total:
        budget = available - header_space
        take = 0
        used = 0.0
        while index + take < total and used + row_heights[index + take] <= budget:
            used += row_heights[index + take]
            take += 1
        if take == 0:
            # One row taller than a page still gets its own page, and the table
            # for it is allowed to break inside that row.
            take, used = 1, row_heights[index]
        pages.append(
            _Page(
                first=index,
                last=index + take,
                heights=(*leading, *row_heights[index:index + take]),
                height=header_space + used,
                break_in_row=used > budget,
            )
        )
        index += take
        available = other_page_height
    if not pages:
        pages.append(
            _Page(
                first=0,
                last=0,
                heights=leading,
                height=header_space,
                break_in_row=False,
            )
        )
    return pages


def _page_commands(model: PdfModel, page: _Page) -> list[tuple[Any, ...]]:
    """Paint one page: the header band, plain cell fills, and merge rectangles.

    Every merge is clipped to the rows this page prints, which is what lets a
    band that runs over a page edge keep its fill and border on the next page.
    """
    header_rows = 1 if model.show_headers else 0
    # Model rows minus this page's own row numbers.
    shift = page.first + 1 - header_rows
    commands = _table_commands(bool(header_rows))
    for col0, row0, col1, row1 in model.spans:  # model rows, header at 0
        top = max(row0, page.first + 1)
        bottom = min(row1, page.last)
        if top > bottom:
            continue
        anchor = model.rows[row0 - 1][col0]
        top -= shift
        bottom -= shift
        if top < bottom or col0 < col1:
            commands.append(("SPAN", (col0, top), (col1, bottom)))
        if anchor.fill is not None:
            commands.append(("BACKGROUND", (col0, top), (col1, bottom), Color(*anchor.fill)))
        if anchor.toolbar_border:
            commands.append(("BOX", (col0, top), (col1, bottom), 0.75, _BORDER))
    for index, row in enumerate(model.rows[page.first:page.last]):
        table_row = index + header_rows
        model_row = page.first + index + 1
        for col, cell in enumerate(row):
            if (col, model_row) in model.merged_cells:
                continue
            if cell.fill is not None:
                commands.append(("BACKGROUND", (col, table_row), (col, table_row), Color(*cell.fill)))
            if cell.toolbar_border:
                commands.append(("BOX", (col, table_row), (col, table_row), 0.75, _BORDER))
    return commands


def _table_for_page(
    model: PdfModel,
    page: _Page,
    header: list[Any],
    body: list[list[Any]],
    widths: list[float],
) -> Table:
    """One page as its own table.

    A page never splits, because ReportLab would then squeeze the first rows of
    the next page into the space left over and print the header row again under
    the one it already printed. Only a single row taller than a whole page is
    allowed to break, and that page has no header to repeat.
    """
    table = Table(
        ([header] if header else []) + body[page.first:page.last],
        colWidths=widths,
        rowHeights=list(page.heights),
        splitByRow=1 if page.break_in_row else 0,
        splitInRow=1 if page.break_in_row else 0,
    )
    table.setStyle(_page_commands(model, page))
    return table


def _story_for(model: PdfModel) -> list[Any]:
    """Title, spacer, and one table per page.

    The sheet is paginated from measured row heights instead of letting ReportLab
    split one long table, because that split can start a page with only a couple
    of rows and then repeat the header row again below it on the same page. Here
    a page holds as many rows as fit and prints the header exactly once.
    """
    title = _title_flowable(model)
    story: list[Any] = [title, Spacer(1, _TITLE_GAP)]
    if not model.headers:
        return story
    cache: dict[tuple[Any, ...], ParagraphStyle] = {}
    header, body = _flowables(model, cache)
    widths = _column_widths(model.col_widths_px)
    header_height, row_heights = _measure_heights(header, body, model, widths)
    used = (
        title.wrap(_PAGE_WIDTH, _PAGE_HEIGHT)[1]
        + title.getSpaceBefore()
        + title.getSpaceAfter()
        + _TITLE_GAP
    )
    pages = _plan_pages(header_height, row_heights, _PAGE_HEIGHT - used, _PAGE_HEIGHT)
    for page in pages:
        # A file with no header row and no data rows prints the title only.
        if not page.heights:
            continue
        story.append(_table_for_page(model, page, header, body, widths))
    return story


def _draw(story: list[Any], title: str) -> bytes:
    """Lay the story out on landscape A4 and return the PDF bytes.

    The frame is placed by hand with no extra padding, so the planned page
    heights match the space the story is actually given.
    """
    buffer = BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=_PAGE_SIZE,
        leftMargin=_PAGE_MARGIN,
        rightMargin=_PAGE_MARGIN,
        topMargin=_PAGE_MARGIN,
        bottomMargin=_PAGE_MARGIN,
        title=title,
    )
    frame = Frame(
        _PAGE_MARGIN,
        _PAGE_MARGIN,
        _PAGE_WIDTH,
        _PAGE_HEIGHT,
        id="ark-sheet",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="ark-sheet", frames=[frame])])
    doc.build(story)
    return buffer.getvalue()


def render_sheet_pdf(
    payload: dict[str, Any],
    *,
    headers: bool = True,
    empty_columns: bool = True,
    empty_rows: bool = True,
) -> tuple[bytes, str]:
    """Return `(pdf_bytes, filename)`. Raises PdfTooLarge before drawing.

    A merged rectangle that runs past a page edge is cut at that edge, and its
    fill and border continue on the next page; only its text stays with the
    anchor. Raises PdfLayoutError when even that cannot be laid out.

    `headers` is false for a file without the column header row, and
    `empty_columns` and `empty_rows` are false to leave out the columns and rows
    that hold no value and no style. All three default to printing what the sheet
    shows.
    """
    model = build_pdf_model(
        payload,
        headers=headers,
        empty_columns=empty_columns,
        empty_rows=empty_rows,
    )
    try:
        body = _draw(_story_for(model), model.title)
    except LayoutError as exc:
        raise PdfLayoutError(f"pdf layout failed: {exc}") from exc
    return body, model.filename
