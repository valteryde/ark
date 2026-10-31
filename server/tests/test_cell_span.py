import pytest

from app.cell_span import CellSpanError, parse_cell_spans, spans_after_clearing_row


def test_parse_accepts_rectangles_and_rejects_junk():
    spans = parse_cell_spans(
        [
            {"row": 1, "col": 2, "rowSpan": 2, "colSpan": 3},
        ],
        max_rows=10,
        max_cols=5,
    )
    assert spans == [{"row": 1, "col": 2, "rowSpan": 2, "colSpan": 3}]
    assert parse_cell_spans(None, max_rows=10, max_cols=5) == []

    with pytest.raises(CellSpanError):
        parse_cell_spans({"row": 1}, max_rows=10, max_cols=5)
    with pytest.raises(CellSpanError):
        parse_cell_spans([{"row": 1, "col": 1, "rowSpan": 1, "colSpan": 1}], max_rows=10, max_cols=5)
    with pytest.raises(CellSpanError):
        parse_cell_spans([{"row": True, "col": 1, "rowSpan": 2, "colSpan": 1}], max_rows=10, max_cols=5)
    with pytest.raises(CellSpanError, match="outside"):
        parse_cell_spans([{"row": 2, "col": 1, "rowSpan": 2, "colSpan": 1}], max_rows=2, max_cols=2)
    with pytest.raises(CellSpanError, match="overlap"):
        parse_cell_spans(
            [
                {"row": 1, "col": 1, "rowSpan": 2, "colSpan": 2},
                {"row": 2, "col": 2, "rowSpan": 2, "colSpan": 2},
            ],
            max_rows=10,
            max_cols=5,
        )


def test_row_clear_drops_spans_that_include_the_row():
    spans = [
        {"row": 1, "col": 1, "rowSpan": 1, "colSpan": 2},
        {"row": 3, "col": 1, "rowSpan": 3, "colSpan": 1},
    ]
    assert spans_after_clearing_row(spans, 4) == [spans[0]]
    assert spans_after_clearing_row(spans, 1) == [spans[1]]
