"""Browser token (ark_token) verification against the partner app.

Ark does not mint or interpret tokens. When ARK_PARTNER_BASE_URL is set, each
unseen token is verified once with `GET {base}/ark/auth` (Authorization:
Bearer <token>, header omitted for anonymous requests so the partner decides
whether anonymous access is allowed); a 2xx response means valid. Results are
cached in-memory per token for ARK_AUTH_CACHE_TTL seconds (default 300). With
no partner base URL configured (local dev), all requests are accepted.
"""

from __future__ import annotations

import logging
import os
import time

import httpx

logger = logging.getLogger("ark")


def partner_base_url() -> str:
    return os.environ.get("ARK_PARTNER_BASE_URL", "").rstrip("/")


def _cache_ttl_seconds() -> float:
    raw = os.environ.get("ARK_AUTH_CACHE_TTL", "300")
    try:
        return max(float(raw), 0.0)
    except ValueError:
        return 300.0


# token -> (valid, expires_at_monotonic)
_cache: dict[str, tuple[bool, float]] = {}


def clear_auth_cache() -> None:
    _cache.clear()


async def verify_browser_token(token: str | None) -> bool:
    """True when the token is valid for browser access (or no partner is configured)."""
    base = partner_base_url()
    if not base:
        return True

    cache_key = token or ""
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached is not None and cached[1] > now:
        return cached[0]

    headers = {"authorization": f"Bearer {token}"} if token else {}
    valid = False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{base}/ark/auth", headers=headers)
        valid = 200 <= r.status_code < 300
    except Exception as e:
        logger.warning("partner auth check failed: %s", e)
        # Partner unreachable: fail closed, but do not cache so recovery is immediate.
        return False

    _cache[cache_key] = (valid, now + _cache_ttl_seconds())
    return valid
