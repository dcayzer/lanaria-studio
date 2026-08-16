import {
  edgeDepthMap,
  interiorAfterBorder,
  NOT_STITCHABLE_NUM,
  type ShapeGrid,
} from "./shape-border.ts";
import {
  buildPerimeterPath,
  canUseDirectionalRepeat,
  distributeRepeats,
  type PathPoint,
} from "./perimeter-path.ts";

export function maskToShapeGrid(
  mask: boolean[][] | null | undefined,
  gridW: number,
  gridH: number,
): ShapeGrid {
  const cells = new Array<number>(gridW * gridH).fill(0);
  if (mask) {
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (!mask[y]?.[x]) cells[y * gridW + x] = NOT_STITCHABLE_NUM;
      }
    }
  }
  return { width: gridW, height: gridH, cells };
}

export function isUnrestricted(grid: ShapeGrid): boolean {
  for (let i = 0; i < grid.cells.length; i++) {
    if (grid.cells[i] === NOT_STITCHABLE_NUM) return false;
  }
  return true;
}

export function shapedFrameCells(
  depths: number[],
  gridW: number,
  gridH: number,
  inset: number,
  thickness: number,
  isRectangle: boolean = false,
): PathPoint[] {
  let maxDepth = -1;
  for (let i = 0; i < depths.length; i++) { if (depths[i] > maxDepth) maxDepth = depths[i]; }
  const band = isRectangle ? thickness : Math.max(2, thickness);
  const out: PathPoint[] = [];
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const d = depths[y * gridW + x];
      if (d < 0) continue;
      if (d >= inset && d < inset + band && d < maxDepth) out.push({ x, y });
    }
  }
  return out;
}

export interface AccentPlacement { points: PathPoint[]; collapsed: boolean; }

export function accentsAroundShape(
  grid: ShapeGrid,
  inset: number,
  count: number,
): AccentPlacement {
  if (count < 1) return { points: [], collapsed: false };
  const inner = inset > 0 ? interiorAfterBorder(grid, inset) : grid;
  const path = buildPerimeterPath(inner);
  if (path.length === 0) return { points: [], collapsed: true };
  const step = path.length / count;
  const points: PathPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push(path.points[Math.round(i * step) % path.length]);
  }
  return { points, collapsed: false };
}

export interface StampRun { points: PathPoint[]; tooShort: boolean; axisAligned: boolean; }

export function stampsAroundShape(
  grid: ShapeGrid,
  inset: number,
  pitch: number,
): StampRun {
  const inner = inset > 0 ? interiorAfterBorder(grid, inset) : grid;
  const path = buildPerimeterPath(inner);
  if (path.length === 0) return { points: [], tooShort: true, axisAligned: false };
  const axisAligned = canUseDirectionalRepeat(path);
  const dist = distributeRepeats(path, Math.max(1, Math.round(pitch)));
  return { points: dist.placements.map((p) => p.at), tooShort: dist.tooShort, axisAligned };
}

export function depthsForMask(
  mask: boolean[][] | null | undefined,
  gridW: number,
  gridH: number,
): { grid: ShapeGrid; depths: number[]; unrestricted: boolean } {
  const grid = maskToShapeGrid(mask, gridW, gridH);
  const unrestricted = isUnrestricted(grid);
  return { grid, depths: edgeDepthMap(grid), unrestricted };
}
