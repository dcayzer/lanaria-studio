// Tests for brick-compose.ts geometry. Run via: bun run src/lib/test-brick-compose.ts
// Pure geometry, no canvas context, no DOM.

import {
  panelPixelRect,
  tileGrid,
  fitCenterRect,
  rotatedDrawRegion,
} from "./brick-compose";
import { BRICK, BRICK_CANVAS_WIDTH_INCHES, BRICK_CANVAS_HEIGHT_INCHES } from "./canvasShapes";
import { BRICK_PANELS, slotPanels, panelFoldRotation } from "./brick-layout";

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

t("panelPixelRect(top) matches BRICK_PANELS fractions", () => {
  const top = BRICK_PANELS.find((p) => p.id === "top")!;
  const W = 1400;
  const H = 1000;
  const r = panelPixelRect(top, W, H);
  const expectedX = Math.round(top.x0 * W);
  const expectedY = Math.round(top.y0 * H);
  const expectedW = Math.round(top.x1 * W) - expectedX;
  const expectedH = Math.round(top.y1 * H) - expectedY;
  assert(r.x === expectedX, `x ${r.x} vs ${expectedX}`);
  assert(r.y === expectedY, `y ${r.y} vs ${expectedY}`);
  assert(r.w === expectedW, `w ${r.w} vs ${expectedW}`);
  assert(r.h === expectedH, `h ${r.h} vs ${expectedH}`);
  // Sanity: 14x10in canvas with 2.75in corners -> top is 8.5x4.5in at centre.
  assert(r.w === Math.round((8.5 / 14) * 1400), `w ${r.w}`);
  assert(r.h === Math.round((4.5 / 10) * 1000), `h ${r.h}`);
});

t("tileGrid 100x100 region at 25px -> 16 tiles", () => {
  const tiles = tileGrid({ x: 0, y: 0, w: 100, h: 100 }, 25, 25);
  assert(tiles.length === 16, `got ${tiles.length}`);
});

t("tileGrid flip flags checkerboard by column/row parity (mirror=true)", () => {
  const tiles = tileGrid({ x: 0, y: 0, w: 100, h: 100 }, 25, 25, true);
  for (const tile of tiles) {
    const i = tile.x / 25;
    const j = tile.y / 25;
    const expectedFX = i % 2 === 1;
    const expectedFY = j % 2 === 1;
    assert(
      tile.flipX === expectedFX && tile.flipY === expectedFY,
      `tile @(${i},${j}): flipX ${tile.flipX} vs ${expectedFX}, flipY ${tile.flipY} vs ${expectedFY}`,
    );
  }
});

t("tileGrid default (no mirror arg) never flips", () => {
  const tiles = tileGrid({ x: 0, y: 0, w: 100, h: 100 }, 25, 25);
  assert(tiles.length === 16, `got ${tiles.length}`);
  for (const tile of tiles) {
    assert(tile.flipX === false && tile.flipY === false, `unexpected flip @(${tile.x},${tile.y})`);
  }
});

t("tileGrid covers region fully with no gaps", () => {
  const region = { x: 30, y: 70, w: 200, h: 150 };
  const tileW = 40, tileH = 40;
  const tiles = tileGrid(region, tileW, tileH);
  // Every integer point inside the region must be covered by some tile.
  for (let py = region.y; py < region.y + region.h; py += 7) {
    for (let px = region.x; px < region.x + region.w; px += 7) {
      const covered = tiles.some(
        (t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h,
      );
      assert(covered, `pixel (${px},${py}) not covered`);
    }
  }
});

t("tileGrid tiles are aligned to canvas origin (region offset ignored)", () => {
  // Region NOT starting on a tile boundary: 30 % 40 = 30 != 0.
  // The nearest lower multiple of tileW is 0, so first tile.x must be 0.
  const tiles = tileGrid({ x: 30, y: 70, w: 200, h: 150 }, 40, 40);
  const xs = Array.from(new Set(tiles.map((t) => t.x))).sort((a, b) => a - b);
  const ys = Array.from(new Set(tiles.map((t) => t.y))).sort((a, b) => a - b);
  // Region 30..230 x 70..220 with 40px tiles -> cols starting at 0,40,80,120,160,200
  //                                              rows starting at 40,80,120,160,200
  assert(xs[0] === 0, `first col x ${xs[0]}, expected 0 (aligned to canvas origin)`);
  assert(ys[0] === 40, `first row y ${ys[0]}, expected 40 (nearest lower tile boundary)`);
  for (const x of xs) assert(x % 40 === 0, `col x ${x} not multiple of 40`);
  for (const y of ys) assert(y % 40 === 0, `row y ${y} not multiple of 40`);
});

t("fitCenterRect with padded bbox crops to subject and centres", () => {
  // 1000x1000 image, subject occupies inner 20% (heavy padding).
  const bbox = { minX: 0.4, minY: 0.4, maxX: 0.6, maxY: 0.6 };
  // Panel 800x400 (landscape) at (100, 200).
  const panel = { x: 100, y: 200, w: 800, h: 400 };
  const r = fitCenterRect(1000, 1000, bbox, panel);
  // Subject is 200x200. Aspect square -> fits inside 400x400, uses full h.
  assert(r.w === 400 && r.h === 400, `expected 400x400, got ${r.w}x${r.h}`);
  // Centred in landscape panel: x = 100 + (800-400)/2 = 300; y = 200 + 0 = 200.
  assert(r.x === 300 && r.y === 200, `expected (300,200), got (${r.x},${r.y})`);
});

t("fitCenterRect with null bbox contain-fits whole image", () => {
  const panel = { x: 0, y: 0, w: 400, h: 200 };
  // 1000x1000 square image, no bbox -> uses full image aspect (1:1).
  const r = fitCenterRect(1000, 1000, null, panel);
  assert(r.w === 200 && r.h === 200, `expected 200x200, got ${r.w}x${r.h}`);
  // Centred: x=(400-200)/2=100, y=0.
  assert(r.x === 100 && r.y === 0, `expected (100,0), got (${r.x},${r.y})`);
});

t("fitCenterRect never magnifies beyond panel and preserves aspect", () => {
  // 100x50 image (2:1), fit into 800x400 panel (2:1). No magnification: keep 100x50.
  const r1 = fitCenterRect(100, 50, null, { x: 0, y: 0, w: 800, h: 400 });
  assert(r1.w === 100 && r1.h === 50, `no magnify: got ${r1.w}x${r1.h}`);
  // 2000x1000 image (2:1), panel 800x400 (2:1). Should downscale to 800x400.
  const r2 = fitCenterRect(2000, 1000, null, { x: 0, y: 0, w: 800, h: 400 });
  assert(r2.w === 800 && r2.h === 400, `downscale: got ${r2.w}x${r2.h}`);
  // Aspect preserved (allow 1px rounding): w/h ratio ~ 2.
  const ratio = r2.w / r2.h;
  assert(Math.abs(ratio - 2) < 0.05, `aspect ${ratio}`);
  // Never exceeds panel.
  assert(r2.x >= 0 && r2.y >= 0 && r2.x + r2.w <= 800 && r2.y + r2.h <= 400, "exceeds panel");
});

t("slotPanels returns correct panel sets", () => {
  assert(slotPanels("uniform").length === 5, "uniform=5");
  assert(slotPanels("arms").length === 4, "arms=4");
  assert(!slotPanels("arms").includes("top"), "arms excludes top");
  assert(slotPanels("armsTopBottom").join(",") === "sideTop,sideBottom", "armsTopBottom");
  assert(slotPanels("armsLeftRight").join(",") === "endLeft,endRight", "armsLeftRight");
  assert(slotPanels("center").join(",") === "top", "center");
});

t("panelFoldRotation values", () => {
  assert(panelFoldRotation("top") === 0, "top=0");
  assert(panelFoldRotation("sideBottom") === 0, "sideBottom=0");
  assert(panelFoldRotation("sideTop") === 180, "sideTop=180");
  assert(panelFoldRotation("endLeft") === 90, "endLeft=90");
  assert(panelFoldRotation("endRight") === 270, "endRight=270");
});

t("short tabs rotate in opposite directions", () => {
  assert(
    panelFoldRotation("endLeft") + panelFoldRotation("endRight") === 360,
    `sum ${panelFoldRotation("endLeft") + panelFoldRotation("endRight")}`,
  );
});

t("every arm rotation is a valid 90-multiple", () => {
  const allowed = new Set([0, 90, 180, 270]);
  for (const id of ["sideTop", "sideBottom", "endLeft", "endRight"] as const) {
    const r = panelFoldRotation(id);
    assert(allowed.has(r), `${id} rotation ${r}`);
    assert(r % 90 === 0, `${id} not %90`);
  }
});

t("rotatedDrawRegion is identity at 0 and 180", () => {
  const p = { x: 100, y: 200, w: 400, h: 100 };
  for (const rot of [0, 180] as const) {
    const r = rotatedDrawRegion(p, rot);
    assert(r.x === p.x && r.y === p.y && r.w === p.w && r.h === p.h, `rot ${rot}: ${JSON.stringify(r)}`);
  }
});

t("rotatedDrawRegion swaps w/h and preserves centre at 90/270", () => {
  const p = { x: 100, y: 200, w: 400, h: 100 };
  const expected = { x: 250, y: 50, w: 100, h: 400 };
  for (const rot of [90, 270] as const) {
    const r = rotatedDrawRegion(p, rot);
    assert(
      r.x === expected.x && r.y === expected.y && r.w === expected.w && r.h === expected.h,
      `rot ${rot}: got ${JSON.stringify(r)}`,
    );
    const cxIn = p.x + p.w / 2;
    const cyIn = p.y + p.h / 2;
    const cxOut = r.x + r.w / 2;
    const cyOut = r.y + r.h / 2;
    assert(cxIn === cxOut && cyIn === cyOut, `centre drift rot ${rot}`);
  }
});

t("naming hazard: 'top' is the centre face, not an arm", () => {
  assert(panelFoldRotation("top") === 0, "top rotation must be 0");
  const top = BRICK_PANELS.find((p) => p.id === "top")!;
  assert(
    top.widthInches === BRICK.coverLength && top.heightInches === BRICK.coverWidth,
    `top dims ${top.widthInches}x${top.heightInches} vs cover ${BRICK.coverLength}x${BRICK.coverWidth}`,
  );
  // Sanity: canvas constants imported so test fails loudly if they vanish.
  assert(BRICK_CANVAS_WIDTH_INCHES > 0 && BRICK_CANVAS_HEIGHT_INCHES > 0, "canvas dims");
});



console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
