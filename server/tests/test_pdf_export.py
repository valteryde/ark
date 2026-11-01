import base64
import re
import zlib

import pytest

from app.pdf_export import (
    MAX_PDF_DATA_ROWS,
    PdfTooLarge,
    _Page,
    _page_commands,
    _plan_pages,
    build_pdf_model,
    parse_pdf_color,
    render_sheet_pdf,
    resolve_pdf_cell,
)

COLUMNS = [
    {"id": "name", "header": "Name", "widthPx": 200},
    {
        "id": "priority",
        "header": "Priority",
        "widthPx": 120,
        "valueType": "select",
        "selectOptions": [
            {"value": "HIGH", "label": "High", "color": "#1b4332", "backgroundColor": "#d8f3dc"},
        ],
    },
    {"id": "amount", "header": "Amount", "widthPx": 80, "valueType": "number"},
    {"id": "secret", "header": "Secret", "widthPx": 80, "hidden": True},
]


def _cell(row, col):
    model = build_pdf_model(
        {
            "title": "Clients",
            "path": "clients/21",
            "columns": COLUMNS,
            "rows": [
                {"name": "Acme", "priority": "HIGH", "amount": 12, "secret": "nope"},
                {"name": "", "amount": 3},
            ],
            "cellStyles": {
                "1:1": {
                    "font-weight": "700",
                    "background-color": "#fff59d",
                    "color": "#2563eb",
                    "text-decoration-line": "underline line-through",
                    "font-style": "italic",
                    "box-shadow": "inset 0 0 0 1px #64748b",
                    "position": "fixed",
                },
                "2:1": {"background-color": "#fff59d"},
                "2:3": {"justify-content": "center"},
                "4:1": {"background-color": "#eeeeee"},
                "1:4": {"color": "#111111"},
            },
        }
    )
    return model, model.rows[row][col]


def test_parse_pdf_color_hex_and_rgb():
    assert parse_pdf_color("#fff") == (1, 1, 1)
    assert parse_pdf_color("#fff59d") == (1, 245 / 255, 157 / 255)
    assert parse_pdf_color("#fff59dff") == (1, 245 / 255, 157 / 255)
    assert parse_pdf_color("rgb(37, 99, 235)") == (37 / 255, 99 / 255, 235 / 255)
    assert parse_pdf_color("not-a-color") is None


def test_styled_cell_select_label_and_hidden_column():
    model, name = _cell(0, 0)
    assert model.headers == ("Name", "Priority", "Amount")
    assert name.text == "Acme"
    assert name.bold is True
    assert name.italic is True
    assert name.underline is True
    assert name.strike is True
    assert name.toolbar_border is True
    assert name.fill == parse_pdf_color("#fff59d")
    assert name.text_color == parse_pdf_color("#2563eb")

    priority = model.rows[0][1]
    assert priority.text == "High"
    assert priority.fill == parse_pdf_color("#d8f3dc")
    assert priority.text_color == parse_pdf_color("#1b4332")

    amount = model.rows[0][2]
    assert amount.text == "12"
    assert amount.align == "right"

    centered = model.rows[1][2]
    assert centered.align == "center"
    blank = model.rows[1][0]
    assert blank.text == ""
    assert blank.fill == parse_pdf_color("#fff59d")
    # Style-only row 4 is included; the hidden column's style is not a column.
    assert len(model.rows) == 4
    assert model.rows[3][0].fill == parse_pdf_color("#eeeeee")


def test_cell_style_wins_over_select_chip_and_number_align():
    cell = resolve_pdf_cell(
        COLUMNS[1],
        "HIGH",
        {"background-color": "#111111", "justify-content": "flex-end"},
    )
    assert cell.text == "High"
    assert cell.fill == parse_pdf_color("#111111")
    assert cell.text_color == parse_pdf_color("#1b4332")
    assert cell.align == "right"

    number = resolve_pdf_cell(COLUMNS[2], 4, {"justify-content": "flex-start"})
    assert number.align == "left"
    other_border = resolve_pdf_cell(
        COLUMNS[0], "A", {"box-shadow": "inset 0 0 0 1px #000000"}
    )
    assert other_border.toolbar_border is False


def test_merged_cells_span_visible_columns_and_blank_covered_text():
    model = build_pdf_model(
        {
            "title": "Merged",
            "columns": COLUMNS,
            "rows": [
                {"name": "Acme", "priority": "HIGH", "amount": 12, "secret": "nope"},
                {"name": "Beta", "priority": "HIGH"},
            ],
            "cellSpans": [
                {"row": 1, "col": 1, "rowSpan": 1, "colSpan": 2},
                {"row": 1, "col": 4, "rowSpan": 2, "colSpan": 1},
            ],
        }
    )
    assert model.spans == ((0, 1, 1, 1),)
    assert model.rows[0][0].text == "Acme"
    assert model.rows[0][1].text == ""
    body, _filename = render_sheet_pdf(
        {
            "title": "Merged",
            "columns": COLUMNS,
            "rows": [{"name": "Acme", "priority": "HIGH"}],
            "cellSpans": [{"row": 1, "col": 1, "rowSpan": 1, "colSpan": 2}],
        }
    )
    assert body.startswith(b"%PDF")


def test_too_many_rows():
    payload = {
        "title": "Big",
        "columns": [{"id": "name", "header": "Name", "widthPx": 100}],
        "rows": [{} for _ in range(MAX_PDF_DATA_ROWS + 1)],
    }
    with pytest.raises(PdfTooLarge):
        build_pdf_model(payload)


def test_render_starts_with_pdf_magic():
    body, filename = render_sheet_pdf(
        {
            "title": "Client / 21",
            "path": "clients/21",
            "columns": [{"id": "name", "header": "Name", "widthPx": 160}],
            "rows": [{"name": "Acme"}],
        }
    )
    assert body.startswith(b"%PDF")
    assert filename == "Client-21.pdf"


_PAGE_RE = re.compile(rb"/Type\s*/Page[^s]")


def _page_count(body: bytes) -> int:
    return len(_PAGE_RE.findall(body))


def _tall_sheet(rows: int) -> dict:
    """Four columns. Only B carries text, so every row keeps a real height.

    The other columns are empty and get merged into tall bands, which is what a
    grade sheet template looks like.
    """
    return {
        "title": "Grade sheet",
        "path": "karakter/d/1",
        "columns": [
            {"id": "a", "header": "A", "widthPx": 48},
            {"id": "b", "header": "B", "widthPx": 320},
            {"id": "c", "header": "C", "widthPx": 48},
            {"id": "d", "header": "D", "widthPx": 48},
        ],
        "rows": [{"a": "", "b": f"row {i}", "c": "", "d": ""} for i in range(1, rows + 1)],
        "cellStyles": {
            f"{row}:{col}": {"background-color": "#cfe2f3"}
            for row in range(1, rows + 1)
            for col in (1, 3, 4)
        },
    }


def test_merge_taller_than_one_page_still_exports():
    """A merge covering more rows than fit on one page must not kill the export.

    ReportLab keeps a merged rectangle whole when it breaks a table between
    rows, so a merge taller than one page leaves no legal break at all. The
    build then raises LayoutError and the caller gets a 500 instead of a PDF.
    """
    payload = _tall_sheet(80)
    payload["cellSpans"] = [{"row": 1, "col": 1, "rowSpan": 80, "colSpan": 1}]
    body, _ = render_sheet_pdf(payload)
    assert body.startswith(b"%PDF")
    assert _page_count(body) >= 2


def test_grade_sheet_merges_like_the_karakter_template_export():
    """The merge shape the karakter template seeds: two full-height bands."""
    payload = _tall_sheet(45)
    payload["cellSpans"] = [
        {"row": 1, "col": 1, "rowSpan": 1, "colSpan": 4},
        {"row": 2, "col": 4, "rowSpan": 44, "colSpan": 1},
        {"row": 3, "col": 1, "rowSpan": 43, "colSpan": 1},
        {"row": 7, "col": 3, "rowSpan": 29, "colSpan": 1},
    ]
    body, _ = render_sheet_pdf(payload)
    assert body.startswith(b"%PDF")
    assert _page_count(body) >= 2


def test_merge_that_fits_one_page_stays_on_one_page():
    payload = _tall_sheet(12)
    payload["cellSpans"] = [{"row": 2, "col": 1, "rowSpan": 11, "colSpan": 1}]
    body, _ = render_sheet_pdf(payload)
    assert _page_count(body) == 1


_HEADER_HEIGHT = 18.0
_ROW_HEIGHT = 18.0
_TOOLBAR_BORDER = "inset 0 0 0 1px #64748b"


def _band_sheet(rows: int) -> dict:
    """Two columns: a merged band running down one of them, and a plain one.

    Only the anchor carries the fill and border, because that is how a merge is
    stored and how the grid paints it. Green is exact in the PDF operators, so
    the test can look for `0 1 0 rg` without worrying about rounding.
    """
    return {
        "title": "Band",
        "path": "karakter/d/1",
        "columns": [
            {"id": "a", "header": "A", "widthPx": 60},
            {"id": "b", "header": "B", "widthPx": 320},
        ],
        "rows": [{"a": "", "b": f"row {i}"} for i in range(1, rows + 1)],
        "cellStyles": {"2:1": {"background-color": "#00ff00", "box-shadow": _TOOLBAR_BORDER}},
        "cellSpans": [{"row": 2, "col": 1, "rowSpan": rows - 1, "colSpan": 1}],
    }


_STREAM_RE = re.compile(rb"stream\r?\n(.*?)endstream", re.S)


def _drawing_ops(body: bytes) -> bytes:
    """The drawing operators of a generated PDF.

    ReportLab writes each page stream as ASCII85 around raw Deflate, so the
    operators are only readable after undoing both.
    """
    parts = []
    for raw in _STREAM_RE.findall(body):
        raw = raw.strip()
        try:
            raw = base64.a85decode(raw, adobe=True)
        except ValueError:
            pass  # an uncompressed or unrelated stream is used as it is
        try:
            raw = zlib.decompressobj().decompress(raw)
        except zlib.error:
            pass
        parts.append(raw)
    return b" ".join(parts)


def _fills(commands: list[tuple]) -> list[tuple]:
    """BACKGROUND commands as (start, stop, 0xrrggbb). Color has no __eq__."""
    return [(c[1], c[2], c[3].hexval()) for c in commands if c[0] == "BACKGROUND"]


def _band_heights(ops: bytes) -> list[float]:
    """Heights of the green rectangles the export painted, in document order."""
    return [
        abs(float(match[3]))
        for match in re.findall(
            rb"0 1 0 rg\s*\nn ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re f\*", ops
        )
    ]


_HLINE_RE = re.compile(r"[-\d.]+ ([-\d.]+) m [-\d.]+ \1 l S")


def _horizontal_lines(ops: bytes) -> list[float]:
    """The height of every horizontal grid line segment ReportLab stroked."""
    return [float(match[1]) for match in _HLINE_RE.finditer(ops.decode("latin-1"))]


def test_header_row_prints_once_on_every_page():
    """No page may start twice.

    Letting ReportLab split one long table was the old export. A merge that had
    to stay whole could end a page after two rows, and the rest of the table
    carried on underneath, header row drawn a second time on the same page.
    """
    body, _ = render_sheet_pdf(_band_sheet(45))
    pages = _page_count(body)
    assert pages == 2
    ops = _drawing_ops(body)
    assert ops.count(b"(A) Tj") == pages
    assert ops.count(b"(B) Tj") == pages


def test_band_that_runs_past_a_page_keeps_fill_and_border_on_the_next():
    """The merge is cut at the page edge, and its style keeps running below it.

    The fill and border live on the anchor cell only. When the merge was painted
    from that one cell, the part on the second page came out plain white.
    """
    body, _ = render_sheet_pdf(_band_sheet(45))
    pages = _page_count(body)
    ops = _drawing_ops(body)

    # One fragment of the band per page, and all of its 44 rows still painted.
    band_heights = _band_heights(ops)
    assert len(band_heights) == pages
    assert abs(sum(band_heights) - 44 * _ROW_HEIGHT) < 1.0
    # The toolbar border is drawn around the fragment on each page as well.
    # ReportLab drops the leading zero, so accept either spelling.
    assert len(re.findall(rb"\.?392157 \.?454902 \.?545098 RG", ops)) == pages


def _page_plan(first: int, last: int) -> _Page:
    """A planned page of equal-height rows, for the style command tests."""
    heights = (_HEADER_HEIGHT,) * (1 + last - first)
    return _Page(first, last, heights, sum(heights), False)


def test_pages_hold_every_row_with_one_header_row_each():
    pages = _plan_pages(_HEADER_HEIGHT, [_ROW_HEIGHT] * 45, 479.3, 523.3)
    assert [(page.first, page.last) for page in pages] == [(0, 25), (25, 45)]
    for index, page in enumerate(pages):
        room = 479.3 if index == 0 else 523.3
        assert page.heights == (_HEADER_HEIGHT, *([_ROW_HEIGHT] * (page.last - page.first)))
        assert page.height <= room
        assert page.break_in_row is False
        if page.last < 45:
            # Packing stops only when no further row would have fitted.
            assert page.height + _ROW_HEIGHT > room


def test_pages_without_a_header_row_pack_the_same_rows():
    pages = _plan_pages(None, [_ROW_HEIGHT] * 45, 491.3, 523.3)
    assert pages[0].first == 0
    assert pages[-1].last == 45
    assert [page.first for page in pages[1:]] == [page.last for page in pages[:-1]]
    for index, page in enumerate(pages):
        room = 491.3 if index == 0 else 523.3
        # No header height in front, so the page is only its own data rows.
        assert page.heights == (_ROW_HEIGHT,) * (page.last - page.first)
        assert page.height <= room
        assert page.break_in_row is False
        if page.last < 45:
            assert page.height + _ROW_HEIGHT > room


def test_a_sheet_without_rows_or_headers_has_no_table_to_print():
    assert _plan_pages(None, [], 491.3, 523.3) == [_Page(0, 0, (), 0.0, False)]


def test_one_row_taller_than_a_page_breaks_inside_that_row():
    pages = _plan_pages(_HEADER_HEIGHT, [900.0, _ROW_HEIGHT], 479.3, 523.3)
    assert [(page.first, page.last) for page in pages] == [(0, 1), (1, 2)]
    assert pages[0].break_in_row is True
    assert pages[1].break_in_row is False


def test_merge_is_clipped_to_the_rows_a_page_prints():
    model = build_pdf_model(_band_sheet(20))
    top_commands = _page_commands(model, _page_plan(0, 12))
    bottom_commands = _page_commands(model, _page_plan(12, 20))
    assert ("SPAN", (0, 2), (0, 12)) in top_commands
    assert ("SPAN", (0, 1), (0, 8)) in bottom_commands
    assert ((0, 2), (0, 12), "0x00ff00") in _fills(top_commands)
    assert ((0, 1), (0, 8), "0x00ff00") in _fills(bottom_commands)
    for commands, start, stop in (
        (top_commands, (0, 2), (0, 12)),
        (bottom_commands, (0, 1), (0, 8)),
    ):
        boxes = [c for c in commands if c[0] == "BOX"]
        assert [(c[1], c[2]) for c in boxes] == [(start, stop)]
        assert boxes[0][3] == 0.75
    # Cells the merge covers keep no style commands of their own.
    assert len(_fills(top_commands)) == 2  # the header band and the merge fragment
    assert len(_fills(bottom_commands)) == 2


def _mixed_sheet() -> dict:
    """One column with text, one with nothing, one that is only painted, one hidden."""
    return {
        "title": "Mixed",
        "path": "mixed/1",
        "columns": [
            {"id": "a", "header": "A", "widthPx": 60},
            {"id": "b", "header": "B", "widthPx": 60},
            {"id": "c", "header": "C", "widthPx": 60},
            {"id": "d", "header": "D", "widthPx": 60, "hidden": True},
        ],
        "rows": [{"a": "text"}, {"a": "", "b": ""}, {"a": ""}],
        # C holds no value at all, but it is painted, so it is not empty.
        "cellStyles": {"2:3": {"background-color": "#00ff00"}},
    }


def test_export_can_leave_the_column_header_row_out():
    model = build_pdf_model(_band_sheet(3), headers=False)
    assert model.show_headers is False

    body, _ = render_sheet_pdf(_band_sheet(3), headers=False)
    ops = _drawing_ops(body)
    assert _page_count(body) == 1
    # Neither the labels nor the grey band they sit in are drawn. ReportLab
    # drops the leading zero of a colour channel.
    assert b"(A) Tj" not in ops
    assert b"(B) Tj" not in ops
    assert b".96 .96 .96 rg" not in ops
    assert b"(row 1) Tj" in ops


def test_export_without_headers_still_paginates_and_runs_a_band_down():
    body, _ = render_sheet_pdf(_band_sheet(45), headers=False)
    pages = _page_count(body)
    assert pages == 2
    ops = _drawing_ops(body)
    assert b"(A) Tj" not in ops
    band_heights = _band_heights(ops)
    assert len(band_heights) == pages
    assert abs(sum(band_heights) - 44 * _ROW_HEIGHT) < 1.0


def test_a_page_without_a_header_row_numbers_its_rows_from_zero():
    model = build_pdf_model(_band_sheet(20), headers=False)
    commands = _page_commands(model, _page_plan(0, 12))
    assert ("SPAN", (0, 1), (0, 11)) in commands
    assert ((0, 1), (0, 11), "0x00ff00") in _fills(commands)
    # No header band to paint, so only the merge fragment is filled.
    assert len(_fills(commands)) == 1


def test_empty_columns_print_unless_the_caller_asks_for_auto_hide():
    assert build_pdf_model(_mixed_sheet()).headers == ("A", "B", "C")
    assert build_pdf_model(_mixed_sheet(), empty_columns=False).headers == ("A", "C")

    body, _ = render_sheet_pdf(_mixed_sheet(), empty_columns=False)
    ops = _drawing_ops(body)
    assert b"(B) Tj" not in ops
    assert b"(C) Tj" in ops
    assert b"0 1 0 rg" in ops  # the painted column is still there


def test_auto_hide_keeps_a_column_that_only_carries_a_merge_band():
    """A band with no text is still content, because it is drawn."""
    model = build_pdf_model(_band_sheet(6), empty_columns=False)
    assert model.headers == ("A", "B")


def _covered_sheet(*, painted: bool = True) -> dict:
    """Three columns where only C holds text, and one merge over A and B."""
    return {
        "title": "Covered",
        "path": "covered/1",
        "columns": [
            {"id": "a", "header": "A", "widthPx": 60},
            {"id": "b", "header": "B", "widthPx": 60},
            {"id": "c", "header": "C", "widthPx": 60},
        ],
        "rows": [{"a": "", "b": "", "c": "text"} for _ in range(3)],
        "cellStyles": {"1:1": {"background-color": "#00ff00"}} if painted else {},
        "cellSpans": [{"row": 1, "col": 1, "rowSpan": 1, "colSpan": 2}],
    }


def test_auto_hide_keeps_a_column_only_because_a_painted_band_covers_it():
    """A band is content for every column it crosses, so it keeps its width."""
    assert build_pdf_model(_covered_sheet()).headers == ("A", "B", "C")
    model = build_pdf_model(_covered_sheet(), empty_columns=False)
    assert model.headers == ("A", "B", "C")
    assert model.spans == ((0, 1, 1, 1),)
    body, _ = render_sheet_pdf(_covered_sheet(), empty_columns=False)
    assert b"0 1 0 rg" in _drawing_ops(body)


def test_auto_hide_drops_a_column_a_merge_only_covers_when_it_paints_nothing():
    """A rectangle with neither text nor style draws nothing, so it is still blank."""
    model = build_pdf_model(_covered_sheet(painted=False), empty_columns=False)
    assert model.headers == ("C",)
    assert model.spans == ()


def _band_and_gaps_sheet() -> dict:
    """Six rows: two hold text, and a green band runs through three of the rest.

    Only the band anchor carries the style, which is how a merge is stored.
    """
    return {
        "title": "Band and gaps",
        "path": "band/1",
        "columns": [
            {"id": "a", "header": "A", "widthPx": 60},
            {"id": "b", "header": "B", "widthPx": 320},
        ],
        "rows": [
            {"a": "", "b": "one"},
            {"a": "", "b": ""},
            {"a": "", "b": ""},
            {"a": "", "b": ""},
            {"a": "", "b": ""},
            {"a": "", "b": "six"},
        ],
        "cellStyles": {"2:1": {"background-color": "#00ff00"}},
        "cellSpans": [{"row": 2, "col": 1, "rowSpan": 3, "colSpan": 1}],
        "rowCount": 6,
    }


def test_auto_hide_drops_blank_rows_but_not_ones_a_band_runs_through():
    assert len(build_pdf_model(_band_and_gaps_sheet()).rows) == 6
    model = build_pdf_model(_band_and_gaps_sheet(), empty_rows=False)
    # Row 5 holds nothing, while rows 2 to 4 belong to the band.
    assert [row[1].text for row in model.rows] == ["one", "", "", "", "six"]
    assert model.spans == ((0, 2, 0, 4),)
    full = _drawing_ops(render_sheet_pdf(_band_and_gaps_sheet())[0])
    narrow = _drawing_ops(render_sheet_pdf(_band_and_gaps_sheet(), empty_rows=False)[0])
    assert b"0 1 0 rg" in narrow
    # One grid line less on paper: the blank row is gone, the band is not.
    assert len(_horizontal_lines(narrow)) == len(_horizontal_lines(full)) - 1


def test_auto_hide_drops_rows_a_band_covers_when_the_band_paints_nothing():
    sheet = _band_and_gaps_sheet()
    sheet["cellStyles"] = {}
    model = build_pdf_model(sheet, empty_rows=False)
    assert [row[1].text for row in model.rows] == ["one", "six"]
    assert model.spans == ()


def test_auto_hide_can_narrow_both_columns_and_rows_at_once():
    model = build_pdf_model(
        _band_and_gaps_sheet(), headers=False, empty_columns=False, empty_rows=False
    )
    assert model.headers == ("A", "B")
    assert len(model.rows) == 5
    assert model.show_headers is False


def test_auto_hide_of_an_empty_sheet_leaves_the_title_alone():
    """No column survives, so there is no table to draw at all."""
    sheet = {
        "title": "Nothing",
        "path": "nothing/1",
        "columns": [{"id": "a", "header": "A", "widthPx": 60, "valueType": "string"}],
        "rows": [{"a": ""}],
    }
    assert build_pdf_model(sheet, empty_columns=False).headers == ()
    body, _ = render_sheet_pdf(sheet, empty_columns=False)
    ops = _drawing_ops(body)
    assert b"(Nothing) Tj" in ops
    assert b"(A) Tj" not in ops
    assert _page_count(body) == 1
