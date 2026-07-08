"""Live, coalesced change notifications from Ark to the partner app.

Every persisted browser edit enqueues a lightweight event. Events for the same
(sheet, user token) are coalesced for a short window (ARK_NOTIFY_COALESCE_MS,
default 250 ms) so a paste of 200 cells becomes one POST while single edits
stay effectively instant. The partner receives:

    POST {ARK_PARTNER_BASE_URL}/ark/notify
    { "type": "sheet.changed", "sheetPath": "...", "revision": N,
      "events": [ { "kind": "cell", ... }, ... ] }

and can pull the full sheet from GET /api/partner/sheets/{path}. Notifications
are fire-and-forget with one retry; failures never block the grid.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

from .partner_auth import partner_base_url

logger = logging.getLogger("ark")


def _coalesce_seconds() -> float:
    raw = os.environ.get("ARK_NOTIFY_COALESCE_MS", "250")
    try:
        return max(float(raw), 0.0) / 1000.0
    except ValueError:
        return 0.25


class PartnerNotifier:
    """Per-(sheet, token) coalescing queues posting sheet.changed to the partner."""

    def __init__(self) -> None:
        # (sheet_path, token) -> {"events": [...], "revision": int}
        self._batches: dict[tuple[str, str], dict[str, Any]] = {}
        self._tasks: dict[tuple[str, str], asyncio.Task[None]] = {}

    def enqueue(
        self,
        sheet_path: str,
        event: dict[str, Any],
        revision: int,
        token: str | None = None,
    ) -> None:
        """Buffer one change event; schedules a flush if none is pending."""
        if not partner_base_url():
            return
        key = (sheet_path, token or "")
        batch = self._batches.get(key)
        if batch is None:
            batch = {"events": [], "revision": revision}
            self._batches[key] = batch
        batch["events"].append(event)
        batch["revision"] = max(batch["revision"], revision)
        if key not in self._tasks:
            task = asyncio.get_running_loop().create_task(self._flush_later(key))
            self._tasks[key] = task

    async def _flush_later(self, key: tuple[str, str]) -> None:
        try:
            await asyncio.sleep(_coalesce_seconds())
            batch = self._batches.pop(key, None)
            if batch is None or not batch["events"]:
                return
            sheet_path, token = key
            body = {
                "type": "sheet.changed",
                "sheetPath": sheet_path,
                "revision": batch["revision"],
                "events": batch["events"],
            }
            headers = {"authorization": f"Bearer {token}"} if token else {}
            await self._post(body, headers)
        finally:
            self._tasks.pop(key, None)

    async def _post(self, body: dict[str, Any], headers: dict[str, str]) -> None:
        url = f"{partner_base_url()}/ark/notify"
        for attempt in (1, 2):
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    r = await client.post(url, json=body, headers=headers)
                    r.raise_for_status()
                return
            except Exception as e:
                if attempt == 2:
                    logger.warning("partner notify POST failed (giving up): %s", e)
                else:
                    await asyncio.sleep(1.0)

    async def flush_now(self) -> None:
        """Flush all pending batches immediately (tests / shutdown)."""
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        self._tasks.clear()
        keys = list(self._batches.keys())
        for key in keys:
            batch = self._batches.pop(key, None)
            if batch is None or not batch["events"]:
                continue
            sheet_path, token = key
            body = {
                "type": "sheet.changed",
                "sheetPath": sheet_path,
                "revision": batch["revision"],
                "events": batch["events"],
            }
            headers = {"authorization": f"Bearer {token}"} if token else {}
            await self._post(body, headers)


notifier = PartnerNotifier()
