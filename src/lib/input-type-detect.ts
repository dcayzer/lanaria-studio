/**
 * input-type-detect.ts — decide whether an uploaded image is flat artwork
 * or a continuous-tone photograph.
 *
 * WHY THIS EXISTS
 * The chart engine runs two genuinely different regimes (`inputType`):
 * "generated" (24-colour budget, structural thin-line detection ON) and
 * "photo" (48-colour budget, thin-line detection OFF). Previously every
 * upload was hardcoded to "photo", so uploading flat artwork produced a
 * fuzzy chart with invented shadows -- twice the palette to spend finding
 * gradients that aren't there, and no edge handling to keep outlines crisp.
 *
 * HOW IT DECIDES, and why the obvious metric fails.
 * The intuitive test -- "flat art has large flat colour fields" -- is
 * measurably WRONG on its own. A photograph of a subject on a plain studio
 * backdrop measures ~0.92-0.96 flat, HIGHER than real flat artwork
 * (~0.63-0.77), because the backdrop is a huge uniform region. Tested, not
 * assumed.
 *
 * What actually separates them is the character of the NON-flat pixels:
 *   - Flat art transitions ABRUPTLY. Its non-flat pixels are hard edges
 *     (large local range) sitting between flat fields.
 *   - Photographs shade GRADUALLY. Their non-flat pixels are smooth ramps
 *     (small-but-nonzero local range) spanning the whole subject.
 * So the primary signal is `rampShare`: of the pixels that aren't flat,
 * what proportion are gentle ramps rather than hard edges.
 *
 * Plus one guard: an image with essentially NO flat regions at all is a
 * photograph regardless of ramp share -- busy photographic texture (foliage,
 * fabric, gravel) produces hard local contrast everywhere and would
 * otherwise read as "all edges, therefore flat art".
 */

/** Local 3x3 range at or below this counts as a flat region. Tolerant enough
 *  to absorb JPEG noise and sensor grain -- verified stable on the same
 *  artwork re-saved at JPEG quality 95 down to 50 (flat fraction moved only
 *  0.624 -> 0.613). */
const FLAT_TOLERANCE = 8;
/** Above FLAT_TOLERANCE and at or below this is a smooth ramp; beyond it is
 *  a hard edge. */
const RAMP_CEILING = 40;
/** Below this share of flat pixels, treat as a photograph outright. */
const MIN_FLAT_FRACTION = 0.15;
/** Above this ramp share, treat as a photograph. Real flat art measured
 *  0.235-0.384; studio-backdrop photos measured 0.558-0.658. */
const MAX_RAMP_SHARE = 0.45;
/** Longest edge to analyse at. Downsampling first is both faster and less
 *  sensitive to per-pixel noise. */
const ANALYSIS_SIZE = 256;

export type InputType = "generated" | "photo";

export interface DetectionResult {
  inputType: InputType;
  flatFraction: number;
  rampShare: number;
  /** How clear-cut the call was, 0-1. Low values mean the image sits near a
   *  threshold and the user may well want to override. */
  confidence: number;
}

/** Pure classification decision, extracted so it is testable without a canvas. */
export function classify(flatFraction: number, rampShare: number): InputType {
  if (flatFraction < MIN_FLAT_FRACTION) return "photo";
  if (rampShare > MAX_RAMP_SHARE) return "photo";
  return "generated";
}

/** Confidence in the call made by `classify`, 0-1. */
export function classifyConfidence(flatFraction: number, rampShare: number): number {
  const margin =
    flatFraction < MIN_FLAT_FRACTION
      ? (MIN_FLAT_FRACTION - flatFraction) / MIN_FLAT_FRACTION
      : Math.abs(rampShare - MAX_RAMP_SHARE) / MAX_RAMP_SHARE;
  return Math.max(0, Math.min(1, margin * 2));
}

/**
 * Classifies an already-loaded image. Runs on a downsampled copy, so it's
 * cheap enough to call synchronously on upload.
 */
export function detectInputType(img: HTMLImageElement | HTMLCanvasElement): DetectionResult {
  const srcW = "naturalWidth" in img ? img.naturalWidth : img.width;
  const srcH = "naturalHeight" in img ? img.naturalHeight : img.height;
  const scale = Math.min(1, ANALYSIS_SIZE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    // Can't analyse -- fall back to the safer regime. "generated" is the
    // safer default here: its narrower palette and edge handling degrade a
    // photo gracefully, whereas photo mode on flat art is the actual defect
    // this module exists to fix.
    return { inputType: "generated", flatFraction: 0, rampShare: 0, confidence: 0 };
  }
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const at = (x: number, y: number, c: number) => data[(y * w + x) * 4 + c];

  let flat = 0;
  let ramp = 0;
  let edge = 0;
  let counted = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let maxRange = 0;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            const v = at(nx, ny, c);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        const range = hi - lo;
        if (range > maxRange) maxRange = range;
      }
      counted++;
      if (maxRange <= FLAT_TOLERANCE) flat++;
      else if (maxRange <= RAMP_CEILING) ramp++;
      else edge++;
    }
  }

  const flatFraction = counted > 0 ? flat / counted : 0;
  const nonFlat = ramp + edge;
  const rampShare = nonFlat > 0 ? ramp / nonFlat : 0;

  const inputType = classify(flatFraction, rampShare);
  const confidence = classifyConfidence(flatFraction, rampShare);

  return { inputType, flatFraction, rampShare, confidence };
}
