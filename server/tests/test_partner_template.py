import pytest

from app.partner_template import PartnerTemplateError, parse_template_response

COLUMNS = [{"id": "name", "header": "Name", "widthPx": 200}]


def test_parse_accepts_int_and_string_versions():
    t = parse_template_response({"version": 3, "columns": COLUMNS})
    assert t["version"] == 3
    t = parse_template_response({"version": "2024-06", "columns": COLUMNS})
    assert t["version"] == "2024-06"


def test_parse_demands_a_version():
    with pytest.raises(PartnerTemplateError):
        parse_template_response({"columns": COLUMNS})
    with pytest.raises(PartnerTemplateError):
        parse_template_response({"version": None, "columns": COLUMNS})
    with pytest.raises(PartnerTemplateError):
        parse_template_response({"version": "  ", "columns": COLUMNS})
    with pytest.raises(PartnerTemplateError):
        parse_template_response({"version": True, "columns": COLUMNS})
    with pytest.raises(PartnerTemplateError):
        parse_template_response({"version": 1.5, "columns": COLUMNS})


def test_parse_validates_columns_and_rows():
    with pytest.raises(PartnerTemplateError):
        parse_template_response({"version": 1, "columns": []})
    with pytest.raises(PartnerTemplateError):
        parse_template_response({"version": 1, "columns": COLUMNS, "rows": ["not-an-object"]})


def test_parse_normalizes_name_and_passthrough_fields():
    t = parse_template_response(
        {
            "version": 1,
            "name": "  client  ",
            "columns": COLUMNS,
            "title": "Client",
            "rowCount": 50,
            "enabledUiCapabilities": ["undo"],
            "ignored_extra": "dropped",
        }
    )
    assert t["name"] == "client"
    assert t["title"] == "Client"
    assert t["rowCount"] == 50
    assert t["enabledUiCapabilities"] == ["undo"]
    assert "ignored_extra" not in t
    assert t["rows"] == []


def test_parse_rejects_non_object():
    with pytest.raises(PartnerTemplateError):
        parse_template_response([1, 2, 3])
