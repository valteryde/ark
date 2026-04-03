/** URL path segment for the browser, e.g. `api/clients` → `clients` → `/clients`. */
export function browserSegmentForRoutingPath(routingPath: string): string {
  const p = routingPath.trim();
  if (p.startsWith('api/')) {
    return p.slice(4) || 'sheet';
  }
  return p.replace(/\//g, '-').replace(/^-+|-+$/g, '') || 'sheet';
}
