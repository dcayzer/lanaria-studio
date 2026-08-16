// Bridges progress-tracking.ts's ProgressGrid (boolean[][], [y][x]) with
// progress-persistence.ts's ProgressSnapshot (flat numeric indices) -- the
// two shipped independently and were never reconciled. Both stay untouched;
// this is the small adapter layer between them, following the same pattern
// as thread-calculator-bridge.ts and chart-layer-compositor.ts earlier in
// this project.

import type { ProgressGrid } from "./progress-tracking";
import { makeProgressGrid } from "./progress-tracking";
import type { ProgressSnapshot } from "./progress-persistence";

/** ProgressGrid -> the flat done-index list ProgressSnapshot expects. */
export function gridToSnapshot(grid: ProgressGrid): ProgressSnapshot {
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  const done: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grid[y][x]) done.push(y * width + x);
    }
  }
  return { width, height, done };
}

/** ProgressSnapshot -> a fresh ProgressGrid. Out-of-range indices (shouldn't
 *  happen -- reconcileProgress already guards dimension mismatches upstream
 *  -- but defensive here too) are silently skipped rather than throwing. */
export function snapshotToGrid(snapshot: ProgressSnapshot): ProgressGrid {
  const grid = makeProgressGrid(snapshot.width, snapshot.height);
  for (const i of snapshot.done) {
    const y = Math.floor(i / snapshot.width);
    const x = i % snapshot.width;
    if (y >= 0 && y < snapshot.height && x >= 0 && x < snapshot.width) {
      grid[y][x] = true;
    }
  }
  return grid;
}
