// Tests for brick-layout.ts. Run via: bunx tsx src/lib/test-brick-layout.ts
// (or `bun run src/lib/test-brick-layout.ts`). Pure lib, no React, no DOM.

import {
  BRICK_PANELS,
  brickPanelStitches,
  brickSmallestPanelStitches,
  brickMinFeatureStitches,
  buildBrickSlotPrompt,
  slotPanels,
} from "./brick-layout";
import {
  BRICK,
  BRICK_CANVAS_WIDTH_INCHES,
  BRICK_CANVAS_HEIGHT_INCHES,
} from "./canvasShapes";

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function approx(a: number, b: number, eps = 1e-9) {
  if (Math.abs(a - b) > eps) throw new Error(`expected ${a} ~= ${b}`);
}
function rectsOverlap(a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

t("five panels", () => {
  assert(BRICK_PANELS.length === 5, `got ${BRICK_PANELS.length}`);
});

t("fractional boundaries derived from BRICK", () => {
  const xL = BRICK.coverDepth / BRICK_CANVAS_WIDTH_INCHES;
  const xR = (BRICK.coverDepth + BRICK.coverLength) / BRICK_CANVAS_WIDTH_INCHES;
  const yT = BRICK.coverDepth / BRICK_CANVAS_HEIGHT_INCHES;
  const yB = (BRICK.coverDepth + BRICK.coverWidth) / BRICK_CANVAS_HEIGHT_INCHES;
  const top = BRICK_PANELS.find((p) => p.id === "top")!;
  approx(top.x0, xL);
  approx(top.x1, xR);
  approx(top.y0, yT);
  approx(top.y1, yB);
});

t("inch widths sum to canvas width across middle row", () => {
  const eL = BRICK_PANELS.find((p) => p.id === "endLeft")!;
  const top = BRICK_PANELS.find((p) => p.id === "top")!;
  const eR = BRICK_PANELS.find((p) => p.id === "endRight")!;
  approx(eL.widthInches + top.widthInches + eR.widthInches, BRICK_CANVAS_WIDTH_INCHES);
  assert(BRICK_CANVAS_WIDTH_INCHES === 14, `expected 14, got ${BRICK_CANVAS_WIDTH_INCHES}`);
});

t("inch heights sum to canvas height down middle column", () => {
  const sT = BRICK_PANELS.find((p) => p.id === "sideTop")!;
  const top = BRICK_PANELS.find((p) => p.id === "top")!;
  const sB = BRICK_PANELS.find((p) => p.id === "sideBottom")!;
  approx(sT.heightInches + top.heightInches + sB.heightInches, BRICK_CANVAS_HEIGHT_INCHES);
  assert(BRICK_CANVAS_HEIGHT_INCHES === 10, `expected 10, got ${BRICK_CANVAS_HEIGHT_INCHES}`);
});

t("brickPanelStitches at mesh 13: centre ~110x58, arms ~36 deep", () => {
  const p = brickPanelStitches(13);
  const top = p.find((x) => x.id === "top")!;
  assert(top.widthStitches === Math.round(8.5 * 13), `top w ${top.widthStitches}`);
  assert(top.heightStitches === Math.round(4.5 * 13), `top h ${top.heightStitches}`);
  assert(top.widthStitches === 111 || top.widthStitches === 110, `centre width ~110, got ${top.widthStitches}`);
  assert(top.heightStitches === 59 || top.heightStitches === 58, `centre height ~58, got ${top.heightStitches}`);
  const armDepth = Math.round(BRICK.coverDepth * 13);
  const eL = p.find((x) => x.id === "endLeft")!;
  const sT = p.find((x) => x.id === "sideTop")!;
  assert(eL.widthStitches === armDepth, `endLeft depth ${eL.widthStitches} vs ${armDepth}`);
  assert(sT.heightStitches === armDepth, `sideTop depth ${sT.heightStitches} vs ${armDepth}`);
  assert(Math.abs(armDepth - 36) <= 1, `arm depth ~36, got ${armDepth}`);
});

t("brickMinFeatureStitches floored at 3", () => {
  for (const mesh of [8, 10, 12, 13, 14, 18, 24]) {
    const v = brickMinFeatureStitches(mesh);
    assert(v >= 3, `mesh ${mesh}: got ${v}`);
    assert(Number.isInteger(v), `mesh ${mesh}: non-integer ${v}`);
  }
});

t("brickSmallestPanelStitches picks the arm depth (narrowest dim)", () => {
  const mesh = 13;
  const armDepth = Math.round(BRICK.coverDepth * mesh);
  assert(brickSmallestPanelStitches(mesh) === armDepth, `expected ${armDepth}`);
});

t("panels never overlap", () => {
  for (let i = 0; i < BRICK_PANELS.length; i++) {
    for (let j = i + 1; j < BRICK_PANELS.length; j++) {
      assert(
        !rectsOverlap(BRICK_PANELS[i], BRICK_PANELS[j]),
        `${BRICK_PANELS[i].id} overlaps ${BRICK_PANELS[j].id}`,
      );
    }
  }
});

t("panels never cover the four cut-away corners", () => {
  const xL = BRICK.coverDepth / BRICK_CANVAS_WIDTH_INCHES;
  const xR = (BRICK.coverDepth + BRICK.coverLength) / BRICK_CANVAS_WIDTH_INCHES;
  const yT = BRICK.coverDepth / BRICK_CANVAS_HEIGHT_INCHES;
  const yB = (BRICK.coverDepth + BRICK.coverWidth) / BRICK_CANVAS_HEIGHT_INCHES;
  const corners = [
    { x: xL / 2, y: yT / 2 },
    { x: (xR + 1) / 2, y: yT / 2 },
    { x: xL / 2, y: (yB + 1) / 2 },
    { x: (xR + 1) / 2, y: (yB + 1) / 2 },
  ];
  for (const c of corners) {
    for (const p of BRICK_PANELS) {
      const inside = c.x > p.x0 && c.x < p.x1 && c.y > p.y0 && c.y < p.y1;
      assert(!inside, `corner (${c.x},${c.y}) inside panel ${p.id}`);
    }
  }
});

t("buildBrickSlotPrompt(center) requests one motif with real stitch dims + subject", () => {
  const s = buildBrickSlotPrompt("center", "seaside cottage", 13);
  assert(/self-contained motif/i.test(s), "no motif mention");
  assert(/plain flat/i.test(s), "no plain-background mention");
  assert(s.includes("seaside cottage"), "subject missing");
  const top = brickPanelStitches(13).find((p) => p.id === "top")!;
  assert(s.includes(`${top.widthStitches}x${top.heightStitches}`), `centre stitch dims ${top.widthStitches}x${top.heightStitches} not baked in`);
  const minFeat = brickMinFeatureStitches(13);
  assert(s.includes(`${minFeat} stitches`), `min feature ${minFeat} not baked in`);
});

t("buildBrickSlotPrompt(pattern) is orientation-free, forbids silhouettes, cites dims", () => {
  for (const slot of ["uniform", "arms", "armsTopBottom", "armsLeftRight"] as const) {
    const s = buildBrickSlotPrompt(slot, "sailor's knots", 13);
    assert(/SEAMLESS REPEATING/i.test(s), `${slot}: no seamless mention`);
    assert(/NO single focal subject/i.test(s), `${slot}: no focal-subject prohibition`);
    assert(/heart, star, letter, animal/i.test(s), `${slot}: no silhouette prohibition`);
    assert(s.includes("sailor's knots"), `${slot}: subject missing`);
    // Cites at least one of its target panels' stitch dims.
    const ids = slotPanels(slot);
    const first = brickPanelStitches(13).find((p) => p.id === ids[0])!;
    assert(
      s.includes(`${first.widthStitches}x${first.heightStitches}`),
      `${slot}: expected panel ${ids[0]} stitch dims ${first.widthStitches}x${first.heightStitches}`,
    );
  }
});

t("slotPanels returns correct panel sets", () => {
  assert(slotPanels("uniform").length === 5, "uniform=5");
  assert(slotPanels("arms").length === 4 && !slotPanels("arms").includes("top"), "arms=4 no top");
  assert(
    slotPanels("armsTopBottom").join(",") === "sideTop,sideBottom",
    `armsTopBottom got ${slotPanels("armsTopBottom").join(",")}`,
  );
  assert(
    slotPanels("armsLeftRight").join(",") === "endLeft,endRight",
    `armsLeftRight got ${slotPanels("armsLeftRight").join(",")}`,
  );
  assert(slotPanels("center").join(",") === "top", "center=top");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
