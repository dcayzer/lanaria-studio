// Progress tracking — for users who chart with Tessella but stitch on their
// own canvas (not printing/finishing with us). They mark off stitches as they
// complete them; this tracks which cells are done and reports progress overall
// and per thread colour (so "you've finished all the navy, 40% of the ivory").
//
// Storage is a flat boolean grid parallel to the chart, kept SEPARATE from the
// chart's own pixel data — marking a stitch complete must never alter the
// design itself. Persistence (per user, per saved chart) is a wiring concern
// for later; this module is the pure state + stats logic.
//
// Cells that are NOT_STITCHABLE (outside a non-rectangular shape — see
// canvas-shape-mask.ts) are never counted toward the total, so a circle chart
// reports 100% when every stitchable cell is done, not when the padded corners
// are "done" too.

export type ProgressGrid = boolean[][]; // [y][x] === true means stitched

export interface ProgressStats {
  totalStitchable: number;
  completed: number;
  remaining: number;
  fraction: number; // 0..1 over stitchable cells
  percent: number; // 0..100, rounded to 1 dp
}

export interface PerColorProgress {
  code: string;
  total: number;
  completed: number;
  fraction: number;
  percent: number;
}

export function makeProgressGrid(width: number, height: number): ProgressGrid {
  return Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
}

/**
 * Mark a single cell's completion state. Returns a NEW grid (immutable update)
 * so React state updates stay clean. Out-of-bounds is a no-op (returns the
 * same grid reference).
 */
export function setStitched(
  grid: ProgressGrid,
  x: number,
  y: number,
  done: boolean,
): ProgressGrid {
  if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) return grid;
  if (grid[y][x] === done) return grid;
  const next = grid.map((row) => row.slice());
  next[y][x] = done;
  return next;
}

/**
 * Mark a rectangular block (e.g. a brush stroke or a drag-select) complete or
 * incomplete in one pass. Returns a new grid. Coordinates are clamped to the
 * grid; x0/y0 need not be <= x1/y1 (they're normalised).
 */
export function setStitchedRect(
  grid: ProgressGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  done: boolean,
): ProgressGrid {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const lx = Math.max(0, Math.min(x0, x1));
  const hx = Math.min(w - 1, Math.max(x0, x1));
  const ly = Math.max(0, Math.min(y0, y1));
  const hy = Math.min(h - 1, Math.max(y0, y1));
  if (lx > hx || ly > hy) return grid;
  const next = grid.map((row) => row.slice());
  for (let y = ly; y <= hy; y++) {
    for (let x = lx; x <= hx; x++) next[y][x] = done;
  }
  return next;
}

/**
 * Mark every cell of a given thread code complete/incomplete at once — a
 * genuinely useful real-world action ("I've done all the background"). Needs
 * the chart's code grid to know which cells carry that code.
 */
export function setStitchedByCode(
  grid: ProgressGrid,
  codeGrid: string[][],
  code: string,
  done: boolean,
): ProgressGrid {
  const next = grid.map((row) => row.slice());
  for (let y = 0; y < next.length; y++) {
    for (let x = 0; x < next[y].length; x++) {
      if (codeGrid[y]?.[x] === code) next[y][x] = done;
    }
  }
  return next;
}

/**
 * Overall progress. `notStitchable` is the sentinel used by the shape mask
 * (default matches canvas-shape-mask.ts). Cells holding it in `codeGrid` are
 * excluded from the total. If `codeGrid` is omitted, every cell counts.
 */
export function progressStats(
  grid: ProgressGrid,
  codeGrid?: string[][],
  notStitchable = "__NOT_STITCHABLE__",
): ProgressStats {
  let total = 0;
  let done = 0;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (codeGrid && codeGrid[y]?.[x] === notStitchable) continue;
      total++;
      if (grid[y][x]) done++;
    }
  }
  const fraction = total === 0 ? 0 : done / total;
  return {
    totalStitchable: total,
    completed: done,
    remaining: total - done,
    fraction,
    percent: Math.round(fraction * 1000) / 10,
  };
}

/** Per-thread-colour progress, one entry per code present in the chart. */
export function perColorProgress(
  grid: ProgressGrid,
  codeGrid: string[][],
  notStitchable = "__NOT_STITCHABLE__",
): PerColorProgress[] {
  const total = new Map<string, number>();
  const done = new Map<string, number>();
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const code = codeGrid[y]?.[x];
      if (code === undefined || code === notStitchable) continue;
      total.set(code, (total.get(code) ?? 0) + 1);
      if (grid[y][x]) done.set(code, (done.get(code) ?? 0) + 1);
    }
  }
  const out: PerColorProgress[] = [];
  for (const [code, t] of total) {
    const d = done.get(code) ?? 0;
    const fraction = t === 0 ? 0 : d / t;
    out.push({ code, total: t, completed: d, fraction, percent: Math.round(fraction * 1000) / 10 });
  }
  // Most-remaining first — the practical "what's left to do" ordering.
  out.sort((a, b) => b.total - b.completed - (a.total - a.completed));
  return out;
}
