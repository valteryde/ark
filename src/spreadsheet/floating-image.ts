import type { FloatingImage } from './types.ts';

/** Sheet-level pictures. They are not cell values. */
export const MAX_FLOATING_IMAGES = 20;
export const MAX_FLOATING_IMAGE_SRC_LENGTH = 1_500_000;
export const MIN_FLOATING_IMAGE_PX = 24;
export const MAX_FLOATING_IMAGE_EDGE = 4000;
export const MAX_FLOATING_IMAGE_POS = 1_000_000;
/** Longer side when a picture is first dropped on the sheet. */
export const FLOATING_IMAGE_INSERT_MAX_EDGE = 240;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SRC_RE = /^data:image\/(png|jpeg|jpg|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export type FloatingImageCorner = 'nw' | 'ne' | 'sw' | 'se';

export interface FloatingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function roundPx(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function cloneFloatingImages(images: readonly FloatingImage[]): FloatingImage[] {
  return images.map((image) => ({
    id: image.id,
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
    ...(image.src !== undefined ? { src: image.src } : {}),
  }));
}

export function floatingImagesEqual(
  a: readonly FloatingImage[],
  b: readonly FloatingImage[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.id !== right.id ||
      left.x !== right.x ||
      left.y !== right.y ||
      left.width !== right.width ||
      left.height !== right.height ||
      left.src !== right.src
    ) {
      return false;
    }
  }
  return true;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function parseImage(raw: unknown): FloatingImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  if (!ID_RE.test(id)) return null;
  const x = finiteNumber(o.x);
  const y = finiteNumber(o.y);
  const width = finiteNumber(o.width);
  const height = finiteNumber(o.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (x < 0 || y < 0 || x > MAX_FLOATING_IMAGE_POS || y > MAX_FLOATING_IMAGE_POS) return null;
  if (
    width < MIN_FLOATING_IMAGE_PX ||
    height < MIN_FLOATING_IMAGE_PX ||
    width > MAX_FLOATING_IMAGE_EDGE ||
    height > MAX_FLOATING_IMAGE_EDGE
  ) {
    return null;
  }
  let src: string | undefined;
  if (o.src !== undefined) {
    if (typeof o.src !== 'string') return null;
    const trimmed = o.src.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_FLOATING_IMAGE_SRC_LENGTH) return null;
    if (!SRC_RE.test(trimmed)) return null;
    src = trimmed;
  }
  return {
    id,
    x: roundPx(x),
    y: roundPx(y),
    width: roundPx(width),
    height: roundPx(height),
    ...(src !== undefined ? { src } : {}),
  };
}

/**
 * Keep well-formed images and drop the rest, so one bad entry does not blank
 * the sheet. `src` may be omitted (a move that does not resend the file).
 * Duplicate ids and anything past the cap are dropped.
 */
export function normalizeFloatingImages(raw: unknown): FloatingImage[] {
  if (!Array.isArray(raw)) return [];
  const out: FloatingImage[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_FLOATING_IMAGES) break;
    const image = parseImage(item);
    if (!image || seen.has(image.id)) continue;
    seen.add(image.id);
    out.push(image);
  }
  return out;
}

/**
 * Incoming list wins for order and geometry. An entry without `src` keeps the
 * bytes already stored for that id. An unknown id with no `src` is dropped.
 */
export function mergeFloatingImages(
  previous: readonly FloatingImage[],
  incoming: readonly FloatingImage[],
): FloatingImage[] {
  const prev = new Map(previous.map((image) => [image.id, image]));
  const out: FloatingImage[] = [];
  for (const image of incoming) {
    const src = image.src || prev.get(image.id)?.src;
    if (!src) continue;
    out.push({
      id: image.id,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
      src,
    });
  }
  return out;
}

/**
 * Wire form of a local edit. `src` is included only for an id whose bytes
 * changed (a new picture, or one that was deleted and undone).
 */
export function floatingImagesForCommit(
  before: readonly FloatingImage[],
  after: readonly FloatingImage[],
): FloatingImage[] {
  const prev = new Map(before.map((image) => [image.id, image]));
  return after.map((image) => {
    const old = prev.get(image.id);
    if (old && old.src === image.src) {
      return {
        id: image.id,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      };
    }
    return {
      id: image.id,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
      ...(image.src !== undefined ? { src: image.src } : {}),
    };
  });
}

/** Fit a picture on drop: longer side at most 240px, neither side under 24px. */
export function floatingImageBoxSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  let width = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : MIN_FLOATING_IMAGE_PX;
  let height = Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : MIN_FLOATING_IMAGE_PX;
  const longest = Math.max(width, height);
  if (longest > FLOATING_IMAGE_INSERT_MAX_EDGE) {
    const scale = FLOATING_IMAGE_INSERT_MAX_EDGE / longest;
    width *= scale;
    height *= scale;
  }
  const shortest = Math.min(width, height);
  if (shortest < MIN_FLOATING_IMAGE_PX && shortest > 0) {
    const scale = MIN_FLOATING_IMAGE_PX / shortest;
    width *= scale;
    height *= scale;
  }
  return {
    width: roundPx(clamp(width, MIN_FLOATING_IMAGE_PX, MAX_FLOATING_IMAGE_EDGE)),
    height: roundPx(clamp(height, MIN_FLOATING_IMAGE_PX, MAX_FLOATING_IMAGE_EDGE)),
  };
}

function clampBox(box: FloatingBox): FloatingBox {
  const width = roundPx(clamp(box.width, MIN_FLOATING_IMAGE_PX, MAX_FLOATING_IMAGE_EDGE));
  const height = roundPx(clamp(box.height, MIN_FLOATING_IMAGE_PX, MAX_FLOATING_IMAGE_EDGE));
  return {
    x: roundPx(clamp(box.x, 0, MAX_FLOATING_IMAGE_POS)),
    y: roundPx(clamp(box.y, 0, MAX_FLOATING_IMAGE_POS)),
    width,
    height,
  };
}

export function moveFloatingBox(start: FloatingBox, dx: number, dy: number): FloatingBox {
  return clampBox({
    x: start.x + dx,
    y: start.y + dy,
    width: start.width,
    height: start.height,
  });
}

/**
 * Resize from `corner`. The opposite corner stays put. Shift keeps the
 * starting aspect ratio. The box never shrinks below 24px.
 */
export function resizeFloatingBox(
  start: FloatingBox,
  corner: FloatingImageCorner,
  dx: number,
  dy: number,
  keepAspect: boolean,
): FloatingBox {
  const east = corner === 'ne' || corner === 'se';
  const south = corner === 'sw' || corner === 'se';
  let width = east ? start.width + dx : start.width - dx;
  let height = south ? start.height + dy : start.height - dy;
  if (keepAspect && start.width > 0 && start.height > 0) {
    const scaleX = width / start.width;
    const scaleY = height / start.height;
    const scale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
    const safe = scale > 0 ? scale : MIN_FLOATING_IMAGE_PX / Math.max(start.width, start.height);
    width = start.width * safe;
    height = start.height * safe;
  }
  const nextWidth = clamp(width, MIN_FLOATING_IMAGE_PX, MAX_FLOATING_IMAGE_EDGE);
  const nextHeight = clamp(height, MIN_FLOATING_IMAGE_PX, MAX_FLOATING_IMAGE_EDGE);
  const x = east ? start.x : start.x + start.width - nextWidth;
  const y = south ? start.y : start.y + start.height - nextHeight;
  return clampBox({ x, y, width: nextWidth, height: nextHeight });
}
