// Tests for input-type-detect.ts classification decision.
// Run via: bun run src/lib/test-input-type-detect.ts

import { classify, classifyConfidence } from "./input-type-detect";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const CASES: [string, number, number, "generated" | "photo"][] = [
  ["real flat art (Diet Coke JPEG)", 0.627, 0.235, "generated"],
  ["real flat art (AI house PNG)", 0.766, 0.384, "generated"],
  ["photo (studio backdrop)", 0.94, 0.56, "photo"],
  ["photo (busy texture)", 0.0, 0.007, "photo"],
  ["photo (smooth gradient)", 0.226, 1.0, "photo"],
];

for (const [name, flat, ramp, want] of CASES) {
  test(name, () => {
    const got = classify(flat, ramp);
    assert(got === want, `expected ${want}, got ${got}`);
  });
}

test("confidence is within 0..1", () => {
  for (const [, flat, ramp] of CASES) {
    const c = classifyConfidence(flat, ramp);
    assert(c >= 0 && c <= 1, `confidence out of range: ${c}`);
  }
});

test("near-threshold ramp share is low confidence", () => {
  assert(classifyConfidence(0.6, 0.44) < 0.35, "expected low confidence near threshold");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
