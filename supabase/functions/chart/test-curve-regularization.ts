// Deno test — Phase 7 curve/diagonal regularization.
// Run: deno test --allow-read supabase/functions/chart/test-curve-regularization.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  regularizeEdge, edgeRoughness, edgeReversals, DEFAULT_REGULARIZE_OPTIONS,
} from "./curve-regularization.ts";

// Deterministic PRNG (mulberry32) — reproducible fuzz.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("noisy straight diagonal snaps to an even staircase; endpoints preserved; not rougher", () => {
  // Straight diagonal from 0..10 over 11 steps, +/-1 noise on interior positions.
  const clean = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const orig  = [0, 2, 1, 3, 3, 5, 6, 6, 8, 9, 10];
  const out = regularizeEdge(orig);
  assertEquals(out.length, orig.length, "G1 length preserved");
  assertEquals(out[0], orig[0], "G2 start endpoint preserved");
  assertEquals(out[out.length - 1], orig[orig.length - 1], "G2 end endpoint preserved");
  for (let i = 0; i < out.length; i++) {
    assert(Math.abs(out[i] - orig[i]) <= 1, `G3 pos ${i} within tol: ${out[i]} vs ${orig[i]}`);
  }
  assert(edgeReversals(out) <= edgeReversals(orig), `G4 no new reversals: ${edgeReversals(out)} <= ${edgeReversals(orig)}`);
  assert(edgeRoughness(out) <= edgeRoughness(orig), `G4 not rougher: ${edgeRoughness(out)} <= ${edgeRoughness(orig)}`);
  // Should match the perfect staircase (all interior positions within tol=1).
  assertEquals(out, clean, `should snap to the even staircase; got ${JSON.stringify(out)}`);
});

Deno.test("genuine smooth curve keeps its bend (not flattened onto the chord)", () => {
  // Convex bulge: peak deviation of 4 from chord (well beyond tol=1).
  // Chord endpoints (0,0)-(10,0); interior bulge up.
  const orig = [0, 1, 3, 4, 5, 4, 3, 1, 0, 0, 0];
  const chord = orig.map((_, i) => Math.round(orig[0] + (orig[orig.length - 1] - orig[0]) * i / (orig.length - 1)));
  const out = regularizeEdge(orig);
  assertEquals(out.length, orig.length);
  assertEquals(out[0], orig[0]);
  assertEquals(out[orig.length - 1], orig[orig.length - 1]);
  // The bulge peak (>tol from chord) must survive — output must NOT equal the flat chord.
  const maxOut = Math.max(...out);
  const maxChord = Math.max(...chord);
  assert(maxOut > maxChord + 1, `bend must survive; maxOut=${maxOut} vs chord=${maxChord}`);
  for (let i = 0; i < out.length; i++) {
    assert(Math.abs(out[i] - orig[i]) <= 1, `G3 pos ${i}: ${out[i]} vs ${orig[i]}`);
  }
});

Deno.test("feature larger than tol (spike) is preserved verbatim", () => {
  // Baseline flat at 5 with a single spike to 10 (spike=5, tol=1).
  const orig = [5, 5, 5, 10, 5, 5, 5, 5];
  const out = regularizeEdge(orig);
  assertEquals(out.length, orig.length);
  assertEquals(out[3], 10, `spike must survive verbatim; got ${out[3]}`);
});

Deno.test("clean straight edge is unchanged", () => {
  const orig = [3, 3, 3, 3, 3, 3, 3];
  const out = regularizeEdge(orig);
  assertEquals(out, orig, `flat edge should be identity; got ${JSON.stringify(out)}`);
  const diag = [0, 1, 2, 3, 4, 5, 6];
  const out2 = regularizeEdge(diag);
  assertEquals(out2, diag, `clean diagonal should be identity; got ${JSON.stringify(out2)}`);
});

Deno.test("edge below minLen returned as-is", () => {
  const orig = [0, 2, 1, 3];
  const out = regularizeEdge(orig);
  assertEquals(out, orig, `short edge (len<${DEFAULT_REGULARIZE_OPTIONS.minLen}) is identity; got ${JSON.stringify(out)}`);
});

Deno.test("single-inflection edge (vessel waist) — endpoints pinned across bend, waist retained", () => {
  // Vase waist: goes in, then back out. Waist depth 4, well beyond tol=1.
  const orig = [8, 7, 5, 4, 4, 4, 5, 7, 8];
  const out = regularizeEdge(orig);
  assertEquals(out.length, orig.length);
  assertEquals(out[0], orig[0], "start pinned");
  assertEquals(out[out.length - 1], orig[orig.length - 1], "end pinned");
  const minOut = Math.min(...out);
  assert(minOut <= 5, `waist retained (min<=5); got ${minOut}`);
  for (let i = 0; i < out.length; i++) {
    assert(Math.abs(out[i] - orig[i]) <= 1, `G3 pos ${i}: ${out[i]} vs ${orig[i]}`);
  }
});

Deno.test("fuzz: 2000 random noisy monotone edges — all four guarantees hold", () => {
  const rnd = mulberry32(0xC0FFEE);
  const N = 2000;
  let passed = 0;
  const failures: string[] = [];
  for (let k = 0; k < N; k++) {
    const len = 6 + Math.floor(rnd() * 25); // 6..30
    const dir = rnd() < 0.5 ? 1 : -1;
    const start = Math.floor(rnd() * 50);
    const slope = 0.2 + rnd() * 1.5; // 0.2..1.7 per step
    const clean: number[] = [];
    for (let i = 0; i < len; i++) clean.push(Math.round(start + dir * slope * i));
    // Noise: ~40% of INTERIOR positions get +/-1.
    const orig = clean.slice();
    for (let i = 1; i < len - 1; i++) {
      if (rnd() < 0.4) orig[i] += rnd() < 0.5 ? -1 : 1;
    }
    const out = regularizeEdge(orig);
    let ok = true;
    let why = "";
    if (out.length !== orig.length) { ok = false; why = "length"; }
    else if (out[0] !== orig[0]) { ok = false; why = "start"; }
    else if (out[out.length - 1] !== orig[orig.length - 1]) { ok = false; why = "end"; }
    else {
      for (let i = 0; i < out.length; i++) {
        if (Math.abs(out[i] - orig[i]) > 1) { ok = false; why = `tol@${i} (${out[i]} vs ${orig[i]})`; break; }
      }
    }
    if (ok && edgeReversals(out) > edgeReversals(orig)) {
      ok = false; why = `reversals ${edgeReversals(out)} > ${edgeReversals(orig)}`;
    }
    if (ok) passed++;
    else if (failures.length < 5) failures.push(`case ${k} (len=${len} dir=${dir}): ${why}\n  orig=${JSON.stringify(orig)}\n  out=${JSON.stringify(out)}`);
  }
  console.log(`fuzz: ${passed}/${N} passed`);
  assertEquals(passed, N, `all ${N} fuzz cases must pass all four guarantees; failures:\n${failures.join("\n")}`);
});
