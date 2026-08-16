// Run: deno test supabase/functions/chart/test-palette-denoise.ts
//
// Mechanism under test: an anti-aliased / JPEG-ringed boundary between two
// flat colour fields creates a narrow band of genuinely-spread colours.
// median-cut, fed unfiltered pixels, correctly finds those bands and spends
// threads on them. An edge-preserving median pre-pass on the PALETTE-DERIVATION
// input collapses that band without touching real edges.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  medianDenoise,
  computeFlatRegionMask,
  buildClusterColours,
} from "./palette-derivation.ts";

const W = 64, H = 64;
const A: [number, number, number] = [46, 66, 62];   // dark body
const B: [number, number, number] = [212, 74, 60];  // red field

// Deterministic pseudo-noise so the test never flakes.
function noise(i: number): number {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return Math.round(((s - Math.floor(s)) - 0.5) * 12); // +/-6
}

/** Two flat fields, a 3px interpolated ramp between them, plus sensor noise. */
function buildSource(): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  const edge = W / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 3;
      const d = x - edge;
      let c: [number, number, number];
      if (d < -1) c = A;
      else if (d > 1) c = B;
      else {
        const t = (d + 1.5) / 3; // ringing/anti-alias ramp
        c = [
          Math.round(A[0] + (B[0] - A[0]) * t),
          Math.round(A[1] + (B[1] - A[1]) * t),
          Math.round(A[2] + (B[2] - A[2]) * t),
        ];
      }
      for (let k = 0; k < 3; k++) {
        px[off + k] = Math.min(255, Math.max(0, c[k] + noise(off + k)));
      }
    }
  }
  return px;
}

function uniqueClusterCount(src: Uint8Array, target: number, mask: Uint8Array | null): number {
  const clusters = buildClusterColours(src, W * H, target, false, mask);
  return new Set(clusters.map((c) => c.rgb.join(","))).size;
}

function flatCount(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

Deno.test("denoise: flat-region mask recovers the noisy flat fields", () => {
  const raw = buildSource();
  const rawFlat = flatCount(computeFlatRegionMask(raw, W, H));
  const denFlat = flatCount(computeFlatRegionMask(medianDenoise(raw, W, H), W, H));
  assert(
    denFlat > rawFlat,
    `denoised flat-pixel count must exceed raw (${denFlat} vs ${rawFlat})`,
  );
  // The real fields are ~all of the image minus the 3px ramp column.
  assert(denFlat > W * H * 0.8, `expected most pixels flat after denoise, got ${denFlat}`);
});

Deno.test("denoise: median-cut wastes fewer clusters on the transition band", () => {
  const raw = buildSource();
  const den = medianDenoise(raw, W, H);
  const rawMask = computeFlatRegionMask(raw, W, H);
  const denMask = computeFlatRegionMask(den, W, H);
  const target = 16;

  const rawClusters = uniqueClusterCount(raw, target, rawMask);
  const denClusters = uniqueClusterCount(den, target, denMask);
  assert(
    denClusters <= rawClusters,
    `denoised input must not need more distinct clusters (${denClusters} vs ${rawClusters})`,
  );

  // The mechanism: how many cluster centres land in the ramp between the two
  // design colours (each such cluster buys itself a spurious thread), and how
  // far the palette drifts from the two real colours overall.
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const offDesign = (src: Uint8Array, mask: Uint8Array) =>
    buildClusterColours(src, W * H, target, false, mask)
      .map((c) => Math.min(dist(c.rgb, A), dist(c.rgb, B)));
  const rawOff = offDesign(raw, rawMask);
  const denOff = offDesign(den, denMask);
  const rawIntermediate = rawOff.filter((d) => d > 25).length;
  const denIntermediate = denOff.filter((d) => d > 25).length;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  assert(
    denIntermediate < rawIntermediate,
    `denoise must reduce spurious mid-band clusters (${denIntermediate} vs ${rawIntermediate})`,
  );
  assert(
    mean(denOff) < mean(rawOff) * 0.75,
    `denoised palette must sit closer to the real design colours ` +
      `(mean off-design ${mean(denOff).toFixed(1)} vs ${mean(rawOff).toFixed(1)})`,
  );
});


Deno.test("denoise: genuine hard edge is preserved (not smeared)", () => {
  // No noise, no ramp: a pure hard edge must survive the median untouched.
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 3;
      const c = x < W / 2 ? A : B;
      px[off] = c[0]; px[off + 1] = c[1]; px[off + 2] = c[2];
    }
  }
  const den = medianDenoise(px, W, H);
  const at = (x: number, y: number) => {
    const o = (y * W + x) * 3;
    return [den[o], den[o + 1], den[o + 2]];
  };
  assertEquals(at(W / 2 - 1, H / 2), A, "last A pixel must stay exactly A");
  assertEquals(at(W / 2, H / 2), B, "first B pixel must stay exactly B");
});

Deno.test("denoise: 1024x1024 pass stays inside a sane time budget", () => {
  const n = 1024;
  const px = new Uint8Array(n * n * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 7) & 0xff;
  const t0 = performance.now();
  medianDenoise(px, n, n);
  const ms = performance.now() - t0;
  console.log(`medianDenoise 1024x1024 radius=1: ${Math.round(ms)}ms`);
  assert(ms < 15000, `denoise too slow: ${ms}ms`);
});
