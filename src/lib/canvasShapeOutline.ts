// Canvas shape outline — the drawn cut/finish line for non-rectangular shapes.
//
// This is a DISPLAY annotation only. The chart grid stays rectangular; this
// simply draws the shape's boundary (in the Tessella olive) over the canvas so
// the stitcher can see the finished outline within the rectangular chart. It is
// NOT charted into cells and does not affect the palette, thread counts, or the
// image sent to the chart engine.
//
// Geometry is expressed in FRACTIONAL coordinates [0..1] x [0..1] of the
// bounding grid, so the same path serves both the low-res preview and the
// full-resolution chart canvas: multiply x by the drawn width, y by the drawn
// height. A single geometry source keeps preview and chart identical.

import type { CanvasShape } from "./canvasShapes";

export const TESSELLA_OLIVE = "#3B4F35";

export type Point = readonly [number, number];

// ---------------------------------------------------------------------------
// Stocking geometry — MEASURED, not parametric.
//
// Traced directly from a real stocking product photo (Hunt & Hope, IG
// @huntandhope): the fabric was colour-segmented from the background, motif
// holes filled, the boundary smoothed (morphological closing/opening to
// remove weave-texture noise and one artifact spike from the hanging-loop
// cord bleeding into the green threshold), then contour-traced and simplified.
// Cross-checked by re-overlaying the traced polygon on the source photo.
//
// Points are normalised to the silhouette's own bounding box: x in [0,1]
// (0 = back/heel side, 1 = toe tip), y in [0,1] (0 = cuff top, 1 = sole,
// lowest point). STOCKING_ASPECT is that bounding box's measured width/height
// ratio. The stocking is scaled UNIFORMLY (one free dimension only — see
// isSingleDimension) rather than letting width/height be set independently,
// so the traced proportions are never distorted.
// ---------------------------------------------------------------------------
export const STOCKING_ASPECT = 0.4059; // measured bbox width / height

const STOCKING_POINTS: Point[] = [
  [0.1497, 0.0052],
  [0.3248, 0.6412],
  [0.285, 0.693],
  [0.0271, 0.8242],
  [0.0, 0.8953],
  [0.0637, 0.9528],
  [0.2197, 0.9922],
  [0.3583, 1.0],
  [0.4347, 0.989],
  [0.6146, 0.8888],
  [0.9315, 0.8197],
  [0.9904, 0.7938],
  [1.0, 0.7401],
  [0.9172, 0.6445],
  [0.9013, 0.5456],
  [0.9936, 0.0],
];

// Largest axis-aligned rectangle inscribed in the traced stocking polygon
// above, computed numerically (rasterise the polygon at 700x700 resolution,
// classic histogram-based maximal-rectangle-in-binary-matrix algorithm)
// rather than guessed -- same "measure, don't guess" discipline used to
// trace the silhouette itself. This is the stocking's equivalent of
// ELLIPSE_SAFE_FRACTION in index.tsx: the guaranteed-safe zone a generated
// subject's own bounding box must fit inside to avoid being clipped by the
// finished cut edge. It sits down the leg (the widest, straightest-sided
// part of the silhouette, x in [0.32, 0.90], y in [0.00, 0.83]) -- the heel
// bulge, toe curl, and cuff taper are all outside it deliberately.
export const STOCKING_SAFE_RECT = { x0: 0.3243, y0: 0.0043, x1: 0.9014, y1: 0.8257 } as const;

function stockingOutline(): Point[] {
  return STOCKING_POINTS;
}

function ellipseOutline(samples = 160): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const a = (2 * Math.PI * i) / samples;
    pts.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]);
  }
  return pts;
}

const BRICK_AX = 0.5 * (8.5 / 14);
const BRICK_AY = 0.5 * (4.5 / 10);

function brickOutline(): Point[] {
  const ax = BRICK_AX;
  const ay = BRICK_AY;
  const c = 0.5;
  return [
    [c - ax, 0],
    [c + ax, 0],
    [c + ax, c - ay],
    [1, c - ay],
    [1, c + ay],
    [c + ax, c + ay],
    [c + ax, 1],
    [c - ax, 1],
    [c - ax, c + ay],
    [0, c + ay],
    [0, c - ay],
    [c - ax, c - ay],
    [c - ax, 0],
  ];
}

function brickFoldLines(): Point[][] {
  const ax = BRICK_AX;
  const ay = BRICK_AY;
  const c = 0.5;
  return [
    [[c - ax, c - ay], [c + ax, c - ay]],
    [[c - ax, c + ay], [c + ax, c + ay]],
    [[c - ax, c - ay], [c - ax, c + ay]],
    [[c + ax, c - ay], [c + ax, c + ay]],
  ];
}

export function shapeOutline(shape: CanvasShape): Point[] | null {
  switch (shape) {
    case "circle":
    case "oval":
      return ellipseOutline();
    case "stocking":
      return stockingOutline();
    case "brick":
      return brickOutline();
    default:
      return null;
  }
}

export const OUTLINE_MARGIN_INCHES = 1;

function hasOutlineMargin(shape: CanvasShape): boolean {
  return shape === "circle" || shape === "oval" || shape === "stocking";
}

export function outlineMarginFraction(
  shape: CanvasShape,
  canvasWidthInches: number,
  canvasHeightInches: number,
): { mfx: number; mfy: number } {
  if (!hasOutlineMargin(shape) || canvasWidthInches <= 0 || canvasHeightInches <= 0) {
    return { mfx: 0, mfy: 0 };
  }
  return {
    mfx: Math.min(0.45, OUTLINE_MARGIN_INCHES / canvasWidthInches),
    mfy: Math.min(0.45, OUTLINE_MARGIN_INCHES / canvasHeightInches),
  };
}

export function shapeOutlinePath(
  shape: CanvasShape,
  w: number,
  h: number,
  canvasWidthInches: number,
  canvasHeightInches: number,
): string | null {
  const pts = shapeOutline(shape);
  if (!pts) return null;
  const { mfx, mfy } = outlineMarginFraction(shape, canvasWidthInches, canvasHeightInches);
  const d = pts
    .map(([fx, fy], i) => {
      const x = (mfx + fx * (1 - 2 * mfx)) * w;
      const y = (mfy + fy * (1 - 2 * mfy)) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  return d + " Z";
}

export function drawShapeOutline(
  ctx: CanvasRenderingContext2D,
  shape: CanvasShape,
  ox: number,
  oy: number,
  w: number,
  h: number,
  canvasWidthInches: number,
  canvasHeightInches: number,
  color: string = TESSELLA_OLIVE,
  lineWidth = 3,
): void {
  const pts = shapeOutline(shape);
  if (!pts) return;
  const { mfx, mfy } = outlineMarginFraction(shape, canvasWidthInches, canvasHeightInches);
  const strokeFx = lineWidth / Math.max(1, w);
  const strokeFy = lineWidth / Math.max(1, h);
  const fx0 = mfx + strokeFx;
  const fy0 = mfy + strokeFy;
  const toX = (fx: number) => ox + (fx0 + fx * (1 - 2 * fx0)) * w;
  const toY = (fy: number) => oy + (fy0 + fy * (1 - 2 * fy0)) * h;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach(([fx, fy], i) => {
    const x = toX(fx);
    const y = toY(fy);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();

  if (shape === "brick") {
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, lineWidth * 0.5);
    for (const seg of brickFoldLines()) {
      ctx.beginPath();
      seg.forEach(([fx, fy], i) => {
        const x = toX(fx);
        const y = toY(fy);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
}
