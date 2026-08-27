// Palette derivation primitives: median-cut clustering, flat-region masking,
// and the edge-preserving median denoise that feeds them. Extracted from
// index.ts unchanged so the mechanism can be tested directly (index.ts calls
// Deno.serve at module scope and cannot be imported from a test).

import { CHART_DIAG } from "./diag.ts";

export type Rgb = [number, number, number];

// A cluster colour carries its sample population so merges can weight by it.
export type ClusterColour = { rgb: Rgb; population: number; protected?: boolean };

export function averageColour(colours: Rgb[]): Rgb {
  let r = 0, g = 0, b = 0;
  for (const c of colours) { r += c[0]; g += c[1]; b += c[2]; }
  const n = Math.max(1, colours.length);
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

export function channelWithLargestRange(colours: Rgb[]): number {
  const mins: Rgb = [255, 255, 255];
  const maxs: Rgb = [0, 0, 0];
  for (const c of colours) {
    for (let i = 0; i < 3; i++) {
      if (c[i] < mins[i]) mins[i] = c[i];
      if (c[i] > maxs[i]) maxs[i] = c[i];
    }
  }
  const ranges = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
  return ranges[0] >= ranges[1] && ranges[0] >= ranges[2] ? 0 : ranges[1] >= ranges[2] ? 1 : 2;
}

/**
 * Representative colour for a median-cut box.
 *
 * averageColour() is correct when a box holds ONE design colour plus its
 * anti-aliasing spread -- the mean is that colour. It is wrong when the
 * colour budget forces two perceptually DISTANT colours into the same box,
 * because the mean is then a colour present nowhere in the artwork.
 * Measured on a real flat-art tree: red + cream baubles fused into one box
 * produced #DE7C6D salmon, dE00 16.4 from any real image colour.
 *
 * So: only intervene when the box is genuinely fusing distant colours
 * (spread above BOX_FUSION_DE). Below that the mean is returned unchanged,
 * so tight boxes and continuous-tone photo gradients keep their existing
 * behaviour byte-for-byte. Above it, the box is greedily sub-clustered and
 * the most populous sub-cluster's mean is returned -- guaranteed to be a
 * real colour from the artwork rather than an invented blend.
 *
 * Same principle as the thin-line modal-colour fix (audit A5): when a group
 * spans more than one real ink colour, summarise by the dominant member,
 * never by the average.
 */
const BOX_FUSION_DE = 25;      // spread above which a box is judged to be fusing
const BOX_SUBCLUSTER_DE = 10;  // greedy sub-cluster radius
const BOX_SAMPLE_CAP = 256;    // cap sub-clustering cost on large boxes

function srgbToLinearLocal(c: number): number {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function rgbToLabLocal(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinearLocal(r), gl = srgbToLinearLocal(g), bl = srgbToLinearLocal(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722);
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function ciede2000Local(lab1: [number, number, number], lab2: [number, number, number]): number {
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

function boxRepresentativeColour(box: Rgb[]): Rgb {
  const mean = averageColour(box);
  if (box.length < 4) return mean;
  const meanLab = rgbToLabLocal(mean[0], mean[1], mean[2]);
  const probeStep = Math.max(1, Math.floor(box.length / 64));
  let spread = 0;
  for (let i = 0; i < box.length; i += probeStep) {
    const c = box[i];
    const d = ciede2000Local(meanLab, rgbToLabLocal(c[0], c[1], c[2]));
    if (d > spread) spread = d;
  }
  if (spread <= BOX_FUSION_DE) return mean;

  const step = Math.max(1, Math.floor(box.length / BOX_SAMPLE_CAP));
  const subs: { lab: [number, number, number]; n: number; sum: [number, number, number] }[] = [];
  for (let i = 0; i < box.length; i += step) {
    const c = box[i];
    const cl = rgbToLabLocal(c[0], c[1], c[2]);
    let placed = false;
    for (const s of subs) {
      if (ciede2000Local(cl, s.lab) <= BOX_SUBCLUSTER_DE) {
        s.n++; s.sum[0] += c[0]; s.sum[1] += c[1]; s.sum[2] += c[2];
        placed = true; break;
      }
    }
    if (!placed) subs.push({ lab: cl, n: 1, sum: [c[0], c[1], c[2]] });
  }
  if (!subs.length) return mean;
  let best = subs[0];
  for (const s of subs) if (s.n > best.n) best = s;
  return [Math.round(best.sum[0] / best.n), Math.round(best.sum[1] / best.n), Math.round(best.sum[2] / best.n)];
}

export function medianCut(colours: Rgb[], targetCount: number): ClusterColour[] {
  const target = Math.max(1, Math.min(targetCount, colours.length));
  const boxes: Rgb[][] = [colours];
  while (boxes.length < target) {
    let bestBoxIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const channel = channelWithLargestRange(boxes[i]);
      const values = boxes[i].map((c) => c[channel]);
      const range = Math.max(...values) - Math.min(...values);
      const score = range * boxes[i].length;
      if (score > bestScore) { bestScore = score; bestBoxIndex = i; }
    }
    if (bestBoxIndex < 0) break;
    const box = boxes.splice(bestBoxIndex, 1)[0];
    const channel = channelWithLargestRange(box);
    box.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(box.length / 2);
    boxes.push(box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => ({ rgb: boxRepresentativeColour(box), population: box.length }));
}

export function isPlainWhite(r: number, g: number, b: number, floor: number): boolean {
  return r >= floor && g >= floor && b >= floor && Math.max(r, g, b) - Math.min(r, g, b) <= 8;
}

/**
 * Reserve palette slots for vivid colours BEFORE population-weighted
 * median-cut ever runs, so a small-but-vivid region (a yellow dress, a red
 * accent) cannot be absorbed into the dominant neutral mass and erased.
 *
 * Threshold is ADAPTIVE (a percentile of this image's own chroma), not a
 * fixed number, so it works on both a muted engraving and a naturally vivid
 * illustration. Reservation is bucketed by hue family, one slot per ~60
 * degrees, filled in population order -- otherwise several TONES of the
 * same hue (light/mid/dark yellow) can consume every reserved slot before a
 * smaller but genuinely different hue (red) gets a turn, which is exactly
 * what an unbucketed version did when tested against a real image.
 */
const CHROMA_PERCENTILE = 80;
const CHROMA_GROUP_DE = 14;
const RESERVE_MIN_ABS = 20;
const RESERVE_MIN_FRACTION = 0.0015;
const RESERVE_HUE_BUCKET = 60;
const RESERVE_MIN_LIGHTNESS = 12; // excludes near-black anti-aliasing fringe

function reserveVividColours(samples: Rgb[], maxReserved: number): { reserved: Rgb[]; reservedPopulations: number[]; usedIdx: Set<number> } {
  if (maxReserved <= 0 || samples.length < 50) return { reserved: [], reservedPopulations: [], usedIdx: new Set() };
  const labs = samples.map((c) => rgbToLabLocal(c[0], c[1], c[2]));
  const chromas = labs.map((l) => Math.sqrt(l[1] * l[1] + l[2] * l[2]));
  const sorted = [...chromas].sort((a, b) => a - b);
  const threshold = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * CHROMA_PERCENTILE / 100))];

  interface Group { lab: [number, number, number]; idx: number[]; rgbSum: [number, number, number] }
  const groups: Group[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (chromas[i] < threshold || labs[i][0] < RESERVE_MIN_LIGHTNESS) continue;
    let placed = false;
    for (const g of groups) {
      if (ciede2000Local(labs[i], g.lab) <= CHROMA_GROUP_DE) {
        g.idx.push(i);
        g.rgbSum = [g.rgbSum[0] + samples[i][0], g.rgbSum[1] + samples[i][1], g.rgbSum[2] + samples[i][2]];
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ lab: labs[i], idx: [i], rgbSum: [...samples[i]] as Rgb });
  }

  const survivors = groups.filter(
    (g) => g.idx.length >= RESERVE_MIN_ABS && g.idx.length / samples.length >= RESERVE_MIN_FRACTION,
  );
  const withRgb = survivors.map((g) => ({
    g,
    rgb: [Math.round(g.rgbSum[0] / g.idx.length), Math.round(g.rgbSum[1] / g.idx.length), Math.round(g.rgbSum[2] / g.idx.length)] as Rgb,
  }));
  for (const w of withRgb) w.g.lab = rgbToLabLocal(w.rgb[0], w.rgb[1], w.rgb[2]);
  withRgb.sort((a, b) => b.g.idx.length - a.g.idx.length);

  const hueOf = (l: [number, number, number]) => {
    const d = Math.atan2(l[2], l[1]) * 180 / Math.PI;
    return d < 0 ? d + 360 : d;
  };
  const bucketsFilled = new Set<number>();
  const chosen: typeof withRgb = [];
  for (const w of withRgb) {
    if (chosen.length >= maxReserved) break;
    const b = Math.floor(hueOf(w.g.lab) / RESERVE_HUE_BUCKET);
    if (bucketsFilled.has(b)) continue;
    bucketsFilled.add(b);
    chosen.push(w);
  }
  for (const w of withRgb) {
    if (chosen.length >= maxReserved) break;
    if (chosen.includes(w)) continue;
    chosen.push(w);
  }

  const usedIdx = new Set<number>();
  for (const w of chosen) for (const i of w.g.idx) usedIdx.add(i);
  return { reserved: chosen.map((w) => w.rgb), reservedPopulations: chosen.map((w) => w.g.idx.length), usedIdx };
}

/**
 * Find LOCALLY CONTRASTING colour islands -- regions whose hue differs
 * sharply from their immediate surroundings, and which are large enough to
 * actually appear in the finished stitching.
 *
 * This complements reserveVividColours rather than duplicating it. That one
 * ranks by absolute chroma, so it catches a vivid yellow dress. This one
 * catches a muted blue collar on tan fur: not saturated (chroma 6), just a
 * different hue from everything around it. Both are real design features and
 * both were being erased, for different reasons.
 *
 * Size is judged in STITCHES, not pixel fraction. Measured on a real upload,
 * a dog's collar is 0.003% of pixels -- which sounds like noise -- but 81
 * stitches on that user's 216x216 chart, which is plainly visible. Working in
 * stitch units also makes the rule correctly scale-aware.
 */
const SALIENT_WINDOW = 6;          // radius, in stitches, of the "surroundings"
const SALIENT_MIN_HUE_DELTA = 45;  // degrees from local hue to count as contrasting
const SALIENT_MIN_CHROMA = 5;      // below this there is no reliable hue at all
const SALIENT_MIN_STITCHES = 4;    // smaller than this cannot be stitched legibly

export function findSalientColourIslands(
  sourceRgb: Uint8Array,
  srcW: number,
  srcH: number,
  gridW: number,
  gridH: number,
): { rgb: Rgb; stitches: number }[] {
  if (gridW < 8 || gridH < 8) return [];
  // Box-average the source down to one cell per stitch, so every measurement
  // below is already in the units that decide visibility.
  const cell = new Float64Array(gridW * gridH * 3);
  const counts = new Float64Array(gridW * gridH);
  for (let y = 0; y < srcH; y++) {
    const gy = Math.min(gridH - 1, Math.floor((y * gridH) / srcH));
    for (let x = 0; x < srcW; x++) {
      const gx = Math.min(gridW - 1, Math.floor((x * gridW) / srcW));
      const s = (y * srcW + x) * 3, d = (gy * gridW + gx) * 3;
      cell[d] += sourceRgb[s]; cell[d + 1] += sourceRgb[s + 1]; cell[d + 2] += sourceRgb[s + 2];
      counts[gy * gridW + gx]++;
    }
  }
  const rgbAt: Rgb[] = [];
  const hueAt = new Float64Array(gridW * gridH);
  const chromaAt = new Float64Array(gridW * gridH);
  for (let i = 0; i < gridW * gridH; i++) {
    const n = Math.max(1, counts[i]);
    const r = Math.round(cell[i * 3] / n), g = Math.round(cell[i * 3 + 1] / n), b = Math.round(cell[i * 3 + 2] / n);
    rgbAt.push([r, g, b]);
    const l = rgbToLabLocal(r, g, b);
    chromaAt[i] = Math.sqrt(l[1] * l[1] + l[2] * l[2]);
    let h = Math.atan2(l[2], l[1]) * 180 / Math.PI;
    hueAt[i] = h < 0 ? h + 360 : h;
  }

  const salient = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const i = y * gridW + x;
      if (chromaAt[i] < SALIENT_MIN_CHROMA) continue;
      let sx = 0, sy = 0, n = 0;
      for (let dy = -SALIENT_WINDOW; dy <= SALIENT_WINDOW; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= gridH) continue;
        for (let dx = -SALIENT_WINDOW; dx <= SALIENT_WINDOW; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= gridW) continue;
          const j = ny * gridW + nx;
          if (chromaAt[j] < 4) continue;
          const rad = hueAt[j] * Math.PI / 180;
          sx += Math.cos(rad); sy += Math.sin(rad); n++;
        }
      }
      if (n < 6) continue;
      let local = Math.atan2(sy / n, sx / n) * 180 / Math.PI;
      if (local < 0) local += 360;
      const delta = Math.abs(((hueAt[i] - local + 180) % 360 + 360) % 360 - 180);
      if (delta >= SALIENT_MIN_HUE_DELTA) salient[i] = 1;
    }
  }

  const seen = new Uint8Array(gridW * gridH);
  const out: { rgb: Rgb; stitches: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < gridW * gridH; start++) {
    if (!salient[start] || seen[start]) continue;
    stack.length = 0; stack.push(start); seen[start] = 1;
    const members: number[] = [];
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const y = (i / gridW) | 0, x = i % gridW;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= gridH || nx < 0 || nx >= gridW) continue;
          const j = ny * gridW + nx;
          if (salient[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (members.length < SALIENT_MIN_STITCHES) continue;
    let r = 0, g = 0, b = 0;
    for (const i of members) { r += rgbAt[i][0]; g += rgbAt[i][1]; b += rgbAt[i][2]; }
    const n = members.length;
    out.push({ rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], stitches: n });
  }
  out.sort((a, b) => b.stitches - a.stitches);
  return out;
}

/**
 * Reserve ONE palette slot for a genuinely dark, near-NEUTRAL colour
 * (black / charcoal ink) before population-weighted median-cut runs.
 *
 * Why the two existing reservation mechanisms cannot cover this:
 * reserveVividColours ranks by CHROMA percentile, and
 * findSalientColourIslands requires chroma >= SALIENT_MIN_CHROMA (5) plus a
 * local HUE contrast. Black ink has chroma ~1-2 and no meaningful hue at
 * all, so BOTH skip it by construction -- this is a genuine gap, not a
 * tuning problem.
 *
 * Measured on a real upload (a hand-lettered vegetable illustration): the
 * black handwriting resolved to olive green #567338 at dE00 23.5, purely
 * because green was the darkest entry the palette happened to contain.
 * Every other entry was further still (next nearest #697820 at 25.1). With
 * no dark neutral in the palette there is no correct answer available at
 * matching time, so the fix has to happen here, at derivation.
 *
 * REGRESSION GUARD: the absolute DARK_MAX_LIGHTNESS cap, not the
 * percentile. A percentile alone always finds "the darkest 5%" of any
 * image and would invent a spurious black thread on artwork that contains
 * none. Verified against a pastel-only control: adaptive threshold came
 * back at L 77.4, the cap held it to 45, zero candidates, nothing
 * reserved -- byte-identical behaviour on any image without real dark ink.
 *
 * Deliberately at most ONE slot: if the artwork genuinely has plenty of
 * dark, median-cut finds it unaided and this reservation merely duplicates
 * an entry the downstream near-duplicate merge then collapses. Self-
 * correcting either way.
 */
const DARK_LIGHTNESS_PERCENTILE = 5;
const DARK_MAX_LIGHTNESS = 45;   // absolute: must actually BE dark
const DARK_MAX_CHROMA = 18;      // neutral-ish; saturated darks are reserveVividColours' job
const DARK_MIN_ABS = 20;
const DARK_MIN_FRACTION = 0.0015;

function reserveDarkNeutrals(
  samples: Rgb[],
  alreadyUsed: Set<number>,
): { reserved: Rgb[]; reservedPopulations: number[]; usedIdx: Set<number> } {
  const empty = { reserved: [] as Rgb[], reservedPopulations: [] as number[], usedIdx: new Set<number>() };
  if (samples.length < 50) {
    console.log("reserveDarkNeutrals: SKIP too few samples", samples.length);
    return empty;
  }
  const labs = samples.map((c) => rgbToLabLocal(c[0], c[1], c[2]));
  const ls = labs.map((l) => l[0]);
  const sorted = [...ls].sort((a, b) => a - b);
  const pct = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * DARK_LIGHTNESS_PERCENTILE / 100))];
  const cap = Math.min(pct, DARK_MAX_LIGHTNESS);
  const idx: number[] = [];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < samples.length; i++) {
    if (alreadyUsed.has(i)) continue;
    const chroma = Math.sqrt(labs[i][1] * labs[i][1] + labs[i][2] * labs[i][2]);
    if (labs[i][0] > cap || chroma > DARK_MAX_CHROMA) continue;
    idx.push(i);
    r += samples[i][0]; g += samples[i][1]; b += samples[i][2];
  }
  if (idx.length < DARK_MIN_ABS || idx.length / samples.length < DARK_MIN_FRACTION) {
    console.log("reserveDarkNeutrals: SKIP gate", JSON.stringify({ samples: samples.length, pct, cap, candidates: idx.length, needAbs: DARK_MIN_ABS, needFrac: DARK_MIN_FRACTION }));
    return empty;
  }
  const n = idx.length;
  const reservedRgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)] as Rgb;
  const darkReservedDiag = { rgb: reservedRgb, population: n, pct, cap, samples: samples.length };
  console.log("reserveDarkNeutrals: RESERVED", JSON.stringify(darkReservedDiag));
  CHART_DIAG.darkReserved = darkReservedDiag;
  return {
    reserved: [reservedRgb],
    reservedPopulations: [n],
    usedIdx: new Set<number>(idx),
  };
}

export function buildClusterColours(
  sourceRgb: Uint8Array,
  total: number,
  targetCount: number,
  skipPlainWhite = false,
  flatMask: Uint8Array | null = null,
): ClusterColour[] {
  const sampleLimit = 24000;
  const stride = Math.max(1, Math.ceil(total / sampleLimit));
  const samples: Rgb[] = [];
  const fallbackSamples: Rgb[] = [];
  for (let i = 0; i < total; i += stride) {
    const offset = i * 3;
    const r = sourceRgb[offset], g = sourceRgb[offset + 1], b = sourceRgb[offset + 2];
    if (skipPlainWhite && isPlainWhite(r, g, b, 248)) continue;
    fallbackSamples.push([r, g, b]);
    // Palette is derived from design colours only -- edge blends are
    // artifacts and must not buy themselves a thread. Assignment still
    // covers every pixel; only the palette DERIVATION is restricted.
    if (flatMask && !flatMask[i]) continue;
    samples.push([r, g, b]);
  }
  // Line-dominated artwork (thin strokes, little flat area) can leave too few
  // flat samples to describe the image. Fall back to all pixels rather than
  // producing a palette that omits the linework's own colour -- verified as a
  // real case: the Lanaria logo measures only ONE significant flat colour.
  const chosen = samples.length >= Math.max(200, fallbackSamples.length * 0.05)
    ? samples
    : fallbackSamples;
  if (!chosen.length) chosen.push([255, 255, 255]);

  const reserveCap = Math.max(1, Math.floor(targetCount / 3));
  const vivid = reserveVividColours(chosen, reserveCap);
  const dark = reserveDarkNeutrals(chosen, vivid.usedIdx);
  const reserved = [...vivid.reserved, ...dark.reserved];
  const reservedPopulations = [...vivid.reservedPopulations, ...dark.reservedPopulations];
  const usedIdx = new Set<number>([...vivid.usedIdx, ...dark.usedIdx]);
  if (!reserved.length) return medianCut(chosen, targetCount);

  const remaining = chosen.filter((_, i) => !usedIdx.has(i));
  const remainingTarget = Math.max(1, targetCount - reserved.length);
  const rest = remaining.length ? medianCut(remaining, remainingTarget) : [];
  const reservedClusters: ClusterColour[] = reserved.map((rgb, i) => ({ rgb, population: reservedPopulations[i], protected: true }));
  return [...reservedClusters, ...rest];
}

/**
 * Edge-preserving median denoise, applied ONLY to what feeds palette
 * derivation (flat-region mask + cluster sampling) for flat art. NOT the
 * same tool as shading's gaussian/box blur -- a median filter collapses shot
 * noise and JPEG ringing while leaving genuine hard edges sharp, whereas a
 * mean-based blur smears them. This is why forcing shading to "none" (fixed
 * the pink/brown blend) was not enough on its own: it removed the blur that
 * was ALSO incidentally hiding this narrower problem -- real anti-aliasing/
 * JPEG-ringing gradient along an outline that median-cut, working from
 * unfiltered pixels, correctly finds as genuinely-spread colour clusters and
 * assigns separate threads to. The per-cell thread ASSIGNMENT stage must
 * keep using the real unfiltered pixels -- only the palette-derivation
 * INPUT is denoised, so this cannot blur any actual chart geometry.
 */
export function medianDenoise(sourceRgb: Uint8Array, w: number, h: number, radius = 1): Uint8Array {
  const out = new Uint8Array(sourceRgb.length);
  const windowSize = (2 * radius + 1) * (2 * radius + 1);
  const rs = new Uint8Array(windowSize);
  const gs = new Uint8Array(windowSize);
  const bs = new Uint8Array(windowSize);
  // In-place insertion sort on the fixed 9-element windows. Measured on a
  // 1024x1024 source: the allocating [...slice].sort() form cost ~8.5s per
  // pass, this form ~0.3s. Same result, no per-pixel garbage.
  const medianOf = (buf: Uint8Array, n: number): number => {
    for (let i = 1; i < n; i++) {
      const v = buf[i];
      let j = i - 1;
      while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
      buf[j + 1] = v;
    }
    return buf[n >> 1];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.min(w - 1, Math.max(0, x + dx));
          const ny = Math.min(h - 1, Math.max(0, y + dy));
          const off = (ny * w + nx) * 3;
          rs[n] = sourceRgb[off]; gs[n] = sourceRgb[off + 1]; bs[n] = sourceRgb[off + 2];
          n++;
        }
      }
      const outOff = (y * w + x) * 3;
      out[outOff] = medianOf(rs, n);
      out[outOff + 1] = medianOf(gs, n);
      out[outOff + 2] = medianOf(bs, n);
    }
  }

  return out;
}

/**
 * Marks pixels sitting inside a FLAT colour region (local 3x3 range within
 * tolerance). These are the artist's actual fill colours. Pixels excluded by
 * this are anti-aliasing and JPEG ringing at edges -- real artifacts, not
 * design intent. Measured on real uploads: ~17-26% of a flat-art image is
 * edge blend rather than design colour.
 *
 * A SECOND pass then admits stroke cores -- see the comment on it below.
 * Without that pass this function is blind to linework, which is how a
 * colour that exists only as thin strokes (black handwriting, a fine outline)
 * could be absent from the derived palette entirely.
 */
export function computeFlatRegionMask(
  sourceRgb: Uint8Array,
  w: number,
  h: number,
  tolerance = 8,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let maxRange = 0;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            const v = sourceRgb[(ny * w + nx) * 3 + c];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        if (hi - lo > maxRange) maxRange = hi - lo;
      }
      if (maxRange <= tolerance) mask[y * w + x] = 1;
    }
  }

  // SECOND PASS -- STROKE CORES.
  //
  // The flat test above keeps only pixels whose whole 3x3 neighbourhood is
  // near-uniform. That is right for finding FILL colours, but a stroke
  // narrower than ~3px has no uniform interior: every pixel of it has an
  // edge in its window. So linework is excluded from palette derivation
  // ENTIRELY, and any colour that exists only as lines never becomes a
  // cluster, never earns a thread, and every stitch that should be that
  // colour falls through to whatever unrelated thread happens to be nearest.
  //
  // Measured on a real 1024x1024 upload of hand-lettered artwork:
  //   sourceStats         pixelsUnder250 = 6556, minPixelSum = 37
  //   thinLineMap         flagged = 54018, of which flaggedDark = 4229
  //   reserveDarkNeutrals samples = 615, 5th-pct L = 48.6, candidates = 0
  // The black ink was present in the image and correctly detected as
  // linework, yet of the 615 samples that reached palette derivation NOT ONE
  // was below L 45. The palette's darkest entry came out as 337 #567338, a
  // drab green -- which is exactly what the black handwriting was stitched
  // in. The same failure applies to any line-only colour, dark or not.
  //
  // A pixel is admitted here if enough of its 8 neighbours share its colour
  // closely. Along a stroke the ink is consistent, so a core pixel has
  // several near-identical neighbours; an isolated anti-aliased speck does
  // not. This deliberately errs toward including borderline edge pixels
  // rather than excluding real ink: an over-included blend is a near
  // duplicate that the existing near-duplicate merge collapses downstream,
  // whereas an excluded ink colour is unrecoverable -- no later stage can
  // invent it back.
  //
  // ADDITIVE ONLY: this pass can set mask bits to 1, never to 0, so every
  // colour previously derived is still derived. It cannot run on photographs
  // at all -- index.ts passes flatMask = null for inputType "photo", so
  // computeFlatRegionMask is never called on that path.
  const LINE_CORE_TOL = 26;
  const MIN_LINE_CORE_NEIGHBOURS = 3;
  let lineCorePixels = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      const o = i * 3;
      const r = sourceRgb[o], g = sourceRgb[o + 1], b = sourceRgb[o + 2];
      let similar = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = Math.min(w - 1, Math.max(0, x + dx));
          const ny = Math.min(h - 1, Math.max(0, y + dy));
          const n = (ny * w + nx) * 3;
          const d = Math.abs(sourceRgb[n] - r)
            + Math.abs(sourceRgb[n + 1] - g)
            + Math.abs(sourceRgb[n + 2] - b);
          if (d <= LINE_CORE_TOL) similar++;
        }
      }
      if (similar >= MIN_LINE_CORE_NEIGHBOURS) {
        mask[i] = 1;
        lineCorePixels++;
      }
    }
  }
  console.log("linework palette sampling:", JSON.stringify({ lineCorePixels }));
  return mask;
}

/**
 * How many genuinely distinct colours the FLAT regions actually contain --
 * greedy clustering by Euclidean RGB distance, counting only clusters with
 * material population (not single-pixel noise). This is what the quantiser
 * SHOULD be told to aim for on flat art, instead of a fixed floor that
 * guarantees overshoot on simple artwork. Measured on a real 5-colour icon:
 * the fixed floor of 16 forces 11+ spurious splits no matter how clean the
 * palette-derivation input is upstream.
 */
export function estimateNaturalColourCount(
  sourceRgb: Uint8Array,
  flatMask: Uint8Array | null,
  total: number,
  distThreshold = 40,
): number {
  // Sample cap raised 8000 -> 40000 (still a cheap linear scan -- the cluster
  // list stays small, this is not the expensive part of the pipeline). At
  // 8000 samples on a 1024x1024 source, a normal 40-90px design element
  // (a Christmas bauble, a small badge/logo detail) produced only 10-38
  // samples -- below the population floor below, so it was silently dropped
  // from the colour-count estimate entirely, understating the budget the
  // quantiser was given and forcing genuinely distinct colours to share a
  // median-cut box (see the phantom-colour fix on boxRepresentativeColour,
  // same underlying incident).
  const stride = Math.max(1, Math.ceil(total / 40000));
  const clusters: { rgb: Rgb; count: number }[] = [];
  // Hard cap. Without one, a high-diversity source (busy fabric, film grain,
  // a detailed photo) can grow this toward the full sample count, and every
  // sample does a linear scan of it -- cost toward samples^2. This function
  // only needs to COUNT roughly how many colours exist, not enumerate every
  // one exactly, so once the cap is hit, attribute to the nearest existing
  // cluster instead of growing further. Simulated: uncapped worst case ~800M
  // comparisons on adversarial input; capped, ~12M regardless of source.
  const MAX_CLUSTERS = 300;
  for (let i = 0; i < total; i += stride) {
    if (flatMask && !flatMask[i]) continue;
    const off = i * 3;
    const r = sourceRgb[off], g = sourceRgb[off + 1], b = sourceRgb[off + 2];
    let matched = false;
    let nearest = -1, nearestD = Infinity;
    for (const c of clusters) {
      const d = Math.abs(c.rgb[0] - r) + Math.abs(c.rgb[1] - g) + Math.abs(c.rgb[2] - b);
      if (d <= distThreshold) { c.count++; matched = true; break; }
      if (d < nearestD) { nearestD = d; nearest = clusters.indexOf(c); }
    }
    if (!matched) {
      if (clusters.length < MAX_CLUSTERS) clusters.push({ rgb: [r, g, b], count: 1 });
      else if (nearest >= 0) clusters[nearest].count++;
    }
  }

  const total_ = clusters.reduce((s, c) => s + c.count, 0);
  if (!total_) return 3;
  // Population floor changed from a 0.5%-only fraction to fraction OR an
  // absolute sample count. A percentage-only floor conflates "small design
  // element" with "noise" purely because of canvas size -- the same colour
  // patch counts as legitimate on a simple image and as noise on a busy one,
  // which is backwards. Verified against both real element sizes (40-100px
  // baubles, all now survive) and noise fleck sizes (4-12px, all still
  // correctly rejected) at the new sample density.
  const MIN_ABSOLUTE_SAMPLES = 6;
  const MIN_FRACTION = 0.001;
  return Math.max(
    2,
    clusters.filter((c) => c.count >= MIN_ABSOLUTE_SAMPLES && c.count / total_ > MIN_FRACTION).length,
  );
}
