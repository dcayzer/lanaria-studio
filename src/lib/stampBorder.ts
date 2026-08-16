// Client-side port of the border-stamping logic that the chart edge function
// applies on top of a quantised pixel grid. Used for blank-canvas charts so
// borders can be added without re-running the chart pipeline.

import {
  rebuildChart,
  type ChartData,
  type ChartPaletteEntry,
} from "@/components/StitchChart";
import type { ThreadColor } from "@/data/threadPalettes";

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

function threadToEntry(c: ThreadColor): ChartPaletteEntry {
  return { id: c.code, name: c.name, family: c.family, hex: c.hex };
}

export function stampBorderOnChart(
  chart: ChartData,
  border: BorderSpec | null,
  brandPalette: ThreadColor[],
): ChartData {
  const supported = new Set(["simple", "double", "ornate", "star", "floral", "folk"]);
  if (!border || !supported.has(border.style.toLowerCase())) return chart;

  const validColors = border.colors.filter(
    (c): c is string => typeof c === "string" && /^#?[0-9a-fA-F]{6}$/.test(c.replace("#", "")),
  );
  if (!validColors.length || !brandPalette.length) return chart;

  const gridW = chart.width;
  const gridH = chart.height;

  // Expand pixelsRLE → flat Uint16Array
  const total = gridW * gridH;
  const px = new Uint16Array(total);
  {
    let i = 0;
    for (const [idx, len] of chart.pixelsRLE) {
      for (let n = 0; n < len && i < total; n++) px[i++] = idx;
    }
  }

  // Working palette starts from the chart's existing palette and grows as we
  // resolve border thread colours.
  const workingPalette: ChartPaletteEntry[] = [...chart.palette];
  const byId = new Map<string, number>();
  workingPalette.forEach((p, i) => byId.set(p.id, i));

  const ensureColor = (hex: string): number => {
    const normalized = hex.startsWith("#") ? hex : `#${hex}`;
    const thread = nearestThread(normalized, brandPalette);
    const existing = byId.get(thread.code);
    if (existing !== undefined) return existing;
    const entry = threadToEntry(thread);
    workingPalette.push(entry);
    const newIdx = workingPalette.length - 1;
    byId.set(thread.code, newIdx);
    return newIdx;
  };

  const setPx = (x: number, y: number, ci: number) => {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return;
    px[y * gridW + x] = ci;
  };

  const drawFrame = (inset: number, thickness: number, ci: number) => {
    for (let t = 0; t < thickness; t++) {
      const o = inset + t;
      if (o * 2 + 1 >= gridW || o * 2 + 1 >= gridH) return;
      for (let x = o; x <= gridW - 1 - o; x++) {
        setPx(x, o, ci);
        setPx(x, gridH - 1 - o, ci);
      }
      for (let y = o; y <= gridH - 1 - o; y++) {
        setPx(o, y, ci);
        setPx(gridW - 1 - o, y, ci);
      }
    }
  };

  const placeStamp = (stamp: Stamp, cx: number, cy: number, palIdxs: number[]) => {
    const x0 = cx - Math.floor(stamp.w / 2);
    const y0 = cy - Math.floor(stamp.h / 2);
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        const v = stamp.cells[y * stamp.w + x];
        if (v > 0) setPx(x0 + x, y0 + y, palIdxs[v - 1] ?? palIdxs[0]);
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
    drawFrame(inset, thickness, ensureColor(validColors[0]));
  } else if (style === "double") {
    const c1 = ensureColor(validColors[0]);
    const c2 = ensureColor(validColors[1] ?? validColors[0]);
    drawFrame(inset, thickness, c1);
    drawFrame(inset + thickness + 1, thickness, c2);
  } else if (style === "ornate") {
    const c1 = ensureColor(validColors[0]);
    const c2 = ensureColor(validColors[1] ?? validColors[0]);
    const c3 = ensureColor(validColors[2] ?? validColors[1] ?? validColors[0]);
    const outerThickness = Math.max(2, thickness + 1);
    drawFrame(inset, outerThickness, c1);
    drawFrame(inset + outerThickness + 1, 1, c2);
    const r = 2;
    const stampDiamond = (cx: number, cy: number, fill: number, inner?: number) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= r) setPx(cx + dx, cy + dy, fill);
        }
      }
      if (inner !== undefined) setPx(cx, cy, inner);
    };
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
  } else if (style === "folk") {
    const toothC = ensureColor(validColors[0]);
    const diamondC = ensureColor(validColors[1] ?? validColors[0]);
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
  } else {
    // star / floral — single repeating stamp with corners.
    let cornerEntry: { stamp: Stamp; palSlots: number[] } | null = null;
    let edgeSequence: Array<{ stamp: Stamp; palSlots: number[] }> = [];
    if (style === "star") {
      const c1 = ensureColor(validColors[0]);
      const s = { stamp: STAMPS.star, palSlots: [c1] };
      cornerEntry = s;
      edgeSequence = [s];
    } else if (style === "floral") {
      const petal = ensureColor(validColors[0]);
      const center = ensureColor(validColors[1] ?? validColors[0]);
      const s = { stamp: STAMPS.flower, palSlots: [petal, center] };
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
      const cornerXs = [motifInset + Math.floor(sW / 2), gridW - 1 - motifInset - Math.floor(sW / 2)];
      const cornerYs = [motifInset + Math.floor(sH / 2), gridH - 1 - motifInset - Math.floor(sH / 2)];
      for (const cy of cornerYs)
        for (const cx of cornerXs)
          placeStamp(cornerEntry.stamp, cx, cy, cornerEntry.palSlots);
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
      for (const x of xs) { const s = next(); placeStamp(s.stamp, x, topY, s.palSlots); }
      for (const x of xs) { const s = next(); placeStamp(s.stamp, x, botY, s.palSlots); }
      for (const y of ys) { const s = next(); placeStamp(s.stamp, leftX, y, s.palSlots); }
      for (const y of ys) { const s = next(); placeStamp(s.stamp, rightX, y, s.palSlots); }
    }
  }

  // Rebuild the chart so palette, usage, sections, symbols, RLE all stay in sync.
  return rebuildChart(gridW, gridH, workingPalette, px) as ChartData;
}
