// The key wiring problem this solves:
//
// Once text/monogram become a LIVE overlay (composited fresh every render
// from chartBase + current text/monogram config, via applyLayersToChart),
// StitchChart's own paint/select/move tools still hand back a single FLAT
// ChartData through onChange — which necessarily includes whatever text
// pixels were visible at the time, since StitchChart has no concept of
// layers. If we naively took that flat result and made it the new
// chartBase, moving the text afterwards would leave a "ghost" of it baked in
// at the old position forever.
//
// The fix: diff the flat result StitchChart hands back against the exact
// composite we last showed it. Any cell that's UNCHANGED is either
// untouched base or an unmodified part of the text/monogram overlay — leave
// chartBase alone there. Any cell that DIFFERS is a genuine manual edit
// (paint, move, fill, transform) — fold that specific cell into chartBase.
// This means: painting over a letter permanently sticks (correct — the user
// deliberately edited that stitch), but simply repositioning the text
// afterwards doesn't drag a ghost along, because untouched overlay cells
// were never written into chartBase in the first place.

import type { ChartData, ChartPaletteEntry } from "@/components/StitchChart";
import { chartToCodeGrid, codeGridToChart } from "./chart-layer-compositor";

/**
 * Compute the new chartBase after a manual StitchChart edit.
 *
 * @param chartBase       The current base (image or blank+border), pre-overlay.
 * @param lastComposite   The exact ChartData StitchChart was showing/editing
 *                         (i.e. applyLayersToChart(chartBase, currentLayers, ...)).
 * @param editedByUser    What StitchChart's onChange handed back.
 */
export function mergeManualEdit(
  chartBase: ChartData,
  lastComposite: ChartData,
  editedByUser: ChartData,
): ChartData {
  if (
    chartBase.width !== editedByUser.width ||
    chartBase.height !== editedByUser.height ||
    lastComposite.width !== editedByUser.width ||
    lastComposite.height !== editedByUser.height
  ) {
    // Dimensions changed (shouldn't happen via StitchChart's own tools) —
    // safest fallback is to trust the edit wholesale rather than diff
    // mismatched grids.
    return editedByUser;
  }

  const baseGrid = chartToCodeGrid(chartBase);
  const beforeGrid = chartToCodeGrid(lastComposite);
  const afterGrid = chartToCodeGrid(editedByUser);

  let touched = 0;
  for (let y = 0; y < baseGrid.length; y++) {
    for (let x = 0; x < baseGrid[y].length; x++) {
      if (beforeGrid[y][x] !== afterGrid[y][x]) {
        baseGrid[y][x] = afterGrid[y][x];
        touched++;
      }
    }
  }

  if (touched === 0) return chartBase; // nothing actually changed

  const entryByCode = new Map<string, ChartPaletteEntry>();
  for (const p of chartBase.palette) entryByCode.set(p.id, p);
  for (const p of editedByUser.palette) if (!entryByCode.has(p.id)) entryByCode.set(p.id, p);

  return codeGridToChart(baseGrid, (code) => entryByCode.get(code));
}

/** How many cells actually differ between two same-size ChartData grids (diagnostic use). */
export function countDiff(a: ChartData, b: ChartData): number {
  const ga = chartToCodeGrid(a);
  const gb = chartToCodeGrid(b);
  let n = 0;
  for (let y = 0; y < ga.length; y++) {
    for (let x = 0; x < ga[y].length; x++) {
      if (ga[y][x] !== gb[y][x]) n++;
    }
  }
  return n;
}
