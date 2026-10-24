import pytest

from app.store import SheetValidationError, blank_sheet_columns


def test_auto_create_blank_sheet(fresh_store):
    payload, created = fresh_store.get_or_create_sheet("clients/21")
    assert created is True
    assert payload["columns"] == blank_sheet_columns()
    assert payload["rows"] == []
    assert payload["rowCount"] == 100
    assert payload["revision"] == 1
    assert payload["path"] == "clients/21"

    again, created_again = fresh_store.get_or_create_sheet("clients/21")
    assert created_again is False
    assert again["revision"] == 1


def test_create_from_partner_template_records_name_and_version(fresh_store):
    template = {
        "name": "client",
        "version": 3,
        "title": "Client",
        "columns": [
            {"id": "id", "header": "ID", "widthPx": 80, "readOnly": True},
            {"id": "name", "header": "Name", "widthPx": 200},
        ],
        "rows": [{"id": 1, "name": "Acme"}],
        "rowCount": 50,
    }
    payload, created = fresh_store.get_or_create_sheet("clients/21", template)
    assert created is True
    assert payload["title"] == "Client"
    assert [c["id"] for c in payload["columns"]] == ["id", "name"]
    assert payload["rows"] == [{"id": 1, "name": "Acme"}]
    # Small template rowCounts don't cap the grid; the blank-sheet floor wins.
    assert payload["rowCount"] == 100
    assert payload["template"] == {"name": "client", "version": "3"}


def test_existing_sheet_ignores_new_template(fresh_store):
    v1 = {"version": 1, "columns": [{"id": "a", "header": "A", "widthPx": 100}]}
    fresh_store.get_or_create_sheet("clients/21", v1)
    v2 = {
        "version": 2,
        "columns": [
            {"id": "a", "header": "A", "widthPx": 100},
            {"id": "b", "header": "B", "widthPx": 100},
        ],
    }
    payload, created = fresh_store.get_or_create_sheet("clients/21", v2)
    assert created is False
    assert payload["template"] == {"version": "1"}
    assert [c["id"] for c in payload["columns"]] == ["a"]


def test_create_from_template_requires_version(fresh_store):
    with pytest.raises(SheetValidationError):
        fresh_store.get_or_create_sheet(
            "clients/21",
            {"columns": [{"id": "a", "header": "A", "widthPx": 100}]},
        )


def test_apply_cell_persists_and_bumps_revision(fresh_store):
    fresh_store.get_or_create_sheet("clients")
    rev = fresh_store.apply_cell("clients", 3, 1, "Acme")
    assert rev == 2
    rev = fresh_store.apply_cell("clients", 3, 2, 42)
    assert rev == 3

    payload = fresh_store.get_sheet_payload("clients")
    assert payload["revision"] == 3
    assert payload["rows"][2]["a"] == "Acme"
    assert payload["rows"][2]["b"] == 42


def test_apply_cell_on_missing_sheet_raises(fresh_store):
    with pytest.raises(SheetValidationError):
        fresh_store.apply_cell("brand/new", 1, 1, "hello")


def test_apply_cell_empty_string_clears_cell(fresh_store):
    fresh_store.get_or_create_sheet("clients")
    fresh_store.apply_cell("clients", 1, 1, "Acme")
    fresh_store.apply_cell("clients", 1, 1, "")
    payload = fresh_store.get_sheet_payload("clients")
    assert payload["rows"] == []


def test_apply_cell_grows_row_count(fresh_store):
    fresh_store.get_or_create_sheet("clients")
    fresh_store.apply_cell("clients", 250, 1, "far down")
    payload = fresh_store.get_sheet_payload("clients")
    assert payload["rowCount"] == 250


def test_apply_cell_out_of_schema_lands_in_sparse_cells(fresh_store):
    fresh_store.replace_sheet(
        "clients", {"columns": [{"id": "name", "header": "Name", "widthPx": 200}]}
    )
    fresh_store.apply_cell("clients", 2, 9, "beyond")
    payload = fresh_store.get_sheet_payload("clients")
    assert payload["cells"] == {"2:9": "beyond"}
    assert payload["rows"] == []


def test_apply_cell_validation(fresh_store):
    with pytest.raises(SheetValidationError):
        fresh_store.apply_cell("clients", 0, 1, "x")
    with pytest.raises(SheetValidationError):
        fresh_store.apply_cell("clients", 1, 1, True)
    with pytest.raises(SheetValidationError):
        fresh_store.apply_cell("clients", 1, 1, float("nan"))
    with pytest.raises(SheetValidationError):
        fresh_store.apply_cell("clients", 1, 1, {"nested": "object"})


def test_row_delete_clears_row_without_shifting(fresh_store):
    fresh_store.get_or_create_sheet("clients")
    fresh_store.apply_cell("clients", 1, 1, "first")
    fresh_store.apply_cell("clients", 2, 1, "second")
    fresh_store.apply_cell("clients", 3, 1, "third")
    rev = fresh_store.apply_row_delete("clients", 2)
    payload = fresh_store.get_sheet_payload("clients")
    assert payload["revision"] == rev
    assert payload["rows"][0]["a"] == "first"
    assert payload["rows"][1] == {}
    assert payload["rows"][2]["a"] == "third"


def test_row_delete_unknown_sheet_raises(fresh_store):
    with pytest.raises(SheetValidationError):
        fresh_store.apply_row_delete("nope", 1)


def test_replace_sheet_full_payload_round_trip(fresh_store):
    payload = fresh_store.replace_sheet(
        "clients",
        {
            "title": "Clients",
            "description": "All clients",
            "columns": [
                {"id": "id", "header": "ID", "widthPx": 80, "readOnly": True},
                {"id": "name", "header": "Name", "widthPx": 200},
            ],
            "rows": [
                {"id": 1, "name": "Acme"},
                {"id": 2, "name": "Beta"},
            ],
            "rowCount": 120,
            "enabledUiCapabilities": ["undo", "redo"],
        },
    )
    assert payload["title"] == "Clients"
    assert payload["rowCount"] == 120
    assert payload["rows"][0] == {"id": 1, "name": "Acme"}
    assert payload["enabledUiCapabilities"] == ["undo", "redo"]
    assert payload["revision"] == 1

    replaced = fresh_store.replace_sheet(
        "clients",
        {
            "columns": [{"id": "name", "header": "Name", "widthPx": 200}],
            "rows": [{"name": "Only one"}],
        },
    )
    assert replaced["revision"] == 2
    assert replaced["rows"] == [{"name": "Only one"}]
    assert "title" not in replaced


def test_replace_sheet_rejects_bad_columns(fresh_store):
    with pytest.raises(SheetValidationError):
        fresh_store.replace_sheet("clients", {"columns": []})
    with pytest.raises(SheetValidationError):
        fresh_store.replace_sheet(
            "clients",
            {
                "columns": [
                    {"id": "a", "header": "A", "widthPx": 100},
                    {"id": "a", "header": "Dup", "widthPx": 100},
                ]
            },
        )


def test_patch_sheet_cells_by_row_col_and_column_id(fresh_store):
    fresh_store.replace_sheet(
        "clients",
        {
            "columns": [
                {"id": "id", "header": "ID", "widthPx": 80, "readOnly": True},
                {"id": "name", "header": "Name", "widthPx": 200},
            ],
            "rows": [{"id": 1, "name": "Acme"}, {"id": 2, "name": "Beta"}],
        },
    )
    result = fresh_store.patch_sheet(
        "clients",
        {
            "cells": [
                {"row": 1, "columnId": "name", "value": "Acme Corp"},
                {"recordId": 2, "columnId": "name", "value": "Beta LLC"},
                {"row": 3, "col": 2, "value": "Gamma"},
            ]
        },
    )
    assert result["revision"] == 2
    applied = result["appliedCells"]
    assert applied[0] == {"row": 1, "col": 2, "columnId": "name", "value": "Acme Corp"}
    assert applied[1] == {"row": 2, "col": 2, "columnId": "name", "value": "Beta LLC"}
    assert applied[2] == {"row": 3, "col": 2, "columnId": "name", "value": "Gamma"}

    payload = fresh_store.get_sheet_payload("clients")
    assert payload["rows"][0]["name"] == "Acme Corp"
    assert payload["rows"][1]["name"] == "Beta LLC"
    assert payload["rows"][2]["name"] == "Gamma"


def test_patch_sheet_metadata(fresh_store):
    fresh_store.get_or_create_sheet("clients")
    result = fresh_store.patch_sheet("clients", {"title": "New title", "rowCount": 300})
    assert result["revision"] == 2
    payload = fresh_store.get_sheet_payload("clients")
    assert payload["title"] == "New title"
    assert payload["rowCount"] == 300


def test_patch_sheet_unknown_record_id(fresh_store):
    fresh_store.replace_sheet(
        "clients",
        {
            "columns": [
                {"id": "id", "header": "ID", "widthPx": 80, "readOnly": True},
                {"id": "name", "header": "Name", "widthPx": 200},
            ],
            "rows": [{"id": 1, "name": "Acme"}],
        },
    )
    with pytest.raises(SheetValidationError):
        fresh_store.patch_sheet(
            "clients", {"cells": [{"recordId": 99, "columnId": "name", "value": "x"}]}
        )


def test_delete_sheet(fresh_store):
    fresh_store.get_or_create_sheet("clients")
    assert fresh_store.delete_sheet("clients") is True
    assert fresh_store.get_sheet_payload("clients") is None
    assert fresh_store.delete_sheet("clients") is False


def test_list_sheets(fresh_store):
    fresh_store.get_or_create_sheet("b-sheet")
    fresh_store.get_or_create_sheet("a-sheet")
    sheets = fresh_store.list_sheets()
    assert [s["path"] for s in sheets] == ["a-sheet", "b-sheet"]
    assert all("revision" in s for s in sheets)


def test_number_values_round_trip_as_numbers(fresh_store):
    fresh_store.get_or_create_sheet("clients")
    fresh_store.apply_cell("clients", 1, 1, 120000)
    fresh_store.apply_cell("clients", 1, 2, 1.5)
    payload = fresh_store.get_sheet_payload("clients")
    assert payload["rows"][0]["a"] == 120000
    assert payload["rows"][0]["b"] == 1.5


def test_path_normalization(fresh_store):
    payload, created = fresh_store.get_or_create_sheet("/clients//21/")
    assert payload["path"] == "clients/21"
    _, created_again = fresh_store.get_or_create_sheet("clients/21")
    assert created_again is False


def test_apply_cell_rejects_readonly_columns(fresh_store):
    fresh_store.replace_sheet(
        "grades",
        {
            "columns": [
                {"id": "student_id", "header": "Student ID", "widthPx": 120, "readOnly": True},
                {"id": "grade", "header": "Grade", "widthPx": 80},
            ],
            "rows": [{"student_id": "S101", "grade": "B"}],
        },
    )
    # Writing to read-only column 1 must raise SheetValidationError
    with pytest.raises(SheetValidationError, match="column 'student_id' is read-only"):
        fresh_store.apply_cell("grades", 1, 1, "Hacked")

    # Writing to writable column 2 must succeed
    fresh_store.apply_cell("grades", 1, 2, "A")
    payload = fresh_store.get_sheet_payload("grades")
    assert payload["rows"][0]["student_id"] == "S101"
    assert payload["rows"][0]["grade"] == "A"


def test_audit_logs_lifecycle_and_diffs(fresh_store):
    fresh_store.get_or_create_sheet("classes/math", actor_type="user", actor_id="alice")
    fresh_store.apply_cell("classes/math", 1, 1, "Alice", actor_type="user", actor_id="alice")
    fresh_store.apply_cell("classes/math", 1, 1, "Alice Smith", actor_type="user", actor_id="alice")
    fresh_store.apply_cell("classes/math", 1, 1, "", actor_type="user", actor_id="alice")

    logs, total = fresh_store.get_audit_logs(sheet_path="classes/math", order="asc")
    assert total == 4
    assert len(logs) == 4

    assert logs[0]["action"] == "sheet.create"
    assert logs[0]["actorId"] == "alice"
    assert logs[0]["revision"] == 1

    assert logs[1]["action"] == "cell.update"
    assert logs[1]["details"]["oldValue"] is None
    assert logs[1]["details"]["newValue"] == "Alice"

    assert logs[2]["action"] == "cell.update"
    assert logs[2]["details"]["oldValue"] == "Alice"
    assert logs[2]["details"]["newValue"] == "Alice Smith"

    assert logs[3]["action"] == "cell.clear"
    assert logs[3]["details"]["oldValue"] == "Alice Smith"
    assert logs[3]["details"]["newValue"] == ""


def test_audit_logs_row_delete_records_cleared_cells(fresh_store):
    fresh_store.get_or_create_sheet("classes/bio")
    fresh_store.apply_cell("classes/bio", 2, 1, "Test Cell")
    fresh_store.apply_row_delete("classes/bio", 2, actor_type="user", actor_id="teacher_1")

    logs, total = fresh_store.get_audit_logs(sheet_path="classes/bio", action="row.delete")
    assert total == 1
    entry = logs[0]
    assert entry["action"] == "row.delete"
    assert entry["actorId"] == "teacher_1"
    assert entry["details"]["row"] == 2
    assert entry["details"]["clearedCells"] == [{"col": 1, "value": "Test Cell"}]


def test_audit_logs_survive_sheet_deletion(fresh_store):
    fresh_store.get_or_create_sheet("ephemeral/sheet")
    fresh_store.apply_cell("ephemeral/sheet", 1, 1, "data")
    assert fresh_store.delete_sheet("ephemeral/sheet", actor_id="admin") is True

    # After deleting sheet, audit logs are preserved and include sheet.delete
    logs, total = fresh_store.get_audit_logs(sheet_path="ephemeral/sheet", order="asc")
    assert total == 3
    actions = [l["action"] for l in logs]
    assert actions == ["sheet.create", "cell.update", "sheet.delete"]
    assert logs[2]["actorId"] == "admin"

    # get_audit_log_by_id
    entry = fresh_store.get_audit_log_by_id(logs[2]["id"])
    assert entry is not None
    assert entry["action"] == "sheet.delete"
    assert fresh_store.get_audit_log_by_id(999999) is None


def test_audit_logs_filtering_and_pagination(fresh_store):
    fresh_store.get_or_create_sheet("org/team1/sheetA")
    fresh_store.get_or_create_sheet("org/team1/sheetB")
    fresh_store.get_or_create_sheet("org/team2/sheetC")

    # Prefix filter
    logs, total = fresh_store.get_audit_logs(prefix="org/team1")
    assert total == 2
    paths = {l["sheetPath"] for l in logs}
    assert paths == {"org/team1/sheetA", "org/team1/sheetB"}

    # Action filter
    logs, total = fresh_store.get_audit_logs(action="sheet.create")
    assert total == 3

    # Pagination
    page1, total = fresh_store.get_audit_logs(limit=2, offset=0, order="asc")
    assert total == 3
    assert len(page1) == 2
    page2, total = fresh_store.get_audit_logs(limit=2, offset=2, order="asc")
    assert len(page2) == 1
    assert page1[0]["id"] != page2[0]["id"]

