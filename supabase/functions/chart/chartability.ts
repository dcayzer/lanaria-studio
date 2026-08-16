// Phase 5 — chartability scoring (measurement layer).
//
// Rates a QUANTIZED GRID (what the engine actually sees) on how cleanly it will
// chart, and — as importantly — reports WHERE and WHY it will fail. Two uses:
//   * Phase 6 optimises generation prompts against this score.
//   * Pre-flight warns the user before charting a motif that will render badly.
//
// IMPORTANT ON CALIBRATION: the SIGNAL COMPUTATIONS below are exact and
// unit-tested against synthetic grids with known ground truth. The THRESHOLDS
// that turn raw measurements into 0..1 sub-scores and an overall verdict are
// PROVISIONAL — marked `CALIBRATE` — and can only be finalised against a
// labelled corpus (grids you've each rated Perfect/Minor/Poor/Unusable). Treat
// the numbers as directional until that corpus exists; treat the measurements
// as sound now.

export interface GridInput {
  grid: number[];
  W: number;
  H: number;
  palette: string[];        // hex per colour index
  bgIds: Set<number>;       // background colour indices
}

export interface SignalResult {
  name: string;
  raw: Record<string, number>;   // exact measurements
  score: number;                 // 0 (bad) .. 1 (good) — PROVISIONAL mapping
  note: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function srgbToLinear(c: number): number { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.0;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function ciede2000(lab1: [number, number, number], lab2: [number, number, number]): number {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const avgLp = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  const atan = (y: number, x: number) => { let d = Math.atan2(y, x) * 180 / Math.PI; if (d < 0) d += 360; return d; };
  const h1p = (a1p === 0 && b1 === 0) ? 0 : atan(b1, a1p);
  const h2p = (a2p === 0 && b2 === 0) ? 0 : atan(b2, a2p);
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dLp = L2 - L1, dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI / 180) / 2);
  let avghp: number;
  if (C1p * C2p === 0) avghp = h1p + h2p;
  else if (Math.abs(h1p - h2p) > 180) avghp = (h1p + h2p + 360) / 2;
  else avghp = (h1p + h2p) / 2;
  const T = 1 - 0.17 * Math.cos((avghp - 30) * Math.PI / 180) + 0.24 * Math.cos((2 * avghp) * Math.PI / 180)
    + 0.32 * Math.cos((3 * avghp + 6) * Math.PI / 180) - 0.20 * Math.cos((4 * avghp - 63) * Math.PI / 180);
  const dtheta = 30 * Math.exp(-Math.pow((avghp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(avgLp - 50, 2)) / Math.sqrt(20 + Math.pow(avgLp - 50, 2));
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const Rt = -Math.sin((2 * dtheta) * Math.PI / 180) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}

function usedColours(g: GridInput): number[] {
  const seen = new Set<number>();
  for (const v of g.grid) if (!g.bgIds.has(v)) seen.add(v);
  return [...seen];
}
function foregroundMask(g: GridInput): Uint8Array {
  const m = new Uint8Array(g.W * g.H);
  for (let i = 0; i < m.length; i++) m[i] = g.bgIds.has(g.grid[i]) ? 0 : 1;
  return m;
}
function regionsOf(g: GridInput, colourFilter: (c: number) => boolean): number[] {
  const { W, H } = g;
  const seen = new Uint8Array(W * H);
  const sizes: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !colourFilter(g.grid[s])) continue;
    const col = g.grid[s]; let n = 0; const st = [s]; seen[s] = 1;
    while (st.length) {
      const i = st.pop()!; n++; const r = (i / W) | 0, c = i % W;
      for (const [ni, ok] of [[i - 1, c > 0], [i + 1, c < W - 1], [i - W, r > 0], [i + W, r < H - 1]] as [number, boolean][])
        if (ok && !seen[ni] && g.grid[ni] === col) { seen[ni] = 1; st.push(ni); }
    }
    sizes.push(n);
  }
  return sizes;
}

export function colourSignal(g: GridInput): SignalResult {
  const used = usedColours(g);
  const labs = used.map((i) => rgbToLab(...hexToRgb(g.palette[i])));
  let minDist = Infinity;
  for (let i = 0; i < labs.length; i++)
    for (let j = i + 1; j < labs.length; j++)
      minDist = Math.min(minDist, ciede2000(labs[i], labs[j]));
  if (!isFinite(minDist)) minDist = 100;
  const countScore = used.length <= 8 ? 1 : Math.max(0, 1 - (used.length - 8) / 12);
  const sepScore = Math.min(1, minDist / 15);
  return {
    name: "colour",
    raw: { colourCount: used.length, minCIEDE2000: minDist },
    score: Math.min(countScore, sepScore),
    note: `${used.length} colours, closest pair ${minDist.toFixed(1)} dE`,
  };
}

export function fragmentationSignal(g: GridInput): SignalResult {
  const used = usedColours(g);
  let allSizes: number[] = [];
  for (const col of used) allSizes = allSizes.concat(regionsOf(g, (c) => c === col));
  const total = allSizes.reduce((s, v) => s + v, 0) || 1;
  const specks = allSizes.filter((s) => s <= 2).length;
  const regionsPerColour = used.length ? allSizes.length / used.length : 0;
  const largestFrac = allSizes.length ? Math.max(...allSizes) / total : 0;
  const speckScore = Math.max(0, 1 - specks / 40);
  const spreadScore = Math.max(0, 1 - Math.max(0, regionsPerColour - 3) / 12);
  return {
    name: "fragmentation",
    raw: { regionCount: allSizes.length, specks, regionsPerColour, largestFrac },
    score: Math.min(speckScore, spreadScore),
    note: `${allSizes.length} regions, ${specks} specks, ${regionsPerColour.toFixed(1)}/colour`,
  };
}

export function featureSizeSignal(g: GridInput): SignalResult {
  const { W, H } = g;
  const m = foregroundMask(g);
  let orig = 0, eroded = 0;
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    if (!m[i]) continue;
    orig++;
    const keep = (r > 0 && m[i - W]) && (r < H - 1 && m[i + W]) && (c > 0 && m[i - 1]) && (c < W - 1 && m[i + 1]);
    if (keep) { out[i] = 1; eroded++; }
  }
  const survival = orig ? eroded / orig : 1;
  const score = Math.min(1, survival / 0.45);
  return {
    name: "featureSize",
    raw: { foreground: orig, survivingErosion: eroded, survivalRatio: survival },
    score,
    note: `${(survival * 100).toFixed(0)}% of design survives one erosion`,
  };
}

export function diagonalSignal(g: GridInput): SignalResult {
  const { W, H } = g;
  const m = foregroundMask(g);
  let corner = 0, edge = 0;
  for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
    const s = m[r * W + c] + m[r * W + c + 1] + m[(r + 1) * W + c] + m[(r + 1) * W + c + 1];
    if (s === 1 || s === 3) corner++;
    else if (s === 2) edge++;
  }
  const mixed = corner + edge;
  const cornerRatio = mixed ? corner / mixed : 0;
  const score = Math.max(0, 1 - cornerRatio / 0.6);
  return {
    name: "diagonal",
    raw: { cornerBlocks: corner, edgeBlocks: edge, cornerRatio },
    score,
    note: `${(cornerRatio * 100).toFixed(0)}% of boundary is diagonal staircase`,
  };
}

export function symmetrySignal(g: GridInput): SignalResult {
  const { W, H } = g;
  const m = foregroundMask(g);
  let c0 = W, c1 = 0, r0 = H, r1 = 0, any = false;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (m[r * W + c]) {
    any = true; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  if (!any) return { name: "symmetry", raw: { mismatch: 0 }, score: 1, note: "empty" };
  let mism = 0, tot = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const mc = c1 - (c - c0);
    if (mc < 0 || mc >= W) continue;
    tot++;
    if (m[r * W + c] !== m[r * W + mc]) mism++;
  }
  const mismatch = tot ? mism / tot : 0;
  const score = Math.max(0, 1 - mismatch / 0.25);
  return { name: "symmetry", raw: { mismatchRatio: mismatch }, score, note: `${(mismatch * 100).toFixed(0)}% mirror mismatch` };
}

export type Verdict = "Perfect" | "Minor" | "Poor" | "Unusable";

export interface ChartabilityReport {
  signals: SignalResult[];
  overall: number;
  verdict: Verdict;
  worst: string[];
}

export function scoreChartability(g: GridInput): ChartabilityReport {
  const signals = [
    colourSignal(g), fragmentationSignal(g), featureSizeSignal(g),
    diagonalSignal(g), symmetrySignal(g),
  ];
  const weights: Record<string, number> = {
    colour: 1.0, fragmentation: 1.0, featureSize: 1.2, diagonal: 1.0, symmetry: 0.5,
  };
  const gateFail =
    signals.find((s) => s.name === "featureSize")!.raw.survivalRatio < 0.15 ||
    signals.find((s) => s.name === "colour")!.raw.colourCount > 24;

  let wsum = 0, w = 0;
  for (const s of signals) { const ww = weights[s.name] ?? 1; wsum += s.score * ww; w += ww; }
  const overall = wsum / w;

  let verdict: Verdict;
  if (gateFail || overall < 0.4) verdict = "Unusable";
  else if (overall < 0.65) verdict = "Poor";
  else if (overall < 0.85) verdict = "Minor";
  else verdict = "Perfect";

  const worst = signals.slice().sort((a, b) => a.score - b.score).filter((s) => s.score < 0.7).map((s) => s.name);
  return { signals, overall, verdict, worst };
}
