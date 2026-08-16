// Deno test for src/lib/tile-fill.ts's downscale + upscale-regression paths.
// Run: deno test --allow-read supabase/functions/chart/test-tile-fill.ts

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildTileFillLayer,
  downsampleMotif,
  type TileMotifSource,
} from "../../../src/lib/tile-fill.ts";

const S = "_"; // sentinel

Deno.test("downsampleMotif: hand-computed 4x4 -> 2x2 dominant", () => {
  //   [A A | B B]      -> block(0,0): A A A A -> A
  //   [A A | B C]      -> block(0,1): B B B C -> B
  //   ---------
  //   [D D | E E]      -> block(1,0): D D D E -> D
  //   [D E | E E]      -> block(1,1): E E E E -> E
  const motif: TileMotifSource = {
    width: 4,
    height: 4,
    cells: [
      ["A", "A", "B", "B"],
      ["A", "A", "B", "C"],
      ["D", "D", "E", "E"],
      ["D", "E", "E", "E"],
    ],
  };
  const out = downsampleMotif(motif, 2);
  assertEquals(out.width, 2);
  assertEquals(out.height, 2);
  assertEquals(out.cells, [
    ["A", "B"],
    ["D", "E"],
  ]);
});

Deno.test("downsampleMotif: all-sentinel block stays sentinel", () => {
  const motif: TileMotifSource = {
    width: 4,
    height: 2,
    cells: [
      [S, S, "R", "R"],
      [S, S, "R", "R"],
    ],
  };
  assertEquals(downsampleMotif(motif, 2).cells, [[S, "R"]]);
});

Deno.test("downsampleMotif: mixed block picks majority (sentinel counted)", () => {
  // Block(0,0) = [R R / R S] -> R wins 3-1.
  // Block(0,1) = [S S / S R] -> S wins 3-1.
  const motif: TileMotifSource = {
    width: 4,
    height: 2,
    cells: [
      ["R", "R", S, S],
      ["R", S, S, "R"],
    ],
  };
  assertEquals(downsampleMotif(motif, 2).cells, [["R", S]]);
});

Deno.test("downsampleMotif: deterministic first-seen tie-break", () => {
  // 2A + 2B. Scan order A,B,B,A -> A first-seen -> A.
  const m1: TileMotifSource = {
    width: 2,
    height: 2,
    cells: [
      ["A", "B"],
      ["B", "A"],
    ],
  };
  assertEquals(downsampleMotif(m1, 2).cells, [["A"]]);
  // Swap first cell -> B first-seen -> B.
  const m2: TileMotifSource = {
    width: 2,
    height: 2,
    cells: [
      ["B", "A"],
      ["A", "B"],
    ],
  };
  assertEquals(downsampleMotif(m2, 2).cells, [["B"]]);
});

Deno.test("downsampleMotif: sub-block motif clamps to 1x1", () => {
  const motif: TileMotifSource = { width: 1, height: 1, cells: [["X"]] };
  assertEquals(downsampleMotif(motif, 2), {
    width: 1,
    height: 1,
    cells: [["X"]],
  });
});

Deno.test("downsampleMotif: N=1 is identity", () => {
  const motif: TileMotifSource = {
    width: 2,
    height: 2,
    cells: [
      ["A", "B"],
      ["C", "D"],
    ],
  };
  assertEquals(downsampleMotif(motif, 1).cells, motif.cells);
});

// -------- Upscale regression: existing integer paths unchanged. --------

const upMotif: TileMotifSource = {
  width: 2,
  height: 2,
  cells: [
    ["A", "B"],
    ["C", "D"],
  ],
};

Deno.test("buildTileFillLayer: scale=1 tiles native across canvas", () => {
  const layer = buildTileFillLayer("t", upMotif, 4, 4, "all", S, { x: 0, y: 0 }, 1);
  assertEquals(layer.cells, [
    ["A", "B", "A", "B"],
    ["C", "D", "C", "D"],
    ["A", "B", "A", "B"],
    ["C", "D", "C", "D"],
  ]);
});

Deno.test("buildTileFillLayer: scale=2 upscales each native cell to 2x2", () => {
  const layer = buildTileFillLayer("t", upMotif, 4, 4, "all", S, { x: 0, y: 0 }, 2);
  assertEquals(layer.cells, [
    ["A", "A", "B", "B"],
    ["A", "A", "B", "B"],
    ["C", "C", "D", "D"],
    ["C", "C", "D", "D"],
  ]);
});

Deno.test("buildTileFillLayer: scale=3 upscales each native cell to 3x3", () => {
  const layer = buildTileFillLayer("t", upMotif, 6, 6, "all", S, { x: 0, y: 0 }, 3);
  const A = "A", B = "B", C = "C", D = "D";
  assertEquals(layer.cells, [
    [A, A, A, B, B, B],
    [A, A, A, B, B, B],
    [A, A, A, B, B, B],
    [C, C, C, D, D, D],
    [C, C, C, D, D, D],
    [C, C, C, D, D, D],
  ]);
});

Deno.test("buildTileFillLayer: scale=0.5 downsamples first, then tiles at 1x", () => {
  const motif: TileMotifSource = {
    width: 4,
    height: 4,
    cells: [
      ["A", "A", "B", "B"],
      ["A", "A", "B", "B"],
      ["C", "C", "D", "D"],
      ["C", "C", "D", "D"],
    ],
  };
  const layer = buildTileFillLayer("t", motif, 4, 4, "all", S, { x: 0, y: 0 }, 0.5);
  assertEquals(layer.cells, [
    ["A", "B", "A", "B"],
    ["C", "D", "C", "D"],
    ["A", "B", "A", "B"],
    ["C", "D", "C", "D"],
  ]);
});

Deno.test("buildTileFillLayer: scale=0.5 preserves sentinel gaps through shrink+tile", () => {
  const motif: TileMotifSource = {
    width: 4,
    height: 2,
    cells: [
      [S, S, "R", "R"],
      [S, S, "R", "R"],
    ],
  };
  const layer = buildTileFillLayer("t", motif, 4, 1, "all", S, { x: 0, y: 0 }, 0.5);
  assertEquals(layer.cells, [[S, "R", S, "R"]]);
});
