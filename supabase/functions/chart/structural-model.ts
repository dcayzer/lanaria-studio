// ============================================================================
// Tessella Chart Engine — Structural Model (Phases 2–3 of the technical plan)
// ============================================================================
// Replaces the six raster repair passes (segment stamp rogue-trim, frame
// border normalisation, paired-region symmetry, divider centring, junction
// protection plumbing, crossing-gap patching) with one coherent system:
//
//   buildStructuralModel()  — detect frames, dividers, free lines, pairs
//   applyConstraints()      — parity snap, centring, congruence (on objects)
//   renderModel()           — single deterministic rasterisation
//
// Design principles:
//   * Structure is detected ONCE and kept as objects with relations.
//   * Constraints are solved in object space (integer rectangle arithmetic),
//     where "two equal panes + 1-cell bar needs odd interior" is a one-line
//     parity snap instead of an impossible pixel repair.
//   * Rendering draws each object completely: a stroked polyline cannot have
//     a gap; two dividers drawn through a shared junction cannot lose it.
//   * Everything the model does not own is left untouched, so organic motifs
//     (margarita bowl, lime flesh, animals) pass through unchanged.
//
// Deno/Supabase-edge compatible. No imports. Integrates into
// supabase/functions/chart/index.ts — see INTEGRATION.md.
// ============================================================================

import { planSiblingRegularization, planDividerReconciliation, type SiblingCandidate } from "./sibling-regularization.ts";
import { CHART_DIAG } from "./diag.ts";

export type Rgb = [number, number, number];

export interface PaletteEntry { hex: string; id?: string }

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

/** A straight 1-cell-wide structural line, in output-grid space. */
export interface ModelLine {
  kind: "line";
  colour: number;              // palette index
  orientation: "h" | "v";
  /** For "h": row is fixed; c0..c1 inclusive. For "v": col fixed; r0..r1. */
  row: number; col: number;    // fixed coordinate (row for h, col for v)
  a: number; b: number;        // span start/end (inclusive) along the free axis
}

/** A hollow rectangular frame (window/door surround) with internal dividers. */
export interface ModelFrame {
  kind: "frame";
  frameColour: number;         // palette index of the border colour
  paneColour: number;          // dominant interior colour
  /** Outer rectangle, inclusive. */
  r0: number; c0: number; r1: number; c1: number;
  borderW: { t: number; b: number; l: number; r: number }; // measured per side
  /** Divider positions AFTER constraints, in absolute grid coords. */
  hDividers: number[];         // rows of horizontal bars inside the frame
  vDividers: number[];         // cols of vertical bars inside the frame
  pairId: number | null;       // frames constrained to be congruent share an id
}

export interface StructuralModel {
  gridW: number;
  gridH: number;
  frames: ModelFrame[];
  /** Lines not inside any frame (pith arcs rendered as their cell sets). */
  freeLines: FreeLine[];
  /** Every cell the model owns; passes like despeckle must not touch these. */
  ownedCells: Set<number>;
}

/** A free-form thin line (e.g. pith): kept as connected cells + colour. */
export interface FreeLine {
  kind: "freeline";
  colour: number;
  cells: number[];             // grid indices; connectivity enforced at render
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hexToRgbLocal(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminanceL(rgb: Rgb): number {
  // Lightness approximation adequate for light/dark classification (0..100).
  const [r, g, b] = rgb.map((v) => v / 255) as unknown as Rgb;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 116 * Math.cbrt(Math.max(y, 0.0001)) - 16;
}

export function classifyPalette(
  outPalette: PaletteEntry[],
  // Grid-derived background palette indices (from identifyOutermostRegion).
  // When provided, ONLY these count as background — a near-white DESIGN
  // colour (e.g. Appletons cream #f2efe6 at 242/239/230) is then correctly
  // treated as a light design colour rather than silently swallowed by a
  // hardcoded RGB threshold. Root cause of the live frames:[] failure: the
  // frame thread crossed the >=230 heuristic and every window was excluded
  // from frame analysis before geometry was ever checked (plan §5.2 — the
  // background is a property of the GRID, not of a colour value).
  gridBgIds?: Set<number>,
  bgWhiteThresh = 230,
) {
  const bgIds = new Set<number>();
  const lightIds = new Set<number>();
  for (let i = 0; i < outPalette.length; i++) {
    const rgb = hexToRgbLocal(outPalette[i].hex);
    const [r, g, b] = rgb;
    const isBg = gridBgIds ? gridBgIds.has(i)
      : (r >= bgWhiteThresh && g >= bgWhiteThresh && b >= bgWhiteThresh);
    if (isBg) { bgIds.add(i); continue; }
    if (luminanceL(rgb) >= 78) lightIds.add(i);
  }
  return { bgIds, lightIds };
}

const mode = (arr: number[]): number => {
  const t: Record<number, number> = {};
  let best = 0, bc = 0;
  for (const v of arr) { t[v] = (t[v] ?? 0) + 1; if (t[v] > bc) { bc = t[v]; best = v; } }
  return best;
};

// ---------------------------------------------------------------------------
// Phase 2 — model construction
// ---------------------------------------------------------------------------

export interface RawRegion {
  colour: number;
  cells: number[];
  r0: number; r1: number; c0: number; c1: number;
}

export function connectedRegions(
  grid: Uint16Array, gridW: number, gridH: number,
  include: (colour: number) => boolean,
): RawRegion[] {
  const N = gridW * gridH;
  const seen = new Uint8Array(N);
  const out: RawRegion[] = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || !include(grid[s])) continue;
    const colour = grid[s];
    const cells: number[] = [];
    const stack = [s];
    seen[s] = 1;
    let r0 = gridH, r1 = 0, c0 = gridW, c1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const r = (i / gridW) | 0, c = i % gridW;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
      const nbs = [i - 1, i + 1, i - gridW, i + gridW];
      const ok = [c > 0, c < gridW - 1, r > 0, r < gridH - 1];
      for (let k = 0; k < 4; k++) {
        if (!ok[k]) continue;
        const ni = nbs[k];
        if (!seen[ni] && grid[ni] === colour) { seen[ni] = 1; stack.push(ni); }
      }
    }
    out.push({ colour, cells, r0, r1, c0, c1 });
  }
  return out;
}

/**
 * Classify a light-coloured region as a frame if it is a hollow rectangle:
 * its cells trace the border band of its bbox and the interior is a
 * different colour. Returns the detected dividers too (light-coloured runs
 * of the SAME colour crossing the interior — these are part of the same
 * connected region when they join the frame, which glazing bars do).
 */
export function analyseFrameCandidate(
  region: RawRegion, grid: Uint16Array, gridW: number,
): { isFrame: boolean; hRows: number[]; vCols: number[]; paneColour: number; bw: { t: number; b: number; l: number; r: number } } {
  const none = { isFrame: false, hRows: [], vCols: [], paneColour: -1, bw: { t: 1, b: 1, l: 1, r: 1 } };
  const { r0, r1, c0, c1 } = region;
  const h = r1 - r0 + 1, w = c1 - c0 + 1;
  if (h < 5 || w < 5) return none;

  const cellSet = new Set(region.cells);
  const at = (r: number, c: number) => cellSet.has(r * gridW + c);

  // Border coverage: fraction of the bbox perimeter that is frame colour.
  let per = 0, perHit = 0;
  for (let c = c0; c <= c1; c++) { per += 2; if (at(r0, c)) perHit++; if (at(r1, c)) perHit++; }
  for (let r = r0 + 1; r < r1; r++) { per += 2; if (at(r, c0)) perHit++; if (at(r, c1)) perHit++; }
  if (perHit / per < 0.85) return none;

  // Measure ACTUAL border thickness per side: consecutive fully-spanned
  // rows from the top/bottom, and fully-spanned columns from left/right.
  // Without this, a 2-wide left border reads its inner column as a
  // "vertical divider" (caught by test [1]).
  // Coverage-tolerant, not literal 100%: matches the 0.85 tolerance already
  // used for perimeter coverage and interior hRun/vRun detection everywhere
  // else in this function. A single stray quantization pixel (background dot,
  // anti-aliased corner) should not make an otherwise-solid border row/column
  // measure as 1 cell short — that under-measurement then causes the interior
  // scan to start early and pick up the border's own next cell as a false
  // divider candidate. Confirmed live: a bottom-left window's true 2-cell left
  // border under-measured as 1 due to one stray pixel, producing a spurious
  // second vDivider that pair-congruence then propagated onto its twin.
  const BORDER_COVERAGE_THRESH = 0.85;
  const rowFull = (r: number) => {
    let hit = 0;
    for (let c = c0; c <= c1; c++) if (at(r, c)) hit++;
    return hit / (c1 - c0 + 1) >= BORDER_COVERAGE_THRESH;
  };
  const colFull = (c: number) => {
    let hit = 0;
    for (let r = r0; r <= r1; r++) if (at(r, c)) hit++;
    return hit / (r1 - r0 + 1) >= BORDER_COVERAGE_THRESH;
  };
  let bwT = 0; while (bwT < h && rowFull(r0 + bwT)) bwT++;
  let bwB = 0; while (bwB < h && rowFull(r1 - bwB)) bwB++;
  let bwL = 0; while (bwL < w && colFull(c0 + bwL)) bwL++;
  let bwR = 0; while (bwR < w && colFull(c1 - bwR)) bwR++;
  bwT = Math.max(1, bwT); bwB = Math.max(1, bwB); bwL = Math.max(1, bwL); bwR = Math.max(1, bwR);
  console.log("DIAG: border widths:", JSON.stringify({ r0, c0, r1, c1, bwT, bwB, bwL, bwR }));
  if (bwT + bwB >= h || bwL + bwR >= w) return none; // solid block, no interior


  // Interior rows/cols (beyond the measured borders) fully spanned by frame
  // colour are dividers. Consecutive spanned lines collapse to their centre.
  const iR0 = r0 + bwT, iR1 = r1 - bwB, iC0 = c0 + bwL, iC1 = c1 - bwR;
  const hRuns: number[][] = [];
  for (let r = iR0; r <= iR1; r++) {
    let hit = 0;
    for (let c = iC0; c <= iC1; c++) if (at(r, c)) hit++;
    if (hit / Math.max(1, iC1 - iC0 + 1) >= 0.85) {
      const last = hRuns[hRuns.length - 1];
      if (last && last[last.length - 1] === r - 1) last.push(r); else hRuns.push([r]);
    }
  }
  const vRuns: number[][] = [];
  for (let c = iC0; c <= iC1; c++) {
    let hit = 0;
    for (let r = iR0; r <= iR1; r++) if (at(r, c)) hit++;
    if (hit / Math.max(1, iR1 - iR0 + 1) >= 0.85) {
      const last = vRuns[vRuns.length - 1];
      if (last && last[last.length - 1] === c - 1) last.push(c); else vRuns.push([c]);
    }
  }
  // Border-bleed fold: a run touching iR0/iC0/iR1/iC1 is border bleed ONLY
  // if it is directly fused to the border (no pane gap) AND the border's
  // own measured thickness on that side is itself ambiguous (a partial,
  // not-fully-spanning row/col existed immediately outside the measured
  // border — i.e. rowFull()/colFull() under-counted by exactly one line).
  // A genuine divider adjacent to a solid, cleanly-measured border has NO
  // such ambiguity signature and must be kept. The earlier version treated
  // every border-adjacent run as bleed unconditionally, which discarded
  // real dividers legitimately positioned close to a window's border —
  // confirmed live where one twin of a paired window kept its divider and
  // the other lost it.
  const rowPartial = (r: number) => {
    let hit = 0;
    for (let c = c0; c <= c1; c++) if (at(r, c)) hit++;
    const frac = hit / Math.max(1, c1 - c0 + 1);
    return frac > 0 && frac < 1;
  };
  const colPartial = (c: number) => {
    let hit = 0;
    for (let r = r0; r <= r1; r++) if (at(r, c)) hit++;
    const frac = hit / Math.max(1, r1 - r0 + 1);
    return frac > 0 && frac < 1;
  };
  const isBorderBleed = (
    run: number[], lo: number, hi: number, borderLo: number, borderHi: number,
    partial: (x: number) => boolean,
  ): boolean => {
    if (run[0] === lo && partial(borderLo)) return true;
    if (run[run.length - 1] === hi && partial(borderHi)) return true;
    return false;
  };
  const hInterior = hRuns.filter((run) => !isBorderBleed(run, iR0, iR1, r0 + bwT - 1, r1 - bwB + 1, rowPartial));
  const vInterior = vRuns.filter((run) => !isBorderBleed(run, iC0, iC1, c0 + bwL - 1, c1 - bwR + 1, colPartial));
  let hRows = hInterior.map((run) => run[(run.length / 2) | 0]);
  let vCols = vInterior.map((run) => run[(run.length / 2) | 0]);

  // Minimum-pane-size merge: a real sash divider leaves a stitchable pane
  // (>=2 cells) on each side. Detected lines closer together than that are
  // near-duplicates of the SAME physical divider (shading/gradient noise in
  // the source produced two nearby partial-contrast rows/cols), not two
  // separate sashes. Collapse any run of candidates within minPane of each
  // other to their mean position. Observed live: an 11-row window reporting
  // 3 hDividers (rows 29,33,38) — implausible for a real window sash.
  const collapseClose = (arr: number[], minPane: number): number[] => {
    if (arr.length < 2) return arr;
    const sorted = [...arr].sort((a, b) => a - b);
    const out: number[] = [];
    let group = [sorted[0]];
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k] - group[group.length - 1] < minPane) group.push(sorted[k]);
      else { out.push(Math.round(group.reduce((s, v) => s + v, 0) / group.length)); group = [sorted[k]]; }
    }
    out.push(Math.round(group.reduce((s, v) => s + v, 0) / group.length));
    return out;
  };
  const MIN_PANE = 2;
  hRows = collapseClose(hRows, MIN_PANE);
  vCols = collapseClose(vCols, MIN_PANE);

  // Must actually be hollow with a dominant interior pane colour.
  let interiorNonFrame = 0;
  const paneTally: Record<number, number> = {};
  for (let r = iR0; r <= iR1; r++) {
    for (let c = iC0; c <= iC1; c++) {
      const idx = r * gridW + c;
      if (!cellSet.has(idx)) {
        interiorNonFrame++;
        paneTally[grid[idx]] = (paneTally[grid[idx]] ?? 0) + 1;
      }
    }
  }
  if (interiorNonFrame < 4) return none;
  let paneColour = -1, pc = 0;
  for (const k in paneTally) if (paneTally[+k] > pc) { pc = paneTally[+k]; paneColour = +k; }
  return { isFrame: true, hRows, vCols, paneColour, bw: { t: bwT, b: bwB, l: bwL, r: bwR } };
}

export function buildStructuralModel(
  grid: Uint16Array,
  gridW: number,
  gridH: number,
  outPalette: PaletteEntry[],
  segmentStampedCells: Set<number>,
  canvasShape?: string | null,
): StructuralModel {
  // Durable grid capture — writes the input grid to the private `chart-debug`
  // storage bucket so fixtures survive edge-log retention. Non-fatal: any
  // failure is logged and swallowed so a real generation is never impacted.
  try {
    const url = (globalThis as any).Deno?.env?.get?.("SUPABASE_URL");
    const key = (globalThis as any).Deno?.env?.get?.("SUPABASE_SERVICE_ROLE_KEY");
    if (url && key) {
      const gH = grid.length / gridW;
      const payload = JSON.stringify({
        gridW,
        gridH: gH,
        grid: Array.from(grid),
        palette: outPalette.map((p) => p.hex),
        // Diagnostics travel with the capture because edge logs roll off
        // within the hour. Additive only -- `grid` and `palette` above are
        // untouched.
        diag: {
          darkReserved: CHART_DIAG.darkReserved,
          protectedThreads: CHART_DIAG.protectedThreads,
          darkSegments: CHART_DIAG.darkSegments,
          paletteWithUsage: CHART_DIAG.paletteWithUsage,
          segmentAdmitted: CHART_DIAG.segmentAdmitted,
          segColourClusters: CHART_DIAG.segColourClusters,
          sourceStats: CHART_DIAG.sourceStats,

        },
      });
      const stamp = new Date().toISOString().replace(/:/g, "-");
      const path = `grids/${stamp}-${gridW}x${gH}.json`;
      // Fire-and-observe; keep the isolate alive via EdgeRuntime.waitUntil
      // so the upload isn't killed when the HTTP response returns.
      const uploadPromise = (async () => {
        try {
          const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
          const client = createClient(url, key, { auth: { persistSession: false } });
          const { error } = await client.storage
            .from("chart-debug")
            .upload(path, payload, { contentType: "application/json", upsert: false });
          if (error) console.error("DIAG: grid capture failed:", error.message);
          else console.log("DIAG: grid captured:", path);
        } catch (e) {
          console.error("DIAG: grid capture threw:", (e as Error).message);
        }
      })();
      if (typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
        (globalThis as any).EdgeRuntime.waitUntil(uploadPromise);
      }
    } else {
      console.error("DIAG: grid capture skipped — missing SUPABASE_URL/SERVICE_ROLE_KEY");
    }
  } catch (e) {
    console.error("DIAG: grid capture setup failed:", (e as Error).message);
  }
  // Background = the outermost region's colour, read from the grid itself,
  // plus pure white as a safety net. Never a colour-value heuristic.
  const outermost = identifyOutermostRegion(grid, gridW, gridH);
  const gridBgIds = new Set<number>();
  if (outermost) gridBgIds.add(outermost.colour);
  for (let i = 0; i < outPalette.length; i++) {
    const [r, g, b] = hexToRgbLocal(outPalette[i].hex);
    if (r >= 250 && g >= 250 && b >= 250) gridBgIds.add(i); // pure white only
  }
  const { bgIds, lightIds } = classifyPalette(outPalette, gridBgIds);

  const model: StructuralModel = {
    gridW, gridH, frames: [], freeLines: [], ownedCells: new Set(),
  };

  // ---- Frames: light hollow rectangles (geometry authoritative) ---------
  // Geometry is authoritative: solid-framed windows are barely stamped, so
  // the prior stamp-evidence prerequisite ate real windows. analyseFrameCandidate
  // rejects the merged-mullion blob (low border coverage) and 1-wide outlines
  // (too small); nested-frame suppression below removes light panes inside a
  // detected frame. Confirmed against _fixture-live.json.
  const siblingCandidates: SiblingCandidate[] = [];
  const lightRegions = connectedRegions(grid, gridW, gridH, (c) => lightIds.has(c));
  for (const region of lightRegions) {
    const a = analyseFrameCandidate(region, grid, gridW);
    const rH = region.r1 - region.r0 + 1, rW = region.c1 - region.c0 + 1;
    if (rH < 5 || rW < 5) continue;

    if (a.isFrame) {
      model.frames.push({
        kind: "frame",
        frameColour: region.colour,
        paneColour: a.paneColour,
        r0: region.r0, c0: region.c0, r1: region.r1, c1: region.c1,
        // Border strokes are definitionally 1 stitch in this domain. When
        // analyseFrameCandidate measures a.bw.* > 1 it is a downsample artifact
        // (proven by matched-pair twins reporting DISAGREEING per-side widths —
        // physically impossible for real design). Keep a.bw for divider
        // detection, but normalise the persisted borderW to 1 on all sides.
        borderW: { t: 1, b: 1, l: 1, r: 1 },
        hDividers: a.hRows,
        vDividers: a.vCols,
        pairId: null,
      });
      siblingCandidates.push({
        id: siblingCandidates.length, colour: region.colour,
        r0: region.r0, r1: region.r1, c0: region.c0, c1: region.c1,
        accepted: true, hDividerCount: a.hRows.length, vDividerCount: a.vCols.length,
        paneColour: a.paneColour, coverage: 1, hollow: true,
        frameCellCount: region.cells.length,
      });
    } else {
      const cellSet = new Set(region.cells);
      const at = (r: number, c: number) => cellSet.has(r * gridW + c);
      let per = 0, perHit = 0;
      for (let c = region.c0; c <= region.c1; c++) { per += 2; if (at(region.r0, c)) perHit++; if (at(region.r1, c)) perHit++; }
      for (let r = region.r0 + 1; r < region.r1; r++) { per += 2; if (at(r, region.c0)) perHit++; if (at(r, region.c1)) perHit++; }
      const coverage = per ? perHit / per : 0;
      let interiorNonFrame = 0, interiorTotal = 0;
      const paneTally: Record<number, number> = {};
      for (let r = region.r0 + 1; r < region.r1; r++) for (let c = region.c0 + 1; c < region.c1; c++) {
        interiorTotal++;
        if (!at(r, c)) {
          interiorNonFrame++;
          const pc = grid[r * gridW + c];
          paneTally[pc] = (paneTally[pc] ?? 0) + 1;
        }
      }
      const hollow = interiorTotal > 0 && interiorNonFrame / interiorTotal > 0.3;
      // Compute a real dominant interior colour so mirror-pair recovery
      // never propagates -1 into ModelFrame.paneColour (which would write
      // 65535 into the Uint16Array grid via renderModel's put() and blank
      // out every interior cell). If no non-frame interior pixels exist,
      // paneColour stays -1 and recoverMirrorPair filters this candidate out.
      let paneColour = -1, pc = 0;
      for (const k in paneTally) if (paneTally[+k] > pc) { pc = paneTally[+k]; paneColour = +k; }
      siblingCandidates.push({
        id: siblingCandidates.length, colour: region.colour,
        r0: region.r0, r1: region.r1, c0: region.c0, c1: region.c1,
        accepted: false, hDividerCount: 0, vDividerCount: 0,
        paneColour, coverage, hollow,
        frameCellCount: region.cells.length,
      });
    }
  }

  // A brick canvas is five independently-generated panels stitched into one
  // image, so mirror-matching about the whole canvas's centreline manufactures
  // bogus duplicates across panel boundaries. Skip whole-canvas passes there.
  const recovered = canvasShape === "brick"
    ? []
    : planSiblingRegularization(
        siblingCandidates,
        model.frames.map((f) => ({ r0: f.r0, r1: f.r1, c0: f.c0, c1: f.c1 })),
        gridW,
      );
  const evenlySpaced = (lo: number, hi: number, n: number): number[] => {
    if (n === 0) return [];
    const out: number[] = [];
    for (let k = 1; k <= n; k++) out.push(Math.round(lo + ((hi - lo) * k) / (n + 1)));
    return out;
  };
  for (const rf of recovered) {
    model.frames.push({
      kind: "frame", frameColour: rf.colour, paneColour: rf.paneColour,
      r0: rf.r0, c0: rf.c0, r1: rf.r1, c1: rf.c1,
      borderW: { t: 1, b: 1, l: 1, r: 1 },
      hDividers: evenlySpaced(rf.r0 + 1, rf.r1 - 1, rf.hDividerCount),
      vDividers: evenlySpaced(rf.c0 + 1, rf.c1 - 1, rf.vDividerCount),
      pairId: null,
    });
  }

  const dividerFixes = planDividerReconciliation(siblingCandidates);
  for (const fix of dividerFixes) {
    const srcCand = siblingCandidates[fix.id];
    if (!srcCand) continue;
    const targetFrame = model.frames.find((f) => f.r0 === srcCand.r0 && f.c0 === srcCand.c0 && f.r1 === srcCand.r1 && f.c1 === srcCand.c1);
    if (!targetFrame) continue;
    if (fix.hDividerCount !== targetFrame.hDividers.length) {
      targetFrame.hDividers = evenlySpaced(targetFrame.r0 + 1, targetFrame.r1 - 1, fix.hDividerCount);
    }
    if (fix.vDividerCount !== targetFrame.vDividers.length) {
      targetFrame.vDividers = evenlySpaced(targetFrame.c0 + 1, targetFrame.c1 - 1, fix.vDividerCount);
    }
  }

  // Nested-frame suppression: a candidate whose bbox sits inside another
  // frame's bbox is interior structure of that frame, not its own frame.
  model.frames = model.frames.filter((f, i) =>
    !model.frames.some((g2, j) => j !== i &&
      f.r0 >= g2.r0 && f.r1 <= g2.r1 && f.c0 >= g2.c0 && f.c1 <= g2.c1 &&
      (g2.r1 - g2.r0) * (g2.c1 - g2.c0) > (f.r1 - f.r0) * (f.c1 - f.c0)));

  // ---- Free lines: segment-stamped cells not inside any frame bbox -------
  const inAnyFrame = (idx: number): boolean => {
    const r = (idx / gridW) | 0, c = idx % gridW;
    return model.frames.some((f) => r >= f.r0 && r <= f.r1 && c >= f.c0 && c <= f.c1);
  };
  const freeCells = [...segmentStampedCells].filter((i) => !inAnyFrame(i) && !bgIds.has(grid[i]));
  // Group free cells by colour + 8-connectivity.
  const freeSet = new Set(freeCells);
  const seen = new Set<number>();
  for (const s of freeCells) {
    if (seen.has(s)) continue;
    const colour = grid[s];
    const comp: number[] = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const r = (i / gridW) | 0, c = i % gridW;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
        const ni = nr * gridW + nc;
        if (freeSet.has(ni) && !seen.has(ni) && grid[ni] === colour) { seen.add(ni); stack.push(ni); }
      }
    }
    if (comp.length >= 3) model.freeLines.push({ kind: "freeline", colour, cells: comp });
  }

  // ---- Pair detection (congruence constraint targets) --------------------
  if (canvasShape !== "brick") detectFramePairs(model);

  return model;
}

function detectFramePairs(model: StructuralModel): void {
  const centreC = model.gridW / 2;
  let nextPair = 1;
  const fs = model.frames;
  for (let i = 0; i < fs.length; i++) {
    if (fs[i].pairId !== null) continue;
    for (let j = i + 1; j < fs.length; j++) {
      if (fs[j].pairId !== null) continue;
      const a = fs[i], b = fs[j];
      if (a.frameColour !== b.frameColour) continue;
      const aCr = (a.r0 + a.r1) / 2, bCr = (b.r0 + b.r1) / 2;
      if (Math.abs(aCr - bCr) > 3) continue;
      const aCc = (a.c0 + a.c1) / 2, bCc = (b.c0 + b.c1) / 2;
      if ((aCc - centreC) * (bCc - centreC) >= 0) continue;        // must straddle centre
      if (Math.abs(Math.abs(aCc - centreC) - Math.abs(bCc - centreC)) > 4) continue;
      const aW = a.c1 - a.c0, bW = b.c1 - b.c0;
      const aH = a.r1 - a.r0, bH = b.r1 - b.r0;
      if (Math.abs(aW - bW) > 3 || Math.abs(aH - bH) > 3) continue;
      a.pairId = b.pairId = nextPair++;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3a — constraints (object space)
// ---------------------------------------------------------------------------

export function applyConstraints(model: StructuralModel): void {
  // 1. Pair congruence: paired frames adopt identical dimensions & layout.
  //    Canonical = intersection of extents (trim-only, never grow).
  const byPair = new Map<number, ModelFrame[]>();
  for (const f of model.frames) {
    if (f.pairId === null) continue;
    const list = byPair.get(f.pairId) ?? [];
    list.push(f);
    byPair.set(f.pairId, list);
  }
  const centreC = model.gridW / 2;
  for (const [, pair] of byPair) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const h = Math.min(a.r1 - a.r0, b.r1 - b.r0);
    const w = Math.min(a.c1 - a.c0, b.c1 - b.c0);
    // Columns: intersect the left frame's span with the MIRROR of its
    // partner's span, then place both frames mirror-symmetrically on that
    // common span. Trim-only by construction (the intersection is a subset
    // of both original spans) and mirror-exact regardless of which side of
    // either frame the quantisation excess landed on. The old rule (both
    // frames trim their right edge) was mirror-correct only when the wider
    // frame's excess sat on its right side -- a coin flip per generation,
    // measured as 0 vs 104 asymmetric cells on the same symmetric facade;
    // a fixed-side trim merely swaps which case fails.
    const axis = model.gridW - 1;          // mirror of column c is axis - c
    const leftF = ((a.c0 + a.c1) / 2) <= ((b.c0 + b.c1) / 2) ? a : b;
    const rightF = leftF === a ? b : a;
    const C0 = Math.max(leftF.c0, axis - rightF.c1);
    const C1 = Math.min(leftF.c1, axis - rightF.c0);
    if (C1 - C0 >= 4) {
      leftF.c0 = C0; leftF.c1 = C1;
      rightF.c0 = axis - C1; rightF.c1 = axis - C0;
    } else {
      // Degenerate mirror overlap (pair far from true mirror positions) --
      // fall back to width equalisation without repositioning.
      for (const f of pair) { if ((f.c0 + f.c1) / 2 > centreC) f.c0 = f.c1 - w; else f.c1 = f.c0 + w; }
    }
    for (const f of pair) { f.r1 = f.r0 + h; }
    // Divider layout: use frame-relative positions from whichever frame has
    // more dividers detected (more complete), applied to both. Offsets are
    // measured from each frame's own interior start so per-side border
    // widths (which may differ between the two frames) are respected.
    const donor = (a.hDividers.length + a.vDividers.length) >= (b.hDividers.length + b.vDividers.length) ? a : b;
    const relH = donor.hDividers.map((r) => r - (donor.r0 + donor.borderW.t));
    const relV = donor.vDividers.map((c) => c - (donor.c0 + donor.borderW.l));
    for (const f of pair) {
      f.hDividers = relH.map((d) => f.r0 + f.borderW.t + d);
      f.vDividers = relV.map((d) => f.c0 + f.borderW.l + d);
    }
  }

  // 2. Parity snap + divider centring, per frame.
  for (const f of model.frames) {
    const innerR0 = f.r0 + f.borderW.t, innerR1 = f.r1 - f.borderW.b;
    const innerC0 = f.c0 + f.borderW.l, innerC1 = f.c1 - f.borderW.r;

    // Vertical dividers split the interior width into (n+1) panes.
    // Equal panes need: innerW - n ≡ 0 (mod n+1). Snap by trimming inward
    // (never grow) until parity is satisfied -- toward the mirror axis for
    // paired frames (left edge when the frame sits right of centre), right
    // edge otherwise, matching the pair-congruence trim direction above.
    const trimLeft = f.pairId !== null && (f.c0 + f.c1) / 2 > centreC;
    f.vDividers = snapDividers(innerC0, innerC1, f.vDividers.length, (shrink) => { if (trimLeft) f.c0 += shrink; else f.c1 -= shrink; });
    const ic0 = f.c0 + f.borderW.l;                  // recompute after snap
    const ic1 = f.c1 - f.borderW.r;
    f.vDividers = placeDividers(ic0, ic1, f.vDividers.length);

    f.hDividers = snapDividers(innerR0, innerR1, f.hDividers.length, (shrink) => { f.r1 -= shrink; });
    const ir1 = f.r1 - f.borderW.b;
    f.hDividers = placeDividers(innerR0, ir1, f.hDividers.length);
  }


  // Helper: returns dummy array (length preserved) — real positions come
  // from placeDividers after the snap mutation runs.
  function snapDividers(
    lo: number, hi: number, nDividers: number, shrinkFrame: (by: number) => void,
  ): number[] {
    if (nDividers === 0) return [];
    const inner = hi - lo + 1;
    const panes = nDividers + 1;
    const rem = (inner - nDividers) % panes;
    if (rem !== 0) shrinkFrame(rem);                 // trim-only parity snap
    return new Array(nDividers).fill(0);
  }

  function placeDividers(lo: number, hi: number, n: number): number[] {
    if (n === 0) return [];
    const inner = hi - lo + 1;
    const paneW = (inner - n) / (n + 1);
    const out: number[] = [];
    let cursor = lo;
    for (let k = 0; k < n; k++) {
      cursor += paneW;
      out.push(Math.round(cursor));
      cursor += 1;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Phase 3b — rendering (single deterministic rasterisation)
// ---------------------------------------------------------------------------

export function renderModel(
  model: StructuralModel,
  grid: Uint16Array,
  outUsage: Record<string, number>,
  outPalette: PaletteEntry[],
  renderFreeLines = true,
): void {
  const { gridW } = model;
  const outermostR = identifyOutermostRegion(grid, gridW, model.gridH);
  const gridBgIdsR = new Set<number>();
  if (outermostR) gridBgIdsR.add(outermostR.colour);
  for (let i = 0; i < outPalette.length; i++) {
    const [r, g, b] = hexToRgbLocal(outPalette[i].hex);
    if (r >= 250 && g >= 250 && b >= 250) gridBgIdsR.add(i);
  }
  const { bgIds } = classifyPalette(outPalette, gridBgIdsR);
  const bgFill = bgIds.size ? [...bgIds][0] : 0;

  const put = (idx: number, colour: number) => {
    const old = grid[idx];
    if (old === colour) { model.ownedCells.add(idx); return; }
    outUsage[String(old)] = Math.max(0, (outUsage[String(old)] ?? 0) - 1);
    outUsage[String(colour)] = (outUsage[String(colour)] ?? 0) + 1;
    grid[idx] = colour;
    model.ownedCells.add(idx);
  };

  for (const f of model.frames) {
    // Clear anything the (possibly shrunk) frame no longer covers: cells of
    // frame colour in the ORIGINAL grid outside the new rect are handled by
    // the caller diffing before/after; within this function we render the
    // definitive frame area only.
    // 1) Panes
    const iR0 = f.r0 + f.borderW.t, iR1 = f.r1 - f.borderW.b;
    const iC0 = f.c0 + f.borderW.l, iC1 = f.c1 - f.borderW.r;
    for (let r = iR0; r <= iR1; r++) {
      for (let c = iC0; c <= iC1; c++) {
        put(r * gridW + c, f.paneColour);
      }
    }
    // 2) Border, per-side thickness
    for (let w = 0; w < f.borderW.t; w++) {
      for (let c = f.c0; c <= f.c1; c++) put((f.r0 + w) * gridW + c, f.frameColour);
    }
    for (let w = 0; w < f.borderW.b; w++) {
      for (let c = f.c0; c <= f.c1; c++) put((f.r1 - w) * gridW + c, f.frameColour);
    }
    for (let w = 0; w < f.borderW.l; w++) {
      for (let r = f.r0; r <= f.r1; r++) put(r * gridW + f.c0 + w, f.frameColour);
    }
    for (let w = 0; w < f.borderW.r; w++) {
      for (let r = f.r0; r <= f.r1; r++) put(r * gridW + f.c1 - w, f.frameColour);
    }
    // 3) Dividers, full strokes — junctions intact by construction because
    //    both the horizontal and vertical stroke write the shared cell.
    for (const dr of f.hDividers) {
      for (let c = iC0; c <= iC1; c++) put(dr * gridW + c, f.frameColour);
    }
    for (const dc of f.vDividers) {
      for (let r = iR0; r <= iR1; r++) put(r * gridW + dc, f.frameColour);
    }

  }

  // Free lines: re-stamp their cells and bridge any diagonal-only breaks so
  // every free line is 4-connected end to end.
  //
  // renderFreeLines=false leaves free lines ENTIRELY to the existing pith /
  // segment machinery: at 13-mesh, diagonally-adjacent stitches read as a
  // connected diagonal line — that is how diagonals are stitched — so
  // orthogonal bridging would thicken deliberate diagonals (margarita pith)
  // into staircases. The Phase 3 cutover therefore renders frames only.
  if (!renderFreeLines) { void bgFill; return; }
  for (const line of model.freeLines) {
    const cellSet = new Set(line.cells);
    for (const idx of line.cells) put(idx, line.colour);
    for (const idx of line.cells) {
      const r = (idx / gridW) | 0, c = idx % gridW;
      for (const [dr, dc] of [[1, 1], [1, -1]] as const) {
        const ni = (r + dr) * gridW + (c + dc);
        if (!cellSet.has(ni)) continue;
        const b1 = r * gridW + (c + dc);
        const b2 = (r + dr) * gridW + c;
        if (!cellSet.has(b1) && !cellSet.has(b2)) put(b1, line.colour);
      }
    }
  }

  void bgFill; // reserved for caller-side diff clearing
}

// ---------------------------------------------------------------------------
// Convenience entry point matching the old pass call sites
// ---------------------------------------------------------------------------

export function runStructuralPass(
  grid: Uint16Array,
  gridW: number,
  gridH: number,
  outPalette: PaletteEntry[],
  outUsage: Record<string, number>,
  segmentStampedCells: Set<number>,
  opts: { renderFreeLines?: boolean; canvasShape?: string | null } = {},
): StructuralModel {
  const model = buildStructuralModel(grid, gridW, gridH, outPalette, segmentStampedCells, opts.canvasShape);

  // Snapshot frame footprints BEFORE constraints so shrunk frames get their
  // orphaned cells cleared back to the surrounding fill.
  const before = model.frames.map((f) => ({ ...f }));

  applyConstraints(model);
  renderModel(model, grid, outUsage, outPalette, opts.renderFreeLines ?? true);

  // Clear orphaned frame-colour cells left outside shrunk rects.
  for (let i = 0; i < model.frames.length; i++) {
    const was = before[i], now = model.frames[i];
    if (was.r1 === now.r1 && was.c1 === now.c1 && was.r0 === now.r0 && was.c0 === now.c0) continue;
    // Fill colour: sample just outside the ORIGINAL rect midpoints.
    const midR = ((was.r0 + was.r1) / 2) | 0;
    const outside = (was.c1 + 1 < gridW) ? grid[midR * gridW + was.c1 + 1] : grid[midR * gridW + Math.max(0, was.c0 - 1)];
    for (let r = was.r0; r <= was.r1; r++) {
      for (let c = was.c0; c <= was.c1; c++) {
        const inNew = r >= now.r0 && r <= now.r1 && c >= now.c0 && c <= now.c1;
        if (inNew) continue;
        const idx = r * gridW + c;
        // Clear ANY leftover pixel in the vacated strip, not just ones
        // matching the frame's own colour/pane colour. A vacated strip can
        // contain a genuine THIRD colour (a source-image anti-aliasing
        // artifact unrelated to either) that the old narrower check let
        // survive untouched into the final render. Confirmed live: a stray
        // tan pixel, neither frame nor pane colour, sat in a column a
        // pair-congruence shrink vacated, and was never repainted.
        if (grid[idx] !== outside) {
          outUsage[String(grid[idx])] = Math.max(0, (outUsage[String(grid[idx])] ?? 0) - 1);
          outUsage[String(outside)] = (outUsage[String(outside)] ?? 0) + 1;
          grid[idx] = outside;
        }
      }
    }
  }

  return model;
}

// ---------------------------------------------------------------------------
// §5.2 groundwork — background as the OUTERMOST REGION, not "white cells".
// The current engine assumes white canvas; Scenes and photographic input
// both break that. This identifies the region touching the grid border as
// the background candidate regardless of its colour. Shadow-logged in
// Phase 2; becomes the background authority when Scenes lands.
// ---------------------------------------------------------------------------
export function identifyOutermostRegion(
  grid: Uint16Array,
  gridW: number,
  gridH: number,
): { colour: number; cellCount: number; touchesAllSides: boolean } | null {
  // Flood from every border cell; the largest single-colour component that
  // touches the border is the outermost region.
  const N = gridW * gridH;
  const seen = new Uint8Array(N);
  let best: { colour: number; cellCount: number; sides: Set<string> } | null = null;

  const borderStarts: number[] = [];
  for (let c = 0; c < gridW; c++) { borderStarts.push(c, (gridH - 1) * gridW + c); }
  for (let r = 1; r < gridH - 1; r++) { borderStarts.push(r * gridW, r * gridW + gridW - 1); }

  for (const s of borderStarts) {
    if (seen[s]) continue;
    const colour = grid[s];
    const sides = new Set<string>();
    let count = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      count++;
      const r = (i / gridW) | 0, c = i % gridW;
      if (r === 0) sides.add("top");
      if (r === gridH - 1) sides.add("bottom");
      if (c === 0) sides.add("left");
      if (c === gridW - 1) sides.add("right");
      const nbs = [i - 1, i + 1, i - gridW, i + gridW];
      const ok = [c > 0, c < gridW - 1, r > 0, r < gridH - 1];
      for (let k = 0; k < 4; k++) {
        if (!ok[k]) continue;
        const ni = nbs[k];
        if (!seen[ni] && grid[ni] === colour) { seen[ni] = 1; stack.push(ni); }
      }
    }
    if (!best || count > best.cellCount) best = { colour, cellCount: count, sides };
  }
  if (!best) return null;
  return { colour: best.colour, cellCount: best.cellCount, touchesAllSides: best.sides.size === 4 };
}
