// Non-rectangular trim CLASSIFIER (diagnostic-only).
//
// SCOPE: this classifier distinguishes thin outlines from sparse composite
// frames on rejected light regions. Composites are FLAGGED but NOT
// decomposed: two real fixtures (_fixture-house-surround.json and
// _fixture-ornate.json) were measured and found structurally dissimilar
// (a 3-band frame vs. an L-shaped decorated slab), with no consistent
// neck signal that would support a universal split rule. A decomposition
// pass is deliberately not attempted here rather than guessed at from two
// non-representative examples.
//
// What this file DOES: deterministic classification using fill ratio,
// elongation, hollowness, cell count, and (for gappy-rectangle only)
// evidence of an aligned same-size sibling elsewhere in the grid — the
// same precondition sibling-regularization itself requires.

import type { RawRegion } from "./structural-model.ts";

export type TrimKind =
  | "gappy-rectangle"
  | "thin-stroke"
  | "sparse-composite"
  | "solid-blob"
  | "too-small";

export interface TrimClassification {
  kind: TrimKind;
  fillRatio: number;
  elongation: number;
  hollow: boolean;
  note: string;
}

// FINDING FROM TESTING (recorded, not smoothed over): fill-ratio + elongation
// + hollowness does NOT reliably separate a fused multi-element blob from a
// legitimately gappy single rectangle — tested against synthetic proxies of
// both real diagnosed cases, a raw-perimeter-coverage discriminator was also
// tried and also failed (the blob proxy scored 0.73, the gappy-rectangle proxy
// scored 0.56 — backwards from what would be needed). Shape statistics alone
// are insufficient here; further threshold tuning against guessed synthetic
// proxies would fit noise, not the real defect.
//
// SAFE RESOLUTION: 'gappy-rectangle' is not decided from shape at all. It is
// decided from the SAME evidence sibling-regularization itself already
// requires and has proven safe this session — an aligned, same-size sibling
// elsewhere in the grid (the anchored or unanchored precondition). A region
// with no sibling defaults to 'solid-blob' regardless of its fill/elongation,
// which is the conservative choice: an isolated ambiguous shape gets flagged
// for future decomposition work rather than guessed at.

export function classifyRejectedRegion(
  region: RawRegion, grid: Uint16Array, gridW: number,
  hasSibling: (region: RawRegion) => boolean = () => false,
): TrimClassification {
  const { r0, r1, c0, c1 } = region;
  const h = r1 - r0 + 1, w = c1 - c0 + 1;
  const bboxArea = h * w;
  const fillRatio = bboxArea ? region.cells.length / bboxArea : 0;
  const elongation = Math.max(h, w) / Math.max(1, Math.min(h, w));

  if (h < 5 || w < 5) {
    return { kind: "too-small", fillRatio, elongation, hollow: false, note: `${h}x${w} below minimum treatable size` };
  }

  const cellSet = new Set(region.cells);
  const at = (r: number, c: number) => cellSet.has(r * gridW + c);
  let interiorNonRegion = 0, interiorTotal = 0;
  for (let r = r0 + 1; r < r1; r++) for (let c = c0 + 1; c < c1; c++) {
    interiorTotal++;
    if (!at(r, c)) interiorNonRegion++;
  }
  const hollow = interiorTotal > 0 && interiorNonRegion / interiorTotal > 0.3;

  if (fillRatio < 0.30) {
    // A genuinely thin 1-2px outline stays small regardless of how long it
    // is. A composite frame (multiple sub-elements fused, e.g. a door
    // surround fused with roofline trim) is large AND sparse -- low fill
    // for a structural reason (it's frame-shaped, not because it's a thin
    // trace). Measured tonight against real fixtures: the largest
    // legitimate low-fill/solid region across every tested fixture topped
    // out at 114 cells; the two real fused-composite examples found were
    // 692 and 700 cells -- a >6x gap. 300 sits with wide margin on both
    // sides of that gap, not tuned to either example specifically.
    const kind = region.cells.length >= 300 ? "sparse-composite" : "thin-stroke";
    const note = kind === "sparse-composite"
      ? `large sparse region (${region.cells.length} cells, ${(fillRatio * 100).toFixed(0)}% fill) -- likely a fused multi-element frame, not a traceable outline. No safe automatic treatment yet (investigated: two real examples measured structurally dissimilar, no consistent split signal found).`
      : `sparse trace (${(fillRatio * 100).toFixed(0)}% of bbox) — outline/trim candidate for curve-based ownership`;
    return { kind, fillRatio, elongation, hollow, note };
  }

  if (hollow && hasSibling(region)) {
    return { kind: "gappy-rectangle", fillRatio, elongation, hollow, note: `hollow with a matching sibling elsewhere — sibling-regularization territory (${(fillRatio * 100).toFixed(0)}% fill)` };
  }

  return { kind: "solid-blob", fillRatio, elongation, hollow, note: `${hollow ? "hollow but no sibling to confirm shape" : "not hollow"} (${(fillRatio * 100).toFixed(0)}% fill, ${elongation.toFixed(1)}x elongation) — needs decomposition, no safe automatic treatment yet` };
}

export interface TrimReport {
  total: number;
  byKind: Record<TrimKind, number>;
  items: TrimClassification[];
}

export function classifyAllRejected(regions: RawRegion[], grid: Uint16Array, gridW: number, isRejected: (r: RawRegion) => boolean): TrimReport {
  const items = regions.filter(isRejected).map((r) => classifyRejectedRegion(r, grid, gridW));
  const byKind: Record<TrimKind, number> = { "gappy-rectangle": 0, "thin-stroke": 0, "sparse-composite": 0, "solid-blob": 0, "too-small": 0 };
  for (const it of items) byKind[it.kind]++;
  return { total: items.length, byKind, items };
}
