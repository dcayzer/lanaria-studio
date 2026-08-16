// Deno test — Phase 5 chartability scoring.
// Run: deno test --allow-read supabase/functions/chart/test-chartability.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  colourSignal, fragmentationSignal, featureSizeSignal, diagonalSignal,
  symmetrySignal, scoreChartability, ciede2000, type GridInput,
} from "./chartability.ts";
import { borderCompletenessSignal, strokeWidthSignal } from "./chartability-engine-signals.ts";
import type { PaletteEntry } from "./structural-model.ts";

// String-map builder: each char maps to a palette index; '.' = bg (index 0).
function build(rows: string[], map: Record<string, number>, palette: string[]): GridInput {
  const H = rows.length, W = rows[0].length;
  const grid = new Array(W * H).fill(0);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const ch = rows[r][c];
    grid[r * W + c] = ch === "." ? 0 : (map[ch] ?? 0);
  }
  return { grid, W, H, palette, bgIds: new Set([0]) };
}

Deno.test("featureSize: solid block survives erosion, thin line does not", () => {
  const palette = ["#ffffff", "#ff0000"];
  const solid = build([
    "..........",
    "..XXXXXXX.",
    "..XXXXXXX.",
    "..XXXXXXX.",
    "..XXXXXXX.",
    "..XXXXXXX.",
    "..XXXXXXX.",
    "..XXXXXXX.",
    "..XXXXXXX.",
    "..........",
  ], { X: 1 }, palette);
  const thin = build([
    "..........",
    "..XXXXXX..",
    "..........",
    "..XXXXXX..",
    "..........",
    "..XXXXXX..",
    "..........",
    "..........",
  ], { X: 1 }, palette);
  const s1 = featureSizeSignal(solid);
  const s2 = featureSizeSignal(thin);
  assert(s1.raw.survivalRatio > 0.5, `solid should survive: ${s1.raw.survivalRatio}`);
  assertEquals(s2.raw.survivingErosion, 0, `1-thick lines should fully erode: ${s2.raw.survivingErosion}`);
  assert(s1.score > s2.score, `solid score > thin score; got ${s1.score} vs ${s2.score}`);
});

Deno.test("diagonal: staircase has higher corner-ratio than rectangle", () => {
  const palette = ["#ffffff", "#ff0000"];
  const rect = build([
    "..........",
    "..XXXXXX..",
    "..XXXXXX..",
    "..XXXXXX..",
    "..XXXXXX..",
    "..........",
  ], { X: 1 }, palette);
  const diag = build([
    "X.........",
    "XX........",
    ".XX.......",
    "..XX......",
    "...XX.....",
    "....XX....",
    ".....XX...",
    "......XX..",
  ], { X: 1 }, palette);
  const r = diagonalSignal(rect), d = diagonalSignal(diag);
  assert(d.raw.cornerRatio > r.raw.cornerRatio,
    `diagonal cornerRatio > rect; got ${d.raw.cornerRatio} vs ${r.raw.cornerRatio}`);
  assert(d.score < r.score, `diagonal scores worse; got ${d.score} vs ${r.score}`);
});

Deno.test("fragmentation: speckled grid has more specks & higher regions/colour than clean", () => {
  const palette = ["#ffffff", "#ff0000", "#00ff00"];
  const clean = build([
    "..........",
    "..XXXXX...",
    "..XXXXX...",
    "..YYYYY...",
    "..YYYYY...",
    "..........",
  ], { X: 1, Y: 2 }, palette);
  const speckled = build([
    "X.Y.X.Y.X.",
    ".Y.X.Y.X.Y",
    "X.Y.X.Y.X.",
    ".Y.X.Y.X.Y",
    "X.Y.X.Y.X.",
    ".Y.X.Y.X.Y",
  ], { X: 1, Y: 2 }, palette);
  const a = fragmentationSignal(clean), b = fragmentationSignal(speckled);
  assert(b.raw.specks > a.raw.specks, `speckled specks > clean; got ${b.raw.specks} vs ${a.raw.specks}`);
  assert(b.raw.regionsPerColour > a.raw.regionsPerColour,
    `speckled regions/colour > clean; got ${b.raw.regionsPerColour} vs ${a.raw.regionsPerColour}`);
  assert(a.score > b.score, `clean scores better; got ${a.score} vs ${b.score}`);
});

Deno.test("colour: near-duplicate shades flagged (CIEDE2000 < 5); count reported", () => {
  const palette = ["#ffffff", "#ff0000", "#fe0100", "#00ff00"]; // #ff0000 vs #fe0100 nearly identical
  const g = build([
    "XY..",
    "ZZ..",
  ], { X: 1, Y: 2, Z: 3 }, palette);
  const s = colourSignal(g);
  assertEquals(s.raw.colourCount, 3);
  assert(s.raw.minCIEDE2000 < 5, `near-duplicates: minDE < 5, got ${s.raw.minCIEDE2000}`);
  assert(s.score < 0.5, `duplicate pair penalises score; got ${s.score}`);
  // Sanity: ciede2000 of identical colours is ~0.
  assert(ciede2000([50, 0, 0], [50, 0, 0]) < 1e-6);
});

Deno.test("symmetry: symmetric shape has lower mismatch than asymmetric", () => {
  const palette = ["#ffffff", "#ff0000"];
  const sym = build([
    "..XXXX..",
    ".XXXXXX.",
    "XXXXXXXX",
    "XXXXXXXX",
    ".XXXXXX.",
    "..XXXX..",
  ], { X: 1 }, palette);
  const asym = build([
    "XXXXXX..",
    "XXXXX...",
    "XXXX....",
    "XXX.....",
    "XX......",
    "X.......",
  ], { X: 1 }, palette);
  const a = symmetrySignal(sym), b = symmetrySignal(asym);
  assert(a.raw.mismatchRatio < b.raw.mismatchRatio,
    `sym mismatch < asym; got ${a.raw.mismatchRatio} vs ${b.raw.mismatchRatio}`);
  assert(a.score > b.score, `sym scores better; got ${a.score} vs ${b.score}`);
});

Deno.test("overall verdict: clean 2-region grid beats speckled 6-colour", () => {
  const palette = ["#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"];
  const clean = build([
    "............",
    "............",
    "...XXXXXX...",
    "...XXXXXX...",
    "...XXXXXX...",
    "...XXXXXX...",
    "...YYYYYY...",
    "...YYYYYY...",
    "...YYYYYY...",
    "...YYYYYY...",
    "............",
    "............",
  ], { X: 1, Y: 2 }, palette);
  // Isolated 1-cell specks across many colours; ~zero erosion survival.
  const speckled = build([
    "X.Y.Z.A.B.C.",
    "............",
    "Y.Z.A.B.C.X.",
    "............",
    "Z.A.B.C.X.Y.",
    "............",
    "A.B.C.X.Y.Z.",
    "............",
    "B.C.X.Y.Z.A.",
    "............",
    "C.X.Y.Z.A.B.",
    "............",
  ], { X: 1, Y: 2, Z: 3, A: 4, B: 5, C: 6 }, palette);
  const r1 = scoreChartability(clean);
  const r2 = scoreChartability(speckled);
  assert(r1.overall > r2.overall, `clean overall > speckled; got ${r1.overall} vs ${r2.overall}`);
  assert(r1.verdict === "Perfect" || r1.verdict === "Minor",
    `clean should be Perfect/Minor; got ${r1.verdict}`);
  assert(r2.verdict === "Poor" || r2.verdict === "Unusable",
    `speckled should be Poor/Unusable; got ${r2.verdict}`);
});

Deno.test("engine: borderCompletenessSignal reports high accept rate on clean fixture", async () => {
  const fx = JSON.parse(await Deno.readTextFile(new URL("./_fixture-live.json", import.meta.url)));
  const palette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));
  const g = { grid: new Uint16Array(fx.grid), W: fx.gridW as number, H: fx.gridH as number, palette };
  const s = borderCompletenessSignal(g);
  assert(s.raw.candidates > 0, `expected frame candidates, got ${s.raw.candidates}`);
  assert(s.raw.acceptRate >= 0.75, `most candidates should pass; got ${s.raw.acceptRate} (${s.note})`);
  assert(s.score >= 1, `score should saturate at 1 (>=0.75 accept); got ${s.score}`);
});

Deno.test("engine: strokeWidthSignal reports mean near 1 on clean fixture", async () => {
  const fx = JSON.parse(await Deno.readTextFile(new URL("./_fixture-live.json", import.meta.url)));
  const palette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));
  const g = { grid: new Uint16Array(fx.grid), W: fx.gridW as number, H: fx.gridH as number, palette };
  const s = strokeWidthSignal(g);
  assert(s.raw.measured > 0, `expected measured widths, got ${s.raw.measured}`);
  assert(s.raw.meanWidth >= 1 && s.raw.meanWidth < 2,
    `mean stroke width should be near 1; got ${s.raw.meanWidth}`);
  assert(s.raw.variance < 1, `variance should be low; got ${s.raw.variance}`);
});
