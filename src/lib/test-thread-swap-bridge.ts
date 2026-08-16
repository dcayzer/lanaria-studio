// Tests for thread-swap-bridge.ts (cross-brand stash substitution suggestions).
// Run via: bun run src/lib/test-thread-swap-bridge.ts

import { suggestFromStash, SUBSTITUTE_MAX_DELTAE } from "./thread-swap-bridge";
import type { StashEntry } from "./thread-inventory";

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

// DMC B5200 (#FFFFFF) vs Appletons 991b (#FCFCFC) -> ΔE00 ≈ 0.60 (verified),
// comfortably under SUBSTITUTE_MAX_DELTAE. DMC 310 (#000000) vs the same
// Appletons white -> ΔE00 ≈ 98.9, comfortably over it.
const entry = (over: Partial<StashEntry> = {}): StashEntry => ({
  brand: "appletons",
  code: "991b",
  name: "Bright White 991b",
  quantity: 3,
  unit: "skein",
  ...over,
});

t("exact brand+code match in stash returns exact:true, deltaE 0", () => {
  const s = suggestFromStash("dmc", "B5200", [
    entry(),
    entry({ brand: "DMC", code: " b5200 ", name: "Snow White", quantity: 2 }),
  ]);
  assert(s, "expected a suggestion");
  assert(s!.exact === true, `expected exact:true, got ${s!.exact}`);
  assert(s!.deltaE === 0, `expected deltaE 0, got ${s!.deltaE}`);
  assert(s!.onHand === 2, `expected onHand 2, got ${s!.onHand}`);
  assert(s!.hex.toUpperCase() === "#FFFFFF", `expected target hex, got ${s!.hex}`);
});

t("close cross-brand match under the ΔE ceiling returns exact:false", () => {
  const s = suggestFromStash("dmc", "B5200", [entry()]);
  assert(s, "expected a suggestion");
  assert(s!.exact === false, "expected exact:false for a cross-brand swap");
  assert(s!.brand === "appletons", `expected appletons, got ${s!.brand}`);
  assert(s!.code === "991b", `expected 991b, got ${s!.code}`);
  assert(
    s!.deltaE > 0 && s!.deltaE <= SUBSTITUTE_MAX_DELTAE,
    `expected 0 < deltaE <= ${SUBSTITUTE_MAX_DELTAE}, got ${s!.deltaE}`,
  );
  assert(s!.onHand === 3 && s!.unit === "skein", "expected on-hand qty/unit carried through");
});

t("nothing returned when the closest stash colour exceeds the ΔE ceiling", () => {
  // Needed: DMC 310 black. Stash: only a white.
  const s = suggestFromStash("dmc", "310", [entry()]);
  assert(s === null, `expected null, got ${JSON.stringify(s)}`);
});

t("zero-quantity stash lines are never suggested", () => {
  assert(
    suggestFromStash("dmc", "B5200", [entry({ quantity: 0 })]) === null,
    "zero-quantity cross-brand line should not be suggested",
  );
  assert(
    suggestFromStash("dmc", "B5200", [entry({ brand: "dmc", code: "B5200", quantity: 0 })]) ===
      null,
    "zero-quantity exact line should not be suggested",
  );
});

t("unknown needed brand/code returns null rather than throwing", () => {
  assert(suggestFromStash("madeira", "123", [entry()]) === null, "unknown brand -> null");
  assert(suggestFromStash("dmc", "not-a-code", [entry()]) === null, "unknown code -> null");
});

t("stash lines with unresolvable brand/code are skipped, not fatal", () => {
  const s = suggestFromStash("dmc", "B5200", [
    entry({ brand: "madeira", code: "999" }),
    entry({ brand: "dmc", code: "not-a-code" }),
    entry(),
  ]);
  assert(s && s.code === "991b", "expected the one resolvable stash line to win");
});

t("empty stash returns null", () => {
  assert(suggestFromStash("dmc", "B5200", []) === null, "empty stash -> null");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
