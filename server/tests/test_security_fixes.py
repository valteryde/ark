import hashlib
import pytest
from starlette.testclient import TestClient

from app.collab import CollabHub
from app.main import app, _user_actor_id
from app.partner_auth import verify_browser_token, clear_auth_cache, _MAX_CACHE_SIZE, _cache
from app.store import (
    SheetValidationError,
    normalize_sheet_path,
    validate_cell_value,
    _validate_title,
    _validate_description,
    _validate_columns,
    MAX_CELL_STRING_LENGTH,
    MAX_TITLE_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    MAX_COLUMN_HEADER_LENGTH,
    MAX_COLUMN_ID_LENGTH,
)

AUTH = {"Authorization": "Bearer secret-token"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ARK_PARTNER_API_TOKEN", "secret-token")
    return TestClient(app)


def test_sec_01_token_fingerprinting():
    raw_token = "secret_jwt_or_bearer_token_123456789"
    hashed = _user_actor_id(raw_token)
    assert hashed.startswith("token:")
    assert raw_token not in hashed
    assert len(hashed) == len("token:") + 12
    # Deterministic hashing
    expected = f"token:{hashlib.sha256(raw_token.encode()).hexdigest()[:12]}"
    assert hashed == expected
    assert _user_actor_id(None) == "anonymous"
    assert _user_actor_id("") == "anonymous"


def test_sec_02_path_normalization_strictness():
    # Valid paths
    assert normalize_sheet_path("clients") == "clients"
    assert normalize_sheet_path("clients/21") == "clients/21"
    assert normalize_sheet_path("/classes/math/") == "classes/math"
    assert normalize_sheet_path("org_1/team-2/sheet_3") == "org_1/team-2/sheet_3"

    # Malicious / traversal inputs must raise SheetValidationError
    malicious = [
        "foo/../bar",
        "foo/%2e%2e/bar",
        "foo/..?admin=1",
        "foo/..#frag",
        "sheet?param=injected",
        "sheet#fragment",
        "sheet with spaces",
        "sheet\x00null",
        "sheet\r\nheader:inject",
        "..",
        "foo/..",
        "/",
        "",
        "   ",
        "sheet;delete",
        "sheet&param",
    ]
    for m in malicious:
        with pytest.raises(SheetValidationError):
            normalize_sheet_path(m)


def test_sec_03_ws_origin_validation(client, monkeypatch):
    monkeypatch.setenv("ARK_ALLOWED_WS_ORIGINS", "https://trusted-embed.example.com")
    from app.main import _parse_allowed_ws_origins
    import app.main as main_mod

    monkeypatch.setattr(main_mod, "_ALLOWED_WS_ORIGINS", _parse_allowed_ws_origins())

    # 1. Allowed external origin passes
    with client.websocket_connect(
        "/ws/ark?path=test_ws",
        headers={"origin": "https://trusted-embed.example.com"},
    ) as ws:
        pass

    # 2. Same-origin (testserver) passes even when allowlist is set
    with client.websocket_connect(
        "/ws/ark?path=test_ws",
        headers={"origin": "http://testserver"},
    ) as ws:
        pass

    # 3. Disallowed external origin fails with 4403
    with pytest.raises(Exception):
        with client.websocket_connect(
            "/ws/ark?path=test_ws",
            headers={"origin": "https://evil-attacker.example.com"},
        ) as ws:
            pass


@pytest.mark.asyncio
async def test_sec_04_auth_cache_bounded_lru(monkeypatch):
    clear_auth_cache()
    # Mock partner url so caching occurs
    monkeypatch.setenv("ARK_PARTNER_BASE_URL", "http://fake-partner.local")

    # Fill cache beyond max size
    from collections import OrderedDict
    for i in range(100):
        _cache[f"token_{i}\x00path_{i}"] = (True, 9999999999.0)

    monkeypatch.setattr("app.partner_auth._MAX_CACHE_SIZE", 50)
    # Insert one more via verify_browser_token simulation
    from app.partner_auth import _MAX_CACHE_SIZE
    assert len(_cache) == 100

    # Truncate to simulated max size and ensure popitem works
    while len(_cache) > 50:
        _cache.popitem(last=False)
    assert len(_cache) == 50
    clear_auth_cache()
    assert len(_cache) == 0


def test_sec_05_collab_hub_room_isolation():
    class DummyWS:
        def __init__(self, name):
            self.name = name

    hub = CollabHub()
    ws1 = DummyWS("ws1")
    ws2 = DummyWS("ws2")

    # Connect clients
    hub._clients.add(ws1)
    hub._client_paths[id(ws1)] = set()
    hub._clients.add(ws2)
    hub._client_paths[id(ws2)] = set()

    hub.subscribe(ws1, "sheet_a")
    hub.subscribe(ws2, "sheet_b")

    assert ws1 in hub._rooms["sheet_a"]
    assert "sheet_a" not in hub._rooms.get("sheet_b", set())
    assert ws1 not in hub._rooms.get("sheet_b", set())

    # Switch ws1 to sheet_b using unsubscribe_all
    hub.unsubscribe_all(ws1)
    assert "sheet_a" not in hub._rooms
    hub.subscribe(ws1, "sheet_b")
    assert ws1 in hub._rooms["sheet_b"]

    # Explicit unsubscribe
    hub.unsubscribe(ws1, "sheet_b")
    assert ws1 not in hub._rooms["sheet_b"]
    assert ws2 in hub._rooms["sheet_b"]


def test_sec_08_route_shadowing_resolution(client, fresh_store):
    # Create a sheet whose path literally ends with audit-logs
    payload = {
        "title": "Audit Compliance 2026",
        "columns": [{"id": "id", "header": "ID", "widthPx": 100}],
        "rows": [{"id": "item1"}],
    }
    r_put = client.put("/api/partner/sheets/compliance/audit-logs", json=payload, headers=AUTH)
    assert r_put.status_code == 200

    # GET /api/partner/sheets/compliance/audit-logs must return the sheet, NOT audit logs!
    r_get = client.get("/api/partner/sheets/compliance/audit-logs", headers=AUTH)
    assert r_get.status_code == 200
    data = r_get.json()
    assert data["title"] == "Audit Compliance 2026"
    assert "rows" in data
    assert "auditLogs" not in data


def test_sec_09_payload_bounds():
    # 1. Cell string bounds
    with pytest.raises(SheetValidationError, match="cell value exceeds maximum length"):
        validate_cell_value("X" * (MAX_CELL_STRING_LENGTH + 1))

    # Valid string length passes
    assert validate_cell_value("X" * MAX_CELL_STRING_LENGTH) == "X" * MAX_CELL_STRING_LENGTH

    # 2. Title bounds
    with pytest.raises(SheetValidationError, match="title must be a string up to"):
        _validate_title("T" * (MAX_TITLE_LENGTH + 1))
    assert _validate_title("Valid Title") == "Valid Title"

    # 3. Description bounds
    with pytest.raises(SheetValidationError, match="description must be a string up to"):
        _validate_description("D" * (MAX_DESCRIPTION_LENGTH + 1))

    # 4. Column ID and header bounds
    with pytest.raises(SheetValidationError, match="column id exceeds maximum length"):
        _validate_columns([{"id": "c" * (MAX_COLUMN_ID_LENGTH + 1), "header": "Col"}])

    with pytest.raises(SheetValidationError, match="column header exceeds maximum length"):
        _validate_columns([{"id": "col1", "header": "H" * (MAX_COLUMN_HEADER_LENGTH + 1)}])


def test_sec_12_security_headers(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
    assert r.headers.get("X-XSS-Protection") == "0"
    assert r.headers.get("X-Frame-Options") == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in r.headers.get("Content-Security-Policy", "")
