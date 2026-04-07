"""Map inbound spreadsheet-style events to partner `POST /ark/tunnel` payloads."""

from __future__ import annotations

from typing import Any


def map_to_tunnel(event: dict[str, Any]) -> dict[str, Any]:
    t = event.get("type")
    if t == "cell.value_committed":
        out: dict[str, Any] = {
            "type": "update_cell",
            "row": event.get("row"),
            "col": event.get("col"),
            "columnId": event.get("columnId"),
            "value": event.get("value"),
            "meta": event,
        }
        rid = event.get("recordId")
        if rid is not None:
            out["recordId"] = rid
        return out
    if t in ("cell.created", "row.created"):
        return {"type": "new_cell", "meta": event}
    if t == "row.deleted":
        out: dict[str, Any] = {
            "type": "delete_row",
            "row": event.get("row"),
            "meta": event,
        }
        rid = event.get("recordId")
        if rid is not None:
            out["recordId"] = rid
        return out
    if t == "cell.deleted":
        return {"type": "delete_cell", "meta": event}
    return {"type": "spreadsheet_event", "payload": event}
