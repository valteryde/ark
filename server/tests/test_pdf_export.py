import pytest

from app.pdf_export import (
    MAX_PDF_DATA_ROWS,
    PdfTooLarge,
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
