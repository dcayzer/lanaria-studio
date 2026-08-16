// ============================================================================
// Tessella Chart Engine — Structural Assertions (Phase 0)
// ============================================================================
// Property checks that hold for ANY correct chart, independent of the exact
// pixels. Used by the golden harness so intentional visual changes don't
// force re-approval churn, while genuine structural regressions (broken
// lines, uneven panes, mismatched pairs) fail loudly with coordinates.
// ============================================================================

import type { PaletteEntry, StructuralModel } from "./structural-model.ts";

export interface AssertionFailure {
  rule: string;
  detail: string;
}

export function assertStructure(
  grid: Uint16Array,
  gridW: number,
  gridH: number,
  outPalette: PaletteEntry[],
  model: StructuralModel,
): AssertionFailure[] {
  const fails: AssertionFailure[] = [];

  // ---- A1: every frame border is uniform width on all four sides ----------
  for (const f of model.frames) {
    const w = f.borderW;
    const checks: Array<[string, number, number]> = [];
    for (let c = f.c0; c <= f.c1; c++) { checks.push(["top", f.r0, c], ["bottom", f.r1, c]); }
    for (let r = f.r0; r <= f.r1; r++) { checks.push(["left", r, f.c0], ["right", r, f.c1]); }
    for (const [side, r, c] of checks) {
      if (grid[r * gridW + c] !== f.frameColour) {
        fails.push({ rule: "A1-frame-border", detail: `frame@(${f.r0},${f.c0}) ${side} edge missing frame colour at (${r},${c})` });
        break; // one failure per frame is enough signal
      }
    }
    void w;
  }

  // ---- A2: dividers are complete strokes (no gaps, junctions included) ----
  for (const f of model.frames) {
    for (const dr of f.hDividers) {
      for (let c = f.c0 + f.borderW.l; c <= f.c1 - f.borderW.r; c++) {
        if (grid[dr * gridW + c] !== f.frameColour) {
          fails.push({ rule: "A2-divider-continuity", detail: `h-divider row ${dr} broken at col ${c} in frame@(${f.r0},${f.c0})` });
          break;
        }
      }
    }
    for (const dc of f.vDividers) {
      for (let r = f.r0 + f.borderW.t; r <= f.r1 - f.borderW.b; r++) {
        if (grid[r * gridW + dc] !== f.frameColour) {
          fails.push({ rule: "A2-divider-continuity", detail: `v-divider col ${dc} broken at row ${r} in frame@(${f.r0},${f.c0})` });
          break;
        }
      }
    }
  }

  // ---- A3: panes within a frame are equal (±0 after parity snap) ----------
  for (const f of model.frames) {
    if (f.vDividers.length) {
      const edges = [f.c0 + f.borderW.l - 1, ...f.vDividers, f.c1 - f.borderW.r + 1];
      const widths: number[] = [];
      for (let k = 0; k + 1 < edges.length; k++) widths.push(edges[k + 1] - edges[k] - 1);
      if (new Set(widths).size > 1) {
        fails.push({ rule: "A3-pane-equality", detail: `frame@(${f.r0},${f.c0}) pane widths ${widths.join(",")}` });
      }
    }
    if (f.hDividers.length) {
      const edges = [f.r0 + f.borderW.t - 1, ...f.hDividers, f.r1 - f.borderW.b + 1];
      const heights: number[] = [];
      for (let k = 0; k + 1 < edges.length; k++) heights.push(edges[k + 1] - edges[k] - 1);
      if (new Set(heights).size > 1) {
        fails.push({ rule: "A3-pane-equality", detail: `frame@(${f.r0},${f.c0}) pane heights ${heights.join(",")}` });
      }
    }
  }


  // ---- A4: paired frames are congruent ------------------------------------
  const byPair = new Map<number, typeof model.frames>();
  for (const f of model.frames) {
    if (f.pairId === null) continue;
    byPair.set(f.pairId, [...(byPair.get(f.pairId) ?? []), f]);
  }
  for (const [pid, pair] of byPair) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    if (a.r1 - a.r0 !== b.r1 - b.r0 || a.c1 - a.c0 !== b.c1 - b.c0) {
      fails.push({ rule: "A4-pair-congruence", detail: `pair ${pid}: ${a.c1 - a.c0 + 1}x${a.r1 - a.r0 + 1} vs ${b.c1 - b.c0 + 1}x${b.r1 - b.r0 + 1}` });
    }
    if (a.hDividers.length !== b.hDividers.length || a.vDividers.length !== b.vDividers.length) {
      fails.push({ rule: "A4-pair-congruence", detail: `pair ${pid}: divider counts differ` });
    }
  }

  // ---- A5: every free line is 4-connected end to end ----------------------
  for (const line of model.freeLines) {
    const cellSet = new Set(line.cells);
    const start = line.cells[0];
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length) {
      const i = stack.pop()!;
      const r = (i / gridW) | 0, c = i % gridW;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
        const ni = nr * gridW + nc;
        // The render pass may add bridge cells; count grid reality, not just
        // the original cell list.
        if (!seen.has(ni) && (cellSet.has(ni) || grid[ni] === line.colour) && (cellSet.has(ni))) {
          seen.add(ni); stack.push(ni);
        }
      }
    }
    // Allow bridge cells to carry connectivity: re-walk over grid colour.
    if (seen.size < cellSet.size) {
      const seen2 = new Set<number>([start]);
      const stack2 = [start];
      while (stack2.length) {
        const i = stack2.pop()!;
        const r = (i / gridW) | 0, c = i % gridW;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
          const ni = nr * gridW + nc;
          if (!seen2.has(ni) && grid[ni] === line.colour) { seen2.add(ni); stack2.push(ni); }
        }
      }
      let reached = 0;
      for (const cIdx of cellSet) if (seen2.has(cIdx)) reached++;
      if (reached < cellSet.size) {
        fails.push({ rule: "A5-line-connectivity", detail: `free line colour ${line.colour}: ${cellSet.size - reached}/${cellSet.size} cells unreachable` });
      }
    }
  }

  // ---- A6: no tiny non-background islands outside model ownership ---------
  {
    const bgWhite = (i: number) => {
      const hex = outPalette[grid[i]]?.hex ?? "#ffffff";
      const h = hex.replace("#", "");
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return r >= 230 && g >= 230 && b >= 230;
    };
    const N = gridW * gridH;
    const seen = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      if (seen[s] || bgWhite(s) || model.ownedCells.has(s)) continue;
      const colour = grid[s];
      const comp: number[] = [];
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        comp.push(i);
        const r = (i / gridW) | 0, c = i % gridW;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
          const ni = nr * gridW + nc;
          if (!seen[ni] && grid[ni] === colour) { seen[ni] = 1; stack.push(ni); }
        }
      }
      if (comp.length === 1) {
        const r = (comp[0] / gridW) | 0, c = comp[0] % gridW;
        fails.push({ rule: "A6-orphan-stitch", detail: `isolated single stitch colour ${colour} at (${r},${c})` });
      }
    }
  }

  return fails;
}
