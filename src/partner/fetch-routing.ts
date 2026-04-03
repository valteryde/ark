/** Encode each path segment for use in /api/ark/routing/{path}. */
function encodeRoutingPath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export class PartnerFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText?: string,
  ) {
    super(message);
    this.name = 'PartnerFetchError';
  }
}

/** GET same-origin /api/ark/routing/{path} and parse JSON. */
export async function fetchRoutingJson<T>(path: string): Promise<T> {
  const url = `/api/ark/routing/${encodeRoutingPath(path)}`;
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch (e) {
    throw new PartnerFetchError(
      `Network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new PartnerFetchError(`Invalid JSON from ${url} (HTTP ${res.status})`, res.status, text);
  }

  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && 'detail' in data
        ? String((data as { detail: unknown }).detail)
        : text;
    throw new PartnerFetchError(
      `HTTP ${res.status} for ${url}: ${detail || res.statusText}`,
      res.status,
      text,
    );
  }

  return data as T;
}
