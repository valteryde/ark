import { assertEquals } from '@std/assert';
import {
  floatingImageBoxSize,
  floatingImagesForCommit,
  mergeFloatingImages,
  moveFloatingBox,
  normalizeFloatingImages,
  resizeFloatingBox,
} from '../../src/spreadsheet/floating-image.ts';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

Deno.test('normalizeFloatingImages keeps a data URL and drops bad entries', () => {
  const images = normalizeFloatingImages([
    { id: 'pic', x: 1.2, y: 0, width: 40, height: 24, src: PNG },
    { id: 'pic', x: 0, y: 0, width: 40, height: 24, src: PNG },
    { id: 'tiny', x: 0, y: 0, width: 8, height: 40, src: PNG },
    { id: 'svg', x: 0, y: 0, width: 40, height: 24, src: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { id: 'moved', x: 10, y: 4, width: 30, height: 30 },
  ]);
  assertEquals(images, [
    { id: 'pic', x: 1.2, y: 0, width: 40, height: 24, src: PNG },
    { id: 'moved', x: 10, y: 4, width: 30, height: 30 },
  ]);
});

Deno.test('mergeFloatingImages keeps stored bytes when src is omitted', () => {
  const previous = [{ id: 'pic', x: 0, y: 0, width: 40, height: 24, src: PNG }];
  const merged = mergeFloatingImages(previous, [
    { id: 'pic', x: 8, y: 2, width: 40, height: 24 },
  ]);
  assertEquals(merged, [{ id: 'pic', x: 8, y: 2, width: 40, height: 24, src: PNG }]);
  assertEquals(mergeFloatingImages(previous, [{ id: 'new', x: 0, y: 0, width: 40, height: 24 }]), []);
});

Deno.test('floatingImagesForCommit omits unchanged src', () => {
  const before = [{ id: 'pic', x: 0, y: 0, width: 40, height: 24, src: PNG }];
  const after = [{ id: 'pic', x: 6, y: 0, width: 40, height: 24, src: PNG }];
  assertEquals(floatingImagesForCommit(before, after), [
    { id: 'pic', x: 6, y: 0, width: 40, height: 24 },
  ]);
  assertEquals(
    floatingImagesForCommit([], [{ id: 'pic', x: 0, y: 0, width: 40, height: 24, src: PNG }]),
    [{ id: 'pic', x: 0, y: 0, width: 40, height: 24, src: PNG }],
  );
});

Deno.test('floatingImageBoxSize caps the long side and enforces the minimum', () => {
  assertEquals(floatingImageBoxSize(480, 240), { width: 240, height: 120 });
  assertEquals(floatingImageBoxSize(10, 10), { width: 24, height: 24 });
  assertEquals(floatingImageBoxSize(40, 30), { width: 40, height: 30 });
});

Deno.test('move and resize stay inside the sheet box', () => {
  assertEquals(moveFloatingBox({ x: 10, y: 10, width: 40, height: 30 }, -40, 5), {
    x: 0,
    y: 15,
    width: 40,
    height: 30,
  });
  assertEquals(
    resizeFloatingBox({ x: 10, y: 10, width: 100, height: 50 }, 'se', 100, 0, false),
    { x: 10, y: 10, width: 200, height: 50 },
  );
  assertEquals(
    resizeFloatingBox({ x: 10, y: 10, width: 100, height: 50 }, 'se', 100, 0, true),
    { x: 10, y: 10, width: 200, height: 100 },
  );
  assertEquals(
    resizeFloatingBox({ x: 10, y: 10, width: 100, height: 50 }, 'nw', 10, 10, false),
    { x: 20, y: 20, width: 90, height: 40 },
  );
});
