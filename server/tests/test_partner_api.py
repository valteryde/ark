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
    with client.websocket_connect("/ws/ark") as ws:
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
    with client.websocket_connect("/ws/ark") as ws:
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
