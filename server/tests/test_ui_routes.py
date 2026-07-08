from app.main import _ui_route_specs


def test_default_ui_routes(monkeypatch):
    monkeypatch.delenv("ARK_UI_ROUTES", raising=False)
    exact, prefixes = _ui_route_specs()
    assert exact == ["clients", "records"]
    assert prefixes == []


def test_exact_routes_are_deduped_and_validated(monkeypatch):
    monkeypatch.setenv("ARK_UI_ROUTES", "clients, clients ,bad segment,records")
    exact, prefixes = _ui_route_specs()
    assert exact == ["clients", "records"]
    assert prefixes == []


def test_wildcard_prefixes_sorted_longest_first(monkeypatch):
    monkeypatch.setenv("ARK_UI_ROUTES", "team/*,team/records/*")
    exact, prefixes = _ui_route_specs()
    assert exact == []
    assert prefixes == [("team", "records"), ("team",)]


def test_invalid_wildcards_dropped(monkeypatch):
    monkeypatch.setenv("ARK_UI_ROUTES", "team/**,team/,*,ok/*")
    exact, prefixes = _ui_route_specs()
    assert prefixes == [("ok",)]


def test_exact_route_shadowed_by_prefix_base_is_removed(monkeypatch):
    monkeypatch.setenv("ARK_UI_ROUTES", "team,team/*")
    exact, prefixes = _ui_route_specs()
    assert exact == []
    assert prefixes == [("team",)]
