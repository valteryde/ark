/**
 * Excel/Sheets-style "jump to edge" used by Ctrl/Cmd+Arrow along a single axis.
 *
 * Given the current position and an occupancy predicate over 1D indices, returns
 * the index the cursor should land on when travelling toward `limit` in `step`
 * increments:
 * - From a blank cell: jump to the next occupied cell (or `limit` if none).
 * - From an occupied cell with an occupied neighbor: jump to the end of that run.
 * - From an occupied cell with a blank neighbor: jump to the next occupied cell
 *   (or `limit` if none).
 */
export function jumpToEdge(
  start: number,
  limit: number,
  step: 1 | -1,
  isOccupied: (index: number) => boolean,
): number {
  const before = (a: number, b: number): boolean => (step > 0 ? a <= b : a >= b);
  const past = (a: number, b: number): boolean => (step > 0 ? a > b : a < b);

  if (!isOccupied(start)) {
    let j = start + step;
    while (before(j, limit)) {
      if (isOccupied(j)) return j;
      j += step;
    }
    return limit;
  }

  const neighbor = start + step;
  if (past(neighbor, limit)) return start;

  if (isOccupied(neighbor)) {
    let j = neighbor;
    while (true) {
      const next = j + step;
      if (past(next, limit)) return j;
      if (!isOccupied(next)) return j;
      j = next;
    }
  }

  let j = neighbor;
  while (before(j, limit)) {
    if (isOccupied(j)) return j;
    j += step;
  }
  return limit;
}
