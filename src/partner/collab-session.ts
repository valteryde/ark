const STORAGE_ID = 'ark-collab-client-id';
const STORAGE_HUE = 'ark-collab-hue';

/** Per-tab identity for collab (skip echo + colorful remote markers). */
export function getCollabClientIdentity(): { clientId: string; markerHue: number } {
  let clientId = sessionStorage.getItem(STORAGE_ID);
  if (!clientId) {
    clientId = crypto.randomUUID();
    sessionStorage.setItem(STORAGE_ID, clientId);
  }
  const hueStr = sessionStorage.getItem(STORAGE_HUE);
  let markerHue = hueStr !== null ? Number.parseInt(hueStr, 10) : Number.NaN;
  if (!Number.isFinite(markerHue)) {
    markerHue = Math.floor(Math.random() * 360);
    sessionStorage.setItem(STORAGE_HUE, String(markerHue));
  }
  markerHue = ((markerHue % 360) + 360) % 360;
  return { clientId, markerHue };
}
