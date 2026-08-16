// Canvas-shape masking — a DEDICATED sentinel value, not the background
// colour. Reusing background risks identifyOutermostRegion misreading
// masked-out cells as canvas background; a dedicated sentinel is unambiguous.
// Distinct from the Motif Library's transparency sentinel: this means
// "permanently outside the finished shape," not "transparent, show what's
// beneath."
//
// Consistency guarantee: the mask boundary is computed from the SAME
// shapeOutline() polygon and the SAME margin math as drawShapeOutline() /
// shapeOutlinePath() (canvasShapeOutline.ts) — by construction, not
// duplicated-and-hopefully-matching math.

import type { CanvasShape } from "./canvasShapes";
import { shapeOutline, outlineMarginFraction, type Point } from "./canvasShapeOutline";

export const NOT_STITCHABLE = "__NOT_STITCHABLE__";

export function shapePolygonInCells(
  shape: CanvasShape,
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
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function shapeMask(
  shape: CanvasShape,
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

export function applyShapeMask(grid: string[][], mask: boolean[][]): void {
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (!mask[y]?.[x]) grid[y][x] = NOT_STITCHABLE;
    }
  }
}

export function stitchableFraction(mask: boolean[][]): number {
  let total = 0, on = 0;
  for (const row of mask) for (const v of row) { total++; if (v) on++; }
  return total === 0 ? 0 : on / total;
}
