// Palette near-duplicate merge pre-pass.
//
// Runs after the final thread palette is picked and the grid is remapped to
// its new indices, but BEFORE structural passes (frame detection, sibling
// regularisation, pith overlay). It collapses palette entries that are
// numerically near-identical AND cover a trivially-small minority share of
// their pair — the fingerprint of quantization noise (e.g. a handful of
// #46423D stitches speckled across a solid #32363D roof) rather than a
// distinct architectural element.
//
// Gate — calibrated from real fixtures (see _scratch_palette_merge.ts):
//
//   MERGE if  ΔE (CIEDE2000) < 11  AND  minorityFraction < 0.045
//
//   where minorityFraction = min(usageA, usageB) / (usageA + usageB).
//
// Measured pairs (dE / minFrac):
//   MUST-MERGE (house-surround roof) 3-4:  8.94 / 0.0336  → merge
//   MUST-MERGE (house-surround red)  1-5:  8.49 / 0.0010  → merge
//   MUST-KEEP  (house-surround wh/cream) 0-2: 9.03 / 0.3095 → keep (minFrac gate)
//   MUST-KEEP  (butterfly-2 highlight dot) 0-3: 5.86 / 0.0739 → keep (minFrac gate)
//   MUST-KEEP  (ornate trim vs bg)   2-4: 10.56 / 0.0519 → keep (minFrac gate)
//   MUST-KEEP  (ornate reds)         3-6: 13.06 / 0.0219 → keep (dE gate)
//
// The two gates are independent: single-scalar ΔE is insufficient (dE 9.03
// must-keep sits between dE 8.49/8.94 must-merge and dE 10.56/13.06 must-keep),
// and single-scalar minFrac is insufficient (butterfly-2 dots at 0.0739 sit
// above the roof at 0.0336). Both signals together yield real separation on
// every fixture we've captured.

import { ciede2000 } from "./chartability.ts";

export const PALETTE_MERGE_DE_CEILING = 11;
export const PALETTE_MERGE_MINORITY_FRACTION_CEILING = 0.045;

export interface OutPaletteEntry {
  id: string;
  name: string;
  family: string;
  hex: string;
}

export interface MergeResult {
  merged: boolean;
  merges: Array<{ absorbed: number; survivor: number; dE: number; minFrac: number }>;
  /** Map from old (pre-merge) palette index → new (post-merge) index. */
  oldToSurvivor: number[];
}

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function srgbToLinear(c: number): number { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.0;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Merge near-duplicate palette entries in place.
 *
 * Mutates: `remapped` (cell indices), `outPalette` (removes absorbed entries),
 * `outUsage` (recounts), `symMap` (drops absorbed keys, rekeys survivors),
 * `sections` (removes absorbed indices, remaps survivors), `oldToNew` (points
 * absorbed old-indices at the survivor's new index).
 *
 * Returns the merge plan for logging/tests.
 */
export function mergeNearDuplicatePaletteEntries(
  remapped: Uint16Array,
  outPalette: OutPaletteEntry[],
  outUsage: Record<string, number>,
  symMap: Record<string, string>,
  sections: Array<{ name: string; paletteIndexes: number[] }>,
  oldToNew: Map<number, number>,
  opts?: {
    deCeiling?: number;
    minorityFractionCeiling?: number;
    protectedIndices?: Set<number>;
    /**
     * When true, merge any pair within `deCeiling` regardless of their
     * population balance. Median-cut given more bins than the artwork has
     * real colours will split ONE design colour into several near-identical
     * entries, all with substantial population -- so the minority-share gate
     * (correct for quantization noise) cannot catch them.
     *
     * Only safe with a TIGHT deCeiling. The house fixture's white/cream pair
     * at deltaE 9.03 must never merge (it is the window-frame vs background
     * distinction; merging it deletes glazing bars -- see the background-
     * protection fix). Callers must stay well below that.
     */
    ignoreMinorityShare?: boolean;
    /**
     * Audit A3. When set, a candidate pair must ALSO be spatially
     * interleaved to merge. Median-cut splitting one real colour leaves the
     * two entries speckled through the same region (interleave ~1.0); two
     * genuinely different design colours occupy separate regions and only
     * meet along an edge (interleave < 0.3). Using min() of the two
     * directions is what protects thin features: a 1-stitch outline has
     * nearly all its cells touching the fill, but the fill has very few
     * touching the outline.
     */
    spatialGate?: { gridW: number; gridH: number; minInterleave: number };
  },
): MergeResult {
  const deCeiling = opts?.deCeiling ?? PALETTE_MERGE_DE_CEILING;
  const minFracCeiling = opts?.minorityFractionCeiling ?? PALETTE_MERGE_MINORITY_FRACTION_CEILING;
  const protectedIndices = opts?.protectedIndices ?? new Set<number>();
  const ignoreMinorityShare = opts?.ignoreMinorityShare ?? false;

  const n = outPalette.length;
  if (n < 2) return { merged: false, merges: [], oldToSurvivor: Array.from({ length: n }, (_, i) => i) };

  const labs = outPalette.map((p) => { const [r, g, b] = hexToRgb(p.hex); return rgbToLab(r, g, b); });
  const usage = outPalette.map((_, i) => outUsage[String(i)] ?? 0);

  // Enumerate qualifying pairs, sorted by dE (closest first).
  interface Cand { i: number; j: number; dE: number; minFrac: number }
  // Contact matrix for the spatial gate (audit A3). One pass over the grid:
  // for each colour, how many of its cells have at least one neighbour of
  // each other colour. O(N*4), computed once for all candidate pairs.
  let contactHas: Int32Array | null = null;
  let contactCount: Int32Array | null = null;
  if (opts?.spatialGate) {
    const { gridW: gW, gridH: gH } = opts.spatialGate;
    contactHas = new Int32Array(n * n);
    contactCount = new Int32Array(n);
    const seenNb = new Set<number>();
    for (let y = 0; y < gH; y++) {
      for (let x = 0; x < gW; x++) {
        const a = remapped[y * gW + x];
        if (a >= n) continue;
        contactCount[a]++;
        seenNb.clear();
        if (x > 0) seenNb.add(remapped[y * gW + x - 1]);
        if (x < gW - 1) seenNb.add(remapped[y * gW + x + 1]);
        if (y > 0) seenNb.add(remapped[(y - 1) * gW + x]);
        if (y < gH - 1) seenNb.add(remapped[(y + 1) * gW + x]);
        for (const b of seenNb) if (b !== a && b < n) contactHas[a * n + b]++;
      }
    }
  }
  const interleaveOf = (i: number, j: number): number => {
    if (!contactHas || !contactCount) return 1;
    if (contactCount[i] === 0 || contactCount[j] === 0) return 0;
    return Math.min(
      contactHas[i * n + j] / contactCount[i],
      contactHas[j * n + i] / contactCount[j],
    );
  };
  const cands: Cand[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (protectedIndices.has(i) || protectedIndices.has(j)) continue;
      const dE = ciede2000(labs[i], labs[j]);
      if (dE >= deCeiling) continue;

      const ui = usage[i], uj = usage[j];
      if (ui + uj === 0) continue;
      const minC = Math.min(ui, uj), majC = Math.max(ui, uj);
      const minFrac = minC / (minC + majC);
      if (!ignoreMinorityShare && minFrac >= minFracCeiling) continue;
      if (opts?.spatialGate && interleaveOf(i, j) < opts.spatialGate.minInterleave) continue;
      cands.push({ i, j, dE, minFrac });
    }
  }
  if (!cands.length) return { merged: false, merges: [], oldToSurvivor: Array.from({ length: n }, (_, i) => i) };
  cands.sort((a, b) => a.dE - b.dE);

  // Union-find where the higher-usage side always wins as the survivor.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const merges: MergeResult["merges"] = [];
  for (const c of cands) {
    const ri = find(c.i), rj = find(c.j);
    if (ri === rj) continue;
    const survivor = usage[ri] >= usage[rj] ? ri : rj;
    const absorbed = survivor === ri ? rj : ri;
    parent[absorbed] = survivor;
    usage[survivor] += usage[absorbed];
    usage[absorbed] = 0;
    merges.push({ absorbed, survivor, dE: c.dE, minFrac: c.minFrac });
  }

  const oldToCompact = applyAbsorptions(
    n, find, remapped, outPalette, outUsage, symMap, sections, oldToNew,
  );

  return { merged: true, merges, oldToSurvivor: oldToCompact };
}

/**
 * Shared absorb/compaction mechanics. Given a union-find `find` over the
 * current palette indices, rewrites grid cells, palette, usage, symbols,
 * sections and the source→out pointer map so that only union roots survive,
 * compacted to a contiguous index range. Returns old-index → new-index.
 */
function applyAbsorptions(
  n: number,
  find: (x: number) => number,
  remapped: Uint16Array,
  outPalette: OutPaletteEntry[],
  outUsage: Record<string, number>,
  symMap: Record<string, string>,
  sections: Array<{ name: string; paletteIndexes: number[] }>,
  oldToNew: Map<number, number>,
): number[] {
  // Compact: old-index → survivor old-index → new compact index.
  const rootOf = new Array(n).fill(0).map((_, i) => find(i));
  const survivorSet = new Set(rootOf);
  const compact = new Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (survivorSet.has(i)) compact[i] = next++;
  }
  const oldToCompact = rootOf.map((r) => compact[r]);

  // Rewrite remapped cells.
  for (let k = 0; k < remapped.length; k++) remapped[k] = oldToCompact[remapped[k]];

  // Rebuild outPalette / outUsage / symMap in place, compacted.
  const newPalette: OutPaletteEntry[] = [];
  const newUsage: Record<string, number> = {};
  const newSym: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    if (!survivorSet.has(i)) continue;
    const ni = compact[i];
    newPalette.push(outPalette[i]);
    // Sum usage across all old indices that root at i.
    let sum = 0;
    for (let k = 0; k < n; k++) if (rootOf[k] === i) sum += outUsage[String(k)] ?? 0;
    newUsage[String(ni)] = sum;
    newSym[String(ni)] = symMap[String(i)] ?? "";
  }
  outPalette.length = 0;
  for (const e of newPalette) outPalette.push(e);
  for (const k of Object.keys(outUsage)) delete outUsage[k];
  for (const k of Object.keys(newUsage)) outUsage[k] = newUsage[k];
  for (const k of Object.keys(symMap)) delete symMap[k];
  for (const k of Object.keys(newSym)) symMap[k] = newSym[k];

  // Rebuild sections: drop absorbed indices, remap survivors, dedupe.
  for (const sec of sections) {
    const remapped2 = new Set<number>();
    for (const idx of sec.paletteIndexes) {
      if (survivorSet.has(idx)) remapped2.add(oldToCompact[idx]);
    }
    sec.paletteIndexes = [...remapped2].sort((a, b) => a - b);
  }
  // Optional: could drop sections that ended up empty, but structural code
  // tolerates empty section lists; leave as-is to preserve stable ordering.

  // Update oldToNew: any (source-palette → outPalette) pointer that lands on
  // an absorbed entry must now point at its survivor's compact index.
  for (const [srcIdx, oldNew] of oldToNew) {
    oldToNew.set(srcIdx, oldToCompact[oldNew]);
  }

  return oldToCompact;
}

export interface CullResult {
  culled: boolean;
  /** Absorbed entries, by pre-cull index, with the target they folded into. */
  culls: Array<{ absorbed: number; survivor: number; usage: number; dE: number }>;
  /** Map from old (pre-cull) palette index → new (post-cull) index. */
  oldToSurvivor: number[];
}

/**
 * Unstitchable-remnant cull. Any palette entry used for fewer than `floor`
 * stitches is reassigned to its nearest REMAINING palette colour by CIEDE2000,
 * regardless of colour distance -- a stray brown among reds and greys is
 * colour-distant from everything, so the distance-gated near-duplicate merge
 * can never remove it. Deliberately distance-blind, usage-gated instead.
 *
 * Protected indices are never culled and are never used as cull targets, and
 * the cull always leaves at least 2 entries standing.
 *
 * Mutates the same structures as `mergeNearDuplicatePaletteEntries`.
 */
export function cullTinyEntries(
  remapped: Uint16Array,
  outPalette: OutPaletteEntry[],
  outUsage: Record<string, number>,
  symMap: Record<string, string>,
  sections: Array<{ name: string; paletteIndexes: number[] }>,
  oldToNew: Map<number, number>,
  floor: number,
  opts?: { protectedIndices?: Set<number> },
): CullResult {
  const protectedIndices = opts?.protectedIndices ?? new Set<number>();
  const n = outPalette.length;
  const identity = Array.from({ length: n }, (_, i) => i);
  if (n < 3) return { culled: false, culls: [], oldToSurvivor: identity };

  const labs = outPalette.map((p) => { const [r, g, b] = hexToRgb(p.hex); return rgbToLab(r, g, b); });
  const usage = outPalette.map((_, i) => outUsage[String(i)] ?? 0);

  // Smallest first: culling the tiniest remnants before larger ones keeps the
  // surviving set as close to the design's real colours as possible.
  const doomed = identity
    .filter((i) => !protectedIndices.has(i) && usage[i] < floor)
    .sort((a, b) => usage[a] - usage[b]);
  if (!doomed.length) return { culled: false, culls: [], oldToSurvivor: identity };

  const removed = new Set<number>();
  const culls: CullResult["culls"] = [];
  const parent = identity.slice();
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));

  for (const idx of doomed) {
    // Never leave fewer than 2 entries standing.
    if (n - removed.size <= 2) break;
    let best = -1;
    let bestDE = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === idx || removed.has(j) || protectedIndices.has(j)) continue;
      const dE = ciede2000(labs[idx], labs[j]);
      if (dE < bestDE) { bestDE = dE; best = j; }
    }
    if (best < 0) continue;
    const survivor = find(best);
    parent[idx] = survivor;
    removed.add(idx);
    culls.push({ absorbed: idx, survivor, usage: usage[idx], dE: bestDE });
  }
  if (!culls.length) return { culled: false, culls: [], oldToSurvivor: identity };

  const oldToCompact = applyAbsorptions(
    n, find, remapped, outPalette, outUsage, symMap, sections, oldToNew,
  );
  return { culled: true, culls, oldToSurvivor: oldToCompact };
}

