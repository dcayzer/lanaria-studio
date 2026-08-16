// Flood fill (editing suite, §14) -- the genuinely-missing "true flood fill".
//
// Confirmed against the real StitchChart.tsx: existing "Background Fill" only
// fills a manually-selected region, and paint is one cell at a time. This is
// the click-a-cell -> fill the contiguous same-colour area tool.
//
// Design choices, matching the codebase:
//   - Operates on the flat palette-index grid (the real chart cells are a
//     Uint16Array of palette indices, §11.8), addressed as cells[y*width + x].
//   - NON-MUTATING: returns the set of changed flat indices. A fill is a
//     manual edit, so handing back a diff lets it flow through mergeManualEdit
//     (§11.9) and StitchChart's undo stack instead of destructively stamping.
//   - The NOT_STITCHABLE sentinel (§8.7) is an automatic barrier: fills never
//     cross it and never fill it, because a barrier cell never equals the
//     target colour. Passing it explicitly also guards against filling WITH it.
//   - Iterative (explicit stack, visited bitmap) -- no recursion, so a
//     whole-background fill on a large chart can't blow the call stack.
//   - 4-connected by default (how tent-stitch cells tile); 8 available.

export interface FloodFillGrid {
  /** Row-major palette indices, length width*height. Not mutated. */
  cells: ArrayLike<number>;
  width: number;
  height: number;
}

export interface FloodFillOptions {
  connectivity?: 4 | 8;
  /** Cells equal to this value are barriers (e.g. NOT_STITCHABLE, §8.7). */
  sentinel?: number;
}

export interface FloodFillResult {
  /** The colour that was under the start cell. */
  target: number;
  replacement: number;
  /** Flat indices whose colour changes, ascending. Empty on a no-op. */
  changed: number[];
  width: number;
  height: number;
}

function idx(x: number, y: number, width: number): number {
  return y * width + x;
}

/** The contiguous same-colour region reachable from (startX,startY), as flat
 *  indices. Shared by floodFill and usable on its own as "select this area". */
export function regionAt(
  grid: FloodFillGrid,
  startX: number,
  startY: number,
  options: FloodFillOptions = {},
): number[] {
  const { cells, width, height } = grid;
  const connectivity = options.connectivity ?? 4;
  const sentinel = options.sentinel;

  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return [];
  const start = idx(startX, startY, width);
  const target = cells[start];
  if (sentinel != null && target === sentinel) return []; // clicked a barrier

  const visited = new Uint8Array(width * height);
  const region: number[] = [];
  const stack: number[] = [start];
  visited[start] = 1;

  const neighbours4 = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
  ];
  const neighbours8 = [
    ...neighbours4, [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];
  const offsets = connectivity === 8 ? neighbours8 : neighbours4;

  while (stack.length > 0) {
    const p = stack.pop()!;
    region.push(p);
    const px = p % width;
    const py = (p - px) / width;
    for (const [dx, dy] of offsets) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = idx(nx, ny, width);
      if (visited[n]) continue;
      if (cells[n] !== target) continue; // barrier/sentinel/other colour
      visited[n] = 1;
      stack.push(n);
    }
  }
  region.sort((a, b) => a - b);
  return region;
}

/** Compute the flood fill without mutating the grid. */
export function floodFill(
  grid: FloodFillGrid,
  startX: number,
  startY: number,
  replacement: number,
  options: FloodFillOptions = {},
): FloodFillResult {
  const { cells, width, height } = grid;
  const start =
    startX < 0 || startY < 0 || startX >= width || startY >= height
      ? -1
      : idx(startX, startY, width);
  const target = start === -1 ? NaN : cells[start];

  if (options.sentinel != null && replacement === options.sentinel) {
    throw new Error("floodFill: replacement colour equals the NOT_STITCHABLE sentinel.");
  }

  // No-op fast paths: out of bounds, or filling a colour with itself.
  if (start === -1 || target === replacement) {
    return { target, replacement, changed: [], width, height };
  }
  const changed = regionAt(grid, startX, startY, options);
  return { target, replacement, changed, width, height };
}

/** Apply a fill result into a MUTABLE cells buffer (e.g. a copied Uint16Array).
 *  Only the changed indices are written -- everything else is untouched, which
 *  is exactly what mergeManualEdit (§11.9) needs to diff cleanly. */
export function applyFloodFill<T extends { [i: number]: number }>(
  cells: T,
  result: FloodFillResult,
): T {
  for (const i of result.changed) cells[i] = result.replacement;
  return cells;
}

/** Convenience: build a FloodFillGrid from a row-major number[][]. */
export function gridFrom2D(rows: number[][]): FloodFillGrid {
  const height = rows.length;
  const width = height > 0 ? rows[0].length : 0;
  const cells = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    if (rows[y].length !== width) throw new Error("gridFrom2D: ragged rows");
    for (let x = 0; x < width; x++) cells[idx(x, y, width)] = rows[y][x];
  }
  return { cells, width, height };
}
