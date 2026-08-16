// Deno test — sibling-regularization v2 unit tests.
// Run: deno test --allow-read supabase/functions/chart/test-sibling.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  planSiblingRegularization,
  planDividerReconciliation,
  type SiblingCandidate,
} from "./sibling-regularization.ts";

function mk(
  id: number,
  r0: number, r1: number, c0: number, c1: number,
  accepted: boolean,
  coverage: number,
  hollow: boolean,
  extra: Partial<SiblingCandidate> = {},
): SiblingCandidate {
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  return {
    id, colour: 3, r0, r1, c0, c1, accepted,
    hDividerCount: extra.hDividerCount ?? (accepted ? 1 : 0),
    vDividerCount: extra.vDividerCount ?? (accepted ? 1 : 0),
    paneColour: extra.paneColour ?? 0,
    coverage, hollow,
    frameCellCount: extra.frameCellCount ?? (2 * w + 2 * h - 4),
  };
}

Deno.test("seven-window house: bottom-row twin recovered (anchored), attic pair recovered (mirror-pair)", () => {
  // gridW = 104 per fixture. Centreline = 52. Attic candidates at c=26-38 and
  // c=65-77 are mirror-symmetric about 52 (centres 32 and 71; distances 20 and 19).
  const gridW = 104;
  const cands: SiblingCandidate[] = [
    // Attic pair (mirror-symmetric, both rejected, hollow, coverage 0.194)
    mk(0, 12, 18, 26, 38, false, 0.194, true),
    mk(1, 12, 18, 65, 77, false, 0.194, true),
    // Middle row (3 accepted)
    mk(5, 37, 52, 21, 33, true, 0.98, true),
    mk(6, 37, 52, 45, 58, true, 0.97, true),
    mk(7, 37, 52, 70, 82, true, 0.96, true),
    // Bottom row: id9 rejected, id10 accepted (same row band)
    mk(9, 61, 79, 20, 34, false, 0.766, true),
    mk(10, 61, 78, 69, 83, true, 0.984, true),
  ];
  const existing = [
    { r0: 37, r1: 52, c0: 21, c1: 33 },
    { r0: 37, r1: 52, c0: 45, c1: 58 },
    { r0: 37, r1: 52, c0: 70, c1: 82 },
    { r0: 61, r1: 78, c0: 69, c1: 83 },
  ];
  const recovered = planSiblingRegularization(cands, existing, gridW);
  const at = (id: number) => cands.find((c) => c.id === id)!;
  const has = (id: number) => recovered.some((r) => r.r0 === at(id).r0 && r.c0 === at(id).c0);

  assert(has(9), `bottom-row twin (id9) must be recovered; got ${JSON.stringify(recovered)}`);
  assert(has(0), `attic id0 must be recovered (mirror-pair); got ${JSON.stringify(recovered)}`);
  assert(has(1), `attic id1 must be recovered (mirror-pair); got ${JSON.stringify(recovered)}`);
  const rec9 = recovered.find((r) => r.r0 === 61 && r.c0 === 20)!;
  assertEquals(rec9.source, "anchored", `id9 source should be anchored; got ${rec9.source}`);
  const rec0 = recovered.find((r) => r.r0 === 12 && r.c0 === 26)!;
  assertEquals(rec0.source, "mirror-pair", `id0 source should be mirror-pair; got ${rec0.source}`);
});

Deno.test("safety: two same-size hollow regions on the SAME side of the centreline (not mirror) — not recovered", () => {
  const gridW = 100; // centre 50
  const cands: SiblingCandidate[] = [
    mk(0, 10, 20, 10, 22, false, 0.30, true), // centre c=16, left of centre
    mk(1, 10, 20, 25, 37, false, 0.30, true), // centre c=31, also left of centre
  ];
  const recovered = planSiblingRegularization(cands, [], gridW);
  assertEquals(recovered.length, 0, `same-side pair must not be recovered; got ${JSON.stringify(recovered)}`);
});

Deno.test("safety: two mirror-symmetric same-size NON-hollow regions — not recovered", () => {
  const gridW = 100;
  const cands: SiblingCandidate[] = [
    mk(0, 10, 20, 10, 22, false, 0.30, false), // NOT hollow
    mk(1, 10, 20, 77, 89, false, 0.30, false), // mirror partner, NOT hollow
  ];
  const recovered = planSiblingRegularization(cands, [], gridW);
  assertEquals(recovered.length, 0, `non-hollow mirror pair must not be recovered; got ${JSON.stringify(recovered)}`);
});

Deno.test("divider reconciliation: col-stacked accepted pair, one detects hDivider one doesn't — zero side overridden", () => {
  // Real fixture-missingbar scenario: top-left (hDivider detected) and
  // bottom-left (hDivider missed) both accepted, col-aligned, same size.
  const cands: SiblingCandidate[] = [
    mk(0, 35, 51, 21, 33, true, 1, true, { hDividerCount: 1, vDividerCount: 1 }),
    mk(1, 63, 81, 21, 33, true, 1, true, { hDividerCount: 0, vDividerCount: 1 }),
  ];
  const overrides = planDividerReconciliation(cands);
  const forBL = overrides.find((o) => o.id === 1);
  assert(forBL, `expected override for bottom-left (id1); got ${JSON.stringify(overrides)}`);
  assertEquals(forBL!.hDividerCount, 1, `bottom-left hDividerCount should reconcile to 1; got ${forBL!.hDividerCount}`);
  assertEquals(forBL!.vDividerCount, 1, `bottom-left vDividerCount should stay 1; got ${forBL!.vDividerCount}`);
  const forTL = overrides.find((o) => o.id === 0);
  assertEquals(forTL, undefined, `top-left (id0) already had hDivider=1, must not be touched; got ${JSON.stringify(forTL)}`);
});

Deno.test("divider reconciliation safety: both siblings detected SOMETHING different — not overridden", () => {
  // 1 vs 2 dividers is a genuine difference, must be left alone.
  const cands: SiblingCandidate[] = [
    mk(0, 10, 30, 10, 30, true, 1, true, { hDividerCount: 1, vDividerCount: 1 }),
    mk(1, 40, 60, 10, 30, true, 1, true, { hDividerCount: 2, vDividerCount: 1 }),
  ];
  const overrides = planDividerReconciliation(cands);
  assertEquals(overrides.length, 0, `non-zero mismatch must not be overridden; got ${JSON.stringify(overrides)}`);
});

Deno.test("safety: mirror-symmetric FILLED (butterfly-wing) pair — not recovered (fill-fraction gate)", () => {
  // Real geometry from _fixture-butterfly.json wings: 14x11 with ~66 cells.
  // Perfect thin border would be 2*14+2*11-4 = 46. Measured ratio ~1.43,
  // above the 1.2 ceiling. Same-colour, same-size, hollow (interior has
  // eye-spot minority colours), mirror-symmetric — passes every OTHER gate.
  const gridW = 78; // centre 39
  const cands: SiblingCandidate[] = [
    mk(0, 15, 25, 6, 19, false, 0.30, true, { frameCellCount: 66 }),
    mk(1, 15, 25, 58, 71, false, 0.30, true, { frameCellCount: 65 }),
  ];
  const recovered = planSiblingRegularization(cands, [], gridW);
  assertEquals(recovered.length, 0, `filled organic pair must not be recovered; got ${JSON.stringify(recovered)}`);
});

Deno.test("safety: mirror-symmetric hollow pair with paneColour=-1 (no valid interior) — not recovered", () => {
  const gridW = 100;
  const cands: SiblingCandidate[] = [
    mk(0, 12, 18, 26, 38, false, 0.194, true, { paneColour: -1 }),
    mk(1, 12, 18, 61, 73, false, 0.194, true, { paneColour: -1 }),
  ];
  const recovered = planSiblingRegularization(cands, [], gridW);
  assertEquals(recovered.length, 0, `pair with unresolved paneColour must not be recovered (would write 65535 into grid); got ${JSON.stringify(recovered)}`);
});
