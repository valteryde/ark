"""Sanitized per-cell presentation styles.

Styles are a small allowlist of CSS declarations (color, background, font,
alignment, borders). Anything else is dropped so a sheet payload cannot inject
URLs, scripts, or layout-breaking properties. The same allowlist is mirrored
in `src/spreadsheet/cell-style.ts`.
"""

from __future__ import annotations

import json
import re
from typing import Any

MAX_STYLE_PROPS = 32
MAX_STYLE_VALUE_LEN = 80
MAX_CELL_STYLE_ENTRIES = 100_000

_CELL_KEY_RE = re.compile(r"^[1-9]\d*:[1-9]\d*$")
_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGB_COLOR_RE = re.compile(
    r"^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$"
)
_RGBA_COLOR_RE = re.compile(
    r"^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(?:0?\.\d+|1(?:\.0+)?|0)\s*\)$"
)
_NAMED_COLOR_RE = re.compile(r"^[a-zA-Z]{3,20}$")
_FONT_WEIGHT_WORD = frozenset({"normal", "bold", "bolder", "lighter"})
_FONT_STYLE = frozenset({"normal", "italic", "oblique"})
_JUSTIFY = frozenset(
    {"normal", "flex-start", "flex-end", "center", "start", "end", "left", "right", "stretch"}
)
_TEXT_ALIGN = frozenset({"left", "right", "center", "start", "end", "justify"})
_BORDER_STYLE = frozenset({"none", "solid", "dashed", "dotted", "double"})
_DECORATION = frozenset({"none", "underline", "overline", "line-through"})
# Wrap keywords only; `pre` / `pre-line` stay out so hard breaks can't reshape a grid row.
_WHITE_SPACE = frozenset({"normal", "nowrap", "pre-wrap"})
_BOX_SHADOW_RE = re.compile(r"^inset\s+0\s+0\s+0\s+1px\s+(.+)$")
_FONT_SIZE_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2})?)px$")
_BORDER_WIDTH_RE = re.compile(r"^(\d(?:\.\d)?)px$")


class CellStyleError(ValueError):
    """A caller-supplied style (or cellStyles map) is not usable."""


def _channel_ok(raw: str) -> bool:
    n = int(raw)
    return 0 <= n <= 255


def sanitize_color(value: str) -> str | None:
    t = value.strip()
    if len(t) > MAX_STYLE_VALUE_LEN:
        return None
    if _HEX_COLOR_RE.fullmatch(t):
        return t
    rgb = _RGB_COLOR_RE.fullmatch(t)
    if rgb:
        if all(_channel_ok(rgb.group(i)) for i in (1, 2, 3)):
            return t
        return None
    rgba = _RGBA_COLOR_RE.fullmatch(t)
    if rgba:
        if all(_channel_ok(rgba.group(i)) for i in (1, 2, 3)):
            return t
        return None
    if _NAMED_COLOR_RE.fullmatch(t):
        return t.lower()
    return None


def _font_weight(value: str) -> str | None:
    t = value.strip()
    if re.fullmatch(r"[1-9]00", t):
        return t
    low = t.lower()
    if low in _FONT_WEIGHT_WORD:
        return low
    return None


def _keyword(value: str, allowed: frozenset[str]) -> str | None:
    low = value.strip().lower()
    return low if low in allowed else None


def _font_size(value: str) -> str | None:
    m = _FONT_SIZE_RE.fullmatch(value.strip())
    if not m:
        return None
    n = float(m.group(1))
    if n < 8 or n > 96:
        return None
    return f"{m.group(1)}px"


def _border_width(value: str) -> str | None:
    m = _BORDER_WIDTH_RE.fullmatch(value.strip())
    if not m:
        return None
    n = float(m.group(1))
    if n < 0 or n > 8:
        return None
    return f"{m.group(1)}px"


def _decoration(value: str) -> str | None:
    parts = value.strip().lower().split()
    if not parts or len(parts) > 4:
        return None
    out: list[str] = []
    for part in parts:
        if part not in _DECORATION:
            return None
        if part == "none":
            continue
        if part not in out:
            out.append(part)
    if "none" in parts and not out:
        return "none"
    if not out:
        return None
    return " ".join(out)


def _box_shadow(value: str) -> str | None:
    m = _BOX_SHADOW_RE.fullmatch(value.strip())
    if not m:
        return None
    color = sanitize_color(m.group(1))
    if not color:
        return None
    return f"inset 0 0 0 1px {color}"


_SANITIZERS = {
    "color": sanitize_color,
    "background-color": sanitize_color,
    "border-color": sanitize_color,
    "font-weight": _font_weight,
    "font-style": lambda v: _keyword(v, _FONT_STYLE),
    "font-size": _font_size,
    "text-decoration-line": _decoration,
    "text-align": lambda v: _keyword(v, _TEXT_ALIGN),
    "white-space": lambda v: _keyword(v, _WHITE_SPACE),
    "justify-content": lambda v: _keyword(v, _JUSTIFY),
    "align-items": lambda v: _keyword(v, _JUSTIFY),
    "box-shadow": _box_shadow,
    "border-width": _border_width,
    "border-style": lambda v: _keyword(v, _BORDER_STYLE),
}


def coerce_cell_style(raw: Any) -> dict[str, str] | None:
    """Best-effort sanitize. Non-objects and empty results become None."""
    if not isinstance(raw, dict):
        return None
    cleaned: dict[str, str] = {}
    for name, fn in _SANITIZERS.items():
        value = raw.get(name)
        if not isinstance(value, str):
            continue
        safe = fn(value)
        if safe:
            cleaned[name] = safe
    return cleaned or None


def parse_cell_style(raw: Any) -> dict[str, str] | None:
    """Validate an API style object.

    `None` and `{}` clear the style. A non-object raises. A non-empty object
    that sanitizes to nothing raises, so a typo is not stored as a clear.
    Unknown properties are dropped when at least one allowed property remains.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise CellStyleError("style must be an object")
    if len(raw) > MAX_STYLE_PROPS:
        raise CellStyleError(f"style must not exceed {MAX_STYLE_PROPS} properties")
    if len(raw) == 0:
        return None
    cleaned = coerce_cell_style(raw)
    if not cleaned:
        raise CellStyleError("style has no allowed properties")
    return cleaned


def parse_cell_styles_map(
    raw: Any, *, max_rows: int, max_cols: int
) -> dict[tuple[int, int], dict[str, str]]:
    """Parse a `"row:col"` map. `None` is an empty map."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise CellStyleError("cellStyles must be an object")
    if len(raw) > MAX_CELL_STYLE_ENTRIES:
        raise CellStyleError(f"cellStyles must not exceed {MAX_CELL_STYLE_ENTRIES} entries")
    out: dict[tuple[int, int], dict[str, str]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not _CELL_KEY_RE.fullmatch(key):
            raise CellStyleError(f"invalid cellStyles key: {key!r}")
        row_s, col_s = key.split(":")
        row, col = int(row_s), int(col_s)
        if row > max_rows or col > max_cols:
            raise CellStyleError(f"cellStyles key out of range: {key}")
        if value is None or value == {}:
            continue
        style = parse_cell_style(value)
        if style:
            out[(row, col)] = style
    return out


def dump_style(style: dict[str, str] | None) -> str | None:
    if not style:
        return None
    return json.dumps(style, separators=(",", ":"), sort_keys=True)


def load_style(raw: str | None) -> dict[str, str] | None:
    """Load a stored style JSON blob, re-sanitizing so old rows stay safe."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return coerce_cell_style(parsed)
