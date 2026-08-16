// Deno test — cleanup passes (hole-fill + gap-bridge) preserve open
// negative space and drop diagonal bridging.
// Run: deno test --allow-read supabase/functions/chart/test-cleanup.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { borderReachableBackground, gapBridge, holeFill } from "./cleanup-passes.ts";

function makeGrid(rows: string[]): { grid: Uint16Array; W: number; H: number } {
  const H = rows.length, W = rows[0].length;
  const grid = new Uint16Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const ch = rows[r][c];
      grid[r * W + c] = ch === "." ? 0 : Number(ch);
    }
  }
  return { grid, W, H };
}

Deno.test("synthetic: enclosed 1px hole is filled", () => {
  const { grid, W, H } = makeGrid([
    "11111",
    "11111",
    "11.11",
    "11111",
    "11111",
  ]);
  const usage: Record<string, number> = {};
  const bg = new Set<number>([0]);
  const n = holeFill(grid, W, H, usage, bg, new Set());
  assertEquals(n, 1);
  assertEquals(grid[2 * W + 2], 1);
});

Deno.test("synthetic: open channel reaching border is preserved", () => {
  const { grid, W, H } = makeGrid([
    "11111",
    "11111",
    "11.11",
    "11.11",
  ]);
  const usage: Record<string, number> = {};
  const bg = new Set<number>([0]);
  const n = holeFill(grid, W, H, usage, bg, new Set());
  assertEquals(n, 0);
  assertEquals(grid[2 * W + 2], 0);
  assertEquals(grid[3 * W + 2], 0);
});

Deno.test("synthetic: axis-aligned 1px gap is bridged", () => {
  const { grid, W, H } = makeGrid([
    "11111",
    "12221",
    "12021",
    "12221",
    "11111",
  ]);
  const usage: Record<string, number> = {};
  const bg = new Set<number>([0]);
  const n = gapBridge(grid, W, H, usage, bg, new Set());
  assert(n >= 1);
  assertEquals(grid[2 * W + 2], 2);
});

Deno.test("synthetic: diagonals NOT bridged (removed direction pairs)", () => {
  // Enclosed center (2,2)=0 with diagonals matching (2s) but H/V differing.
  const { grid, W, H } = makeGrid([
    "11111",
    "12321",
    "14051",
    "12621",
    "11111",
  ]);
  const usage: Record<string, number> = {};
  const bg = new Set<number>([0]);
  const n = gapBridge(grid, W, H, usage, bg, new Set());
  assertEquals(n, 0);
  assertEquals(grid[2 * W + 2], 0);
});

Deno.test("synthetic: open stem gap IS bridged (no enclosure gate on gapBridge)", () => {
  // Vertical line of colour 1 with a 1px gap at (2,1); background reaches L/R border.
  const { grid, W, H } = makeGrid([
    ".1.",
    ".1.",
    "...",
    ".1.",
    ".1.",
  ]);
  const usage: Record<string, number> = {};
  const bg = new Set<number>([0]);
  const n = gapBridge(grid, W, H, usage, bg, new Set());
  assert(n >= 1, `expected >=1 bridge, got ${n}`);
  assertEquals(grid[2 * W + 1], 1);
});



Deno.test("fixture: 5 open-channel cells remain background after cleanup", async () => {
  const fx = JSON.parse(await Deno.readTextFile(
    new URL("./_fixture-surround.json", import.meta.url),
  ));
  const W: number = fx.gridW, H: number = fx.gridH;
  const grid = new Uint16Array(fx.grid);
  const usage: Record<string, number> = {};
  for (let i = 0; i < grid.length; i++) {
    usage[String(grid[i])] = (usage[String(grid[i])] ?? 0) + 1;
  }
  // Palette index 0 is #FCFCFC → the background.
  const bg = new Set<number>([0]);
  const holes = holeFill(grid, W, H, usage, bg, new Set());
  const bridged = gapBridge(grid, W, H, usage, bg, new Set());
  console.log("fixture cleanup: holesFilled=", holes, "gapBridged=", bridged);

  const cells: [number, number][] = [
    [13, 50], [13, 51], [14, 51], [26, 14],
  ];
  for (const [r, c] of cells) {
    const v = grid[r * W + c];
    assertEquals(v, 0, `cell (r${r},c${c}) should stay background (0), got ${v}`);
  }

  // Genuine enclosed holes (>=3 non-bg neighbours, not border-reachable)
  // must all be filled after holeFill converges.
  const openBg = borderReachableBackground(grid, W, H, bg);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const idx = r * W + c;
      if (!bg.has(grid[idx])) continue;
      if (openBg[idx]) continue;
      let nb = 0;
      if (r > 0 && !bg.has(grid[idx - W])) nb++;
      if (r < H - 1 && !bg.has(grid[idx + W])) nb++;
      if (c > 0 && !bg.has(grid[idx - 1])) nb++;
      if (c < W - 1 && !bg.has(grid[idx + 1])) nb++;
      assert(nb < 3, `enclosed bg cell (r${r},c${c}) with ${nb} non-bg neighbours should have been filled`);
    }
  }
});
