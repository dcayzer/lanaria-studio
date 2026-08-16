// Tests for ellipseCells in shape-tools.ts.
// Run via: bun run src/lib/test-ellipse-cells.ts

import { ellipseCells } from "./shape-tools";

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

const SIZES = [6, 8, 11, 16, 21, 30, 45, 61, 80, 101];

function dimsFor(size: number) {
  return { width: size + 4, height: size + 4 };
}

function toXY(cells: number[], width: number) {
  return cells.map((i) => ({ x: i % width, y: Math.floor(i / width) }));
}

/** Count 8-connected components of a cell set. */
function components(pts: Array<{ x: number; y: number }>): number {
  const key = (x: number, y: number) => `${x},${y}`;
  const set = new Set(pts.map((p) => key(p.x, p.y)));
  const seen = new Set<string>();
  let comps = 0;
  for (const p of pts) {
    const k = key(p.x, p.y);
    if (seen.has(k)) continue;
    comps++;
    const stack = [p];
    seen.add(k);
    while (stack.length) {
      const c = stack.pop()!;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nk = key(c.x + dx, c.y + dy);
          if (set.has(nk) && !seen.has(nk)) {
            seen.add(nk);
            stack.push({ x: c.x + dx, y: c.y + dy });
          }
        }
      }
    }
  }
  return comps;
}

t("outline is fully 8-connected at 10 sizes", () => {
  for (const size of SIZES) {
    const dims = dimsFor(size);
    const r = ellipseCells({ x: 2, y: 2 }, { x: 2 + size - 1, y: 2 + size - 1 }, dims, "outline");
    const pts = toXY(r.cells, dims.width);
    assert(pts.length > 0, `size ${size}: empty outline`);
    const comps = components(pts);
    assert(comps === 1, `size ${size}: outline has ${comps} components (gaps)`);
  }
});

t("ring reads as genuinely round (radius within ~1.5 cells)", () => {
  for (const size of SIZES) {
    const dims = dimsFor(size);
    const r = ellipseCells({ x: 2, y: 2 }, { x: 2 + size - 1, y: 2 + size - 1 }, dims, "outline");
    const pts = toXY(r.cells, dims.width);
    const cx = (2 + (2 + size - 1)) / 2;
    const cy = cx;
    const rad = (size - 1) / 2;
    for (const p of pts) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      assert(
        Math.abs(d - rad) <= 1.5,
        `size ${size}: cell ${p.x},${p.y} distance ${d.toFixed(2)} vs radius ${rad}`,
      );
    }
  }
});

t("non-square boxes produce connected ellipses (wide, tall, very thin)", () => {
  const cases: Array<[number, number]> = [
    [40, 12],
    [12, 40],
    [60, 3],
    [3, 60],
    [51, 9],
  ];
  for (const [w, h] of cases) {
    const dims = { width: w + 4, height: h + 4 };
    const r = ellipseCells({ x: 2, y: 2 }, { x: 1 + w, y: 1 + h }, dims, "outline");
    const pts = toXY(r.cells, dims.width);
    assert(pts.length > 0, `${w}x${h}: empty`);
    const comps = components(pts);
    assert(comps === 1, `${w}x${h}: ${comps} components`);
  }
});

t("filled: every row is one contiguous span and centre is filled", () => {
  for (const size of SIZES) {
    const dims = dimsFor(size);
    const r = ellipseCells({ x: 2, y: 2 }, { x: 2 + size - 1, y: 2 + size - 1 }, dims, "filled");
    const pts = toXY(r.cells, dims.width);
    const rows = new Map<number, number[]>();
    for (const p of pts) {
      const arr = rows.get(p.y) ?? [];
      arr.push(p.x);
      rows.set(p.y, arr);
    }
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        assert(xs[i] === xs[i - 1] + 1, `size ${size}: row ${y} has a gap at x=${xs[i]}`);
      }
    }
    const cx = Math.round((2 + (2 + size - 1)) / 2);
    const has = pts.some((p) => p.x === cx && p.y === cx);
    assert(has, `size ${size}: centre cell not filled`);
  }
});

t("outline and filled agree at the boundary (within 1 cell)", () => {
  for (const size of SIZES) {
    const dims = dimsFor(size);
    const a = { x: 2, y: 2 };
    const b = { x: 2 + size - 1, y: 2 + size - 1 };
    const outline = toXY(ellipseCells(a, b, dims, "outline").cells, dims.width);
    const filled = toXY(ellipseCells(a, b, dims, "filled").cells, dims.width);
    const fset = new Set(filled.map((p) => `${p.x},${p.y}`));
    for (const p of outline) {
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1 && !near; dx++) {
          if (fset.has(`${p.x + dx},${p.y + dy}`)) near = true;
        }
      }
      assert(near, `size ${size}: outline cell ${p.x},${p.y} is >1 cell from the filled shape`);
    }
  }
});

t("degenerate 1-wide / 1-tall drags don't throw and still draw a line", () => {
  const dims = { width: 40, height: 40 };
  const horiz = ellipseCells({ x: 5, y: 10 }, { x: 30, y: 10 }, dims, "outline");
  assert(horiz.cells.length >= 20, `1-tall drag drew only ${horiz.cells.length} cells`);
  const vert = ellipseCells({ x: 10, y: 5 }, { x: 10, y: 30 }, dims, "outline");
  assert(vert.cells.length >= 20, `1-wide drag drew only ${vert.cells.length} cells`);
  ellipseCells({ x: 5, y: 10 }, { x: 30, y: 10 }, dims, "filled");
  ellipseCells({ x: 10, y: 5 }, { x: 10, y: 30 }, dims, "filled");
});

t("tiny 2x2 box doesn't throw", () => {
  const dims = { width: 10, height: 10 };
  const o = ellipseCells({ x: 3, y: 3 }, { x: 4, y: 4 }, dims, "outline");
  const f = ellipseCells({ x: 3, y: 3 }, { x: 4, y: 4 }, dims, "filled");
  assert(o.cells.length > 0, "2x2 outline empty");
  assert(f.cells.length > 0, "2x2 filled empty");
  ellipseCells({ x: 3, y: 3 }, { x: 3, y: 3 }, dims, "outline");
});

t("NOT_STITCHABLE sentinel is respected", () => {
  const size = 21;
  const dims = dimsFor(size);
  const SENTINEL = -1;
  const cells = new Array<number>(dims.width * dims.height).fill(0);
  // mask out the left half
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      if (x < dims.width / 2) cells[y * dims.width + x] = SENTINEL;
    }
  }
  for (const mode of ["outline", "filled"] as const) {
    const r = ellipseCells({ x: 2, y: 2 }, { x: 2 + size - 1, y: 2 + size - 1 }, dims, mode, {
      cells,
      sentinel: SENTINEL,
    });
    assert(r.cells.length > 0, `${mode}: nothing drawn`);
    for (const i of r.cells) {
      assert(cells[i] !== SENTINEL, `${mode}: painted a sentinel cell at index ${i}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
