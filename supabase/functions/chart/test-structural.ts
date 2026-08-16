// Deno test — geometry-authoritative frame detection.
// Run: deno test --allow-read supabase/functions/chart/test-structural.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyConstraints, buildStructuralModel, renderModel, runStructuralPass, type PaletteEntry } from "./structural-model.ts";

Deno.test("fixture-border: border strokes normalised to 1 with equal panes", async () => {
  const fixturePath = new URL("./_fixture-border.json", import.meta.url);
  const fx = JSON.parse(await Deno.readTextFile(fixturePath));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  const model = buildStructuralModel(grid, gridW, gridH, outPalette, new Set<number>());
  applyConstraints(model);

  const target = model.frames.find((f) => f.c0 === 51 && f.r0 === 46);
  assert(target, `expected frame at r0=46,c0=51; got ${JSON.stringify(model.frames.map((f) => [f.r0, f.c0, f.r1, f.c1]))}`);

  // 1-stitch strokes are definitional; measured >1 thickness is a downsample
  // artifact (proven by matched-pair twins disagreeing on per-side widths).
  assertEquals(target!.borderW, { t: 1, b: 1, l: 1, r: 1 },
    `borderW must normalise to 1 on every side; got ${JSON.stringify(target!.borderW)}`);

  // Single horizontal + vertical divider with equal panes either side.
  assertEquals(target!.hDividers.length, 1, `expected 1 hDivider; got ${JSON.stringify(target!.hDividers)}`);
  assertEquals(target!.vDividers.length, 1, `expected 1 vDivider; got ${JSON.stringify(target!.vDividers)}`);
  const hd = target!.hDividers[0], vd = target!.vDividers[0];
  const paneAbove = hd - (target!.r0 + 1);
  const paneBelow = (target!.r1 - 1) - hd;
  assertEquals(paneAbove, paneBelow, `pane heights above/below hDivider must be equal; got ${paneAbove} vs ${paneBelow}`);
  const paneLeft = vd - (target!.c0 + 1);
  const paneRight = (target!.c1 - 1) - vd;
  assertEquals(paneLeft, paneRight, `pane widths left/right of vDivider must be equal; got ${paneLeft} vs ${paneRight}`);

  // Render, then verify exactly 1-cell-thick strokes: row just inside the top
  // border and col just inside the left border are pane colour (not frame).
  const usage: Record<string, number> = {};
  renderModel(model, grid, usage, outPalette, false);
  const frameCol = target!.frameColour, paneCol = target!.paneColour;
  // Probe strictly inside the top-left pane (avoids the dividers themselves).
  const probeC = target!.c0 + 1;
  const probeR = target!.r0 + 1;
  assert(probeC < vd && probeR < hd, "probe must land in top-left pane");
  assertEquals(grid[target!.r0 * gridW + probeC], frameCol, "top border row must be frame colour");
  assertEquals(grid[(target!.r0 + 1) * gridW + probeC], paneCol,
    "row just inside top border must be pane colour (border must be 1 cell thick)");
  assertEquals(grid[probeR * gridW + target!.c1], frameCol, "right border col must be frame colour");
  assertEquals(grid[probeR * gridW + (target!.c1 - 1)], paneCol,
    "col just inside right border must be pane colour (border must be 1 cell thick)");
});

Deno.test("fixture-thick: downsample-thick borders normalised, panes equal", async () => {
  const fixturePath = new URL("./_fixture-thick.json", import.meta.url);
  const fx = JSON.parse(await Deno.readTextFile(fixturePath));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  const model = buildStructuralModel(grid, gridW, gridH, outPalette, new Set<number>());
  applyConstraints(model);

  // Three real windows: gable (r0=21) + paired side windows (r0=40).
  const windows = model.frames.filter((f) => f.r0 === 21 || f.r0 === 40);
  assertEquals(windows.length, 3, `expected 3 window frames; got ${JSON.stringify(model.frames.map((f) => [f.r0, f.c0, f.r1, f.c1]))}`);

  const usage: Record<string, number> = {};
  renderModel(model, grid, usage, outPalette, false);

  for (const f of windows) {
    assertEquals(f.borderW, { t: 1, b: 1, l: 1, r: 1 },
      `window borderW must normalise to 1; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])} got ${JSON.stringify(f.borderW)}`);
    assertEquals(f.hDividers.length, 1,
      `window must have 1 hDivider; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])} got ${JSON.stringify(f.hDividers)}`);
    const hd = f.hDividers[0];
    const paneAbove = hd - (f.r0 + 1);
    const paneBelow = (f.r1 - 1) - hd;
    assertEquals(paneAbove, paneBelow,
      `equal panes above/below hDivider; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])} above=${paneAbove} below=${paneBelow}`);

    // Rendered rows: r0 is frame; r0+1 must be pane (1-cell top stroke).
    // Row hd is frame; hd-1 must be pane (1-cell divider). r1 is frame; r1-1 pane.
    const frameCol = f.frameColour, paneCol = f.paneColour;
    // Probe strictly inside the top-left pane (never on a divider).
    const vd = f.vDividers[0] ?? (f.c1 - 1);
    const probeC = f.c0 + 1;
    const probeR = f.r0 + 1;
    assert(probeC < vd && probeR < hd,
      `probe must land in top-left pane; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])} probe=(${probeR},${probeC}) vd=${vd} hd=${hd}`);
    assertEquals(grid[f.r0 * gridW + probeC], frameCol,
      `top border must be frame colour; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[(f.r0 + 1) * gridW + probeC], paneCol,
      `row just inside top border must be pane (border 1 thick); frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[f.r1 * gridW + probeC], frameCol,
      `bottom border must be frame colour; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[(f.r1 - 1) * gridW + probeC], paneCol,
      `row just inside bottom border must be pane (border 1 thick); frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[hd * gridW + probeC], frameCol,
      `hDivider row must be frame colour; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[(hd - 1) * gridW + probeC], paneCol,
      `row just above hDivider must be pane (divider 1 thick); frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);

    assertEquals(grid[probeR * gridW + f.c0], frameCol,
      `left border must be frame colour; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[probeR * gridW + (f.c0 + 1)], paneCol,
      `col just inside left border must be pane; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[probeR * gridW + f.c1], frameCol,
      `right border must be frame colour; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
    assertEquals(grid[probeR * gridW + (f.c1 - 1)], paneCol,
      `col just inside right border must be pane; frame=${JSON.stringify([f.r0, f.c0, f.r1, f.c1])}`);
  }
});

Deno.test("fixture-live: two side windows detected via geometry alone", async () => {
  const fixturePath = new URL("./_fixture-live.json", import.meta.url);
  const fx = JSON.parse(await Deno.readTextFile(fixturePath));
  const gridW = 78, gridH = 78;
  assertEquals(fx.gridW, gridW);
  assertEquals(fx.grid.length, gridW * gridH);
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  // Reproduce live segmentStampedCells: non-empty but ~0 coverage of the
  // side windows (rows 40..53). Stamp first 20 cream cells OUTSIDE that band.
  const CREAM = 2;
  const stamped = new Set<number>();
  for (let i = 0; i < grid.length && stamped.size < 20; i++) {
    if (grid[i] !== CREAM) continue;
    const r = (i / gridW) | 0;
    if (r >= 40 && r <= 55) continue;
    stamped.add(i);
  }
  assert(stamped.size > 0, "stamp set must be non-empty (live condition)");

  const model = buildStructuralModel(grid, gridW, gridH, outPalette, stamped);

  console.log("TEST: frames detected:", JSON.stringify(model.frames.map((f) => ({
    r0: f.r0, c0: f.c0, r1: f.r1, c1: f.c1, h: f.hDividers, v: f.vDividers, col: f.frameColour,
  }))));

  // Fixture also contains a legit gable frame at (19,32)-(32,45) — a fully
  // cream-bordered hollow rect that geometry correctly accepts. The bug we
  // are fixing was the side windows being rejected; assert on that intent.
  assert(model.frames.length >= 2, `expected >=2 frames, got ${model.frames.length}`);

  // Order-independent: find left (c0 < 40) and right (c0 >= 40) frame
  const left  = model.frames.find((f) => f.r0 >= 40 && f.c0 < 40);
  const right = model.frames.find((f) => f.r0 >= 40 && f.c0 >= 40);
  assert(left && right, "one left and one right frame expected");

  // Dimensions: 12 wide, 14 tall (r 40..53, c 17..28 / 49..60)
  for (const f of [left!, right!]) {
    assertEquals(f.c1 - f.c0 + 1, 12, `frame width should be 12: ${JSON.stringify(f)}`);
    assertEquals(f.r1 - f.r0 + 1, 14, `frame height should be 14: ${JSON.stringify(f)}`);
    assertEquals(f.hDividers.length, 1, `1 hDivider: ${JSON.stringify(f)}`);
    assertEquals(f.vDividers.length, 1, `1 vDivider: ${JSON.stringify(f)}`);
    assertEquals(f.frameColour, CREAM);
    // Midrow of a 14-tall bbox is 46 or 47; live grid shows fully-cream row 47.
    assert(f.hDividers[0] === 47, `hDivider expected 47, got ${f.hDividers[0]}`);
  }
  assertEquals(left!.c0, 17); assertEquals(left!.c1, 28);
  assertEquals(right!.c0, 49); assertEquals(right!.c1, 60);
  assertEquals(left!.vDividers[0], 22);
  assertEquals(right!.vDividers[0], 55);

  // Phantom guard against previously-observed rejects: no frame at the arched
  // gable (r0=39) or 1-wide house outline (c0<=12).
  for (const f of model.frames) {
    assert(f.r0 !== 39, `no frame at r0=39, got ${JSON.stringify(f)}`);
    assert(f.c0 > 12, `no frame at c0<=12, got ${JSON.stringify(f)}`);
  }
});

Deno.test("phantom guard: solid light block emits no frame", () => {
  const gridW = 30, gridH = 30;
  const grid = new Uint16Array(gridW * gridH); // all 0 (bg)
  // Solid 10x10 light block colour 2 at (5,5)-(14,14).
  for (let r = 5; r <= 14; r++) for (let c = 5; c <= 14; c++) grid[r * gridW + c] = 2;
  const palette: PaletteEntry[] = [{ hex: "#ffffff" }, { hex: "#000000" }, { hex: "#ebe5df" }];
  const model = buildStructuralModel(grid, gridW, gridH, palette, new Set<number>());
  assertEquals(model.frames.length, 0, `solid block must not be a frame: ${JSON.stringify(model.frames)}`);
});

Deno.test("phantom guard: solid light pane inside a light frame — no phantom inner frame", () => {
  const gridW = 30, gridH = 30;
  const grid = new Uint16Array(gridW * gridH); // bg 0
  // Outer hollow rect colour 2, bbox (3,3)-(20,20).
  for (let r = 3; r <= 20; r++) for (let c = 3; c <= 20; c++) grid[r * gridW + c] = 2;
  // Interior filled with light pane colour 3 (bbox 5,5..18,18).
  for (let r = 5; r <= 18; r++) for (let c = 5; c <= 18; c++) grid[r * gridW + c] = 3;
  const palette: PaletteEntry[] = [
    { hex: "#ffffff" }, { hex: "#000000" }, { hex: "#ebe5df" }, { hex: "#dcdcdc" },
  ];
  const model = buildStructuralModel(grid, gridW, gridH, palette, new Set<number>());
  // Outer may qualify as a hollow frame (that's correct). Inner pane must NOT.
  for (const f of model.frames) {
    assert(!(f.r0 === 5 && f.c0 === 5), `inner pane should not become a phantom frame: ${JSON.stringify(f)}`);
  }
  // Nested-suppression invariant: no frame is strictly inside another.
  for (let i = 0; i < model.frames.length; i++) {
    for (let j = 0; j < model.frames.length; j++) {
      if (i === j) continue;
      const a = model.frames[i], b = model.frames[j];
      const inside = a.r0 >= b.r0 && a.r1 <= b.r1 && a.c0 >= b.c0 && a.c1 <= b.c1
        && (b.r1 - b.r0) * (b.c1 - b.c0) > (a.r1 - a.r0) * (a.c1 - a.c0);
      assert(!inside, `frame ${i} nested inside frame ${j}`);
    }
  }
});

Deno.test("synthetic: uniform 1px-border frame unaffected by per-side borderW type", () => {
  // 13x13 grid; hollow-frame colour 2 at bbox (2,2)-(12,12), pane colour 3,
  // with a horizontal and vertical divider at midlines (row 7, col 7).
  const gridW = 15, gridH = 15;
  const grid = new Uint16Array(gridW * gridH);
  for (let r = 2; r <= 12; r++) for (let c = 2; c <= 12; c++) grid[r * gridW + c] = 2;
  for (let r = 3; r <= 11; r++) for (let c = 3; c <= 11; c++) grid[r * gridW + c] = 3;
  for (let c = 3; c <= 11; c++) grid[7 * gridW + c] = 2;
  for (let r = 3; r <= 11; r++) grid[r * gridW + 7] = 2;
  const palette: PaletteEntry[] = [
    { hex: "#ffffff" }, { hex: "#000000" }, { hex: "#ebe5df" }, { hex: "#dcdcdc" },
  ];
  const model = buildStructuralModel(grid, gridW, gridH, palette, new Set<number>());
  applyConstraints(model);
  const f = model.frames.find((x) => x.r0 === 2 && x.c0 === 2);
  assert(f, `expected frame at (2,2); got ${JSON.stringify(model.frames)}`);
  assertEquals(f!.borderW.t, 1); assertEquals(f!.borderW.b, 1);
  assertEquals(f!.borderW.l, 1); assertEquals(f!.borderW.r, 1);
  assertEquals(f!.r1, 12); assertEquals(f!.c1, 12);
  assertEquals(f!.hDividers, [7]);
  assertEquals(f!.vDividers, [7]);
});


Deno.test("fixture-ornate: sibling regularization recovers rejected window siblings", async () => {
  const fixturePath = new URL("./_fixture-ornate.json", import.meta.url);
  const fx = JSON.parse(await Deno.readTextFile(fixturePath));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  const model = buildStructuralModel(grid, gridW, gridH, outPalette, new Set<number>());

  console.log("ORNATE frames:", model.frames.length, JSON.stringify(model.frames.map((f) => [f.r0, f.c0, f.r1, f.c1])));

  // Middle row (r43-55, 5 aligned cream regions): 1 accepted strict + 4
  // recovered via anchored path.
  const middleRow = model.frames.filter((f) => f.r0 >= 42 && f.r0 <= 44);
  assert(middleRow.length >= 5, `expected >=5 middle-row frames (anchored recovery); got ${middleRow.length}`);

  // Bottom row (r63-76, 4 aligned cream regions): 1 accepted strict + 3
  // recovered via anchored path.
  const bottomRow = model.frames.filter((f) => f.r0 >= 62 && f.r0 <= 64);
  assert(bottomRow.length >= 4, `expected >=4 bottom-row frames (anchored recovery); got ${bottomRow.length}`);

  // Top row (r23-36, 3 cream regions): unanchored path correctly rejects —
  // one member is not hollow (interior mostly frame-colour = solid block),
  // and unanchored requires every member hollow. That's the designed safety
  // gate; no assertion here. Total: middle 5 + bottom 4 = 9+ frames.
  assert(model.frames.length >= 9, `expected >=9 total frames; got ${model.frames.length}`);
});

Deno.test("fixture-doublebar: bottom-left window has single vDivider (not spurious pair)", async () => {
  const fx = JSON.parse(await Deno.readTextFile(new URL("./_fixture-doublebar.json", import.meta.url)));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  const model = buildStructuralModel(grid, gridW, gridH, outPalette, new Set<number>());
  applyConstraints(model);

  // The bottom-left window frame anchored near r61,c19.
  const bl = model.frames.find((f) => f.r0 >= 60 && f.r0 <= 62 && f.c0 >= 18 && f.c0 <= 21);
  assert(bl, `expected bottom-left window frame near r61,c19; got ${JSON.stringify(model.frames.map((f) => [f.r0, f.c0]))}`);
  assertEquals(bl!.vDividers.length, 1,
    `bottom-left window should have 1 vDivider (single mullion); got ${JSON.stringify(bl!.vDividers)} — spurious second divider indicates under-measured border`);
});

Deno.test("fixture-missingbar: accepted-vs-accepted col-stack reconciles missing hDivider", async () => {
  const fx = JSON.parse(await Deno.readTextFile(new URL("./_fixture-missingbar.json", import.meta.url)));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  const model = buildStructuralModel(grid, gridW, gridH, outPalette, new Set<number>());
  applyConstraints(model);

  const bl = model.frames.find((f) => f.r0 >= 62 && f.r0 <= 64 && f.c0 >= 20 && f.c0 <= 22);
  assert(bl, `expected bottom-left window frame near r63,c21; got ${JSON.stringify(model.frames.map((f) => [f.r0, f.c0]))}`);
  assertEquals(bl!.hDividers.length, 1,
    `bottom-left window should have 1 hDivider (reconciled from col-aligned top-left sibling); got ${JSON.stringify(bl!.hDividers)}`);

  const br = model.frames.find((f) => f.r0 >= 62 && f.r0 <= 64 && f.c0 >= 68 && f.c0 <= 70);
  assert(br, `expected bottom-right window frame near r63,c69; got ${JSON.stringify(model.frames.map((f) => [f.r0, f.c0]))}`);
  assertEquals(br!.hDividers.length, 1,
    `bottom-right window should have 1 hDivider (via pair congruence or direct reconciliation); got ${JSON.stringify(br!.hDividers)}`);
});

Deno.test("fixture-straystitch: orphan-cleanup clears stray third-colour pixels in vacated strip", async () => {
  const fx = JSON.parse(await Deno.readTextFile(new URL("./_fixture-straystitch.json", import.meta.url)));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));
  const outUsage: Record<string, number> = {};
  runStructuralPass(grid, gridW, gridH, outPalette, outUsage, new Set<number>(), { renderFreeLines: true });

  const STRAY = 4; // tan — anti-alias artifact, neither frame nor pane colour
  const coords: [number, number][] = [[34,32],[35,32],[36,32],[40,32],[42,32],[43,32],[49,32]];
  // Body/outside colour should be red (1) — the wall surrounding the window.
  for (const [r,c] of coords) {
    const v = grid[r * gridW + c];
    assert(v !== STRAY, `r${r} c${c} still stray tan (${STRAY}); orphan-cleanup did not clear third-colour pixel`);
  }
});

Deno.test("fixture-butterfly: filled wings must not be promoted as mirror-pair frames (blue eye-spots survive)", async () => {
  const fx = JSON.parse(await Deno.readTextFile(new URL("./_fixture-butterfly.json", import.meta.url)));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  // Count blue (palette index 6) cells BEFORE and AFTER runStructuralPass.
  // The diagnosed defect: recoverMirrorPair was promoting the two cream wings
  // (a filled shape, not a hollow frame) into mirror-pair frames with
  // paneColour=-1, then renderModel wiped every interior cell inside those
  // bboxes to 65535 (a Uint16Array wrap of -1) — including all 98 blue
  // eye-spot cells that sit inside those bboxes. Fix (fill-fraction gate +
  // paneColour validity requirement) must preserve them.
  const BLUE = 6;
  let blueBefore = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === BLUE) blueBefore++;

  const outUsage: Record<string, number> = {};
  runStructuralPass(grid, gridW, gridH, outPalette, outUsage, new Set<number>(), { renderFreeLines: true });

  let blueAfter = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === BLUE) blueAfter++;

  // No 65535 sentinels (uncomputed paneColour writes) may reach the grid.
  let sentinel = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === 65535) sentinel++;
  assertEquals(sentinel, 0, `renderModel must never write 65535 (invalid paneColour) into the grid; got ${sentinel} sentinel cells`);

  // Blue eye-spot cells must survive substantially intact — allow a small
  // downstream cleanup margin but reject wholesale loss.
  assert(blueAfter >= blueBefore * 0.9,
    `blue eye-spot cells must survive runStructuralPass: before=${blueBefore} after=${blueAfter}`);
});

Deno.test("fixture-butterfly-2: 8x8 highlight dots must not be promoted as mirror-pair frames (light-grey cells preserved)", async () => {
  const fx = JSON.parse(await Deno.readTextFile(new URL("./_fixture-butterfly-2.json", import.meta.url)));
  const gridW = fx.gridW as number;
  const gridH = fx.gridH as number;
  const grid = new Uint16Array(fx.grid);
  const outPalette: PaletteEntry[] = (fx.palette as string[]).map((hex) => ({ hex }));

  // Palette index 3 = light-grey highlight-dot colour (559 cells before any
  // structural pass). The two 8x8 dots sit at r32,c31 and r32,c69: same
  // colour, same size, mirror-symmetric about the image centre — exactly
  // the false-positive pattern recoverMirrorPair mis-classified as a
  // window pair. With the tightened ceiling those dots must be rejected
  // (fill-ratio 1.143 > 1.0) while the real thin-frame case in
  // _fixture-sevenwindow (fill-ratio 0.75) still passes.
  const HIGHLIGHT = 3;
  let before = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === HIGHLIGHT) before++;
  assertEquals(before, 559, `baseline check: fixture must contain 559 light-grey cells; got ${before}`);

  // Assert BEFORE render: buildStructuralModel must not emit frames on the
  // 8x8 highlight-dot bboxes. This locks the fix at the mirror-pair gate,
  // not downstream cleanup.
  const model = buildStructuralModel(new Uint16Array(fx.grid), gridW, gridH, outPalette, new Set<number>());
  const dotFrames = model.frames.filter((f) =>
    (f.r0 === 32 && f.c0 === 31 && f.r1 === 39 && f.c1 === 38) ||
    (f.r0 === 32 && f.c0 === 69 && f.r1 === 39 && f.c1 === 76));
  assertEquals(dotFrames.length, 0,
    `mirror-pair recovery must reject the 8x8 highlight dots; got ${JSON.stringify(dotFrames.map((f) => [f.r0, f.c0, f.r1, f.c1]))}`);

  const outUsage: Record<string, number> = {};
  runStructuralPass(grid, gridW, gridH, outPalette, outUsage, new Set<number>(), { renderFreeLines: true });

  let after = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === HIGHLIGHT) after++;
  let sentinel = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === 65535) sentinel++;
  assertEquals(sentinel, 0, `no 65535 sentinels may leak from renderModel; got ${sentinel}`);
  // Exact preservation: no frame promoted → nothing repainted over the dots.
  assertEquals(after, before,
    `light-grey highlight-dot cells must survive intact: before=${before} after=${after}`);
});

