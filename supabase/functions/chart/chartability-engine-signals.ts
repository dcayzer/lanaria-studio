// Phase 5 signals that need the REAL structural detector — built against the
// live analyseFrameCandidate/connectedRegions/classifyPalette/identifyOutermostRegion.
// Completes the two signals stubbed in chartability.ts.

import {
  connectedRegions, analyseFrameCandidate, classifyPalette, identifyOutermostRegion,
  type PaletteEntry,
} from "./structural-model.ts";
import type { SignalResult } from "./chartability.ts";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

interface GridInput {
  grid: Uint16Array;
  W: number;
  H: number;
  palette: PaletteEntry[];
}

function lightRegionCandidates(g: GridInput) {
  const outermost = identifyOutermostRegion(g.grid, g.W, g.H);
  const gridBgIds = new Set<number>();
  if (outermost) gridBgIds.add(outermost.colour);
  for (let i = 0; i < g.palette.length; i++) {
    const [r, gg, b] = hexToRgb(g.palette[i].hex);
    if (r >= 250 && gg >= 250 && b >= 250) gridBgIds.add(i);
  }
  const { lightIds } = classifyPalette(g.palette, gridBgIds);
  return connectedRegions(g.grid, g.W, g.H, (c) => lightIds.has(c));
}

export function borderCompletenessSignal(g: GridInput): SignalResult {
  const regions = lightRegionCandidates(g);
  const coverages: number[] = [];
  let candidates = 0, accepted = 0;
  for (const region of regions) {
    const h = region.r1 - region.r0 + 1, w = region.c1 - region.c0 + 1;
    if (h < 5 || w < 5) continue;
    candidates++;
    const a = analyseFrameCandidate(region, g.grid, g.W);
    if (a.isFrame) { accepted++; coverages.push(1); continue; }
    const cellSet = new Set(region.cells);
    const at = (r: number, c: number) => cellSet.has(r * g.W + c);
    let per = 0, perHit = 0;
    for (let c = region.c0; c <= region.c1; c++) { per += 2; if (at(region.r0, c)) perHit++; if (at(region.r1, c)) perHit++; }
    for (let r = region.r0 + 1; r < region.r1; r++) { per += 2; if (at(r, region.c0)) perHit++; if (at(r, region.c1)) perHit++; }
    coverages.push(per ? perHit / per : 0);
  }
  const avgCoverage = coverages.length ? coverages.reduce((s, v) => s + v, 0) / coverages.length : 1;
  const acceptRate = candidates ? accepted / candidates : 1;
  const score = candidates === 0 ? 1 : Math.min(1, acceptRate / 0.7);
  return {
    name: "borderCompleteness",
    raw: { candidates, accepted, acceptRate, avgCoverage },
    score,
    note: candidates === 0
      ? "no frame-shaped regions"
      : `${accepted}/${candidates} frame candidates pass the real detector (avg coverage ${(avgCoverage * 100).toFixed(0)}%)`,
  };
}

export function strokeWidthSignal(g: GridInput): SignalResult {
  const regions = lightRegionCandidates(g);
  const widths: number[] = [];
  for (const region of regions) {
    const h = region.r1 - region.r0 + 1, w = region.c1 - region.c0 + 1;
    if (h < 5 || w < 5) continue;
    const a = analyseFrameCandidate(region, g.grid, g.W);
    if (!a.isFrame) continue;
    widths.push(a.bw.t, a.bw.b, a.bw.l, a.bw.r);
  }
  if (widths.length === 0) return { name: "strokeWidth", raw: { measured: 0 }, score: 1, note: "no frame borders to measure" };
  const mean = widths.reduce((s, v) => s + v, 0) / widths.length;
  const variance = widths.reduce((s, v) => s + (v - mean) ** 2, 0) / widths.length;
  const maxDeviation = Math.max(...widths.map((v) => Math.abs(v - mean)));
  const score = Math.max(0, 1 - (mean - 1 + Math.sqrt(variance)) / 1.5);
  return {
    name: "strokeWidth",
    raw: { measured: widths.length, meanWidth: mean, variance, maxDeviation },
    score: Math.min(1, Math.max(0, score)),
    note: `mean stroke width ${mean.toFixed(2)} (target 1), variance ${variance.toFixed(2)}`,
  };
}
