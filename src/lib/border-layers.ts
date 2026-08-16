// Extraction of border generation from stampBorder.ts into a standalone
// LAYER (see layer-model.ts / compositor.ts).
//
// Unlike glyphs, a border is genuinely PARAMETRIC to the target canvas size
// (inset, thickness, and motif spacing all scale with gridW/gridH) — it was
// never authored at a small fixed resolution and then upscaled. So there is
// no honest "native size" smaller than the full canvas to store it at: the
// border layer is captured at scale=1, offset=(0,0), sized to the whole
// canvas. This is consistent with the layer model's invariant that the
// border is anchored and never draggable or independently scaled — it isn't
// losing any capability by being stored at full resolution, since it was
// never meant to move.
//
// All geometry (drawFrame, placeStamp, distributeWithPitch, the ornate/folk/
// star/floral motif math) is copied verbatim from stampBorder.ts; only the
// output target changes, from a Uint16Array of palette indices to a Cell[][]
// of thread codes with the sentinel standing in for untouched cells.
//
// Verified byte-identical to the real stampBorderOnChart.
//
// ── SHAPE AWARENESS (added) ────────────────────────────────────────────────
// A border used to be a RECTANGLE ring regardless of the canvas shape, which
// is why borders were broken on circle / oval / stocking: the ring had no
// relationship to the stitchable region, so it either escaped the shape or cut
// through it. Passing `shapeMaskGrid` switches every frame to a shape-following
// ring derived from a BFS depth map (shape-border.ts), and switches repeating
// stamps to even spacing around the traced contour (perimeter-path.ts).
//
// Omit `shapeMaskGrid`, or pass an all-true mask, and NOTHING changes: the
// original rectangle code runs, literally the same lines. Rectangular canvases
// — the overwhelmingly common case — carry zero regression risk by
// construction, not by argument.

import type { Layer } from "./layer-model";
import { makeLayer } from "./layer-model";
import type { ThreadColor } from "../data/threadPalettes";
import { findHandBorder } from "../data/hand-charted-borders";
import { tileHandBorder } from "./hand-charted-border-tiling";
import {
  depthsForMask,
  shapedFrameCells,
  accentsAroundShape,
  stampsAroundShape,
} from "./shape-aware-border";

export type BorderSpec = {
  style: string; // "simple" | "double" | "ornate" | "star" | "floral" | "folk"
  colors: Array<string | null | undefined>;
};

type Stamp = { w: number; h: number; cells: number[] };

const STAMPS: Record<string, Stamp> = {
  star: {
    w: 7, h: 7, cells: [
      1,0,0,1,0,0,1,
      0,1,0,1,0,1,0,
      0,0,1,1,1,0,0,
      1,1,1,1,1,1,1,
      0,0,1,1,1,0,0,
      0,1,0,1,0,1,0,
      1,0,0,1,0,0,1,
    ],
  },
  flower: {
    w: 5, h: 5, cells: [
      0,0,1,0,0,
      0,1,1,1,0,
      1,1,2,1,1,
      0,1,1,1,0,
      0,0,1,0,0,
    ],
  },
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function nearestThread(hex: string, palette: ThreadColor[]): ThreadColor {
  const [r, g, b] = hexToRgb(hex);
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const [pr, pg, pb] = hexToRgb(p.hex);
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * Build a standalone BORDER layer, sized to the whole canvas, or null if
 * unsupported/empty — mirrors stampBorderOnChart's gating and geometry
 * exactly. `sentinel` marks cells the border never touches.
 *
 * `shapeMaskGrid` is the canvas-shape mask from `shapeMask()`. Omit it (or
 * pass an all-true mask) for the original rectangle behaviour.
 */
export function borderToLayer(
  id: string,
  border: BorderSpec | null,
  gridW: number,
  gridH: number,
  brandPalette: ThreadColor[],
  sentinel: string,
  shapeMaskGrid?: boolean[][] | null,
): Layer | null {
  // Delaney's hand-charted corner+run borders (see hand-charted-borders.ts).
  // Completely different data source from the procedural styles below (real
  // charted stitch grids, not generated shapes) -- handled in its own branch
  // and returns early. Rectangle canvases only for now; shapeMaskGrid is
  // intentionally ignored here.
  if (border) {
    const hb = findHandBorder(border.style);
    if (hb) {
      const validColors = border.colors.filter(
        (c): c is string => typeof c === "string" && /^#?[0-9a-fA-F]{6}$/.test(c.replace("#", "")),
      );
      if (!validColors.length || !brandPalette.length) return null;
      const resolveColor = (hex: string): string => {
        const normalized = hex.startsWith("#") ? hex : `#${hex}`;
        return nearestThread(normalized, brandPalette).code;
      };
      const cells: string[][] = Array.from({ length: gridH }, () =>
        new Array<string>(gridW).fill(sentinel),
      );
      // Both axes passed through: the border now follows a rectangular canvas
      // instead of being built square at min(gridW, gridH) and centred.
      const tiled = tileHandBorder(hb, Math.max(1, gridW), Math.max(1, gridH));
      const actualH = tiled.length;          // may round to fit whole repeats,
      const actualW = tiled[0]?.length ?? 0; // independently on each axis
      const offX = Math.floor((gridW - actualW) / 2);
      const offY = Math.floor((gridH - actualH) / 2);
      for (let r = 0; r < actualH; r++) {
        for (let c = 0; c < actualW; c++) {
          const role = tiled[r][c];
          if (!role) continue;
          const y = offY + r, x = offX + c;
          if (y < 0 || x < 0 || y >= gridH || x >= gridW) continue;
          const hex = validColors[role - 1] ?? validColors[0];
          cells[y][x] = resolveColor(hex);
        }
      }
      return makeLayer({ id, kind: "border", cells, offset: { x: 0, y: 0 }, scale: 1 });
    }
  }

  const supported = new Set(["simple", "double", "ornate", "star", "floral", "folk"]);
  if (!border || !supported.has(border.style.toLowerCase())) return null;

  const validColors = border.colors.filter(
    (c): c is string => typeof c === "string" && /^#?[0-9a-fA-F]{6}$/.test(c.replace("#", "")),
  );
  if (!validColors.length || !brandPalette.length) return null;

  const cells: string[][] = Array.from({ length: gridH }, () =>
    new Array<string>(gridW).fill(sentinel),
  );

  // Shape geometry. `unrestricted` is true for a rectangle (or no mask at
  // all), which routes every branch below back to the original code.
  const { grid: shapeGrid, depths, unrestricted } = depthsForMask(shapeMaskGrid, gridW, gridH);
  const shaped = !unrestricted;

  const resolveColor = (hex: string): string => {
    const normalized = hex.startsWith("#") ? hex : `#${hex}`;
    return nearestThread(normalized, brandPalette).code;
  };

  const setPx = (x: number, y: number, code: string) => {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return;
    cells[y][x] = code;
  };

  /** Only paint where the shape allows. On a rectangle this is every cell. */
  const setPxInShape = (x: number, y: number, code: string) => {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return;
    if (shaped && depths[y * gridW + x] < 0) return;
    cells[y][x] = code;
  };

  const drawFrame = (inset: number, thickness: number, code: string) => {
    if (shaped) {
      for (const p of shapedFrameCells(depths, gridW, gridH, inset, thickness)) {
        setPx(p.x, p.y, code);
      }
      return;
    }
    for (let t = 0; t < thickness; t++) {
      const o = inset + t;
      if (o * 2 + 1 >= gridW || o * 2 + 1 >= gridH) return;
      for (let x = o; x <= gridW - 1 - o; x++) {
        setPx(x, o, code);
        setPx(x, gridH - 1 - o, code);
      }
      for (let y = o; y <= gridH - 1 - o; y++) {
        setPx(o, y, code);
        setPx(gridW - 1 - o, y, code);
      }
    }
  };

  const placeStamp = (stamp: Stamp, cx: number, cy: number, codes: string[]) => {
    const x0 = cx - Math.floor(stamp.w / 2);
    const y0 = cy - Math.floor(stamp.h / 2);
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        const v = stamp.cells[y * stamp.w + x];
        // Clipped to the shape so a stamp near a curved edge cannot spill
        // outside the canvas; on a rectangle setPxInShape === setPx.
        if (v > 0) setPxInShape(x0 + x, y0 + y, codes[v - 1] ?? codes[0]);
      }
    }
  };

  const distributeWithPitch = (edgeLen: number, stampSize: number, targetPitch: number): number[] => {
    if (edgeLen < stampSize) return [];
    const n = Math.max(0, Math.round((edgeLen - stampSize) / targetPitch) + 1);
    if (n <= 0) return [];
    if (n === 1) return [Math.floor(edgeLen / 2)];
    const step = (edgeLen - stampSize) / (n - 1);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(Math.round(i * step) + Math.floor(stampSize / 2));
    return out;
  };

  const style = border.style.toLowerCase();
  const thickness = Math.max(1, Math.min(2, Math.round(Math.min(gridW, gridH) / 120)));
  const inset = Math.max(2, Math.min(5, Math.round(Math.min(gridW, gridH) / 40)));

  if (style === "simple") {
    drawFrame(inset, thickness, resolveColor(validColors[0]));
  } else if (style === "double") {
    const c1 = resolveColor(validColors[0]);
    const c2 = resolveColor(validColors[1] ?? validColors[0]);
    drawFrame(inset, thickness, c1);
    drawFrame(inset + thickness + 1, thickness, c2);
  } else if (style === "ornate") {
    const c1 = resolveColor(validColors[0]);
    const c2 = resolveColor(validColors[1] ?? validColors[0]);
    const c3 = resolveColor(validColors[2] ?? validColors[1] ?? validColors[0]);
    const outerThickness = Math.max(2, thickness + 1);
    drawFrame(inset, outerThickness, c1);
    drawFrame(inset + outerThickness + 1, 1, c2);
    const r = 2;
    const stampDiamond = (cx: number, cy: number, fill: string, inner?: string) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= r) setPxInShape(cx + dx, cy + dy, fill);
        }
      }
      if (inner !== undefined) setPxInShape(cx, cy, inner);
    };
    if (shaped) {
      // A circle has no corners and no "edge midpoints", so the honest
      // generalisation of "4 corners + 4 midpoints" is 8 evenly spaced accents
      // around the ring. The alternating plain/centred pattern is preserved so
      // the style still reads as ornate rather than as a plain dotted ring.
      const accents = accentsAroundShape(shapeGrid, inset, 8);
      accents.points.forEach((p, i) => {
        if (i % 2 === 0) stampDiamond(p.x, p.y, c3);
        else stampDiamond(p.x, p.y, c3, c1);
      });
    } else {
      const corners: Array<[number, number]> = [
        [inset, inset],
        [gridW - 1 - inset, inset],
        [inset, gridH - 1 - inset],
        [gridW - 1 - inset, gridH - 1 - inset],
      ];
      for (const [cx, cy] of corners) stampDiamond(cx, cy, c3);
      const midX = Math.floor(gridW / 2);
      const midY = Math.floor(gridH / 2);
      stampDiamond(midX, inset, c3, c1);
      stampDiamond(midX, gridH - 1 - inset, c3, c1);
      stampDiamond(inset, midY, c3, c1);
      stampDiamond(gridW - 1 - inset, midY, c3, c1);
    }
  } else if (style === "folk") {
    const toothC = resolveColor(validColors[0]);
    const diamondC = resolveColor(validColors[1] ?? validColors[0]);
    const motifInset = Math.max(2, Math.min(6, Math.round(Math.min(gridW, gridH) / 50)));
    const TW = 5, TD = 3;
    const stampTooth = (edge: string, base: number, pos: number) => {
      for (let d = 0; d < TD; d++) {
        const halfW = Math.max(0, Math.floor((TW - 1) / 2) - d);
        for (let k = -halfW; k <= halfW; k++) {
          if (edge === "top") setPx(pos + k, base + d, toothC);
          else if (edge === "bottom") setPx(pos + k, base - d, toothC);
          else if (edge === "left") setPx(base + d, pos + k, toothC);
          else setPx(base - d, pos + k, toothC);
        }
      }
    };
    if (shaped) {
      // Folk's teeth are DIRECTIONAL — each one points inward from its edge.
      // On a curve "inward" rotates continuously, and quarter turns are the
      // only lossless rotation on a stitch grid (§25.16): anything else
      // resamples the stamp and destroys it. Rather than emit teeth at wrong
      // angles, the shaped path draws only the non-directional diamond chain.
      // See the handoff note — whether to instead quantise each tooth to the
      // nearest cardinal direction is an AESTHETIC call for Delaney, not one
      // to make silently here.
      const dInsetShaped = motifInset + TD + 2;
      const run = stampsAroundShape(shapeGrid, dInsetShaped, 5);
      const dRadiusShaped = 1;
      for (const p of run.points) {
        for (let dy = -dRadiusShaped; dy <= dRadiusShaped; dy++) {
          for (let dx = -dRadiusShaped; dx <= dRadiusShaped; dx++) {
            if (Math.abs(dx) + Math.abs(dy) <= dRadiusShaped) {
              setPxInShape(p.x + dx, p.y + dy, diamondC);
            }
          }
        }
      }
    } else {
    const innerLeft = motifInset + Math.floor(TW / 2);
    const innerRight = gridW - 1 - motifInset - Math.floor(TW / 2);
    const innerTop = motifInset + Math.floor(TW / 2);
    const innerBot = gridH - 1 - motifInset - Math.floor(TW / 2);
    const hCount = Math.max(0, Math.floor((innerRight - innerLeft) / TW) + 1);
    const vCount = Math.max(0, Math.floor((innerBot - innerTop) / TW) + 1);
    const hStep = hCount > 1 ? (innerRight - innerLeft) / (hCount - 1) : 0;
    const vStep = vCount > 1 ? (innerBot - innerTop) / (vCount - 1) : 0;
    for (let i = 0; i < hCount; i++) {
      const x = Math.round(innerLeft + i * hStep);
      stampTooth("top", motifInset, x);
      stampTooth("bottom", gridH - 1 - motifInset, x);
    }
    for (let i = 0; i < vCount; i++) {
      const y = Math.round(innerTop + i * vStep);
      stampTooth("left", motifInset, y);
      stampTooth("right", gridW - 1 - motifInset, y);
    }
    const dInset = motifInset + TD + 2;
    const dRadius = 1;
    const dPitch = 5;
    const drawDiamond = (cx: number, cy: number) => {
      for (let dy = -dRadius; dy <= dRadius; dy++) {
        for (let dx = -dRadius; dx <= dRadius; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= dRadius) setPx(cx + dx, cy + dy, diamondC);
        }
      }
    };
    const dLeft = dInset + dRadius + 2;
    const dRight = gridW - 1 - dInset - dRadius - 2;
    const dTop = dInset + dRadius + 2;
    const dBot = gridH - 1 - dInset - dRadius - 2;
    const dhCount = Math.max(0, Math.floor((dRight - dLeft) / dPitch) + 1);
    const dvCount = Math.max(0, Math.floor((dBot - dTop) / dPitch) + 1);
    const dhStep = dhCount > 1 ? (dRight - dLeft) / (dhCount - 1) : 0;
    const dvStep = dvCount > 1 ? (dBot - dTop) / (dvCount - 1) : 0;
    for (let i = 0; i < dhCount; i++) {
      const x = Math.round(dLeft + i * dhStep);
      drawDiamond(x, dInset);
      drawDiamond(x, gridH - 1 - dInset);
    }
    for (let i = 0; i < dvCount; i++) {
      const y = Math.round(dTop + i * dvStep);
      drawDiamond(dInset, y);
      drawDiamond(gridW - 1 - dInset, y);
    }
    }
  } else {
    // star / floral — single repeating stamp with corners.
    let cornerEntry: { stamp: Stamp; codes: string[] } | null = null;
    let edgeSequence: Array<{ stamp: Stamp; codes: string[] }> = [];
    if (style === "star") {
      const c1 = resolveColor(validColors[0]);
      const s = { stamp: STAMPS.star, codes: [c1] };
      cornerEntry = s;
      edgeSequence = [s];
    } else if (style === "floral") {
      const petal = resolveColor(validColors[0]);
      const center = resolveColor(validColors[1] ?? validColors[0]);
      const s = { stamp: STAMPS.flower, codes: [petal, center] };
      cornerEntry = s;
      edgeSequence = [s];
    }
    if (cornerEntry && edgeSequence.length) {
      const motifInset = Math.max(2, Math.min(6, Math.round(Math.min(gridW, gridH) / 50)));
      const sW = cornerEntry.stamp.w;
      const sH = cornerEntry.stamp.h;
      const stampSize = Math.max(sW, sH);
      const targetGap = 3;
      const targetPitch = stampSize + targetGap;
      if (shaped) {
        // Star and flower are ROTATIONALLY SYMMETRIC — they read the same
        // whichever way the contour is heading — so unlike folk's teeth they
        // can follow a curve with no rotation at all. Even spacing around the
        // traced contour replaces the four-corners-plus-edges layout, which
        // has no meaning on a shape without corners.
        const inwardFromEdge = motifInset + Math.floor(stampSize / 2);
        const run = stampsAroundShape(shapeGrid, inwardFromEdge, targetPitch);
        for (const p of run.points) {
          placeStamp(cornerEntry.stamp, p.x, p.y, cornerEntry.codes);
        }
      } else {
      const cornerXs = [motifInset + Math.floor(sW / 2), gridW - 1 - motifInset - Math.floor(sW / 2)];
      const cornerYs = [motifInset + Math.floor(sH / 2), gridH - 1 - motifInset - Math.floor(sH / 2)];
      for (const cy of cornerYs)
        for (const cx of cornerXs)
          placeStamp(cornerEntry.stamp, cx, cy, cornerEntry.codes);
      const innerXStart = cornerXs[0] + Math.ceil(sW / 2) + targetGap;
      const innerXEnd = cornerXs[1] - Math.ceil(sW / 2) - targetGap;
      const innerYStart = cornerYs[0] + Math.ceil(sH / 2) + targetGap;
      const innerYEnd = cornerYs[1] - Math.ceil(sH / 2) - targetGap;
      const innerW = Math.max(0, innerXEnd - innerXStart);
      const innerH = Math.max(0, innerYEnd - innerYStart);
      const xs = distributeWithPitch(innerW, sW, targetPitch).map((p) => innerXStart + p);
      const ys = distributeWithPitch(innerH, sH, targetPitch).map((p) => innerYStart + p);
      let seqIdx = 0;
      const next = () => edgeSequence[seqIdx++ % edgeSequence.length];
      const topY = cornerYs[0], botY = cornerYs[1], leftX = cornerXs[0], rightX = cornerXs[1];
      for (const x of xs) { const s = next(); placeStamp(s.stamp, x, topY, s.codes); }
      for (const x of xs) { const s = next(); placeStamp(s.stamp, x, botY, s.codes); }
      for (const y of ys) { const s = next(); placeStamp(s.stamp, leftX, y, s.codes); }
      for (const y of ys) { const s = next(); placeStamp(s.stamp, rightX, y, s.codes); }
      }
    }
  }

  return makeLayer({
    id,
    kind: "border",
    cells,
    offset: { x: 0, y: 0 },
    scale: 1,
  });
}
