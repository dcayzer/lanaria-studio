// Detail-vs-stitch-count fit check (client-side, pre-generation).
//
// Answers one question before a chart is generated: does this artwork carry
// more detail than the chosen stitch count can physically resolve? A stitch
// is one solid block of colour, so any feature narrower than a stitch cannot
// survive -- it is averaged into whatever surrounds it.
//
// CALIBRATED AGAINST REAL USER-REPORTED CASES, not invented thresholds. The
// same hand-lettered vegetable illustration was charted twice by the user:
//   12 mesh @ 6x6in  ->  72x72 stitches  -> reported as bad
//   18 mesh @ 9x9in  -> 162x162 stitches -> reported as good
// Measured sub-stitch linework: 47.5% vs 23.3%. Threshold sits at 42%,
// clearly between the two with margin on both sides. Controls: a simple
// flat two-shape motif measures 1-4% at EVERY size (correctly never warns),
// and the metric is monotonic in stitch count on every image tested.
//
// KEY PROPERTY, worth stating because it drives the advice given: resolvable
// detail depends ONLY on total stitch count, not on mesh and canvas size
// separately. 18 mesh at 6in and 12 mesh at 9in are both 108 stitches and
// measure identically (38.6%). Mesh decides physical size and thread weight;
// stitch count decides how much detail survives. So a user who needs more
// detail can get it by going finer OR bigger, and both are offered.

export interface DetailFit {
  /** Fraction of linework thinner than one stitch. Null for full-bleed art
   *  (a photo with no background) where stroke width is not meaningful. */
  subStitch: number | null;
  /** Fraction of stitch cells that are a blend of several colours rather
   *  than one dominant colour. Works on any image including photographs. */
  mixedCells: number;
  /** True when this artwork is likely to lose meaningful detail here. */
  warn: boolean;
  /** Why, in one phrase, for the dialog copy. */
  reason: "fine-linework" | "photographic-detail" | null;
}

const SUB_STITCH_LIMIT = 0.42;
const MIXED_CELL_LIMIT = 0.35;
const ANALYSIS_MAX_DIM = 600;
const COLOUR_BUCKET = 48;
const CELL_PURITY_LIMIT = 0.6;

/** Downsample into a canvas and read pixels back, capped for speed. */
function sample(img: HTMLImageElement): { data: Uint8ClampedArray; w: number; h: number } | null {
  const scale = Math.min(1, ANALYSIS_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch {
    return null;
  }
}

export function assessDetailFit(
  img: HTMLImageElement,
  gridW: number,
  gridH: number,
): DetailFit | null {
  if (!(gridW > 0) || !(gridH > 0)) return null;
  const s = sample(img);
  if (!s) return null;
  const { data, w, h } = s;

  // Ink mask: anything that is not plain near-white paper.
  const ink = new Uint8Array(w * h);
  let inkCount = 0;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const plain = r >= 244 && g >= 244 && b >= 244 && mx - mn <= 8;
    if (!plain) { ink[i] = 1; inkCount++; }
  }
  const inkFrac = inkCount / (w * h);

  // --- Metric 1: sub-stitch linework -------------------------------------
  // Erode the ink mask by half a stitch cell (separable square erosion, a
  // cheap stand-in for a distance transform -- verified to track the exact
  // EDT version within ~2 points on the real test images). Ink that does not
  // survive was thinner than one stitch.
  let subStitch: number | null = null;
  if (inkFrac > 0.02 && inkFrac < 0.85 && inkCount > 50) {
    const r = Math.max(1, Math.round((w / gridW) / 2));
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let keep = 1;
        for (let dx = -r; dx <= r && keep; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || !ink[y * w + nx]) keep = 0;
        }
        tmp[y * w + x] = keep;
      }
    }
    let survived = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!ink[y * w + x]) continue;
        let keep = 1;
        for (let dy = -r; dy <= r && keep; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h || !tmp[ny * w + x]) keep = 0;
        }
        if (keep) survived++;
      }
    }
    subStitch = 1 - survived / inkCount;
  }

  // --- Metric 2: mixed cells (universal, works on photographs) -----------
  let mixed = 0, cells = 0;
  for (let gy = 0; gy < gridH; gy++) {
    const y0 = Math.floor((gy * h) / gridH), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gridH));
    for (let gx = 0; gx < gridW; gx++) {
      const x0 = Math.floor((gx * w) / gridW), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gridW));
      const hist = new Map<number, number>();
      let n = 0;
      for (let y = y0; y < Math.min(y1, h); y++) {
        for (let x = x0; x < Math.min(x1, w); x++) {
          const i = (y * w + x) * 4;
          const key = ((data[i] / COLOUR_BUCKET) | 0) * 10000 +
                      ((data[i + 1] / COLOUR_BUCKET) | 0) * 100 +
                      ((data[i + 2] / COLOUR_BUCKET) | 0);
          hist.set(key, (hist.get(key) ?? 0) + 1);
          n++;
        }
      }
      if (!n) continue;
      let top = 0;
      for (const v of hist.values()) if (v > top) top = v;
      cells++;
      if (top / n < CELL_PURITY_LIMIT) mixed++;
    }
  }
  const mixedCells = cells ? mixed / cells : 0;

  const lineworkBad = subStitch !== null && subStitch >= SUB_STITCH_LIMIT;
  const photoBad = mixedCells >= MIXED_CELL_LIMIT;
  return {
    subStitch,
    mixedCells,
    warn: lineworkBad || photoBad,
    reason: lineworkBad ? "fine-linework" : photoBad ? "photographic-detail" : null,
  };
}

/**
 * Smallest stitch count (square-equivalent) that clears both limits, found by
 * re-measuring at candidate counts rather than extrapolating. Returns null if
 * nothing offered clears it -- in which case the honest answer is that the
 * image itself is the limit, not the canvas.
 */
export function findBetterFit(
  img: HTMLImageElement,
  aspect: number,
  candidates: number[],
): number | null {
  for (const g of candidates) {
    const fit = assessDetailFit(img, g, Math.max(1, Math.round(g / (aspect || 1))));
    if (fit && !fit.warn) return g;
  }
  return null;
}
