"""Map inbound spreadsheet-style events to partner `POST /ark/tunnel` payloads."""

from __future__ import annotations

from typing import Any


def map_to_tunnel(event: dict[str, Any]) -> dict[str, Any]:
    t = event.get("type")
    if t == "cell.value_committed":
        return {
            "type": "update_cell",
            "row": event.get("row"),
            "col": event.get("col"),
            "columnId": event.get("columnId"),
            "value": event.get("value"),
            "meta": event,
        }
    if t in ("cell.created", "row.created"):
        return {"type": "new_cell", "meta": event}
    if t in ("cell.deleted", "row.deleted"):
        return {"type": "delete_cell", "meta": event}
    return {"type": "spreadsheet_event", "payload": event}
