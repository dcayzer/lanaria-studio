// Tests for HandFont.kernAfter / GlyphSource.kernAfterFor layout behaviour.
// Run via: bun run src/lib/test-kern-after.ts
//
// The constraint encoded here is the reason kernAfter exists: cursive "l" has
// a real exit flourish, so pulling the next letter in too far produces either
// a hard cell collision or a same-row visual crossover (the follower's ink
// landing left of "l"'s ink in that row, which reads as tangled thread even
// with no exact collision). The shipped reduction of 1 stitch is the measured
// safe ceiling; 2 already collides. If "l" is ever re-charted, or kernAfter's
// value raised, these tests fail rather than silently shipping tangled text.

import { previewGrid } from "./glyph-layers";
import { HAND_FONTS } from "../data/hand-charted-fonts";

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${(e as Error).message}`); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const LOWER = "abcdefghijklmnopqrstuvwxyz";

/** Ink cells of a rendered pair, split into "which glyph drew it" by rendering
 *  each glyph alone and diffing column extents is unreliable; instead render
 *  "l" alone and the pair, and treat any pair cell not present in the "l"-only
 *  render (at the same coords) as follower ink. A collision is a pair cell
 *  where both would have drawn -- detectable as a cell that "l" alone occupies
 *  and the follower-only render (offset by l's advance) also occupies. */
function inkSet(grid: string[][]): Set<string> {
  const s = new Set<string>();
  grid.forEach((row, r) => row.forEach((v, c) => { if (v !== "0") s.add(`${r},${c}`); }));
  return s;
}

function analyse(fontId: string, follower: string) {
  const lOnly = previewGrid(fontId, "l");
  const fOnly = previewGrid(fontId, follower);
  const pair = previewGrid(fontId, `l${follower}`);
  const lInk = inkSet(lOnly);
  // The follower's origin column in the pair render = pair width - follower width.
  const pairW = pair[0]?.length ?? 0;
  const fW = fOnly[0]?.length ?? 0;
  const x0 = pairW - fW;
  const lRowMax: Record<number, number> = {};
  for (const key of lInk) {
    const [r, c] = key.split(",").map(Number);
    lRowMax[r] = Math.max(lRowMax[r] ?? -1, c);
  }
  let collisions = 0;
  let crossovers = 0;
  fOnly.forEach((row, r) => row.forEach((v, c) => {
    if (v === "0") return;
    const X = x0 + c;
    if (lInk.has(`${r},${X}`)) collisions++;
    if (lRowMax[r] !== undefined && X < lRowMax[r]) crossovers++;
  }));
  return { collisions, crossovers, x0 };
}

for (const fontId of ["cursive", "cursive-lower"]) {
  const font = HAND_FONTS.find((f) => f.id === fontId)!;

  t(`${fontId}: kernAfter declares l:1 (the measured safe ceiling)`, () => {
    assert(font.kernAfter?.["l"] === 1, `kernAfter.l = ${font.kernAfter?.["l"]}, expected 1`);
  });

  t(`${fontId}: "l" + every lowercase letter has no hard collision`, () => {
    const bad: string[] = [];
    for (const ch of LOWER) {
      if (!font.glyphs[ch]) continue;
      const { collisions } = analyse(fontId, ch);
      if (collisions > 0) bad.push(`l${ch}=${collisions}`);
    }
    assert(bad.length === 0, `collisions: ${bad.join(" ")}`);
  });

  t(`${fontId}: "l" + every lowercase letter has no same-row crossover`, () => {
    const bad: string[] = [];
    for (const ch of LOWER) {
      if (!font.glyphs[ch]) continue;
      const { crossovers } = analyse(fontId, ch);
      if (crossovers > 0) bad.push(`l${ch}=${crossovers}`);
    }
    assert(bad.length === 0, `crossovers: ${bad.join(" ")}`);
  });

  t(`${fontId}: the kern actually tightens "l" by exactly 1 stitch`, () => {
    // Real ink width of the stored "l" glyph: rightmost inked column + 1.
    let inkW = 0;
    for (const row of font.glyphs["l"]) {
      for (let c = 0; c < row.length; c++) if (row[c] !== "0") inkW = Math.max(inkW, c + 1);
    }
    // previewGrid lays out with advance = inkW - kernAfter, plus 1 stitch of
    // letter spacing after every glyph including the last.
    const single = previewGrid(fontId, "l")[0].length;
    const pair = previewGrid(fontId, "ll")[0].length;
    assert(single === inkW - 1, `"l" advance ${single}, expected ${inkW - 1} (inkW ${inkW} - kern 1)`);
    assert(pair === (inkW - 1) * 2 + 1, `"ll" width ${pair}, expected ${(inkW - 1) * 2 + 1}`);
  });
}

t("fonts without kernAfter are unaffected (legacy 5x7 advance unchanged)", () => {
  // Built-in font: "AA" is 5 + 1 spacing + 5 = 11 columns, as before.
  const w = previewGrid(null, "AA")[0].length;
  assert(w === 11, `legacy "AA" width ${w}, expected 11`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
