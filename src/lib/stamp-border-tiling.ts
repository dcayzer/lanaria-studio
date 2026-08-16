// Tiles a hand-charted border corner + repeat unit(s) around a rectangular
// canvas, producing a standalone Layer (see layer-model.ts) ready for the
// compositor — the stamp-library counterpart to border-layers.ts's
// procedural star/floral corner+repeat placement, generalized to consume
// USER-CHARTED stamps instead of the two hardcoded motifs.
//
// Geometric note on corner reuse: a corner tile has two sides that must
// align with the two border runs meeting there. For a rectangular frame,
// the mathematically correct way to reuse ONE charted corner (say top-left)
// at the other three is:
//   top-right    = mirror horizontally  (left-facing side becomes right-facing)
//   bottom-left  = mirror vertically    (top-facing side becomes bottom-facing)
//   bottom-right = mirror both (= 180° rotation either way)
// This is "mirror" mode — the safe default, correct regardless of whether
// the motif has any further decorative symmetry. "rotate" mode (0/90/180/270°
// walking clockwise) is offered for motifs deliberately charted with
// rotational intent (e.g. a pinwheel-like corner meant to "spin" the same
// way at each corner) — use it only when that's actually the design.
//
// Repeat units tile with the SAME evenly-spaced-to-fit approach already
// proven in border-layers.ts's distributeWithPitch: compute how many whole
// units fit a span, then space them evenly (adjusting the gap slightly) so
// the pattern always fits exactly, for any canvas size.

import type { Layer } from "./layer-model";
import { makeLayer } from "./layer-model";

/** A hand-charted stamp: row-major grid of thread codes / sentinel cells. */
export type StampGrid = string[][];

export type CornerSymmetry = "mirror" | "rotate";

export interface StampBorderSpec {
  corner: StampGrid;
  /** Tiled along the top and bottom edges. */
  repeatH: StampGrid;
  /**
   * Tiled along the left and right edges. Defaults to `repeatH` rotated 90°
   * clockwise — correct for non-directional motifs (dots, diamonds). Provide
   * explicitly for directional motifs (a vine that must keep "growing" the
   * same visual way on a vertical run as on a horizontal one).
   */
  repeatV?: StampGrid;
  /** Default "mirror" — see module note above. */
  cornerSymmetry?: CornerSymmetry;
  /** Cells from the canvas edge to each stamp's outer bounding-box edge. */
  inset?: number;
  /** Desired gap, in cells, between adjacent repeat units. */
  targetGap?: number;
}

function gridDims(g: StampGrid): { w: number; h: number } {
  const h = g.length;
  const w = h > 0 ? g[0].length : 0;
  return { w, h };
}

export function mirrorHorizontal(g: StampGrid): StampGrid {
  return g.map((row) => [...row].reverse());
}

export function mirrorVertical(g: StampGrid): StampGrid {
  return [...g].reverse().map((row) => [...row]);
}

export function mirrorBoth(g: StampGrid): StampGrid {
  return mirrorVertical(mirrorHorizontal(g));
}

/** Rotate 90° clockwise. Dimensions swap (w x h -> h x w). */
export function rotate90CW(g: StampGrid): StampGrid {
  const { w, h } = gridDims(g);
  const out: StampGrid = Array.from({ length: w }, () => new Array<string>(h).fill(""));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      out[c][h - 1 - r] = g[r][c];
    }
  }
  return out;
}

/** Rotate 180°. Same as mirrorBoth — kept as a named alias for clarity at call sites. */
export function rotate180(g: StampGrid): StampGrid {
  return mirrorBoth(g);
}

export function rotate270CW(g: StampGrid): StampGrid {
  return rotate90CW(rotate90CW(rotate90CW(g)));
}

type CornerPos = "TL" | "TR" | "BL" | "BR";

function cornerVariant(corner: StampGrid, pos: CornerPos, mode: CornerSymmetry): StampGrid {
  if (pos === "TL") return corner;
  if (mode === "mirror") {
    if (pos === "TR") return mirrorHorizontal(corner);
    if (pos === "BL") return mirrorVertical(corner);
    return mirrorBoth(corner); // BR
  }
  // rotate: TL=0°, TR=90°CW, BR=180°, BL=270°CW, walking clockwise round the frame.
  if (pos === "TR") return rotate90CW(corner);
  if (pos === "BR") return rotate180(corner);
  return rotate270CW(corner); // BL
}

/** Same fit-to-span spacing as border-layers.ts's distributeWithPitch. */
function distributeWithPitch(edgeLen: number, stampSize: number, targetPitch: number): number[] {
  if (edgeLen < stampSize) return [];
  const n = Math.max(0, Math.round((edgeLen - stampSize) / targetPitch) + 1);
  if (n <= 0) return [];
  if (n === 1) return [Math.floor(edgeLen / 2)];
  const step = (edgeLen - stampSize) / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round(i * step) + Math.floor(stampSize / 2));
  return out;
}

/**
 * Build a standalone border Layer by placing the corner (in all 4
 * orientations per `cornerSymmetry`) and evenly-spaced repeat units along
 * each edge. `sentinel` cells (and empty strings) in any stamp are treated
 * as transparent and never painted.
 */
export function stampBorderToLayer(
  id: string,
  spec: StampBorderSpec,
  gridW: number,
  gridH: number,
  sentinel: string,
): Layer {
  const inset = spec.inset ?? 2;
  const targetGap = spec.targetGap ?? 2;
  const mode: CornerSymmetry = spec.cornerSymmetry ?? "mirror";
  const repeatV = spec.repeatV ?? rotate90CW(spec.repeatH);

  const cells: string[][] = Array.from({ length: gridH }, () => new Array<string>(gridW).fill(sentinel));

  const stamp = (grid: StampGrid, x0: number, y0: number) => {
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (v === sentinel || v === "") continue;
        const X = x0 + c;
        const Y = y0 + r;
        if (X >= 0 && X < gridW && Y >= 0 && Y < gridH) cells[Y][X] = v;
      }
    }
  };

  const tl = cornerVariant(spec.corner, "TL", mode);
  const tr = cornerVariant(spec.corner, "TR", mode);
  const bl = cornerVariant(spec.corner, "BL", mode);
  const br = cornerVariant(spec.corner, "BR", mode);
  const tlD = gridDims(tl), trD = gridDims(tr), blD = gridDims(bl), brD = gridDims(br);

  stamp(tl, inset, inset);
  stamp(tr, gridW - inset - trD.w, inset);
  stamp(bl, inset, gridH - inset - blD.h);
  stamp(br, gridW - inset - brD.w, gridH - inset - brD.h);

  const rhD = gridDims(spec.repeatH);
  const rvD = gridDims(repeatV);

  // Top edge: spans between tl and tr.
  {
    const xStart = inset + tlD.w + targetGap;
    const xEnd = gridW - inset - trD.w - targetGap;
    const span = Math.max(0, xEnd - xStart);
    const centers = distributeWithPitch(span, rhD.w, rhD.w + targetGap).map((c) => xStart + c);
    for (const cx of centers) stamp(spec.repeatH, cx - Math.floor(rhD.w / 2), inset);
  }
  // Bottom edge: spans between bl and br.
  {
    const xStart = inset + blD.w + targetGap;
    const xEnd = gridW - inset - brD.w - targetGap;
    const span = Math.max(0, xEnd - xStart);
    const centers = distributeWithPitch(span, rhD.w, rhD.w + targetGap).map((c) => xStart + c);
    const y0 = gridH - inset - rhD.h;
    for (const cx of centers) stamp(spec.repeatH, cx - Math.floor(rhD.w / 2), y0);
  }
  // Left edge: spans between tl and bl.
  {
    const yStart = inset + tlD.h + targetGap;
    const yEnd = gridH - inset - blD.h - targetGap;
    const span = Math.max(0, yEnd - yStart);
    const centers = distributeWithPitch(span, rvD.h, rvD.h + targetGap).map((c) => yStart + c);
    for (const cy of centers) stamp(repeatV, inset, cy - Math.floor(rvD.h / 2));
  }
  // Right edge: spans between tr and br.
  {
    const yStart = inset + trD.h + targetGap;
    const yEnd = gridH - inset - brD.h - targetGap;
    const span = Math.max(0, yEnd - yStart);
    const centers = distributeWithPitch(span, rvD.h, rvD.h + targetGap).map((c) => yStart + c);
    const x0 = gridW - inset - rvD.w;
    for (const cy of centers) stamp(repeatV, x0, cy - Math.floor(rvD.h / 2));
  }

  return makeLayer({ id, kind: "border", cells, offset: { x: 0, y: 0 }, scale: 1 });
}
