// Run: deno test --allow-read supabase/functions/chart/test-palette-merge.ts
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  mergeNearDuplicatePaletteEntries,
  PALETTE_MERGE_DE_CEILING,
  PALETTE_MERGE_MINORITY_FRACTION_CEILING,
  cullTinyEntries,
} from "./palette-merge.ts";

async function loadFixture(name: string) {
  const raw = await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
  const d = JSON.parse(raw) as { gridW: number; gridH: number; grid: number[]; palette: string[] };
  return d;
}

function makeState(palette: string[], grid: number[]) {
  const outPalette = palette.map((hex, i) => ({ id: `t${i}`, name: `T${i}`, family: `fam${i}`, hex }));
  const remapped = new Uint16Array(grid.length);
  const outUsage: Record<string, number> = {};
  for (let i = 0; i < grid.length; i++) remapped[i] = grid[i];
  for (let i = 0; i < palette.length; i++) outUsage[String(i)] = 0;
  for (let i = 0; i < grid.length; i++) outUsage[String(grid[i])] = (outUsage[String(grid[i])] ?? 0) + 1;
  const symMap: Record<string, string> = {};
  palette.forEach((_, i) => { symMap[String(i)] = String.fromCharCode(65 + i); });
  const sections = palette.map((_, i) => ({ name: `fam${i}`, paletteIndexes: [i] }));
  const oldToNew = new Map<number, number>();
  palette.forEach((_, i) => oldToNew.set(i, i));
  return { outPalette, remapped, outUsage, symMap, sections, oldToNew };
}

Deno.test("palette-merge: house-surround merges roof-darks and facade-reds, keeps white/cream distinct", async () => {
  const d = await loadFixture("_fixture-house-surround.json");
  const s = makeState(d.palette, d.grid);
  const before = { ...s.outUsage };

  const res = mergeNearDuplicatePaletteEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew,
  );

  assert(res.merged, "expected merges");
  // Roof darks (orig 3=#32363D vs 4=#46423D): 4 → 3
  const roofMerge = res.merges.find((m) => (m.absorbed === 4 && m.survivor === 3) || (m.absorbed === 3 && m.survivor === 4));
  assert(roofMerge, `expected roof-dark merge, got ${JSON.stringify(res.merges)}`);
  assertEquals(roofMerge!.absorbed, 4);
  assertEquals(roofMerge!.survivor, 3);
  // Facade reds (orig 1=#C93C2F vs 5=#D35C52): 5 → 1
  const redMerge = res.merges.find((m) => (m.absorbed === 5 && m.survivor === 1) || (m.absorbed === 1 && m.survivor === 5));
  assert(redMerge, `expected facade-red merge, got ${JSON.stringify(res.merges)}`);
  assertEquals(redMerge!.absorbed, 5);
  assertEquals(redMerge!.survivor, 1);

  // White (orig 0) vs cream (orig 2) MUST NOT merge.
  const whiteCreamMerge = res.merges.find((m) =>
    (m.absorbed === 0 && m.survivor === 2) || (m.absorbed === 2 && m.survivor === 0)
  );
  assertEquals(whiteCreamMerge, undefined, "white and cream must remain distinct");

  // After merge, palette should have 4 entries: white, red(+red2), cream, dark(+dark2)
  assertEquals(s.outPalette.length, 4);
  // Usage conservation
  const total = Object.values(s.outUsage).reduce((a, b) => a + b, 0);
  assertEquals(total, d.grid.length);
  // Merged roof-dark usage
  const roofSurvivorNew = res.oldToSurvivor[3];
  assertEquals(s.outUsage[String(roofSurvivorNew)], before["3"] + before["4"]);
  // Merged facade-red usage
  const redSurvivorNew = res.oldToSurvivor[1];
  assertEquals(s.outUsage[String(redSurvivorNew)], before["1"] + before["5"]);
  // Grid cells conserved (no -1s, no out-of-range)
  for (let i = 0; i < s.remapped.length; i++) {
    assert(s.remapped[i] < s.outPalette.length, `cell ${i} out of range`);
  }
});

Deno.test("palette-merge: butterfly-2 highlight dots (white vs #EBE5DF, minFrac 0.074) are NOT merged", async () => {
  const d = await loadFixture("_fixture-butterfly-2.json");
  const s = makeState(d.palette, d.grid);
  const res = mergeNearDuplicatePaletteEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew,
  );
  // idx 3 (#EBE5DF, 559 cells) must survive as its own palette entry.
  assertEquals(res.oldToSurvivor[3] !== res.oldToSurvivor[0], true, "highlight dot (idx 3) must not merge into white (idx 0)");
  const dotSurvivor = res.oldToSurvivor[3];
  assertEquals(s.outUsage[String(dotSurvivor)], 559, "highlight dot cell count preserved");
});

Deno.test("palette-merge: sevenwindow cream trim (dE 7.79, minFrac 0.29) NOT merged into white", async () => {
  const d = await loadFixture("_fixture-sevenwindow.json");
  const s = makeState(d.palette, d.grid);
  const res = mergeNearDuplicatePaletteEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew,
  );
  // idx 0 (white) vs idx 3 (#EFE2DB cream trim, 1563 cells) MUST NOT merge.
  assertEquals(res.oldToSurvivor[0] !== res.oldToSurvivor[3], true, "cream trim must remain distinct");
});

Deno.test("palette-merge: gates match documented calibration", () => {
  assertEquals(PALETTE_MERGE_DE_CEILING, 11);
  assertEquals(PALETTE_MERGE_MINORITY_FRACTION_CEILING, 0.045);
});

// --- Second-pass (flat-art split-colour) mode: ignoreMinorityShare ---
//
// Median-cut with spare bins splits ONE design colour into two heavily-used
// near-identical entries. The default minority-share gate cannot catch them.

Deno.test("palette-merge: two heavily-used near-identical reds (dE 4.17) — kept by default, merged with ignoreMinorityShare", () => {
  // #B4131E vs #C4212B measures dE 4.17; both hold ~half the pair's stitches.
  const palette = ["#FFFFFF", "#B4131E", "#C4212B"];
  // 200 white, 400 red-a, 350 red-b → pair minFrac = 350/750 = 0.467.
  const grid: number[] = [
    ...new Array(200).fill(0),
    ...new Array(400).fill(1),
    ...new Array(350).fill(2),
  ];

  const a = makeState(palette, grid);
  const resDefault = mergeNearDuplicatePaletteEntries(
    a.remapped, a.outPalette, a.outUsage, a.symMap, a.sections, a.oldToNew,
  );
  assertEquals(
    resDefault.oldToSurvivor[1] !== resDefault.oldToSurvivor[2],
    true,
    "default options must NOT merge two high-population reds (minority gate)",
  );

  const b = makeState(palette, grid);
  const resSplit = mergeNearDuplicatePaletteEntries(
    b.remapped, b.outPalette, b.outUsage, b.symMap, b.sections, b.oldToNew,
    { deCeiling: 7.0, ignoreMinorityShare: true },
  );
  assert(resSplit.merged, "ignoreMinorityShare pass must merge the split red");
  assertEquals(
    resSplit.oldToSurvivor[1],
    resSplit.oldToSurvivor[2],
    "both reds must collapse to one survivor",
  );
  // Higher-usage side survives, stitches conserved.
  assertEquals(b.outUsage[String(resSplit.oldToSurvivor[1])], 750);
  assertEquals(b.outPalette[resSplit.oldToSurvivor[1]].hex, "#B4131E");
  const total = Object.values(b.outUsage).reduce((x, y) => x + y, 0);
  assertEquals(total, grid.length);
});

Deno.test("palette-merge: house white/cream pair (dE 9.03) survives the 7.0 ignoreMinorityShare pass", async () => {
  const d = await loadFixture("_fixture-house-surround.json");
  const s = makeState(d.palette, d.grid);
  const res = mergeNearDuplicatePaletteEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew,
    { deCeiling: 7.0, ignoreMinorityShare: true },
  );
  // The window-frame vs background distinction: merging it deletes glazing bars.
  assertEquals(
    res.oldToSurvivor[0] !== res.oldToSurvivor[2],
    true,
    "white (0) and cream (2) at dE 9.03 must remain distinct under the 7.0 ceiling",
  );
});

// --- Unstitchable-remnant cull ---

Deno.test("cull: 7-stitch remnant is absorbed into nearest neighbour even at large dE", () => {
  // #8B5A2B (brown) is colour-distant from the reds/greys around it.
  const palette = ["#FFFFFF", "#B4131E", "#3A3A3A", "#8B5A2B"];
  const grid: number[] = [
    ...new Array(500).fill(0),
    ...new Array(400).fill(1),
    ...new Array(300).fill(2),
    ...new Array(7).fill(3),
  ];
  const s = makeState(palette, grid);
  const res = cullTinyEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew, 10,
  );
  assert(res.culled, "expected the 7-stitch entry to be culled");
  assertEquals(s.outPalette.length, 3);
  const cull = res.culls[0];
  assertEquals(cull.absorbed, 3);
  assertEquals(cull.usage, 7);
  assert(cull.dE > 20, `expected a large dE absorb, got ${cull.dE}`);
  // Stitch count conserved.
  const total = Object.values(s.outUsage).reduce((a, b) => a + b, 0);
  assertEquals(total, grid.length);
  // Cells all in range, no brown index left.
  for (let i = 0; i < s.remapped.length; i++) {
    assert(s.remapped[i] < s.outPalette.length, `cell ${i} out of range`);
  }
});

Deno.test("cull: entry just above the floor is NOT culled", () => {
  const palette = ["#FFFFFF", "#B4131E", "#3A3A3A", "#8B5A2B"];
  const grid: number[] = [
    ...new Array(500).fill(0),
    ...new Array(400).fill(1),
    ...new Array(300).fill(2),
    ...new Array(10).fill(3),
  ];
  const s = makeState(palette, grid);
  const res = cullTinyEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew, 10,
  );
  assertEquals(res.culled, false, "usage == floor must survive (floor is exclusive)");
  assertEquals(s.outPalette.length, 4);
});

Deno.test("cull: protected background entry is never culled nor used as a target", () => {
  // White has only 5 stitches but is protected; brown has 7 and must fold into
  // a NON-protected neighbour.
  const palette = ["#FFFFFF", "#B4131E", "#3A3A3A", "#8B5A2B"];
  const grid: number[] = [
    ...new Array(5).fill(0),
    ...new Array(400).fill(1),
    ...new Array(300).fill(2),
    ...new Array(7).fill(3),
  ];
  const s = makeState(palette, grid);
  const res = cullTinyEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew, 10,
    { protectedIndices: new Set([0]) },
  );
  assert(res.culled);
  // White survives with its own entry and its 5 stitches.
  const whiteNew = res.oldToSurvivor[0];
  assertEquals(s.outPalette[whiteNew].hex, "#FFFFFF");
  assertEquals(s.outUsage[String(whiteNew)], 5);
  // Brown did not fold into white.
  assert(res.oldToSurvivor[3] !== whiteNew, "protected entry must not be a cull target");
  const total = Object.values(s.outUsage).reduce((a, b) => a + b, 0);
  assertEquals(total, grid.length);
});

Deno.test("cull: never reduces the palette below 2 entries", () => {
  const palette = ["#FFFFFF", "#B4131E"];
  const grid: number[] = [...new Array(3).fill(0), ...new Array(4).fill(1)];
  const s = makeState(palette, grid);
  const res = cullTinyEntries(
    s.remapped, s.outPalette, s.outUsage, s.symMap, s.sections, s.oldToNew, 100,
  );
  assertEquals(res.culled, false);
  assertEquals(s.outPalette.length, 2);
});
