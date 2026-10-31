import pytest

from app.cell_style import CellStyleError, coerce_cell_style, parse_cell_style, parse_cell_styles_map


def test_coerce_keeps_toolbar_declarations_and_drops_unsafe_ones():
    style = coerce_cell_style(
        {
            "color": "#111827",
            "background-color": "rgb(1, 2, 3)",
            "font-weight": "700",
            "font-style": "italic",
            "text-decoration-line": "line-through",
            "justify-content": "center",
            "box-shadow": "inset 0 0 0 1px #64748b",
            "background-image": "url(https://evil.example/x)",
            "position": "fixed",
        }
    )
    assert style == {
        "background-color": "rgb(1, 2, 3)",
        "box-shadow": "inset 0 0 0 1px #64748b",
        "color": "#111827",
        "font-style": "italic",
        "font-weight": "700",
        "justify-content": "center",
        "text-decoration-line": "line-through",
    }


def test_named_colors_and_bold_keyword():
    assert coerce_cell_style({"color": "Red", "font-weight": "Bold"}) == {
        "color": "red",
        "font-weight": "bold",
    }


def test_parse_rejects_empty_allowlist_and_non_objects():
    assert parse_cell_style(None) is None
    assert parse_cell_style({}) is None
    with pytest.raises(CellStyleError):
        parse_cell_style("bold")
    with pytest.raises(CellStyleError):
        parse_cell_style({"background-image": "url(javascript:alert(1))"})


def test_parse_cell_styles_map_keys():
    parsed = parse_cell_styles_map(
        {"1:2": {"color": "#fff"}, "9:9": {}},
        max_rows=50_000,
        max_cols=500,
    )
    assert parsed == {(1, 2): {"color": "#fff"}}
    with pytest.raises(CellStyleError):
        parse_cell_styles_map({"0:1": {"color": "#fff"}}, max_rows=10, max_cols=10)
    with pytest.raises(CellStyleError):
        parse_cell_styles_map(["nope"], max_rows=10, max_cols=10)
