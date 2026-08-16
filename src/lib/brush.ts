// Paint brush — computes which grid cells a brush of a given size covers at a
// pointer position. The size slider maps 1..N; this is the pure geometry of
// "which squares does a size-K brush centred at (cx,cy) touch", so the same
// logic serves the paint tool, the eraser, and the progress-marker brush.
//
// Shape: square brushes (odd sizes centre cleanly on a cell; even sizes offset
// toward the pointer's own cell) are the default because needlepoint fills are
// rectangular blocks — a round brush would leave stair-stepped edges the user
// then has to clean up. A round option is provided for organic fills.

export type BrushShape = "square" | "round";

export interface BrushCell {
  x: number;
  y: number;
}

/**
 * Cells covered by a brush of `size` (>=1) centred on cell (cx, cy), clipped
 * to the grid. size 1 = a single cell; size 3 = a 3x3 block; etc.
 *
 * For even sizes there's no exact centre cell, so the block is anchored so
 * (cx, cy) is its top-left-of-centre — matching the intuition that the cell
 * under the pointer is always painted.
 */
export function brushCells(
  cx: number,
  cy: number,
  size: number,
  gridW: number,
  gridH: number,
  shape: BrushShape = "square",
): BrushCell[] {
  const s = Math.max(1, Math.round(size));
  const half = Math.floor(s / 2);
  // For odd s, the block is [cx-half, cx+half]; for even s, [cx-half+1?] — we
  // anchor so the pointer cell is included and the block grows down/right.
  const x0 = s % 2 === 1 ? cx - half : cx - half + 1;
  const y0 = s % 2 === 1 ? cy - half : cy - half + 1;
  const x1 = x0 + s - 1;
  const y1 = y0 + s - 1;

  const cells: BrushCell[] = [];
  // For round brushes, test distance from the true centre of the block.
  const centreX = (x0 + x1) / 2;
  const centreY = (y0 + y1) / 2;
  const radius = s / 2;

  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= gridH) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= gridW) continue;
      if (shape === "round") {
        // Distance from cell centre to block centre; +0.5 so the rim cells at
        // exactly radius are included, giving a fuller disc at small sizes.
        const dx = x - centreX;
        const dy = y - centreY;
        if (Math.hypot(dx, dy) > radius + 0.0001) continue;
      }
      cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * A continuous drag paints a stroke, but pointermove events are sampled — at
 * speed they arrive far apart, leaving gaps. Interpolate brush stamps along the
 * segment from (x0,y0) to (x1,y1) so a fast drag still paints a solid line.
 * Returns the deduplicated set of covered cells for the whole segment.
 */
export function brushStroke(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  gridW: number,
  gridH: number,
  shape: BrushShape = "square",
): BrushCell[] {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist));
  const seen = new Set<string>();
  const out: BrushCell[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.round(x0 + (x1 - x0) * t);
    const cy = Math.round(y0 + (y1 - y0) * t);
    for (const c of brushCells(cx, cy, size, gridW, gridH, shape)) {
      const key = c.x + "," + c.y;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}
