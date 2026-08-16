/**
 * shape-border.ts — "which cells are the border?" for ANY canvas shape.
 *
 * WHY THIS EXISTS
 * A border used to be a rectangle ring regardless of canvas shape, which is
 * exactly why borders were broken on circle/oval/stocking/brick: the ring had
 * no relationship to the stitchable region, so it either escaped the shape
 * (painted outside it) or cut straight through it.
 *
 * The fix: stop insetting a rectangle, and inset the SHAPE. A multi-source
 * BFS inward from the shape's own boundary gives every stitchable cell its
 * distance from the edge (`edgeDepthMap`). A border of width w is then
 * "every stitchable cell with depth < w" — correct for any shape, and it
 * degenerates to exactly the existing rectangle ring on a rectangular canvas
 * (see the equivalence tests: a 5x5 grid at bandCount 1 produces precisely
 * the classic 16-cell ring).
 *
 * 4-CONNECTIVITY, NOT 8. An 8-connected ring leaves diagonal pinholes — the
 * same defect class already logged elsewhere against thin diagonal features.
 * A border is a physical barrier that must not let anything leak through a
 * diagonal gap, so the BFS here only ever steps N/S/E/W.
 *
 * `NOT_STITCHABLE` / `NOT_STITCHABLE_NUM` are the same constant exported
 * under both names — different call sites in this feature (this file's own
 * tests vs. the adapter/perimeter modules) were each written against one
 * name, and rather than force one to change, both are provided.
 */

export const NOT_STITCHABLE_NUM = -1;
export const NOT_STITCHABLE = NOT_STITCHABLE_NUM;

export interface ShapeGrid {
  width: number;
  height: number;
  /** Flat, row-major (y*width+x). Any value other than NOT_STITCHABLE_NUM
   *  means "stitchable" — the actual value carries no other meaning here. */
  cells: number[];
}

function isStitchable(grid: ShapeGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
  return grid.cells[y * grid.width + x] !== NOT_STITCHABLE_NUM;
}

/**
 * Multi-source BFS, 4-connected: for every stitchable cell, its distance from
 * the nearest non-stitchable cell OR the grid edge (both count as "outside").
 * Non-stitchable cells get -1.
 *
 * On an unmasked rectangle this is provably identical to
 * `min(x, y, W-1-x, H-1-y)` — "distance to nearest edge" — which is exactly
 * the quantity the legacy rectangle frame code iterated over. That identity
 * is what lets every shaped code path fall back to byte-identical rectangle
 * behaviour rather than merely similar behaviour.
 */
export function edgeDepthMap(grid: ShapeGrid): number[] {
  const { width, height, cells } = grid;
  const depth = new Array<number>(width * height).fill(-1);
  const queue: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (cells[i] === NOT_STITCHABLE_NUM) continue;
      const onBoundary =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        !isStitchable(grid, x - 1, y) ||
        !isStitchable(grid, x + 1, y) ||
        !isStitchable(grid, x, y - 1) ||
        !isStitchable(grid, x, y + 1);
      if (onBoundary) {
        depth[i] = 0;
        queue.push(i);
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    const d = depth[i];
    const neighbours: Array<[number, number]> = [
      [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (cells[ni] === NOT_STITCHABLE_NUM) continue;
      if (depth[ni] !== -1) continue;
      depth[ni] = d + 1;
      queue.push(ni);
    }
  }

  return depth;
}

export interface ShapeBorderResult {
  depth: number[];
  cellCount: number;
  collapsed: boolean;
}

export function buildShapeBorder(grid: ShapeGrid, bandCount: number): ShapeBorderResult {
  if (!Number.isInteger(bandCount) || bandCount < 1) {
    throw new Error(`bandCount must be a positive integer, got ${bandCount}`);
  }

  const full = edgeDepthMap(grid);

  let hasInterior = false;
  for (const d of full) {
    if (d >= bandCount) { hasInterior = true; break; }
  }
  const collapsed = !hasInterior;

  const depth = full.map((d) => (d >= 0 && d < bandCount ? d : -1));
  let cellCount = 0;
  for (const d of depth) if (d !== -1) cellCount++;

  return { depth, cellCount, collapsed };
}

export function interiorAfterBorder(grid: ShapeGrid, bandCount: number): ShapeGrid {
  const depths = edgeDepthMap(grid);
  const cells = grid.cells.map((c, i) =>
    depths[i] >= 0 && depths[i] < bandCount ? NOT_STITCHABLE_NUM : c,
  );
  return { width: grid.width, height: grid.height, cells };
}

export function colourRing(ring: ShapeBorderResult, colours: number[]): number[] {
  return ring.depth.map((d) => {
    if (d < 0 || colours.length === 0) return NOT_STITCHABLE_NUM;
    return colours[Math.min(d, colours.length - 1)];
  });
}
