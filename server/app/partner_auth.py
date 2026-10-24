"""Browser token (ark_token) verification against the partner app.

Ark does not mint or interpret tokens. When ARK_PARTNER_BASE_URL is set, each
unseen token is verified once with `GET {base}/ark/auth` (Authorization:
Bearer <token>, header omitted for anonymous requests so the partner decides
whether anonymous access is allowed); a 2xx response means valid. Results are
cached in-memory per token for ARK_AUTH_CACHE_TTL seconds (default 300). With
no partner base URL configured (local dev), all requests are accepted.
"""

from __future__ import annotations

from collections import OrderedDict
import logging
import os
import time

import httpx

logger = logging.getLogger("ark")

_MAX_CACHE_SIZE = 10_000


def partner_base_url() -> str:
    return os.environ.get("ARK_PARTNER_BASE_URL", "").rstrip("/")


def _cache_ttl_seconds() -> float:
    raw = os.environ.get("ARK_AUTH_CACHE_TTL", "300")
    try:
        return max(float(raw), 0.0)
    except ValueError:
        return 300.0


# token\0path -> (valid, expires_at_monotonic)
_cache: OrderedDict[str, tuple[bool, float]] = OrderedDict()


def clear_auth_cache() -> None:
    _cache.clear()


async def verify_browser_token(token: str | None, path: str | None = None) -> bool:
    """True when the token is valid for browser access (or no partner is configured)."""
    base = partner_base_url()
    if not base:
        return True

    cache_key = f"{token or ''}\x00{path or ''}"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached is not None:
        valid, exp = cached
        if exp > now:
            _cache.move_to_end(cache_key)
            return valid
        else:
            del _cache[cache_key]

    headers = {"authorization": f"Bearer {token}"} if token else {}
    params = {"path": path} if path else {}
    valid = False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/ark/auth", headers=headers, params=params)
        valid = 200 <= r.status_code < 300
    except Exception as e:
        logger.warning("partner auth check failed: %s", e)
        # Partner unreachable: fail closed, but do not cache so recovery is immediate.
        return False

    # Negative responses cached for shorter TTL (max 30s) to throttle partner flood
    ttl = _cache_ttl_seconds() if valid else min(_cache_ttl_seconds(), 30.0)
    if len(_cache) >= _MAX_CACHE_SIZE:
        _cache.popitem(last=False)
    _cache[cache_key] = (valid, now + ttl)
    return valid
