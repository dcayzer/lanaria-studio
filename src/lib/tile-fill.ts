// Tile fill — repeat a small motif's native-scale cells across an area,
// instead of the single centred placement motifToLayer gives you (see
// motif-library.ts). This is for scale-preserving pattern fills, e.g.
// stamping a leopard print at its charted density across a whole stocking
// rather than stretching one instance to fit.
//
// Reuses flood-fill.ts's regionAt for region-constrained fills (so a
// same-colour area on the CURRENT chart could be tile-filled, not just the
// whole canvas -- not yet wired to any UI, see tileFillRegion) and
// layer-model.ts's makeLayer/Layer so the result composites through the
// exact same applyLayersToChart pipeline as every other layer -- no new
// compositing code needed.

import { regionAt, type FloodFillGrid } from "./flood-fill";
import { makeLayer, type Layer } from "./layer-model";

export interface TileMotifSource {
  cells: string[][];
  width: number;
  height: number;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * Shrink a motif by an integer factor N: each output cell is the dominant
 * (most-common) value in the corresponding NxN source block. Ties are broken
 * deterministically by first-seen order in a fixed row-major scan of the
 * block, so the same input always yields the same output.
 *
 * Transparency preservation: the sentinel participates in the vote like any
 * other value, so a block that is ENTIRELY sentinel yields sentinel (gaps
 * survive shrinking), and a mixed block still picks the true majority (which
 * may be sentinel if the block is mostly transparent, or a real colour if
 * the real colour dominates -- exactly the behaviour hand-charted motifs
 * with feathered edges want).
 *
 * If the motif is smaller than N in either dimension, the output is clamped
 * to a minimum 1x1 rather than collapsing to empty. In that clamp case the
 * single output cell votes over the ENTIRE source (all cells).
 */
export function downsampleMotif(
  motif: TileMotifSource,
  factor: number,
): TileMotifSource {
  const N = Math.max(1, Math.round(factor));
  if (N === 1) return { cells: motif.cells.map((r) => r.slice()), width: motif.width, height: motif.height };
  const outW = Math.max(1, Math.floor(motif.width / N));
  const outH = Math.max(1, Math.floor(motif.height / N));
  const cells: string[][] = [];
  for (let by = 0; by < outH; by++) {
    const row: string[] = new Array(outW);
    for (let bx = 0; bx < outW; bx++) {
      // Source block extents. Normal case: NxN starting at (bx*N, by*N).
      // Clamp case (motif smaller than N in a dim): cover the whole axis.
      const x0 = motif.width < N ? 0 : bx * N;
      const y0 = motif.height < N ? 0 : by * N;
      const x1 = motif.width < N ? motif.width : Math.min(motif.width, x0 + N);
      const y1 = motif.height < N ? motif.height : Math.min(motif.height, y0 + N);
      const counts = new Map<string, number>();
      const order: string[] = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = motif.cells[y][x];
          const c = counts.get(v);
          if (c === undefined) {
            counts.set(v, 1);
            order.push(v);
          } else {
            counts.set(v, c + 1);
          }
        }
      }
      let best = order[0];
      let bestCount = counts.get(best) ?? 0;
      for (let i = 1; i < order.length; i++) {
        const v = order[i];
        const c = counts.get(v)!;
        if (c > bestCount) {
          best = v;
          bestCount = c;
        }
        // Ties: keep earlier-seen (already in `best`), do nothing.
      }
      row[bx] = best;
    }
    cells.push(row);
  }
  return { cells, width: outW, height: outH };
}

/**
 * Interpret `scale` as either an integer upscale (>=1) or a 1/N fractional
 * downscale (0 < scale < 1, where 1/scale is a positive integer, e.g. 0.5,
 * 1/3). Returns the effective source motif and the integer upscale to apply
 * to it. Downscale is handled by shrinking the motif via `downsampleMotif`
 * FIRST, then tiling the result at scale 1 -- so the seamless-wraparound
 * and region-masking loop below is completely reused and the two paths
 * never fight in the same code.
 */
function resolveScale(
  motif: TileMotifSource,
  scale: number,
): { motif: TileMotifSource; upscale: number } {
  if (scale >= 1) return { motif, upscale: Math.max(1, Math.round(scale)) };
  if (scale <= 0) return { motif, upscale: 1 };
  const N = Math.round(1 / scale);
  if (N >= 2 && Math.abs(1 / N - scale) < 1e-6) {
    return { motif: downsampleMotif(motif, N), upscale: 1 };
  }
  // Non-1/N fractional -- not supported; fall back to native.
  return { motif, upscale: 1 };
}

/**
 * Build a full-canvas-sized layer that repeats `motif` at its native scale,
 * anchored to canvas (0,0) by default -- so multiple disjoint regions tile
 * seamlessly as if it were one continuous print, rather than each region
 * getting its own independently-phased copy. Cells outside `region` (when
 * not "all") are the sentinel, so they don't paint. Cells inside the region
 * that land on the motif's OWN sentinel also pass through as sentinel -- a
 * motif with transparent gaps still lets whatever's beneath show through.
 */
export function buildTileFillLayer(
  id: string,
  motif: TileMotifSource,
  canvasW: number,
  canvasH: number,
  region: ReadonlySet<number> | "all",
  sentinel: string,
  origin: { x: number; y: number } = { x: 0, y: 0 },
  scale: number = 1,
): Layer {
  if (motif.width <= 0 || motif.height <= 0) {
    throw new Error("buildTileFillLayer: motif must have positive dimensions");
  }
  // Fractional downscale (e.g. scale=0.5) is handled as a pre-step: shrink
  // the motif via dominant-colour block sampling, then tile at scale 1. The
  // integer-upscale path below is unchanged for scale >= 1 -- see resolveScale.
  const { motif: effMotif, upscale: s } = resolveScale(motif, scale);
  const periodW = effMotif.width * s;
  const periodH = effMotif.height * s;
  const cells: string[][] = [];
  for (let y = 0; y < canvasH; y++) {
    const row: string[] = new Array(canvasW);
    for (let x = 0; x < canvasW; x++) {
      if (region !== "all" && !region.has(y * canvasW + x)) {
        row[x] = sentinel;
        continue;
      }
      const px = mod(x - origin.x, periodW);
      const py = mod(y - origin.y, periodH);
      const sx = Math.floor(px / s);
      const sy = Math.floor(py / s);
      row[x] = effMotif.cells[sy][sx];
    }
    cells.push(row);
  }
  return makeLayer({ id, kind: "motif", cells, offset: { x: 0, y: 0 }, scale: 1 });
}

/** Tile-fill the ENTIRE canvas with `motif` at the given integer scale (default native, 1x). */
export function tileFillWholeCanvas(
  id: string,
  motif: TileMotifSource,
  canvasW: number,
  canvasH: number,
  sentinel: string,
  origin?: { x: number; y: number },
  scale?: number,
): Layer {
  return buildTileFillLayer(id, motif, canvasW, canvasH, "all", sentinel, origin, scale);
}

/**
 * Tile-fill the contiguous same-value region of `chartGrid` reachable from
 * (startX, startY) -- e.g. click inside one colour area of a generated
 * design to tile-fill just that area, leaving the rest of the chart alone.
 * Returns null if the click point is out of bounds or hits a barrier
 * (matching flood-fill.ts's own no-op convention). NOT YET WIRED to any UI
 * -- needs a click-to-pick-a-point interaction added to the canvas first.
 */
export function tileFillRegion(
  id: string,
  motif: TileMotifSource,
  chartGrid: FloodFillGrid,
  startX: number,
  startY: number,
  canvasW: number,
  canvasH: number,
  sentinel: string,
  floodOptions?: { connectivity?: 4 | 8; sentinel?: number },
  origin?: { x: number; y: number },
  scale?: number,
): Layer | null {
  const region = regionAt(chartGrid, startX, startY, floodOptions);
  if (region.length === 0) return null;
  return buildTileFillLayer(id, motif, canvasW, canvasH, new Set(region), sentinel, origin, scale);
}
