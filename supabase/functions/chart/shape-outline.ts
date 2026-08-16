// shape-outline.ts — server-side port of src/lib/canvasShapeOutline.ts +
// src/lib/canvas-shape-mask.ts's masking logic. Kept geometrically IDENTICAL
// to those client modules (same polygon points, same margin formula) since
// the client's Design Preview and this server's real chart both need to
// agree on where the finished shape's edge actually is.

export type Point = readonly [number, number];

export const STOCKING_ASPECT = 0.4059;

const STOCKING_POINTS: Point[] = [
  [0.1497, 0.0052], [0.3248, 0.6412], [0.285, 0.693], [0.0271, 0.8242],
  [0.0, 0.8953], [0.0637, 0.9528], [0.2197, 0.9922], [0.3583, 1.0],
  [0.4347, 0.989], [0.6146, 0.8888], [0.9315, 0.8197], [0.9904, 0.7938],
  [1.0, 0.7401], [0.9172, 0.6445], [0.9013, 0.5456], [0.9936, 0.0],
];

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
  const ax = BRICK_AX, ay = BRICK_AY, c = 0.5;
  return [
    [c - ax, 0], [c + ax, 0], [c + ax, c - ay], [1, c - ay], [1, c + ay],
    [c + ax, c + ay], [c + ax, 1], [c - ax, 1], [c - ax, c + ay], [0, c + ay],
    [0, c - ay], [c - ax, c - ay], [c - ax, 0],
  ];
}

export function shapeOutline(shape: string | null | undefined): Point[] | null {
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

function hasOutlineMargin(shape: string | null | undefined): boolean {
  return shape === "circle" || shape === "oval" || shape === "stocking";
}

export function outlineMarginFraction(
  shape: string | null | undefined,
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

function shapePolygonInCells(
  shape: string | null | undefined,
  gridW: number,
  gridH: number,
  canvasWidthInches: number,
  canvasHeightInches: number,
): Point[] | null {
  const pts = shapeOutline(shape);
  if (!pts) return null;
  const { mfx, mfy } = outlineMarginFraction(shape, canvasWidthInches, canvasHeightInches);
  return pts.map(([fx, fy]): Point => [
    (mfx + fx * (1 - 2 * mfx)) * gridW,
    (mfy + fy * (1 - 2 * mfy)) * gridH,
  ]);
}

function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Boolean stitchability mask for a shape, in server grid-cell space.
 * `null`/`"rectangle"` shape returns an all-true mask (identical treatment
 * to the client's `shapeMask` for a rectangle).
 */
export function shapeMask(
  shape: string | null | undefined,
  gridW: number,
  gridH: number,
  canvasWidthInches: number,
  canvasHeightInches: number,
): boolean[][] {
  const poly = shapePolygonInCells(shape, gridW, gridH, canvasWidthInches, canvasHeightInches);
  const mask: boolean[][] = Array.from({ length: gridH }, () => new Array<boolean>(gridW).fill(true));
  if (!poly) return mask;
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      mask[y][x] = pointInPolygon(x + 0.5, y + 0.5, poly);
    }
  }
  return mask;
}
