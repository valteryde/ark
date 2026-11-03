"""Sheet-level pictures stored beside the cells, not inside them.

Each image is a box in cell-area pixels: `x` and `y` are the distance from
the top-left of cell A1. `src` is a base64 PNG, JPEG, or GIF data URL.
A move or resize may omit `src`; the stored bytes stay.
"""

from __future__ import annotations

import base64
import json
import math
import re
from typing import Any

MAX_FLOATING_IMAGES = 20
MAX_FLOATING_IMAGE_SRC_LENGTH = 1_500_000
MIN_FLOATING_IMAGE_PX = 24.0
MAX_FLOATING_IMAGE_EDGE = 4000.0
MAX_FLOATING_IMAGE_POS = 1_000_000.0

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SRC_RE = re.compile(
    r"^data:image/(png|jpeg|jpg|gif);base64,([A-Za-z0-9+/]+={0,2})$"
)


class FloatingImageError(ValueError):
    """A caller-supplied floatingImages list is not usable."""


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number


def _round_px(value: float) -> float:
    return math.floor(value * 100 + 0.5) / 100


def _px(value: Any, *, low: float, high: float) -> float | None:
    number = _finite(value)
    if number is None or number < low or number > high:
        return None
    return _round_px(number)


def decode_floating_image_src(src: str) -> bytes | None:
    """Return the decoded bytes, or None when `src` is not an allowed data URL."""
    if not isinstance(src, str) or len(src) > MAX_FLOATING_IMAGE_SRC_LENGTH:
        return None
    match = _SRC_RE.fullmatch(src.strip())
    if match is None:
        return None
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except Exception:
        return None
    if not data:
        return None
    return data


def parse_floating_images(raw: Any, *, require_src: bool) -> list[dict[str, Any]]:
    """Validate a floatingImages array. `None` is an empty list.

    Raises FloatingImageError on a bad entry. When `require_src` is false,
    an entry may omit `src` (the caller copies the stored bytes).
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise FloatingImageError("floatingImages must be an array")
    if len(raw) > MAX_FLOATING_IMAGES:
        raise FloatingImageError(f"floatingImages must not exceed {MAX_FLOATING_IMAGES}")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise FloatingImageError("each floating image must be an object")
        image_id = item.get("id")
        if not isinstance(image_id, str) or _ID_RE.fullmatch(image_id) is None:
            raise FloatingImageError("floating image id must be 1–64 letters, digits, _ or -")
        if image_id in seen:
            raise FloatingImageError(f"duplicate floating image id: {image_id}")
        seen.add(image_id)
        x = _px(item.get("x"), low=0, high=MAX_FLOATING_IMAGE_POS)
        y = _px(item.get("y"), low=0, high=MAX_FLOATING_IMAGE_POS)
        width = _px(item.get("width"), low=MIN_FLOATING_IMAGE_PX, high=MAX_FLOATING_IMAGE_EDGE)
        height = _px(item.get("height"), low=MIN_FLOATING_IMAGE_PX, high=MAX_FLOATING_IMAGE_EDGE)
        if x is None or y is None or width is None or height is None:
            raise FloatingImageError(
                "floating image x/y must be >= 0 and width/height must be between 24 and 4000"
            )
        src = item.get("src")
        stored: dict[str, Any] = {
            "id": image_id,
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        }
        if src is None and not require_src:
            out.append(stored)
            continue
        if not isinstance(src, str) or decode_floating_image_src(src) is None:
            raise FloatingImageError("floating image src must be a base64 PNG, JPEG, or GIF data URL")
        stored["src"] = src.strip()
        out.append(stored)
    return out


def merge_floating_images(
    previous: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Fill omitted `src` from `previous`.

    Returns `(stored, wire)`. `wire` includes `src` only when the caller sent it,
    so a move does not broadcast the file again. Unknown ids without `src` raise.
    """
    prev = {img["id"]: img for img in previous}
    stored: list[dict[str, Any]] = []
    wire: list[dict[str, Any]] = []
    for img in incoming:
        sent_src = "src" in img and bool(img.get("src"))
        src = img.get("src") if sent_src else None
        if not src:
            old = prev.get(img["id"])
            if old is None or not old.get("src"):
                raise FloatingImageError(f"unknown image id: {img['id']}")
            src = old["src"]
        item = {
            "id": img["id"],
            "x": img["x"],
            "y": img["y"],
            "width": img["width"],
            "height": img["height"],
            "src": src,
        }
        stored.append(item)
        wire_item = {
            "id": img["id"],
            "x": img["x"],
            "y": img["y"],
            "width": img["width"],
            "height": img["height"],
        }
        if sent_src:
            wire_item["src"] = src
        wire.append(wire_item)
    return stored, wire


def floating_image_geometry(images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ids and boxes only, for audit rows and sheet events."""
    return [
        {
            "id": img["id"],
            "x": img["x"],
            "y": img["y"],
            "width": img["width"],
            "height": img["height"],
        }
        for img in images
    ]


def dump_floating_images(images: list[dict[str, Any]]) -> str | None:
    if not images:
        return None
    return json.dumps(images)


def load_floating_images(raw: str | None) -> list[dict[str, Any]]:
    """Read a stored JSON list. Corrupt payloads become empty."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    try:
        return parse_floating_images(data, require_src=True)
    except FloatingImageError:
        return []
