// Run: deno test supabase/functions/chart/test-natural-colour-count.ts
//
// Mechanism under test: the quantiser's cluster budget on flat art should come
// from the artwork's OWN measured colour count, not a fixed floor of 16.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeFlatRegionMask,
  estimateNaturalColourCount,
} from "./palette-derivation.ts";

const W = 120, H = 120;

function build(colours: [number, number, number][], noisePixels = 0): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  const bandH = Math.floor(H / colours.length);
  for (let y = 0; y < H; y++) {
    const c = colours[Math.min(colours.length - 1, Math.floor(y / bandH))];
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 3;
      px[off] = c[0]; px[off + 1] = c[1]; px[off + 2] = c[2];
    }
  }
  // Sparse single-pixel noise: well under the 0.5% population floor.
  for (let n = 0; n < noisePixels; n++) {
    const i = (n * 977) % (W * H);
    const off = i * 3;
    px[off] = (n * 53) & 0xff; px[off + 1] = (n * 97) & 0xff; px[off + 2] = (n * 29) & 0xff;
  }
  return px;
}

function estimate(px: Uint8Array): number {
  const mask = computeFlatRegionMask(px, W, H);
  return estimateNaturalColourCount(px, mask, W * H);
}

Deno.test("natural count: three flat colours measure as three", () => {
  const px = build([[20, 22, 26], [212, 74, 60], [240, 238, 230]]);
  assertEquals(estimate(px), 3);
});

Deno.test("natural count: sub-0.5% single-pixel noise is excluded", () => {
  const clean = build([[20, 22, 26], [212, 74, 60], [240, 238, 230]]);
  const noisy = build([[20, 22, 26], [212, 74, 60], [240, 238, 230]], 30);
  assertEquals(estimate(noisy), estimate(clean), "noise must not add clusters");
  assertEquals(estimate(noisy), 3);
});

Deno.test("natural count: continuous gradient returns something sane", () => {
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 3;
      const v = Math.round((x / (W - 1)) * 255);
      px[off] = v; px[off + 1] = Math.round((y / (H - 1)) * 255); px[off + 2] = 128;
    }
  }
  const n = estimate(px);
  // A continuous gradient has no real flat structure, so a high count is the
  // honest answer -- what matters is that it neither crashes nor collapses to
  // a bogus tiny number. Photographs never take this path anyway (the photo
  // branch keeps the original Math.max(16, ...) formula byte-identical).
  console.log(`continuous gradient estimate: ${n}`);
  assert(Number.isFinite(n) && n >= 2, `gradient estimate not sane: ${n}`);
});

Deno.test("natural count: five-colour icon budget vs the old fixed floor", () => {
  const px = build([
    [20, 22, 26], [212, 74, 60], [240, 238, 230], [46, 110, 84], [196, 168, 96],
  ]);
  const measured = estimate(px);
  const newBudget = Math.max(3, measured + 2);
  // Old formula: Math.max(16, round(effectiveMaxColours * clusterMultiplier))
  // with shading "none" (0.8) and a typical 12-colour ceiling => 16.
  const oldBudget = Math.max(16, Math.round(12 * 0.8));
  console.log(
    `5-colour icon: measured=${measured} newClusterCount=${newBudget} oldClusterCount=${oldBudget}`,
  );
  assertEquals(measured, 5);
  assert(newBudget < oldBudget, `new budget ${newBudget} must beat old ${oldBudget}`);
});
