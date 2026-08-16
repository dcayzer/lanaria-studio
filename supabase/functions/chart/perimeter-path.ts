import { NOT_STITCHABLE_NUM, type ShapeGrid } from "./shape-border.ts";

export interface PathPoint { x: number; y: number; }
export interface PerimeterPath { points: PathPoint[]; length: number; corners: number[]; }

const MOORE: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
];

function stitchable(grid: ShapeGrid, x: number, y: number, sentinel: number): boolean {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
  return grid.cells[y * grid.width + x] !== sentinel;
}

export function tracePerimeter(
  grid: ShapeGrid,
  sentinel: number = NOT_STITCHABLE_NUM,
): PathPoint[] {
  let start: PathPoint | null = null;
  outer: for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (stitchable(grid, x, y, sentinel)) { start = { x, y }; break outer; }
    }
  }
  if (!start) return [];

  const neighbourCount = MOORE.filter(([dx, dy]) =>
    stitchable(grid, start!.x + dx, start!.y + dy, sentinel),
  ).length;
  if (neighbourCount === 0) return [{ ...start }];

  const points: PathPoint[] = [];
  let current = { ...start };
  let backtrack = { x: start.x - 1, y: start.y };
  const firstStep = { p: `${current.x},${current.y}`, b: `${backtrack.x},${backtrack.y}` };
  let steps = 0;
  const maxSteps = grid.width * grid.height * 8;

  do {
    points.push({ ...current });
    const bIndex = MOORE.findIndex(
      ([dx, dy]) => current.x + dx === backtrack.x && current.y + dy === backtrack.y,
    );
    const from = bIndex === -1 ? 0 : bIndex;
    let found = false;
    for (let k = 1; k <= MOORE.length; k++) {
      const idx = (from + k) % MOORE.length;
      const [dx, dy] = MOORE[idx];
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (stitchable(grid, nx, ny, sentinel)) {
        const prevIdx = (idx - 1 + MOORE.length) % MOORE.length;
        backtrack = { x: current.x + MOORE[prevIdx][0], y: current.y + MOORE[prevIdx][1] };
        current = { x: nx, y: ny };
        found = true;
        break;
      }
    }
    if (!found) break;
    steps++;
    if (steps > maxSteps) break;
  } while (
    !(`${current.x},${current.y}` === firstStep.p && `${backtrack.x},${backtrack.y}` === firstStep.b)
  );

  return points;
}

export function detectCorners(
  points: PathPoint[],
  window: number = 3,
  thresholdDegrees: number = 60,
): number[] {
  const n = points.length;
  if (n < window * 2 + 1) return [];
  const corners: number[] = [];
  const threshold = (thresholdDegrees * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const before = points[(i - window + n) % n];
    const after = points[(i + window) % n];
    const inX = points[i].x - before.x;
    const inY = points[i].y - before.y;
    const outX = after.x - points[i].x;
    const outY = after.y - points[i].y;
    if ((inX === 0 && inY === 0) || (outX === 0 && outY === 0)) continue;
    const angleIn = Math.atan2(inY, inX);
    const angleOut = Math.atan2(outY, outX);
    let turn = Math.abs(angleOut - angleIn);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn >= threshold) corners.push(i);
  }
  const merged: number[] = [];
  for (const c of corners) {
    const last = merged[merged.length - 1];
    if (last === undefined || c - last > window) merged.push(c);
  }
  if (merged.length > 1 && merged[0] + points.length - merged[merged.length - 1] <= window) {
    merged.pop();
  }
  return merged;
}

export function buildPerimeterPath(
  grid: ShapeGrid,
  sentinel: number = NOT_STITCHABLE_NUM,
): PerimeterPath {
  const points = tracePerimeter(grid, sentinel);
  return { points, length: points.length, corners: detectCorners(points) };
}

export interface RepeatPlacement { index: number; at: PathPoint; }
export interface DistributionResult {
  placements: RepeatPlacement[];
  count: number;
  remainder: number;
  tooShort: boolean;
}

export function distributeRepeats(
  path: PerimeterPath,
  repeatWidth: number,
): DistributionResult {
  if (!Number.isInteger(repeatWidth) || repeatWidth < 1) {
    throw new Error(`repeatWidth must be a positive integer, got ${repeatWidth}`);
  }
  const total = path.length;
  const count = Math.floor(total / repeatWidth);
  if (count < 1) return { placements: [], count: 0, remainder: total, tooShort: true };
  const remainder = total - count * repeatWidth;
  const placements: RepeatPlacement[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    placements.push({ index: cursor, at: path.points[cursor] });
    // Spread the remainder evenly along the path instead of front-loading
    // every widened gap at the trace start (measured: 7 consecutive 10-cell
    // gaps then 17 9-cell gaps on a 232-cell circle -- visibly bunched).
    cursor += repeatWidth + (Math.floor(((i + 1) * remainder) / count) - Math.floor((i * remainder) / count));
  }
  return { placements, count, remainder, tooShort: false };
}

export function canUseDirectionalRepeat(path: PerimeterPath): boolean {
  if (path.points.length < 8) return false;
  let axisAligned = 0;
  for (let i = 0; i < path.points.length; i++) {
    const a = path.points[i];
    const b = path.points[(i + 1) % path.points.length];
    if (a.x === b.x || a.y === b.y) axisAligned++;
  }
  return axisAligned / path.points.length >= 0.95;
}
