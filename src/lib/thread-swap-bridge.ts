// thread-swap-bridge.ts
//
// Cross-brand thread substitution suggestions for the Thread Shopping List --
// "you already have something close enough, no need to buy." Built entirely
// on the already-verified CIEDE2000 matcher in thread-match.ts (validated
// against the Sharma/Wu/Dalal reference dataset) rather than a new
// colour-distance implementation.

import { matchThread, type ThreadColorLike } from "./thread-match";
import type { StashEntry } from "./thread-inventory";
import { THREAD_PALETTES, type ThreadBrand } from "../data/threadPalettes";

/**
 * ΔE00 ceiling for "close enough to substitute". Looser than
 * JND_JUST_NOTICEABLE (2.3) from thread-match.ts on purpose: a stitcher
 * choosing a substitute is deliberately trading a bit of visible difference
 * for not buying more thread, not asking for imperceptible. Starting
 * default -- easy to tune once this is seen against real stash data.
 */
export const SUBSTITUTE_MAX_DELTAE = 5;

export interface StashSuggestion {
  /** True if this is the EXACT brand+code already needed -- not a "swap" at
   *  all, just "you already own this." False for a genuine cross-brand
   *  substitute. */
  exact: boolean;
  brand: string;
  code: string;
  name?: string;
  hex: string;
  deltaE: number;
  onHand: number;
  unit: StashEntry["unit"];
}

function hexFor(brand: string, code: string): string | null {
  const key = brand.trim().toLowerCase() as ThreadBrand;
  const palette = THREAD_PALETTES[key];
  if (!palette) return null;
  const found = palette.find(
    (t) => t.code.trim().toLowerCase() === code.trim().toLowerCase(),
  );
  return found?.hex ?? null;
}

/**
 * Best stash suggestion for one needed colour. Checks for an EXACT
 * brand+code match first (onHand > 0); if none, searches the WHOLE stash
 * across every brand for the closest perceptual match within
 * SUBSTITUTE_MAX_DELTAE. Returns null if nothing qualifies either way.
 */
export function suggestFromStash(
  neededBrand: string,
  neededCode: string,
  stash: StashEntry[],
): StashSuggestion | null {
  const targetHex = hexFor(neededBrand, neededCode);
  if (!targetHex) return null;

  const exact = stash.find(
    (e) =>
      e.quantity > 0 &&
      e.brand.trim().toLowerCase() === neededBrand.trim().toLowerCase() &&
      e.code.trim().toLowerCase() === neededCode.trim().toLowerCase(),
  );
  if (exact) {
    return {
      exact: true,
      brand: exact.brand,
      code: exact.code,
      name: exact.name,
      hex: targetHex,
      deltaE: 0,
      onHand: exact.quantity,
      unit: exact.unit,
    };
  }

  const candidates: Array<ThreadColorLike & { entry: StashEntry }> = [];
  for (const entry of stash) {
    if (entry.quantity <= 0) continue;
    const hex = hexFor(entry.brand, entry.code);
    if (!hex) continue;
    candidates.push({ code: `${entry.brand}::${entry.code}`, hex, entry });
  }
  if (!candidates.length) return null;

  const [best] = matchThread({ code: "target", hex: targetHex }, candidates, { topN: 1 });
  if (!best || best.deltaE > SUBSTITUTE_MAX_DELTAE) return null;

  return {
    exact: false,
    brand: best.thread.entry.brand,
    code: best.thread.entry.code,
    name: best.thread.entry.name,
    hex: best.thread.hex!,
    deltaE: best.deltaE,
    onHand: best.thread.entry.quantity,
    unit: best.thread.entry.unit,
  };
}
