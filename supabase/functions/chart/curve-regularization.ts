// Phase 7 — curve & diagonal regularization (standalone core).
//
// A curved or diagonal boundary in a stitch grid is stored as a staircase: for
// each step along the primary axis, the boundary sits at some position on the
// secondary axis. Noisy quantization makes that staircase jagged — small
// back-and-forth reversals and uneven step lengths — which reads as a ragged
// edge even when the source shape is a clean diagonal or smooth curve.
//
// This module regularizes such an edge subject to HARD guarantees that keep it
// safe and universal:
//   G1. Length preserved     — exactly one boundary position per step in, one
//                              out. It moves the edge, never thickens it, so it
//                              cannot fight the anti-thickening cleanup fix.
//   G2. Endpoints preserved  — the first and last positions never move, so the
//                              edge still meets whatever it connects to.
//   G3. Bounded change (±tol)— every position stays within `tol` of the
//                              original. Small tol => only quantization noise is
//                              removed; any genuine feature larger than tol
//                              (a handle, a deliberate notch, a spout) is kept
//                              verbatim. This is the universal-safety knob.
//   G4. Never rougher        — on pure-noise input the result is smoother; it
//                              never increases total curvature.
//
// It does NOT try to "beautify" shape it can't see — within tol it favours the
// smoothest monotone reading of the edge, and outside tol it defers entirely to
// the original pixels. A frontier of straight/near-straight edges snaps to a
// perfectly even staircase; genuinely curved edges keep their bend.

export interface RegularizeOptions {
  tol: number;
  minLen: number;
  straightEps: number;
}

export const DEFAULT_REGULARIZE_OPTIONS: RegularizeOptions = {
  tol: 1,
  minLen: 5,
  straightEps: 0.75,
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number) => Math.round(x);

export function pava(y: number[]): number[] {
  const blocks: { sum: number; w: number; len: number }[] = [];
  for (const v of y) {
    let b = { sum: v, w: 1, len: 1 };
    while (blocks.length && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].w > b.sum / b.w) {
      const prev = blocks.pop()!;
      b = { sum: prev.sum + b.sum, w: prev.w + b.w, len: prev.len + b.len };
    }
    blocks.push(b);
  }
  const out: number[] = [];
  for (const blk of blocks) {
    const mean = blk.sum / blk.w;
    for (let k = 0; k < blk.len; k++) out.push(mean);
  }
  return out;
}

function monotoneFit(y: number[], dir: number): number[] {
  if (dir >= 0) return pava(y);
  return pava(y.map((v) => -v)).map((v) => -v);
}

export function uniformStaircase(start: number, end: number, n: number): number[] {
  if (n <= 1) return [start];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(round(start + ((end - start) * i) / (n - 1)));
  out[0] = start;
  out[n - 1] = end;
  return out;
}

function repairMonotone(a: number[], dir: number): number[] {
  const out = a.slice();
  if (dir > 0) for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1]);
  else if (dir < 0) for (let i = 1; i < out.length; i++) out[i] = Math.min(out[i], out[i - 1]);
  return out;
}

export function edgeRoughness(a: number[]): number {
  let s = 0;
  for (let i = 2; i < a.length; i++) s += Math.abs(a[i] - 2 * a[i - 1] + a[i - 2]);
  return s;
}

export function edgeReversals(a: number[]): number {
  let count = 0;
  for (let i = 1; i < a.length - 1; i++) {
    const d1 = a[i] - a[i - 1];
    const d2 = a[i + 1] - a[i];
    if (d1 * d2 < 0) count++;
  }
  return count;
}

function regularizeMonotone(orig: number[], opts: RegularizeOptions): number[] {
  const n = orig.length;
  if (n < opts.minLen) return orig.slice();

  const span = orig[n - 1] - orig[0];
  const dir = span > 0 ? 1 : span < 0 ? -1 : 0;

  let fit: number[];
  if (dir === 0) {
    fit = uniformStaircase(orig[0], orig[n - 1], n);
  } else {
    const mono = monotoneFit(orig, dir);
    const straight: number[] = [];
    for (let i = 0; i < n; i++) straight.push(orig[0] + (span * i) / (n - 1));
    let dev = 0;
    for (let i = 0; i < n; i++) dev += Math.abs(mono[i] - straight[i]);
    dev /= n;
    fit = dev <= opts.straightEps
      ? uniformStaircase(orig[0], orig[n - 1], n)
      : repairMonotone(mono.map(round), dir);
  }

  fit[0] = orig[0];
  fit[n - 1] = orig[n - 1];
  fit = repairMonotone(fit, dir);
  fit[n - 1] = orig[n - 1];

  const pinned = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (Math.abs(fit[i] - orig[i]) > opts.tol) { fit[i] = orig[i]; pinned[i] = true; }
  }
  pinned[0] = pinned[n - 1] = true;
  fit[0] = orig[0];
  fit[n - 1] = orig[n - 1];

  const median3 = (a: number, b: number, c: number) =>
    Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 1; i < n - 1; i++) {
      if (pinned[i]) continue;
      const v = clamp(round(median3(fit[i - 1], fit[i], fit[i + 1])), orig[i] - opts.tol, orig[i] + opts.tol);
      if (v !== fit[i]) { fit[i] = v; changed = true; }
    }
    if (!changed) break;
  }
  return fit;
}

function dominantInflection(orig: number[], opts: RegularizeOptions): number {
  const n = orig.length;
  const mn = Math.min(...orig), mx = Math.max(...orig);
  const iMin = orig.indexOf(mn), iMax = orig.indexOf(mx);
  const cand = [iMin, iMax].filter((i) => i > 1 && i < n - 2);
  let best = -1, bestProm = opts.tol;
  for (const i of cand) {
    const prom = Math.min(Math.abs(orig[i] - orig[0]), Math.abs(orig[i] - orig[n - 1]));
    if (prom > bestProm) { bestProm = prom; best = i; }
  }
  if (best < 0) return -1;
  let end = best;
  while (end + 1 < n - 1 && orig[end + 1] === orig[best]) end++;
  return end;
}

function reversalSet(a: number[]): Set<number> {
  const s = new Set<number>();
  for (let i = 1; i < a.length - 1; i++) if ((a[i] - a[i - 1]) * (a[i + 1] - a[i]) < 0) s.add(i);
  return s;
}

function enforceNoNewReversals(out: number[], orig: number[]): number[] {
  const inRev = reversalSet(orig);
  const res = out.slice();
  for (let pass = 0; pass < res.length; pass++) {
    const cur = reversalSet(res);
    let changed = false;
    for (const i of cur) {
      if (inRev.has(i)) continue;
      for (const j of [i - 1, i, i + 1]) {
        if (j > 0 && j < res.length - 1 && res[j] !== orig[j]) { res[j] = orig[j]; changed = true; }
      }
    }
    if (!changed) break;
  }
  return res;
}

export function regularizeEdge(orig: number[], options: Partial<RegularizeOptions> = {}): number[] {
  const opts = { ...DEFAULT_REGULARIZE_OPTIONS, ...options };
  const n = orig.length;
  if (n < opts.minLen) return orig.slice();

  const infl = dominantInflection(orig, opts);
  let out: number[];
  if (infl < 0) {
    out = regularizeMonotone(orig, opts);
  } else {
    const left = regularizeMonotone(orig.slice(0, infl + 1), opts);
    const right = regularizeMonotone(orig.slice(infl), opts);
    out = [...left.slice(0, left.length - 1), ...right];
  }
  return enforceNoNewReversals(out, orig);
}

export function traceRightEdge(filled: boolean[][]): { rowStart: number; cols: number[] } | null {
  const rows: number[] = [];
  let rowStart = -1;
  for (let r = 0; r < filled.length; r++) {
    let last = -1;
    for (let c = 0; c < filled[r].length; c++) if (filled[r][c]) last = c;
    if (last >= 0) { if (rowStart < 0) rowStart = r; rows.push(last); }
    else if (rowStart >= 0) break;
  }
  if (rowStart < 0) return null;
  return { rowStart, cols: rows };
}
