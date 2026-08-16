// Tests for rotateCells in layer-model.ts. Run: bun run src/lib/test-rotate-cells.ts

import { rotateCells } from "./layer-model";

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${(e as Error).message}`); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string) {
  const sa = JSON.stringify(a); const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}: ${sa} !== ${sb}`);
}
function multiset(cells: string[][]): string {
  const flat: string[] = [];
  for (const row of cells) for (const c of row) flat.push(c);
  flat.sort();
  return flat.join(",");
}

const G = [["a","b","c"],["d","e","f"]];

t("rotateCells(g, 0) is identical", () => {
  eq(rotateCells(G, 0), G, "identity");
});

t("rotateCells(g, 90) is 3x2 and matches expected", () => {
  const r = rotateCells(G, 90);
  assert(r.length === 3 && r[0].length === 2, `dims ${r.length}x${r[0].length}`);
  eq(r, [["d","a"],["e","b"],["f","c"]], "90");
});

t("rotateCells(g, 270) is 3x2 and matches expected", () => {
  const r = rotateCells(G, 270);
  assert(r.length === 3 && r[0].length === 2, `dims ${r.length}x${r[0].length}`);
  eq(r, [["c","f"],["b","e"],["a","d"]], "270");
});

t("rotateCells(g, 180) is 2x3 and matches expected", () => {
  const r = rotateCells(G, 180);
  assert(r.length === 2 && r[0].length === 3, `dims ${r.length}x${r[0].length}`);
  eq(r, [["f","e","d"],["c","b","a"]], "180");
});

t("four 90 turns round-trip to original", () => {
  const r = rotateCells(rotateCells(rotateCells(rotateCells(G, 90), 90), 90), 90);
  eq(r, G, "round-trip");
});

t("losslessness: multiset preserved across all rotations", () => {
  const base = multiset(G);
  eq(multiset(rotateCells(G, 90)), base, "90 multiset");
  eq(multiset(rotateCells(G, 180)), base, "180 multiset");
  eq(multiset(rotateCells(G, 270)), base, "270 multiset");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
