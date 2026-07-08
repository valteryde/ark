import pytest

from app import store as store_module


@pytest.fixture()
def fresh_store(tmp_path, monkeypatch):
    """Isolated SheetStore singleton on a temp SQLite file."""
    monkeypatch.setenv("ARK_DB_PATH", str(tmp_path / "ark-test.db"))
    store_module.reset_store()
    yield store_module.get_store()
    store_module.reset_store()
