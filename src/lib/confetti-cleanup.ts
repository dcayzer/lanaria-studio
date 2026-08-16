// Manual confetti cleanup (editing suite, §8.5) — "a finishing convenience
// for the last cell or two, explicitly not a substitute for engine quality."
//
// Distinct from two things already in the codebase:
//   - brush.ts: manual freehand painting. This tool doesn't paint a colour
//     the user chooses; it REMOVES stray leftover pixels by replacing them
//     with whatever colour already surrounds them.
//   - Phase 4 sibling-regularization (chart engine, §2): runs INSIDE
//     generation, recovering gap-broken repeated structure. This tool runs
//     AFTER generation, on demand, in the editing suite, cleaning up whatever
//     small noise survived every automated pass -- a manual, last-ditch pass,
//     not an engine fix.
//
// Reuses flood-fill.ts's regionAt (the same proven flood algorithm Tile
// Fill's region-select and the standalone flood-fill tool already use)
// rather than a new connected-components implementation: findConfetti seeds
// one regionAt call per unvisited cell, marking visited as it goes.

import { regionAt, type FloodFillGrid, type FloodFillOptions } from "./flood-fill";

export interface ConfettiRegion {
  paletteIdx: number;
  /** Flat indices (y*width+x), ascending. */
  cells: number[];
}

/**
 * Scan the WHOLE grid for confetti: every contiguous same-colour region at
 * or below `maxSize` cells. The sentinel colour (e.g. NOT_STITCHABLE, §8.7)
 * is never flagged -- "outside the finished shape" is not confetti, however
 * small a patch of it might be.
 */
export function findConfetti(
  grid: FloodFillGrid,
  maxSize: number,
  options: FloodFillOptions = {},
): ConfettiRegion[] {
  const { cells, width, height } = grid;
  const total = width * height;
  const visited = new Uint8Array(total);
  const regions: ConfettiRegion[] = [];
  for (let i = 0; i < total; i++) {
    if (visited[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    const paletteIdx = cells[i];
    if (options.sentinel != null && paletteIdx === options.sentinel) {
      visited[i] = 1;
      continue;
    }
    const region = regionAt(grid, x, y, options);
    for (const idx of region) visited[idx] = 1;
    if (region.length > 0 && region.length <= maxSize) {
      regions.push({ paletteIdx, cells: region });
    }
  }
  return regions;
}

/**
 * The dominant colour in the ring of cells immediately surrounding `region`
 * (the region's own footprint excluded). Same idea as StitchChart's own
 * dominantNeighbourColor (used for Select/Lasso Move's source-clearing),
 * generalized here to an arbitrary connected cell set rather than only a
 * rectangle, since a confetti region can be any small shape regionAt finds.
 * Returns null (never guesses) if every neighbour is the sentinel or off-grid
 * -- e.g. a stray stitch boxed in on all sides by the non-stitchable mask.
 */
export function dominantSurroundingColour(
  grid: FloodFillGrid,
  region: number[],
  options: { sentinel?: number } = {},
): number | null {
  const { cells, width, height } = grid;
  const inRegion = new Set(region);
  const counts = new Map<number, number>();
  for (const i of region) {
    const x = i % width;
    const y = (i - x) / width;
    const neighbours: Array<[number, number]> = [
      [x, y - 1],
      [x, y + 1],
      [x - 1, y],
      [x + 1, y],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (inRegion.has(n)) continue;
      const val = cells[n];
      if (options.sentinel != null && val === options.sentinel) continue;
      counts.set(val, (counts.get(val) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestCount = -1;
  for (const [val, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = val;
    }
  }
  return best;
}

export interface ConfettiCleanupPlan {
  /** Flat indices whose colour will change, ascending. Empty on a no-op. */
  changed: number[];
  /** Per-changed-index replacement palette index. */
  replacement: Map<number, number>;
  regionsFound: number;
  /** May be less than regionsFound -- a region with no determinable
   *  neighbour is found but left unchanged, not guessed. */
  regionsCleaned: number;
}

/**
 * Plan a full confetti cleanup: every confetti region replaced by its OWN
 * local dominant surrounding colour (not one shared/global colour -- two
 * confetti spots in different parts of the chart can and should clean up
 * differently). Non-mutating -- returns a diff, same "return a diff, don't
 * mutate" convention flood-fill.ts already established, so the result flows
 * through mergeManualEdit and the undo stack like any other manual edit.
 */
export function planConfettiCleanup(
  grid: FloodFillGrid,
  maxSize: number,
  options: FloodFillOptions = {},
): ConfettiCleanupPlan {
  const regions = findConfetti(grid, maxSize, options);
  const replacement = new Map<number, number>();
  let regionsCleaned = 0;
  for (const region of regions) {
    const dom = dominantSurroundingColour(grid, region.cells, options);
    if (dom == null) continue;
    for (const i of region.cells) replacement.set(i, dom);
    regionsCleaned++;
  }
  const changed = [...replacement.keys()].sort((a, b) => a - b);
  return { changed, replacement, regionsFound: regions.length, regionsCleaned };
}

/**
 * Plan cleanup for just the ONE region reachable from (x, y) -- the
 * surgical, click-a-stray-stitch case, as opposed to planConfettiCleanup's
 * whole-canvas pass. Returns null if the clicked cell is the sentinel, the
 * region there exceeds maxSize (a real design area, not confetti -- refuse
 * to touch it rather than guess), or no determinable neighbour exists.
 */
export function planSingleRegionCleanup(
  grid: FloodFillGrid,
  x: number,
  y: number,
  maxSize: number,
  options: FloodFillOptions = {},
): { changed: number[]; replacement: number } | null {
  const region = regionAt(grid, x, y, options);
  if (region.length === 0 || region.length > maxSize) return null;
  const dom = dominantSurroundingColour(grid, region, options);
  if (dom == null) return null;
  return { changed: region, replacement: dom };
}
