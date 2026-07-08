"""Pull-based sheet templates from the partner app.

When a browser opens a sheet path with no document, Ark asks the partner how
the new sheet should look:

    GET {ARK_PARTNER_BASE_URL}/ark/template/{path}
    Authorization: Bearer <ark_token>   (omitted for anonymous users)

The response is a sheet payload (columns required, optional rows to prefill,
title, capabilities, ...) and MUST include a `version` (string or integer) —
partners change templates over time, and each created document records the
template `name`/`version` it was built from.

- 404 → the partner has no template for this path; Ark creates a blank sheet.
- Any other non-2xx, an unreachable partner, or an invalid template body
  (missing version, bad columns) raises PartnerTemplateError: the document is
  NOT created, so a temporary partner problem never pins a wrong blank sheet.
- No ARK_PARTNER_BASE_URL configured → None (blank sheet, local dev).

This is fetched live at creation time, so there is no template registration
step and no partner/Ark startup-order dependency.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .partner_auth import partner_base_url
from .store import SheetValidationError, _validate_columns

logger = logging.getLogger("ark")

_TEMPLATE_PASSTHROUGH_KEYS = (
    "title",
    "description",
    "rowCount",
    "ghostRowCount",
    "defaultRowHeightPx",
    "enabledUiCapabilities",
    "chromeActions",
)


class PartnerTemplateError(Exception):
    """Partner template endpoint failed or returned an invalid template."""


def parse_template_response(data: Any) -> dict[str, Any]:
    """Validate and normalize a partner template body. Raises PartnerTemplateError."""
    if not isinstance(data, dict):
        raise PartnerTemplateError("template response must be a JSON object")

    version = data.get("version")
    if isinstance(version, bool) or not isinstance(version, (str, int)):
        raise PartnerTemplateError(
            "template response must include a version (string or integer)"
        )
    if isinstance(version, str) and not version.strip():
        raise PartnerTemplateError("template version must not be empty")

    try:
        columns = _validate_columns(data.get("columns"))
    except SheetValidationError as e:
        raise PartnerTemplateError(f"invalid template columns: {e}") from e

    rows = data.get("rows", [])
    if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
        raise PartnerTemplateError("template rows must be an array of objects")

    template: dict[str, Any] = {"version": version, "columns": columns, "rows": rows}
    name = data.get("name")
    if isinstance(name, str) and name.strip():
        template["name"] = name.strip()
    for key in _TEMPLATE_PASSTHROUGH_KEYS:
        if key in data:
            template[key] = data[key]
    return template


async def fetch_partner_template(path: str, token: str | None) -> dict[str, Any] | None:
    """Fetch the partner's template for `path`. None = create a blank sheet."""
    base = partner_base_url()
    if not base:
        return None
    headers = {"authorization": f"Bearer {token}"} if token else {}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{base}/ark/template/{path}", headers=headers)
    except Exception as e:
        logger.warning("partner template fetch failed: %s", e)
        raise PartnerTemplateError("partner template endpoint unreachable") from e

    if r.status_code == 404:
        return None
    if not (200 <= r.status_code < 300):
        raise PartnerTemplateError(f"partner template endpoint returned HTTP {r.status_code}")
    try:
        data = r.json()
    except Exception as e:
        raise PartnerTemplateError("partner template response is not valid JSON") from e
    return parse_template_response(data)
