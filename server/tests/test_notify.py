import asyncio

import pytest

from app.partner_notify import PartnerNotifier


class _CapturingNotifier(PartnerNotifier):
    def __init__(self):
        super().__init__()
        self.posts = []

    async def _post(self, body, headers):
        self.posts.append((body, headers))


@pytest.fixture()
def notify_env(monkeypatch):
    monkeypatch.setenv("ARK_PARTNER_BASE_URL", "http://partner.example")
    monkeypatch.setenv("ARK_NOTIFY_COALESCE_MS", "30")


def test_events_within_window_are_coalesced_into_one_post(notify_env):
    async def run():
        n = _CapturingNotifier()
        for i in range(5):
            n.enqueue("clients", {"kind": "cell", "row": i + 1, "col": 1}, revision=i + 2)
        await asyncio.sleep(0.15)
        return n.posts

    posts = asyncio.run(run())
    assert len(posts) == 1
    body, headers = posts[0]
    assert body["type"] == "sheet.changed"
    assert body["sheetPath"] == "clients"
    assert body["revision"] == 6
    assert len(body["events"]) == 5
    assert headers == {}


def test_single_edit_flushes_after_window(notify_env):
    async def run():
        n = _CapturingNotifier()
        n.enqueue("clients", {"kind": "cell", "row": 1, "col": 1}, revision=2)
        await asyncio.sleep(0.15)
        n.enqueue("clients", {"kind": "cell", "row": 2, "col": 1}, revision=3)
        await asyncio.sleep(0.15)
        return n.posts

    posts = asyncio.run(run())
    assert len(posts) == 2
    assert posts[0][0]["revision"] == 2
    assert posts[1][0]["revision"] == 3


def test_batches_are_separate_per_sheet_and_token(notify_env):
    async def run():
        n = _CapturingNotifier()
        n.enqueue("clients", {"kind": "cell", "row": 1, "col": 1}, revision=2, token="alice")
        n.enqueue("clients", {"kind": "cell", "row": 2, "col": 1}, revision=3, token="bob")
        n.enqueue("records", {"kind": "cell", "row": 1, "col": 1}, revision=2, token="alice")
        await asyncio.sleep(0.15)
        return n.posts

    posts = asyncio.run(run())
    assert len(posts) == 3
    keys = {(b["sheetPath"], h.get("authorization")) for b, h in posts}
    assert keys == {
        ("clients", "Bearer alice"),
        ("clients", "Bearer bob"),
        ("records", "Bearer alice"),
    }


def test_no_posts_without_partner_base_url(monkeypatch):
    monkeypatch.delenv("ARK_PARTNER_BASE_URL", raising=False)

    async def run():
        n = _CapturingNotifier()
        n.enqueue("clients", {"kind": "cell", "row": 1, "col": 1}, revision=2)
        await asyncio.sleep(0.05)
        return n.posts

    assert asyncio.run(run()) == []


def test_flush_now_sends_pending_batches(notify_env):
    async def run():
        n = _CapturingNotifier()
        n.enqueue("clients", {"kind": "sheet_created", "path": "clients"}, revision=1)
        await n.flush_now()
        return n.posts

    posts = asyncio.run(run())
    assert len(posts) == 1
    assert posts[0][0]["events"][0]["kind"] == "sheet_created"
