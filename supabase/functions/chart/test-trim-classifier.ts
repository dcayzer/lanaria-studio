// Deno test — trim-classifier: honest triage of rejected non-rectangular regions.
// Run: deno test --allow-read supabase/functions/chart/test-trim-classifier.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyRejectedRegion } from "./trim-classifier.ts";
import type { RawRegion } from "./structural-model.ts";

const GRIDW = 200;

function mkRegion(cells: [number, number][]): { region: RawRegion; grid: Uint16Array } {
  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  const idx: number[] = [];
  for (const [r, c] of cells) {
    if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (c < c0) c0 = c; if (c > c1) c1 = c;
    idx.push(r * GRIDW + c);
  }
  const grid = new Uint16Array(GRIDW * 200);
  for (const i of idx) grid[i] = 1;
  return { region: { colour: 1, cells: idx, r0, r1, c0, c1 }, grid };
}

Deno.test("door+portico fused blob (~33x83, three columns + bottom strip, no sibling) → solid-blob", () => {
  // Three vertical columns (door + two pillars), each 33 tall x 10 wide,
  // spaced across an 83-wide bbox, plus a 3-row bottom connecting strip.
  const cells: [number, number][] = [];
  const R0 = 0, R1 = 32, C0 = 0, C1 = 82;
  const colStarts = [0, 37, 73]; // three columns at c0, c37, c73
  for (const cs of colStarts) {
    for (let r = R0; r <= R1; r++) for (let c = cs; c < cs + 10; c++) cells.push([r, c]);
  }
  for (let r = R1 - 2; r <= R1; r++) for (let c = C0; c <= C1; c++) cells.push([r, c]);
  // Dedupe.
  const seen = new Set<string>();
  const unique = cells.filter(([r, c]) => { const k = `${r},${c}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const { region, grid } = mkRegion(unique);
  assertEquals(region.r1 - region.r0 + 1, 33);
  assertEquals(region.c1 - region.c0 + 1, 83);
  const cls = classifyRejectedRegion(region, grid, GRIDW, () => false);
  assertEquals(cls.kind, "solid-blob", `door+portico blob should be solid-blob; got ${cls.kind} (${cls.note})`);
});

Deno.test("gabled roofline outline (~17x56, thin diagonal trace) → thin-stroke", () => {
  // A gabled outline: two diagonal strokes forming a chevron across the top,
  // plus a thin bottom eave line. Very sparse fill of the bbox.
  const cells: [number, number][] = [];
  const H = 17, W = 56;
  // Left slope from (16,0) up to (0,27)
  for (let i = 0; i <= 27; i++) cells.push([16 - Math.round(i * 16 / 27), i]);
  // Right slope from (0,28) down to (16,55)
  for (let i = 28; i <= 55; i++) cells.push([Math.round((i - 28) * 16 / 27), i]);
  // Bottom eave
  for (let c = 0; c <= 55; c++) cells.push([16, c]);
  const seen = new Set<string>();
  const unique = cells.filter(([r, c]) => { const k = `${r},${c}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const { region, grid } = mkRegion(unique);
  assertEquals(region.r1 - region.r0 + 1, H);
  assertEquals(region.c1 - region.c0 + 1, W);
  const cls = classifyRejectedRegion(region, grid, GRIDW, () => false);
  assert(cls.fillRatio < 0.30, `roofline should be sparse; got fill ${cls.fillRatio}`);
  assertEquals(cls.kind, "thin-stroke", `roofline outline should be thin-stroke; got ${cls.kind} (${cls.note})`);
});

// Hollow-window shape shared by tests 3 and 4: 15h x 13w bbox, 3-cell-thick
// border. Fill ratio ~0.68, interior mostly non-region ⇒ hollow=true.
function hollowWindow(): [number, number][] {
  const cells: [number, number][] = [];
  const R0 = 0, R1 = 14, C0 = 0, C1 = 12, B = 3;
  for (let r = R0; r <= R1; r++) for (let c = C0; c <= C1; c++) {
    const d = Math.min(r - R0, R1 - r, c - C0, C1 - c);
    if (d < B) cells.push([r, c]);
  }
  return cells;
}

Deno.test("gappy window WITH matching sibling → gappy-rectangle", () => {
  const { region, grid } = mkRegion(hollowWindow());
  const cls = classifyRejectedRegion(region, grid, GRIDW, () => true);
  assert(cls.hollow, `window shape must be hollow; got ${cls.hollow}`);
  assert(cls.fillRatio >= 0.30, `window shape must be dense enough; got ${cls.fillRatio}`);
  assertEquals(cls.kind, "gappy-rectangle", `hollow + has sibling should be gappy-rectangle; got ${cls.kind} (${cls.note})`);
});

Deno.test("SAME gappy window ISOLATED (no sibling) → solid-blob (conservative default)", () => {
  const { region, grid } = mkRegion(hollowWindow());
  const cls = classifyRejectedRegion(region, grid, GRIDW, () => false);
  assert(cls.hollow, `same shape is still hollow; got ${cls.hollow}`);
  assertEquals(cls.kind, "solid-blob", `hollow but isolated should default to solid-blob; got ${cls.kind} (${cls.note})`);
});
