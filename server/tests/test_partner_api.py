import pytest
from fastapi.testclient import TestClient

import app.main as main_module


@pytest.fixture()
def client(fresh_store, monkeypatch):
    monkeypatch.setenv("ARK_PARTNER_API_TOKEN", "secret-token")
    monkeypatch.delenv("ARK_PARTNER_BASE_URL", raising=False)
    return TestClient(main_module.app)


AUTH = {"Authorization": "Bearer secret-token"}


def test_partner_api_requires_token(client):
    assert client.get("/api/partner/sheets").status_code == 401
    bad = {"Authorization": "Bearer wrong"}
    assert client.get("/api/partner/sheets", headers=bad).status_code == 401


def test_partner_api_disabled_without_configured_token(fresh_store, monkeypatch):
    monkeypatch.delenv("ARK_PARTNER_API_TOKEN", raising=False)
    monkeypatch.delenv("ARK_PARTNER_BASE_URL", raising=False)
    c = TestClient(main_module.app)
    assert c.get("/api/partner/sheets", headers=AUTH).status_code == 503


def test_put_get_list_delete_sheet(client):
    body = {
        "title": "Clients",
        "columns": [
            {"id": "id", "header": "ID", "widthPx": 80, "readOnly": True},
            {"id": "name", "header": "Name", "widthPx": 200},
        ],
        "rows": [{"id": 1, "name": "Acme"}],
    }
    r = client.put("/api/partner/sheets/clients", json=body, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["revision"] == 1

    r = client.get("/api/partner/sheets/clients", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["rows"] == [{"id": 1, "name": "Acme"}]

    r = client.get("/api/partner/sheets", headers=AUTH)
    assert [s["path"] for s in r.json()["sheets"]] == ["clients"]

    r = client.delete("/api/partner/sheets/clients", headers=AUTH)
    assert r.status_code == 200
    assert client.get("/api/partner/sheets/clients", headers=AUTH).status_code == 404


def test_put_sheet_rejects_invalid_payload(client):
    r = client.put("/api/partner/sheets/clients", json={"columns": []}, headers=AUTH)
    assert r.status_code == 400
    r = client.put("/api/partner/sheets/clients", json=[1, 2], headers=AUTH)
    assert r.status_code == 400


def test_patch_sheet_cells(client):
    client.put(
        "/api/partner/sheets/clients",
        json={
            "columns": [
                {"id": "id", "header": "ID", "widthPx": 80, "readOnly": True},
                {"id": "name", "header": "Name", "widthPx": 200},
            ],
            "rows": [{"id": 1, "name": "Acme"}],
        },
        headers=AUTH,
    )
    r = client.patch(
        "/api/partner/sheets/clients",
        json={"cells": [{"recordId": 1, "columnId": "name", "value": "Acme Corp"}]},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json()["revision"] == 2

    sheet = client.get("/api/partner/sheets/clients", headers=AUTH).json()
    assert sheet["rows"][0]["name"] == "Acme Corp"


def test_patch_unknown_sheet_is_404(client):
    r = client.patch("/api/partner/sheets/missing", json={"title": "x"}, headers=AUTH)
    assert r.status_code == 404


def test_auto_create_fetches_partner_template(client, monkeypatch):
    async def fake_fetch(path, token):
        assert path == "clients/55"
        return {
            "name": "client",
            "version": 7,
            "title": "Client",
            "columns": [{"id": "name", "header": "Name", "widthPx": 200}],
            "rows": [{"name": "Prefilled"}],
        }

    monkeypatch.setattr(main_module, "fetch_partner_template", fake_fetch)
    r = client.get("/api/sheets/clients/55")
    assert r.status_code == 200
    payload = r.json()
    assert payload["title"] == "Client"
    assert payload["rows"] == [{"name": "Prefilled"}]
    assert payload["template"] == {"name": "client", "version": "7"}

    # Template is only consulted at creation; later fetches skip it entirely.
    async def exploding_fetch(path, token):
        raise AssertionError("should not be called for existing sheets")

    monkeypatch.setattr(main_module, "fetch_partner_template", exploding_fetch)
    again = client.get("/api/sheets/clients/55")
    assert again.status_code == 200
    assert again.json()["template"] == {"name": "client", "version": "7"}


def test_auto_create_partner_template_failure_is_502_and_creates_nothing(client, monkeypatch):
    from app.partner_template import PartnerTemplateError

    async def failing_fetch(path, token):
        raise PartnerTemplateError("partner template endpoint returned HTTP 500")

    monkeypatch.setattr(main_module, "fetch_partner_template", failing_fetch)
    r = client.get("/api/sheets/clients/55")
    assert r.status_code == 502

    # Partner recovered: the sheet is created fresh, not pinned blank.
    async def ok_fetch(path, token):
        return {"version": "1", "columns": [{"id": "name", "header": "Name", "widthPx": 200}]}

    monkeypatch.setattr(main_module, "fetch_partner_template", ok_fetch)
    r = client.get("/api/sheets/clients/55")
    assert r.status_code == 200
    assert r.json()["template"] == {"version": "1"}


def test_browser_get_sheet_auto_creates_blank(client):
    r = client.get("/api/sheets/whatever/123")
    assert r.status_code == 200
    payload = r.json()
    assert payload["revision"] == 1
    assert payload["rowCount"] == 100
    assert len(payload["columns"]) == 8

    # Second fetch returns the same document without bumping the revision.
    again = client.get("/api/sheets/whatever/123").json()
    assert again["revision"] == 1


def test_browser_get_sheet_rejects_empty_path(client):
    assert client.get("/api/sheets/").status_code in (400, 404)


def test_browser_auth_enforced_when_partner_base_url_set(client, monkeypatch):
    monkeypatch.setenv("ARK_PARTNER_BASE_URL", "http://partner.example")

    async def fake_verify(token):
        return token == "good"

    async def no_template(path, token):
        return None

    monkeypatch.setattr(main_module, "verify_browser_token", fake_verify)
    monkeypatch.setattr(main_module, "fetch_partner_template", no_template)
    assert client.get("/api/sheets/clients").status_code == 401
    r = client.get("/api/sheets/clients", headers={"Authorization": "Bearer good"})
    assert r.status_code == 200


def test_ws_edit_persists_and_broadcasts(client):
    client.get("/api/sheets/wstest")
    with client.websocket_connect("/ws/ark") as ws:
        ws.send_json(
            {
                "type": "cell.value_committed",
                "row": 2,
                "col": 1,
                "columnId": "a",
                "value": "from ws",
                "sheetPath": "wstest",
                "clientId": "tab-1",
            }
        )
        echoed = ws.receive_json()
        assert echoed["type"] == "cell.value_committed"
        assert echoed["value"] == "from ws"

    sheet = client.get("/api/sheets/wstest").json()
    assert sheet["rows"][1]["a"] == "from ws"
    assert sheet["revision"] >= 2


def test_ws_row_delete_persists(client):
    client.get("/api/sheets/wstest")
    with client.websocket_connect("/ws/ark") as ws:
        ws.send_json(
            {
                "type": "cell.value_committed",
                "row": 1,
                "col": 1,
                "columnId": "a",
                "value": "doomed",
                "sheetPath": "wstest",
            }
        )
        ws.receive_json()
        ws.send_json({"type": "row.deleted", "row": 1, "sheetPath": "wstest"})
        echoed = ws.receive_json()
        assert echoed["type"] == "row.deleted"

    sheet = client.get("/api/sheets/wstest").json()
    assert sheet["rows"] == []


def test_ws_edit_on_unknown_sheet_returns_persist_status(client):
    with client.websocket_connect("/ws/ark") as ws:
        ws.send_json(
            {
                "type": "cell.value_committed",
                "row": 1,
                "col": 1,
                "columnId": "a",
                "value": "orphan",
                "sheetPath": "never-loaded",
            }
        )
        msg = ws.receive_json()
        assert msg["type"] == "cell.persist_status"
        assert msg["ok"] is False


def test_ws_invalid_commit_returns_persist_status(client):
    client.get("/api/sheets/wstest")
    with client.websocket_connect("/ws/ark") as ws:
        ws.send_json(
            {
                "type": "cell.value_committed",
                "row": 1,
                "col": 1,
                "columnId": "a",
                "value": {"bad": "object"},
                "sheetPath": "wstest",
            }
        )
        msg = ws.receive_json()
        assert msg["type"] == "cell.persist_status"
        assert msg["ok"] is False


def test_ws_forbidden_and_presence_types(client):
    with client.websocket_connect("/ws/ark") as ws:
        ws.send_json({"type": "sheet.truth", "sheetPath": "x", "rows": [], "rowCount": 1})
        assert ws.receive_json() == {"error": "forbidden_message_type"}

        ws.send_json({"type": "cell.presence", "row": 1, "col": 1, "mode": "navigate"})
        echoed = ws.receive_json()
        assert echoed["type"] == "cell.presence"


def test_put_sheet_broadcasts_sheet_truth_to_ws_clients(client):
    with client.websocket_connect("/ws/ark?path=clients") as ws:
        client.put(
            "/api/partner/sheets/clients",
            json={
                "title": "Pushed",
                "columns": [{"id": "name", "header": "Name", "widthPx": 200}],
                "rows": [{"name": "Acme"}],
            },
            headers=AUTH,
        )
        msg = ws.receive_json()
        assert msg["type"] == "sheet.truth"
        assert msg["sheetPath"] == "clients"
        assert msg["rows"] == [{"name": "Acme"}]
        assert msg["title"] == "Pushed"


def test_patch_sheet_broadcasts_cell_commits(client):
    client.put(
        "/api/partner/sheets/clients",
        json={
            "columns": [{"id": "name", "header": "Name", "widthPx": 200}],
            "rows": [{"name": "Acme"}],
        },
        headers=AUTH,
    )
    with client.websocket_connect("/ws/ark?path=clients") as ws:
        client.patch(
            "/api/partner/sheets/clients",
            json={"cells": [{"row": 1, "columnId": "name", "value": "Acme Corp"}]},
            headers=AUTH,
        )
        msg = ws.receive_json()
        assert msg == {
            "type": "cell.value_committed",
            "row": 1,
            "col": 1,
            "columnId": "name",
            "value": "Acme Corp",
            "sheetPath": "clients",
        }


def test_cross_sheet_broadcast_isolation(client):
    """Ensures broadcasts for one sheet are not leaked to clients subscribed to another sheet."""
    client.put(
        "/api/partner/sheets/sheet-a",
        json={"columns": [{"id": "x", "header": "X", "widthPx": 100}], "rows": [{"x": "1"}]},
        headers=AUTH,
    )
    client.put(
        "/api/partner/sheets/sheet-b",
        json={"columns": [{"id": "y", "header": "Y", "widthPx": 100}], "rows": [{"y": "2"}]},
        headers=AUTH,
    )
    with client.websocket_connect("/ws/ark?path=sheet-b") as ws_b:
        # Patch sheet-a
        client.patch(
            "/api/partner/sheets/sheet-a",
            json={"cells": [{"row": 1, "columnId": "x", "value": "secret"}]},
            headers=AUTH,
        )
        # Patch sheet-b
        client.patch(
            "/api/partner/sheets/sheet-b",
            json={"cells": [{"row": 1, "columnId": "y", "value": "public"}]},
            headers=AUTH,
        )
        # ws_b should only receive the sheet-b commit, never the sheet-a commit
        msg = ws_b.receive_json()
        assert msg["sheetPath"] == "sheet-b"
        assert msg["value"] == "public"


def test_ws_cross_sheet_authorization_rejected(client, monkeypatch):
    """When partner auth is enabled, sending messages for an unauthorized sheet must be rejected."""
    async def mock_verify(token, path=None):
        return path == "sheet-allowed"

    monkeypatch.setattr("app.main.verify_browser_token", mock_verify)

    with client.websocket_connect("/ws/ark?path=sheet-allowed") as ws:
        # Sending a commit for sheet-forbidden should be rejected with unauthorized
        ws.send_json(
            {
                "type": "cell.value_committed",
                "row": 1,
                "col": 1,
                "value": "hack",
                "sheetPath": "sheet-forbidden",
            }
        )
        msg = ws.receive_json()
        assert msg == {"error": "unauthorized", "sheetPath": "sheet-forbidden"}

        # Subscribing to sheet-forbidden should also be rejected
        ws.send_json({"type": "sheet.subscribe", "sheetPath": "sheet-forbidden"})
        msg2 = ws.receive_json()
        assert msg2 == {"error": "unauthorized", "sheetPath": "sheet-forbidden"}


def test_partner_audit_logs_auth_enforced(client, monkeypatch):
    assert client.get("/api/partner/audit-logs").status_code == 401
    assert client.get("/api/partner/audit-logs", headers={"Authorization": "Bearer bad"}).status_code == 401
    assert client.get("/api/partner/sheets/clients/audit-logs").status_code == 401

    monkeypatch.delenv("ARK_PARTNER_API_TOKEN", raising=False)
    assert client.get("/api/partner/audit-logs", headers=AUTH).status_code == 503


def test_partner_audit_logs_api_and_sheet_filter(client):
    # 1. Partner creates sheet with custom actor header
    custom_actor = {"Authorization": "Bearer secret-token", "X-Actor-Id": "admin_clara"}
    put_body = {
        "title": "Math 101",
        "columns": [
            {"id": "id", "header": "ID", "widthPx": 80, "readOnly": True},
            {"id": "grade", "header": "Grade", "widthPx": 100},
        ],
        "rows": [{"id": 1, "grade": "B"}],
    }
    r = client.put("/api/partner/sheets/math", json=put_body, headers=custom_actor)
    assert r.status_code == 200

    # 2. Browser reads sheet
    r = client.get("/api/sheets/math", headers={"Authorization": "Bearer student_token_42"})
    assert r.status_code == 200

    # 3. Partner patches sheet
    patch_body = {"cells": [{"recordId": 1, "columnId": "grade", "value": "A"}]}
    r = client.patch("/api/partner/sheets/math", json=patch_body, headers=AUTH)
    assert r.status_code == 200

    # 4. Partner queries all audit logs
    r = client.get("/api/partner/audit-logs", headers=AUTH)
    assert r.status_code == 200
    data = r.json()
    assert "auditLogs" in data
    assert "audit_logs" in data
    assert data["total"] >= 3

    # Check the create event has custom actor
    create_events = [l for l in data["auditLogs"] if l["action"] == "sheet.create" and l["sheetPath"] == "math"]
    assert len(create_events) == 1
    assert create_events[0]["actorType"] == "partner"
    assert create_events[0]["actorId"] == "admin_clara"

    # Check the read event has student token
    read_events = [l for l in data["auditLogs"] if l["action"] == "sheet.read" and l["sheetPath"] == "math"]
    assert len(read_events) >= 1
    assert read_events[0]["actorType"] == "user"
    assert read_events[0]["actorId"] == "student_token_42"

    # Check the patch event has oldValue "B" and newValue "A"
    patch_events = [l for l in data["auditLogs"] if l["action"] == "sheet.patch" and l["sheetPath"] == "math"]
    assert len(patch_events) == 1
    cell_info = patch_events[0]["details"]["appliedCells"][0]
    assert cell_info["oldValue"] == "B"
    assert cell_info["newValue"] == "A"

    # 5. Query sheet-scoped audit logs via dedicated endpoint
    r_sheet = client.get("/api/partner/sheets/math/audit-logs", headers=AUTH)
    assert r_sheet.status_code == 200
    assert all(l["sheetPath"] == "math" for l in r_sheet.json()["auditLogs"])

    # Test alias route /sheets/{path}/audit_logs
    r_alias = client.get("/api/partner/sheets/math/audit_logs", headers=AUTH)
    assert r_alias.status_code == 200
    assert len(r_alias.json()["auditLogs"]) == len(r_sheet.json()["auditLogs"])

    # 6. Fetch single audit log by ID
    log_id = create_events[0]["id"]
    r_single = client.get(f"/api/partner/audit-logs/{log_id}", headers=AUTH)
    assert r_single.status_code == 200
    assert r_single.json()["id"] == log_id
    assert r_single.json()["action"] == "sheet.create"

    # Missing ID returns 404
    assert client.get("/api/partner/audit-logs/999999", headers=AUTH).status_code == 404


def test_partner_audit_logs_ws_events_and_sheet_deletion(client):
    # Create sheet
    client.get("/api/sheets/science")

    # WS edit
    with client.websocket_connect("/ws/ark?path=science&ark_token=sci_student_1") as ws:
        ws.send_json(
            {
                "type": "cell.value_committed",
                "row": 1,
                "col": 1,
                "columnId": "a",
                "value": "Atom",
                "sheetPath": "science",
            }
        )
        ws.receive_json()

    # Verify WS edit is audited with user token
    r = client.get("/api/partner/sheets/science/audit-logs?action=cell.update", headers=AUTH)
    assert r.status_code == 200
    update_logs = r.json()["auditLogs"]
    assert len(update_logs) == 1
    assert update_logs[0]["actorType"] == "user"
    assert update_logs[0]["actorId"] == "sci_student_1"
    assert update_logs[0]["details"]["newValue"] == "Atom"

    # Partner deletes the sheet
    del_r = client.delete("/api/partner/sheets/science", headers=AUTH)
    assert del_r.status_code == 200

    # Audit logs for science sheet still exist and include sheet.delete
    r_after = client.get("/api/partner/sheets/science/audit-logs", headers=AUTH)
    assert r_after.status_code == 200
    logs = r_after.json()["auditLogs"]
    actions = [l["action"] for l in logs]
    assert "sheet.delete" in actions
    assert "cell.update" in actions

