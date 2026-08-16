// Line + rectangle tools (editing suite, §15.4 item 4).
//
// Completes the paint-primitive set alongside brush.ts (freehand) and
// flood-fill.ts (contiguous fill): draw a straight line between two cells, or
// a rectangle (outline or filled) from two corners -- the click-start /
// drag-to-end interaction every pixel-art editor has.
//
// Same conventions as flood-fill.ts:
//   - Grid coords -> flat indices (y*width + x); dims passed explicitly.
//   - NON-MUTATING: returns the covered cells so a shape flows through
//     mergeManualEdit (§11.9) and undo instead of stamping destructively.
//   - The NOT_STITCHABLE sentinel (§8.7) is skipped when a cells buffer +
//     sentinel are supplied, so a shape never paints outside the canvas shape.
//   - Thickness reuses a square footprint by default (what needlepoint wants);
//     round is available. This mirrors brush.ts's footprint idea; if you'd
//     rather share brush.ts's exact footprint, swap footprintOffsets for it.

export interface Point { x: number; y: number; }
export interface GridDims { width: number; height: number; }

export interface ShapeOptions {
  /** Line/outline thickness in cells (default 1). */
  thickness?: number;
  /** Footprint shape when thickness > 1 (default "square"). */
  footprint?: "square" | "round";
  /** Optional cells buffer; when given with `sentinel`, sentinel cells are
   *  skipped so the shape can't paint outside a non-rectangular canvas. */
  cells?: ArrayLike<number>;
  sentinel?: number;
}

export interface ShapeResult {
  /** Covered flat indices, ascending, de-duplicated, in-bounds. */
  cells: number[];
  width: number;
  height: number;
}

function idx(x: number, y: number, width: number): number { return y * width + x; }

/** Offsets for a size-N footprint centred (with a top-left bias on even N). */
export function footprintOffsets(size: number, shape: "square" | "round"): Point[] {
  const s = Math.max(1, Math.floor(size));
  if (s === 1) return [{ x: 0, y: 0 }];
  const lo = -Math.floor((s - 1) / 2);
  const hi = lo + s - 1;
  const r = (s - 1) / 2;
  const out: Point[] = [];
  for (let dy = lo; dy <= hi; dy++) {
    for (let dx = lo; dx <= hi; dx++) {
      if (shape === "round" && dx * dx + dy * dy > r * r + 1e-9) continue;
      out.push({ x: dx, y: dy });
    }
  }
  return out;
}

/** Integer grid line between two points (Bresenham). */
export function bresenham(a: Point, b: Point): Point[] {
  let x0 = Math.round(a.x), y0 = Math.round(a.y);
  const x1 = Math.round(b.x), y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  const pts: Point[] = [];
  // guard against pathological infinite loops
  const limit = dx + dy + 2;
  for (let i = 0; i <= limit; i++) {
    pts.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return pts;
}

/** Collect a set of grid points into sorted, unique, in-bounds, non-sentinel
 *  flat indices, expanding each point by the given footprint. */
function collect(points: Point[], dims: GridDims, opts: ShapeOptions): number[] {
  const { width, height } = dims;
  const thickness = opts.thickness ?? 1;
  const foot = thickness > 1 ? footprintOffsets(thickness, opts.footprint ?? "square") : [{ x: 0, y: 0 }];
  const seen = new Set<number>();
  for (const p of points) {
    for (const f of foot) {
      const x = p.x + f.x, y = p.y + f.y;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = idx(x, y, width);
      if (opts.cells && opts.sentinel != null && opts.cells[i] === opts.sentinel) continue;
      seen.add(i);
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** Straight line from a to b. */
export function lineCells(a: Point, b: Point, dims: GridDims, opts: ShapeOptions = {}): ShapeResult {
  return { cells: collect(bresenham(a, b), dims, opts), width: dims.width, height: dims.height };
}

/** Rectangle from two opposite corners. mode "outline" (border only, the
 *  default) or "filled" (solid). Corners may be given in any order. */
export function rectCells(
  a: Point,
  b: Point,
  dims: GridDims,
  mode: "outline" | "filled" = "outline",
  opts: ShapeOptions = {},
): ShapeResult {
  const x0 = Math.min(Math.round(a.x), Math.round(b.x));
  const x1 = Math.max(Math.round(a.x), Math.round(b.x));
  const y0 = Math.min(Math.round(a.y), Math.round(b.y));
  const y1 = Math.max(Math.round(a.y), Math.round(b.y));
  const pts: Point[] = [];
  if (mode === "filled") {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pts.push({ x, y });
  } else {
    for (let x = x0; x <= x1; x++) { pts.push({ x, y: y0 }); pts.push({ x, y: y1 }); }
    for (let y = y0; y <= y1; y++) { pts.push({ x: x0, y }); pts.push({ x: x1, y }); }
  }
  return { cells: collect(pts, dims, opts), width: dims.width, height: dims.height };
}

// Even-odd ray-casting point-in-polygon test, same algorithm already used in
// canvas-shape-mask.ts's shapeMask() -- proven correct there, reused here.
function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Circle/ellipse inscribed in the bounding box of two opposite corners --
 * same drag interaction as rectCells. A square box gives a true circle; a
 * non-square box gives an ellipse, which is a legitimate bonus rather than a
 * defect (a stitcher may well want an oval).
 *
 * Built entirely out of the proven `bresenham` line rasterizer: sample points
 * around the ellipse curve, connect each consecutive pair with a bresenham
 * segment. A bresenham segment between two points can never have a gap, so
 * neither can a ring built entirely out of them -- this sidesteps the same
 * connectivity-gap failure class already found in the border-geometry work
 * (a 4-connected boundary can have real, measured gaps on a diagonal).
 */
export function ellipseCells(
  a: Point, b: Point, dims: GridDims,
  mode: "outline" | "filled" = "outline", opts: ShapeOptions = {},
): ShapeResult {
  const x0 = Math.min(Math.round(a.x), Math.round(b.x));
  const x1 = Math.max(Math.round(a.x), Math.round(b.x));
  const y0 = Math.min(Math.round(a.y), Math.round(b.y));
  const y1 = Math.max(Math.round(a.y), Math.round(b.y));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.max(0.5, (x1 - x0) / 2);
  const ry = Math.max(0.5, (y1 - y0) / 2);

  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))); // Ramanujan approx.
  const samples = Math.max(24, Math.ceil(perimeter * 1.5));
  const ring: Point[] = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    ring.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }

  if (mode === "filled") {
    const pts: Point[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointInPolygon(x + 0.5, y + 0.5, ring)) pts.push({ x, y });
      }
    }
    return { cells: collect(pts, dims, opts), width: dims.width, height: dims.height };
  }

  const pts: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    pts.push(...bresenham(ring[i], ring[(i + 1) % ring.length]));
  }
  return { cells: collect(pts, dims, opts), width: dims.width, height: dims.height };
}

/** Isoceles triangle inscribed in the bounding box of two opposite corners:
 *  apex at top-centre, base along the bottom edge. A 2-point drag defines a
 *  box, not 3 independent vertices, so this is the natural triangle for the
 *  same interaction rectCells/circleCells use. mode "outline" (default) or
 *  "filled". */
export function triangleCells(
  a: Point,
  b: Point,
  dims: GridDims,
  mode: "outline" | "filled" = "outline",
  opts: ShapeOptions = {},
): ShapeResult {
  const x0 = Math.min(Math.round(a.x), Math.round(b.x));
  const x1 = Math.max(Math.round(a.x), Math.round(b.x));
  const y0 = Math.min(Math.round(a.y), Math.round(b.y));
  const y1 = Math.max(Math.round(a.y), Math.round(b.y));
  const apex: Point = { x: (x0 + x1) / 2, y: y0 };
  const baseL: Point = { x: x0, y: y1 };
  const baseR: Point = { x: x1, y: y1 };

  if (mode === "outline") {
    const edges = [...bresenham(apex, baseL), ...bresenham(baseL, baseR), ...bresenham(baseR, apex)];
    return { cells: collect(edges, dims, opts), width: dims.width, height: dims.height };
  }

  // Filled: standard edge-function/sign test per cell -- robust even for a
  // degenerate (zero-height or zero-width) drag.
  const sign = (p1: Point, p2: Point, p3: Point) =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const inside = (x: number, y: number) => {
    const p = { x, y };
    const d1 = sign(p, apex, baseL);
    const d2 = sign(p, baseL, baseR);
    const d3 = sign(p, baseR, apex);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  const pts: Point[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (inside(x, y)) pts.push({ x, y });
    }
  }
  return { cells: collect(pts, dims, opts), width: dims.width, height: dims.height };
}

/** Write a shape's cells into a MUTABLE cells buffer with a colour. Mirrors
 *  applyFloodFill: only the shape's cells change, so mergeManualEdit diffs it
 *  cleanly. Returns the buffer for chaining. */
export function applyShape<T extends { [i: number]: number }>(
  cells: T,
  shape: ShapeResult,
  colour: number,
): T {
  for (const i of shape.cells) cells[i] = colour;
  return cells;
}
