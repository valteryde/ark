"""Render a persisted sheet document to a PDF table.

Reads the same payload the browser and partner GET routes return, including
`cellStyles` (kebab-case CSS). Only the declarations the formatting toolbar
writes are painted. Unknown keys are ignored.
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
from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer

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
_PAGE_WIDTH = landscape(A4)[0] - 72  # 36pt margins on each side
_GRID = Color(0.82, 0.82, 0.82)
_HEADER_FILL = Color(0.96, 0.96, 0.96)
_BORDER = Color(100 / 255, 116 / 255, 139 / 255)  # #64748b


class PdfTooLarge(Exception):
    """The sheet has more data rows than a single export allows."""


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


def build_pdf_model(payload: dict[str, Any]) -> PdfModel:
    """Visible columns and data rows, including style-only cells."""
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

    headers: list[str] = []
    widths: list[float] = []
    body: list[tuple[PdfCellModel, ...]] = []
    for _index, column in visible:
        header = column.get("header")
        headers.append(header if isinstance(header, str) else str(column.get("id", "")))
        width = column.get("widthPx")
        widths.append(float(width) if isinstance(width, (int, float)) and width > 0 else 120.0)

    for row_index in range(1, row_count + 1):
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

    return PdfModel(
        title=title.strip(),
        filename=pdf_filename(payload),
        headers=tuple(headers),
        col_widths_px=tuple(widths),
        rows=tuple(body),
    )


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
    return [w / total * _PAGE_WIDTH for w in widths_px]


def render_sheet_pdf(payload: dict[str, Any]) -> tuple[bytes, str]:
    """Return `(pdf_bytes, filename)`. Raises PdfTooLarge before drawing."""
    model = build_pdf_model(payload)
    cache: dict[tuple[Any, ...], ParagraphStyle] = {}
    header_cell = PdfCellModel(text="", bold=True)
    data: list[list[Any]] = [[_paragraph(header, header_cell, cache) for header in model.headers]]
    commands: list[tuple[Any, ...]] = [
        ("BACKGROUND", (0, 0), (-1, 0), _HEADER_FILL),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("GRID", (0, 0), (-1, -1), 0.3, _GRID),
    ]
    for r, row in enumerate(model.rows, start=1):
        line: list[Any] = []
        for c, cell in enumerate(row):
            line.append(_paragraph(cell.text, cell, cache))
            if cell.fill is not None:
                commands.append(("BACKGROUND", (c, r), (c, r), Color(*cell.fill)))
            if cell.toolbar_border:
                commands.append(("BOX", (c, r), (c, r), 0.75, _BORDER))
        data.append(line)

    story: list[Any] = [
        Paragraph(escape(model.title), ParagraphStyle(
            name="ark-pdf-title",
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=18,
            textColor=black,
            spaceAfter=8,
        )),
        Spacer(1, 6),
    ]
    if model.headers:
        table = LongTable(data, colWidths=_column_widths(model.col_widths_px), repeatRows=1)
        table.setStyle(commands)
        story.append(table)

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
        title=model.title,
    )
    doc.build(story)
    return buffer.getvalue(), model.filename
