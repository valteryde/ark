/** Query/hash key partners use to pass a token when redirecting users to Ark. */
export const PARTNER_TOKEN_PARAM = 'ark_token';

const STORAGE_KEY = 'ark_partner_token';

function parseHashParams(hash: string): URLSearchParams {
  if (!hash || hash === '#') return new URLSearchParams();
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/**
 * Read `ark_token` from the URL (query or hash), persist to sessionStorage, and strip it from the address bar.
 * Call once when entering partner mode so routing fetch and WebSocket can use `getPartnerToken()`.
 */
export function initPartnerTokenFromLocation(): void {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get(PARTNER_TOKEN_PARAM);
  const hashParams = parseHashParams(window.location.hash);
  const fromHash = hashParams.get(PARTNER_TOKEN_PARAM);

  let token: string | null = null;
  if (fromQuery?.trim()) {
    token = fromQuery.trim();
  } else if (fromHash?.trim()) {
    token = fromHash.trim();
  }

  if (token) {
    try {
      sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
      /* ignore quota / private mode */
    }
  }

  const hadQuery = url.searchParams.has(PARTNER_TOKEN_PARAM);
  if (hadQuery) {
    url.searchParams.delete(PARTNER_TOKEN_PARAM);
  }

  const hadHashToken = hashParams.has(PARTNER_TOKEN_PARAM);
  let newHash = '';
  if (window.location.hash) {
    const hp = parseHashParams(window.location.hash);
    if (hp.has(PARTNER_TOKEN_PARAM)) {
      hp.delete(PARTNER_TOKEN_PARAM);
      newHash = hp.toString();
    } else {
      newHash = window.location.hash.slice(1);
    }
  }
  url.hash = newHash ? `#${newHash}` : '';

  if (hadQuery || hadHashToken) {
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
}

export function getPartnerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const t = sessionStorage.getItem(STORAGE_KEY);
    return t && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

/** Headers to send on same-origin partner API calls when a token is present. */
export function partnerAuthHeaders(): Record<string, string> {
  const t = getPartnerToken();
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
}
