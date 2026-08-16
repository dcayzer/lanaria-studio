// Tests for shape-border.ts / perimeter-path.ts / shape-aware-border.ts and the
// shape-aware branches of border-layers.ts.
// Run via: bun run src/lib/test-shape-border.ts

import {
  edgeDepthMap,
  buildShapeBorder,
  interiorAfterBorder,
  colourRing,
  NOT_STITCHABLE_NUM,
  type ShapeGrid,
} from "./shape-border";
import {
  tracePerimeter,
  detectCorners,
  buildPerimeterPath,
  distributeRepeats,
  canUseDirectionalRepeat,
} from "./perimeter-path";
import {
  maskToShapeGrid,
  isUnrestricted,
  shapedFrameCells,
  accentsAroundShape,
  stampsAroundShape,
  depthsForMask,
} from "./shape-aware-border";
import { borderToLayer } from "./border-layers";
import type { ThreadColor } from "../data/threadPalettes";

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

// ── helpers ────────────────────────────────────────────────────────────────
function rectGrid(w: number, h: number): ShapeGrid {
  return { width: w, height: h, cells: new Array(w * h).fill(0) };
}

function gridFromRows(rows: string[]): ShapeGrid {
  const h = rows.length;
  const w = rows[0].length;
  const cells: number[] = [];
  for (const row of rows) {
    for (const ch of row) cells.push(ch === "." ? NOT_STITCHABLE_NUM : 0);
  }
  return { width: w, height: h, cells };
}

function discMask(w: number, h: number): boolean[][] {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const r = Math.min(w, h) / 2;
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => Math.hypot(x - cx, y - cy) <= r - 0.5),
  );
}

function maskFromGrid(g: ShapeGrid): boolean[][] {
  return Array.from({ length: g.height }, (_, y) =>
    Array.from({ length: g.width }, (_, x) => g.cells[y * g.width + x] !== NOT_STITCHABLE_NUM),
  );
}

const SENTINEL = "__T__";
const PALETTE: ThreadColor[] = [
  { code: "A1", name: "Ink", hex: "#101010" },
  { code: "B2", name: "Sage", hex: "#3B4F35" },
  { code: "C3", name: "Cream", hex: "#F0E8D0" },
] as ThreadColor[];

const STYLES = ["simple", "double", "ornate", "star", "floral", "folk"];

function borderCells(
  style: string,
  w: number,
  h: number,
  mask?: boolean[][] | null,
): string[][] {
  const layer = borderToLayer(
    "border",
    { style, colors: ["#101010", "#3B4F35", "#F0E8D0"] },
    w, h, PALETTE, SENTINEL, mask,
  );
  assert(layer, `border layer null for ${style}`);
  return layer!.cells as unknown as string[][];
}

// ── shape-border.ts ────────────────────────────────────────────────────────

t("5x5 all-stitchable depth map is the concentric ring 00000/01110/01210/01110/00000", () => {
  const d = edgeDepthMap(rectGrid(5, 5));
  const expect = [
    0, 0, 0, 0, 0,
    0, 1, 1, 1, 0,
    0, 1, 2, 1, 0,
    0, 1, 1, 1, 0,
    0, 0, 0, 0, 0,
  ];
  assert(JSON.stringify(d) === JSON.stringify(expect), `got ${d.join("")}`);
});

t("rectangle depth === min(x,y,W-1-x,H-1-y) across sizes", () => {
  for (const [w, h] of [[7, 7], [12, 5], [31, 44]] as Array<[number, number]>) {
    const d = edgeDepthMap(rectGrid(w, h));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const want = Math.min(x, y, w - 1 - x, h - 1 - y);
        assert(d[y * w + x] === want, `depth mismatch at ${x},${y} on ${w}x${h}`);
      }
    }
  }
});

t("bandCount=1 on a 5x5 rectangle is exactly the classic 16-cell ring", () => {
  const ring = buildShapeBorder(rectGrid(5, 5), 1);
  assert(ring.cellCount === 16, `cellCount ${ring.cellCount}`);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const onRing = x === 0 || y === 0 || x === 4 || y === 4;
      assert((ring.depth[y * 5 + x] === 0) === onRing, `wrong ring membership at ${x},${y}`);
    }
  }
  assert(ring.collapsed === false, "5x5 band 1 should not be collapsed");
});

t("bandCount rejects 0 and non-integers", () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    let threw = false;
    try { buildShapeBorder(rectGrid(5, 5), bad); } catch { threw = true; }
    assert(threw, `bandCount ${bad} should throw`);
  }
});

t("collapsed is flagged, not silently clipped, when the band eats the whole shape", () => {
  assert(buildShapeBorder(rectGrid(3, 3), 2).collapsed, "3x3 band 2 should collapse");
  assert(buildShapeBorder(rectGrid(5, 5), 3).collapsed, "5x5 band 3 should collapse");
  assert(!buildShapeBorder(rectGrid(9, 9), 2).collapsed, "9x9 band 2 should not collapse");
});

t("interiorAfterBorder removes exactly the ring cells", () => {
  const inner = interiorAfterBorder(rectGrid(5, 5), 1);
  let stitchable = 0;
  for (const c of inner.cells) if (c !== NOT_STITCHABLE_NUM) stitchable++;
  assert(stitchable === 9, `expected 9 interior cells, got ${stitchable}`);
});

t("colourRing maps bands outside-in and clamps past the colour list", () => {
  const ring = buildShapeBorder(rectGrid(9, 9), 3);
  const coloured = colourRing(ring, [10, 20]);
  assert(coloured[0] === 10, "depth 0 -> first colour");
  assert(coloured[9 + 1] === 20, "depth 1 -> second colour");
  assert(coloured[2 * 9 + 2] === 20, "depth 2 clamps to last colour");
  assert(coloured[4 * 9 + 4] === NOT_STITCHABLE_NUM, "interior untouched");
});

t("a one-cell neck (stocking ankle) does not break the depth ring", () => {
  const g = gridFromRows([
    "#####",
    "#####",
    "..#..",
    "#####",
    "#####",
  ]);
  const d = edgeDepthMap(g);
  assert(d[2 * 5 + 2] === 0, "neck cell must be a boundary cell, not unreachable");
  const ring = buildShapeBorder(g, 1);
  assert(ring.depth[2 * 5 + 2] === 0, "neck cell must be part of the ring");
});

// ── perimeter-path.ts ──────────────────────────────────────────────────────

t("tracePerimeter is a closed loop with 8-adjacent consecutive points", () => {
  for (const g of [rectGrid(10, 7), maskToShapeGrid(discMask(21, 21), 21, 21)]) {
    const pts = tracePerimeter(g);
    assert(pts.length > 4, "expected a real contour");
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      assert(dx <= 1 && dy <= 1 && dx + dy > 0, `gap in contour at index ${i}`);
    }
  }
});

t("tracePerimeter survives a one-cell neck", () => {
  const g = gridFromRows([
    "#####",
    "#####",
    "..#..",
    "#####",
    "#####",
  ]);
  const pts = tracePerimeter(g);
  assert(pts.some((p) => p.x === 2 && p.y === 2), "neck cell should appear on the contour");
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    assert(Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1, `gap at ${i}`);
  }
});

t("detectCorners: 4 on a rectangle, 0 on a disc", () => {
  const rect = detectCorners(tracePerimeter(rectGrid(24, 18)));
  assert(rect.length === 4, `rectangle corners = ${rect.length}`);
  const disc = detectCorners(tracePerimeter(maskToShapeGrid(discMask(41, 41), 41, 41)));
  assert(disc.length === 0, `disc corners = ${disc.length}`);
});

t("distributeRepeats fits whole units and spreads the remainder", () => {
  const path = buildPerimeterPath(rectGrid(20, 20));
  const d = distributeRepeats(path, 7);
  assert(!d.tooShort, "should fit");
  assert(d.count === Math.floor(path.length / 7), "count");
  assert(d.remainder === path.length - d.count * 7, "remainder");
  assert(d.placements.length === d.count, "placement count");
  let threw = false;
  try { distributeRepeats(path, 0); } catch { threw = true; }
  assert(threw, "repeatWidth 0 must throw");
  const tiny = distributeRepeats(buildPerimeterPath(rectGrid(2, 2)), 50);
  assert(tiny.tooShort, "tooShort must be surfaced");
});

t("canUseDirectionalRepeat: true on rectangle, false on disc and diagonal edge", () => {
  assert(canUseDirectionalRepeat(buildPerimeterPath(rectGrid(30, 22))), "rectangle should allow");
  const disc = buildPerimeterPath(maskToShapeGrid(discMask(41, 41), 41, 41));
  assert(!canUseDirectionalRepeat(disc), "disc should refuse");
  const diag = gridFromRows([
    "#........",
    "##.......",
    "###......",
    "####.....",
    "#####....",
    "######...",
    "#######..",
    "########.",
    "#########",
  ]);
  assert(!canUseDirectionalRepeat(buildPerimeterPath(diag)), "diagonal edge should refuse");
});

// ── shape-aware-border.ts ──────────────────────────────────────────────────

t("maskToShapeGrid / isUnrestricted treat no-mask and all-true alike", () => {
  const none = maskToShapeGrid(null, 6, 4);
  const all = maskToShapeGrid(
    Array.from({ length: 4 }, () => new Array(6).fill(true)),
    6, 4,
  );
  assert(isUnrestricted(none) && isUnrestricted(all), "both must be unrestricted");
  assert(!isUnrestricted(maskToShapeGrid(discMask(21, 21), 21, 21)), "disc is restricted");
});

t("shapedFrameCells on a rectangle equals the legacy drawFrame ring", () => {
  for (const [w, h] of [[20, 20], [31, 17], [9, 9], [7, 7]] as Array<[number, number]>) {
    for (const inset of [0, 2, 3, 5]) {
      for (const thickness of [1, 2, 3]) {
        // legacy
        const legacy = new Set<string>();
        outerLoop: for (let t2 = 0; t2 < thickness; t2++) {
          const o = inset + t2;
          if (o * 2 + 1 >= w || o * 2 + 1 >= h) break outerLoop;
          for (let x = o; x <= w - 1 - o; x++) { legacy.add(`${x},${o}`); legacy.add(`${x},${h - 1 - o}`); }
          for (let y = o; y <= h - 1 - o; y++) { legacy.add(`${o},${y}`); legacy.add(`${w - 1 - o},${y}`); }
        }
        const depths = edgeDepthMap(rectGrid(w, h));
        const shapedSet = new Set(
          shapedFrameCells(depths, w, h, inset, thickness, true).map((p) => `${p.x},${p.y}`),
        );
        assert(
          shapedSet.size === legacy.size && [...legacy].every((k) => shapedSet.has(k)),
          `frame mismatch ${w}x${h} inset ${inset} thickness ${thickness} (${shapedSet.size} vs ${legacy.size})`,
        );
      }
    }
  }
});

t("shaped frame follows a cross shape — nothing drawn in the arm notches", () => {
  const rows = [
    "....#####....",
    "....#####....",
    "....#####....",
    "#############",
    "#############",
    "#############",
    "....#####....",
    "....#####....",
    "....#####....",
  ];
  const g = gridFromRows(rows);
  const depths = edgeDepthMap(g);
  const pts = shapedFrameCells(depths, g.width, g.height, 0, 1);
  assert(pts.length > 0, "expected border cells");
  for (const p of pts) {
    assert(rows[p.y][p.x] === "#", `border cell at ${p.x},${p.y} is in a notch`);
  }
});

t("accentsAroundShape spaces evenly and reports collapse", () => {
  const disc = maskToShapeGrid(discMask(41, 41), 41, 41);
  const a = accentsAroundShape(disc, 3, 8);
  assert(!a.collapsed && a.points.length === 8, `got ${a.points.length}`);
  const uniq = new Set(a.points.map((p) => `${p.x},${p.y}`));
  assert(uniq.size === 8, "accents should not coincide");
  const tiny = accentsAroundShape(rectGrid(3, 3), 5, 8);
  assert(tiny.collapsed, "over-inset shape should report collapsed");
});

t("stampsAroundShape reports axisAligned honestly", () => {
  const rect = stampsAroundShape(rectGrid(40, 30), 3, 10);
  assert(rect.axisAligned, "rectangle contour is axis aligned");
  const disc = stampsAroundShape(maskToShapeGrid(discMask(41, 41), 41, 41), 3, 10);
  assert(!disc.axisAligned, "disc contour is not axis aligned");
  assert(disc.points.length > 0 && !disc.tooShort, "disc should fit stamps");
});

t("depthsForMask agrees with edgeDepthMap on the converted grid", () => {
  const mask = discMask(25, 25);
  const { grid, depths, unrestricted } = depthsForMask(mask, 25, 25);
  assert(!unrestricted, "disc restricted");
  assert(JSON.stringify(depths) === JSON.stringify(edgeDepthMap(grid)), "depths mismatch");
});

// ── border-layers.ts integration ───────────────────────────────────────────

t("every style: absent mask === all-true mask (byte-identical rectangle path)", () => {
  const allTrue = (w: number, h: number) =>
    Array.from({ length: h }, () => new Array(w).fill(true));
  for (const style of STYLES) {
    for (const [w, h] of [[60, 60], [80, 55]] as Array<[number, number]>) {
      const a = borderCells(style, w, h);
      const b = borderCells(style, w, h, allTrue(w, h));
      const c = borderCells(style, w, h, null);
      assert(JSON.stringify(a) === JSON.stringify(b), `${style} ${w}x${h}: all-true mask differs`);
      assert(JSON.stringify(a) === JSON.stringify(c), `${style} ${w}x${h}: null mask differs`);
    }
  }
});

t("simple/double rectangle output is exactly the legacy frame geometry", () => {
  const w = 60, h = 60;
  const thickness = Math.max(1, Math.min(2, Math.round(Math.min(w, h) / 120)));
  const inset = Math.max(2, Math.min(5, Math.round(Math.min(w, h) / 40)));
  const legacyRing = (ins: number, th: number) => {
    const s = new Set<string>();
    for (let t2 = 0; t2 < th; t2++) {
      const o = ins + t2;
      if (o * 2 + 1 >= w || o * 2 + 1 >= h) return s;
      for (let x = o; x <= w - 1 - o; x++) { s.add(`${x},${o}`); s.add(`${x},${h - 1 - o}`); }
      for (let y = o; y <= h - 1 - o; y++) { s.add(`${o},${y}`); s.add(`${w - 1 - o},${y}`); }
    }
    return s;
  };
  const simple = borderCells("simple", w, h);
  const painted = new Set<string>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (simple[y][x] !== SENTINEL) painted.add(`${x},${y}`);
  const want = legacyRing(inset, thickness);
  assert(painted.size === want.size && [...want].every((k) => painted.has(k)), "simple ring mismatch");

  const dbl = borderCells("double", w, h);
  const painted2 = new Set<string>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dbl[y][x] !== SENTINEL) painted2.add(`${x},${y}`);
  const want2 = new Set([...legacyRing(inset, thickness), ...legacyRing(inset + thickness + 1, thickness)]);
  assert(painted2.size === want2.size && [...want2].every((k) => painted2.has(k)), "double ring mismatch");
});

t("THE BUG: old rectangle border escapes a circle mask (test is meaningful)", () => {
  const w = 61, h = 61;
  const mask = discMask(w, h);
  let escapes = 0;
  for (const style of STYLES) {
    const cells = borderCells(style, w, h); // no mask == old behaviour
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cells[y][x] !== SENTINEL && !mask[y][x]) escapes++;
      }
    }
  }
  assert(escapes > 0, "old code should escape the circle — otherwise the fix test proves nothing");
});

t("THE FIX: on a circle mask no painted border cell falls outside the shape", () => {
  const w = 61, h = 61;
  const mask = discMask(w, h);
  for (const style of STYLES) {
    const cells = borderCells(style, w, h, mask);
    let painted = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cells[y][x] === SENTINEL) continue;
        painted++;
        assert(mask[y][x], `${style}: border cell at ${x},${y} is outside the circle`);
      }
    }
    assert(painted > 0, `${style}: shaped border painted nothing`);
  }
});

t("cross (brick-like) mask: no border cell in the arm notches, any style", () => {
  const rows: string[] = [];
  const w = 39, h = 27;
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const inArm = (x >= 12 && x < 27) || (y >= 9 && y < 18);
      row += inArm ? "#" : ".";
    }
    rows.push(row);
  }
  const mask = maskFromGrid(gridFromRows(rows));
  for (const style of STYLES) {
    const cells = borderCells(style, w, h, mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cells[y][x] !== SENTINEL) {
          assert(mask[y][x], `${style}: cell ${x},${y} painted in a notch`);
        }
      }
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
