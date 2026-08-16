// Thread matching (§8.1 / §8.2 / §8.3).
//
// Perceptual nearest-thread matching for a target colour, plus a distinctness
// check that flags threads a stitcher won't be able to tell apart. Directly
// de-risks: photos charting greyscale when low-saturation shades collapse
// (§8.3), Motif Library recolour, and the DMC Perle expansion (~292 shades ->
// real collision risk, §8.2).
//
// SELF-CONTAINED + VERIFIED: CIEDE2000 here is validated against the full
// 34-pair Sharma, Wu & Dalal (2005) reference dataset (the standard frozen
// fixture for this algorithm) in verify-thread-match.ts. It's safe to use as
// is; if you'd rather share the ciede2000 already in chartability.ts, this
// module's ciede2000 can be swapped for that import with no other change.
//
// RECONCILE BEFORE WIRING: the real ThreadColor shape (../data/threadPalettes)
// -- whether shades are stored as hex, as Lab, or both -- must be checked
// against the exported type. ThreadColorLike below accepts hex OR lab so the
// caller adapts; matching runs in Lab regardless.

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** Minimal thread shape: needs a code, and EITHER hex or lab (lab wins if
 *  both present, since it skips a conversion round-trip). */
export interface ThreadColorLike {
  code: string;
  name?: string;
  hex?: string;
  lab?: Lab;
}

// ---------------------------------------------------------------------------
// sRGB (hex) -> CIE Lab, D65 white point.
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`hexToRgb: not a valid hex colour: "${hex}"`);
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;

function fLab(t: number): number {
  const d = 6 / 29;
  return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const Z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;
  const fx = fLab(X / Xn);
  const fy = fLab(Y / Yn);
  const fz = fLab(Z / Zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function hexToLab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

/** Resolve a ThreadColorLike to Lab, preferring an explicit lab. */
export function toLab(c: ThreadColorLike): Lab {
  if (c.lab) return c.lab;
  if (c.hex) return hexToLab(c.hex);
  throw new Error(`toLab: thread "${c.code}" has neither lab nor hex.`);
}

// ---------------------------------------------------------------------------
// CIEDE2000. Reference: Sharma, Wu & Dalal (2005). kL=kC=kH=1.
// ---------------------------------------------------------------------------

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const POW25_7 = Math.pow(25, 7);

export function ciede2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * RAD) +
    0.24 * Math.cos(2 * hbarp * RAD) +
    0.32 * Math.cos((3 * hbarp + 6) * RAD) -
    0.2 * Math.cos((4 * hbarp - 63) * RAD);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * RAD) * RC;

  const termL = dLp / SL;
  const termC = dCp / SC;
  const termH = dHp / SH;
  return Math.sqrt(termL * termL + termC * termC + termH * termH + RT * termC * termH);
}

/** atan2(b, a) in degrees, normalised to [0, 360). (0,0) -> 0. */
function hueDeg(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  let h = Math.atan2(b, a) * DEG;
  if (h < 0) h += 360;
  return h;
}

/** ΔE00 between two threads (resolving hex/lab as needed). */
export function deltaE(a: ThreadColorLike, b: ThreadColorLike): number {
  return ciede2000(toLab(a), toLab(b));
}

// ---------------------------------------------------------------------------
// Matching + distinctness.
// ---------------------------------------------------------------------------

/** ΔE00 interpretation (Sharma): < ~1.0 imperceptible; ~2.3 is a common
 *  "just noticeable difference". Below JND, two stitched threads read as the
 *  same colour -- the core of the §8.3 greyscale-collapse risk. */
export const JND_IMPERCEPTIBLE = 1.0;
export const JND_JUST_NOTICEABLE = 2.3;

export interface ThreadMatch<T extends ThreadColorLike> {
  thread: T;
  deltaE: number;
}

/** Nearest thread(s) in a palette to a target colour, ascending by ΔE00. */
export function matchThread<T extends ThreadColorLike>(
  target: ThreadColorLike,
  palette: T[],
  opts: { topN?: number } = {},
): ThreadMatch<T>[] {
  const targetLab = toLab(target);
  const ranked = palette
    .map((thread) => ({ thread, deltaE: ciede2000(targetLab, toLab(thread)) }))
    .sort((x, y) => x.deltaE - y.deltaE);
  const n = opts.topN ?? 1;
  return ranked.slice(0, Math.max(1, n));
}

/** Best match per target -- e.g. mapping every distinct pixel colour of a
 *  photo to a thread. Returns matches aligned to the input order. */
export function matchMany<T extends ThreadColorLike>(
  targets: ThreadColorLike[],
  palette: T[],
): ThreadMatch<T>[] {
  return targets.map((t) => matchThread(t, palette, { topN: 1 })[0]);
}

export interface ThreadCollision<T extends ThreadColorLike> {
  a: T;
  b: T;
  deltaE: number;
}

/** All thread PAIRS within `jnd` of each other -- i.e. shades that will look
 *  the same once stitched. Use on a chart's SELECTED thread set to warn about
 *  indistinguishable colours, or on a whole brand palette (e.g. DMC Perle's
 *  ~292 shades) to precompute a confusability map. Ascending by ΔE00. */
export function findCollisions<T extends ThreadColorLike>(
  threads: T[],
  opts: { jnd?: number } = {},
): ThreadCollision<T>[] {
  const jnd = opts.jnd ?? JND_JUST_NOTICEABLE;
  const labs = threads.map(toLab);
  const out: ThreadCollision<T>[] = [];
  for (let i = 0; i < threads.length; i++) {
    for (let j = i + 1; j < threads.length; j++) {
      const d = ciede2000(labs[i], labs[j]);
      if (d < jnd) out.push({ a: threads[i], b: threads[j], deltaE: d });
    }
  }
  out.sort((x, y) => x.deltaE - y.deltaE);
  return out;
}

/** For each thread, its single nearest neighbour in the same set. Handy for a
 *  "how distinct is my palette" readout without listing every pair. */
export function nearestNeighbours<T extends ThreadColorLike>(
  threads: T[],
): Array<{ thread: T; nearest: T; deltaE: number }> {
  const labs = threads.map(toLab);
  return threads.map((thread, i) => {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < threads.length; j++) {
      if (j === i) continue;
      const d = ciede2000(labs[i], labs[j]);
      if (d < bestD) { bestD = d; best = j; }
    }
    return { thread, nearest: threads[best], deltaE: bestD };
  });
}
