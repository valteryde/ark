import {
  MAX_FLOATING_IMAGES,
  cloneFloatingImages,
  floatingImageBoxSize,
  floatingImagesEqual,
  moveFloatingBox,
  normalizeFloatingImages,
  resizeFloatingBox,
  type FloatingBox,
  type FloatingImageCorner,
} from './floating-image.ts';
import type { FloatingImage } from './types.ts';

const CORNERS: readonly FloatingImageCorner[] = ['nw', 'ne', 'sw', 'se'];

const HANDLE_LABEL: Record<FloatingImageCorner, string> = {
  nw: 'Resize from top left',
  ne: 'Resize from top right',
  sw: 'Resize from bottom left',
  se: 'Resize from bottom right',
};

const FILE_HINT = 'Use a PNG, JPEG, or GIF under 1.5 MB.';

export interface FloatingImageLayer {
  sync(): void;
  selectNone(): void;
  hasSelection(): boolean;
  removeSelected(): void;
  insert(src: string, width: number, height: number): boolean;
  insertFile(file: File): Promise<boolean>;
  destroy(): void;
}

export function mountFloatingImageLayer(opts: {
  gridBody: HTMLElement;
  viewport: HTMLElement;
  rowHeaderWidthPx: number;
  getZoom: () => number;
  getImages: () => readonly FloatingImage[];
  onCommit: (before: readonly FloatingImage[], after: readonly FloatingImage[]) => void;
  showHint: (message: string) => void;
  focusSheet: () => void;
}): FloatingImageLayer {
  const root = document.createElement('div');
  root.className = 'sheet-floating-images';
  root.setAttribute('aria-hidden', 'true');
  opts.gridBody.appendChild(root);

  let selectedId: string | null = null;
  let dragStop: (() => void) | null = null;

  function read(): FloatingImage[] {
    return cloneFloatingImages(opts.getImages());
  }

  function applyBox(frame: HTMLElement, box: FloatingBox): void {
    frame.style.left = `${opts.rowHeaderWidthPx + box.x}px`;
    frame.style.top = `${box.y}px`;
    frame.style.width = `${box.width}px`;
    frame.style.height = `${box.height}px`;
  }

  function updateSelectionChrome(): void {
    for (const frame of root.querySelectorAll<HTMLElement>('.sheet-floating-image')) {
      const on = frame.dataset.imageId === selectedId;
      frame.classList.toggle('sheet-floating-image--selected', on);
      frame.setAttribute('aria-label', on ? 'Selected image' : 'Image');
      for (const handle of frame.querySelectorAll<HTMLButtonElement>('.sheet-floating-image__handle')) {
        handle.hidden = !on;
      }
    }
  }

  function paint(images: readonly FloatingImage[]): void {
    root.replaceChildren();
    for (const image of images) {
      const frame = document.createElement('div');
      frame.className = 'sheet-floating-image';
      frame.dataset.imageId = image.id;
      frame.setAttribute('role', 'img');
      applyBox(frame, image);
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      if (image.src) img.src = image.src;
      frame.appendChild(img);
      for (const corner of CORNERS) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = `sheet-floating-image__handle sheet-floating-image__handle--${corner}`;
        handle.dataset.corner = corner;
        handle.setAttribute('aria-label', HANDLE_LABEL[corner]);
        handle.hidden = true;
        frame.appendChild(handle);
      }
      frame.addEventListener('pointerdown', onPointerDown);
      root.appendChild(frame);
    }
    updateSelectionChrome();
  }

  function sync(): void {
    const images = read();
    if (selectedId && !images.some((image) => image.id === selectedId)) selectedId = null;
    paint(images);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const frame = event.currentTarget as HTMLElement;
    const id = frame.dataset.imageId;
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    opts.focusSheet();
    dragStop?.();

    const images = read();
    const current = images.find((image) => image.id === id);
    if (!current) return;
    const handle = (event.target as HTMLElement | null)?.closest?.(
      '.sheet-floating-image__handle',
    ) as HTMLElement | null;
    const corner = handle?.dataset.corner as FloatingImageCorner | undefined;
    const reordered = images.filter((image) => image.id !== id).concat({ ...current });
    root.appendChild(frame);
    selectedId = id;
    updateSelectionChrome();

    const start: FloatingBox = {
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height,
    };
    const before = images;
    const pointerId = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    let latest: FloatingBox = { ...start };

    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const zoom = opts.getZoom() || 1;
      const dx = (ev.clientX - originX) / zoom;
      const dy = (ev.clientY - originY) / zoom;
      latest = corner
        ? resizeFloatingBox(start, corner, dx, dy, ev.shiftKey)
        : moveFloatingBox(start, dx, dy);
      applyBox(frame, latest);
    };

    const stopListening = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      dragStop = null;
    };

    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      stopListening();
      const after = reordered.map((image) =>
        image.id === id
          ? { ...image, x: latest.x, y: latest.y, width: latest.width, height: latest.height }
          : image,
      );
      if (!floatingImagesEqual(before, after)) opts.onCommit(before, after);
      sync();
    };

    const cancel = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      stopListening();
      sync();
    };

    dragStop = stopListening;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    try {
      frame.setPointerCapture(pointerId);
    } catch {
      /* Pointer capture is missing in some test DOMs. Window listeners still run. */
    }
  }

  function insertionOrigin(): { x: number; y: number } {
    const zoom = opts.getZoom() || 1;
    const x = opts.viewport.scrollLeft / zoom - opts.rowHeaderWidthPx + 16;
    const y = opts.viewport.scrollTop / zoom + 16;
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  }

  function insert(src: string, width: number, height: number): boolean {
    const current = read();
    if (current.length >= MAX_FLOATING_IMAGES) {
      opts.showHint('This sheet already has 20 images.');
      return false;
    }
    const box = floatingImageBoxSize(width, height);
    const origin = insertionOrigin();
    const shift = (current.length % 6) * 16;
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const parsed = normalizeFloatingImages([
      {
        id,
        x: origin.x + shift,
        y: origin.y + shift,
        width: box.width,
        height: box.height,
        src,
      },
    ]);
    const image = parsed[0];
    if (!image?.src) {
      opts.showHint(FILE_HINT);
      return false;
    }
    opts.onCommit(current, current.concat(image));
    selectedId = image.id;
    sync();
    return true;
  }

  function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('read'));
      reader.readAsDataURL(file);
    });
  }

  function naturalSize(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      img.onerror = () => reject(new Error('decode'));
      img.src = src;
    });
  }

  async function insertFile(file: File): Promise<boolean> {
    const type = file.type.toLowerCase();
    const allowed =
      type === 'image/png' ||
      type === 'image/jpeg' ||
      type === 'image/jpg' ||
      type === 'image/pjpeg' ||
      type === 'image/gif';
    if (!allowed || file.size > 1_200_000) {
      opts.showHint(FILE_HINT);
      return false;
    }
    let src = '';
    try {
      src = await readFile(file);
    } catch {
      opts.showHint('Could not read that image.');
      return false;
    }
    let size = { width: 240, height: 240 };
    try {
      const natural = await naturalSize(src);
      size = {
        width: natural.width > 0 ? natural.width : 240,
        height: natural.height > 0 ? natural.height : 240,
      };
    } catch {
      opts.showHint('Could not read that image.');
      return false;
    }
    return insert(src, size.width, size.height);
  }

  sync();

  return {
    sync,
    selectNone() {
      if (!selectedId) return;
      selectedId = null;
      updateSelectionChrome();
    },
    hasSelection() {
      return selectedId !== null;
    },
    removeSelected() {
      if (!selectedId) return;
      const before = read();
      const after = before.filter((image) => image.id !== selectedId);
      selectedId = null;
      if (!floatingImagesEqual(before, after)) opts.onCommit(before, after);
      sync();
    },
    insert,
    insertFile,
    destroy() {
      dragStop?.();
      root.remove();
    },
  };
}
