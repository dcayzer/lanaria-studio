// PHASE B -- ownership-aware manual-edit merge.
//
// THE BUG THIS FIXES (reported by Delaney, 4 Aug): she resized the monogram, it
// overlapped the border, she moved it away -- and both the border stitches
// underneath AND some of the monogram's own decorative stitches were destroyed.
//
// ROOT CAUSE: the original mergeManualEdit answers "which cells did the user
// deliberately paint?" purely positionally --
//
//     if (lastComposite[cell] !== editedByUser[cell]) base[cell] = edited[cell]
//
// -- with NO notion of which object owns a cell. Every difference is attributed
// to the base. That is safe when the only thing changing between composites is
// a deliberate paint stroke. It is NOT safe when an object moves, because the
// difference the move produced gets misread as a manual edit and burned
// permanently into the base -- including cells belonging to a DIFFERENT object
// that happened to be underneath. Text and monogram are moved by sliders that
// fire continuously during a drag, so that path exercises the weakness hardest.
//
// THE FIX: attribute every changed cell to whichever object actually owns it,
// using the SAME top-down traversal hitTest already uses for selection, so
// selection, rendering and edit-attribution can never disagree. A cell owned by
// a layer is written into that layer's own cells; only cells owned by nothing
// are written into the base.
//
// This also delivers what Delaney asked for architecturally: paint a stitch on
// a motif and the stitch moves with the motif, because the edit now lives on
// the motif rather than on the canvas underneath it. Decided 5 Aug: the same
// rule applies to the generated image once Phase D lands -- the image is just
// the bottom-most free object and is not a special case.
//
// This module ADDS a function; it does not change mergeManualEdit's behaviour.
// Call sites migrate one at a time, each verified with get_diff.

import type { ChartData, ChartPaletteEntry } from "@/components/StitchChart";
import { chartToCodeGrid, codeGridToChart } from "./chart-layer-compositor";
import { isMovable, type Cell, type Layer } from "./layer-model";

/** A single write into one layer's own native cell grid. */
export interface LayerCellEdit {
  readonly row: number;
  readonly col: number;
  readonly code: Cell;
}

export interface EditAttribution {
  /** The new base -- containing ONLY edits that belong to the background. */
  readonly base: ChartData;
  /** layerId -> writes into that layer's native cells. */
  readonly layerEdits: ReadonlyMap<string, LayerCellEdit[]>;
  /**
   * Edits that landed on a layer which is REBUILT from config every recompose
   * (currently: the border, and text/monogram until Phase A gives them durable
   * identity). Writing these into the layer would be pointless -- the rebuild
   * discards them -- and writing them into the base is exactly the bug this
   * module exists to fix, because the layer then redraws over them anyway.
   * They are surfaced here so the caller can tell the user the edit could not
   * be kept, instead of silently destroying the artwork underneath.
   */
  readonly discardedOnRebuiltLayers: number;
  /**
   * Edits refused because the owning layer is upscaled and the stroke did not
   * cover a whole native block. See the SCALE note below.
   */
  readonly refusedOnScaledLayers: number;
  /** Total cells that differed. Diagnostic. */
  readonly touched: number;
}

/**
 * Native cell coordinates a layer shows at canvas point (x, y), or null if the
 * point is outside its scaled footprint.
 *
 * Deliberately mirrors layer-model's cellAtPoint arithmetic exactly rather than
 * re-deriving it -- if these two ever disagree, selection and edit-attribution
 * disagree, and the user paints on one object while the edit lands on another.
 * Rotation needs no handling here because layers arrive already rotated: the
 * caller passes the very same Layer[] it handed to applyLayersToChart, whose
 * cells are post-rotateCells. Attribution therefore operates on exactly what
 * was composited.
 */
function localCellOf(
  layer: Layer,
  x: number,
  y: number,
): { row: number; col: number } | null {
  const localX = x - layer.offset.x;
  const localY = y - layer.offset.y;
  if (localX < 0 || localY < 0) return null;
  const col = Math.floor(localX / layer.scale);
  const row = Math.floor(localY / layer.scale);
  if (row >= layer.height || col >= layer.width) return null;
  return { row, col };
}

/**
 * Does an edit cover the WHOLE native block of an upscaled layer?
 *
 * At scale > 1 a single native cell covers a scale x scale block on canvas.
 * Painting one stitch inside that block cannot be represented in the layer's
 * native cells without either writing the entire block -- which silently
 * destroys detail the user can plainly see -- or refusing. We refuse, and
 * report it, so the caller can say "flatten this to paint on it directly".
 * Silently expanding a one-stitch stroke into a 3x3 block would be the same
 * class of quiet data loss this whole module exists to eliminate.
 */
function blockFullyCovered(
  layer: Layer,
  local: { row: number; col: number },
  code: Cell,
  afterGrid: string[][],
  W: number,
  H: number,
): boolean {
  if (layer.scale === 1) return true;
  const x0 = layer.offset.x + local.col * layer.scale;
  const y0 = layer.offset.y + local.row * layer.scale;
  for (let dy = 0; dy < layer.scale; dy++) {
    for (let dx = 0; dx < layer.scale; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (afterGrid[y][x] !== code) return false;
    }
  }
  return true;
}

/**
 * Ownership-aware replacement for mergeManualEdit.
 *
 * @param chartBase     Current base (background / image), pre-overlay.
 * @param lastComposite Exactly what StitchChart was showing and editing.
 * @param editedByUser  What StitchChart's onChange handed back.
 * @param layers        The SAME Layer[] passed to applyLayersToChart for
 *                       lastComposite -- bottom-to-top, already rotated.
 * @param sentinel      The per-brand transparency code.
 */
export function mergeManualEditAttributed(
  chartBase: ChartData,
  lastComposite: ChartData,
  editedByUser: ChartData,
  layers: readonly Layer[],
  sentinel: Cell,
): EditAttribution {
  const empty = new Map<string, LayerCellEdit[]>();

  if (
    chartBase.width !== editedByUser.width ||
    chartBase.height !== editedByUser.height ||
    lastComposite.width !== editedByUser.width ||
    lastComposite.height !== editedByUser.height
  ) {
    // Dimensions changed -- can't diff mismatched grids. Same fallback as the
    // original: trust the edit wholesale.
    return {
      base: editedByUser,
      layerEdits: empty,
      discardedOnRebuiltLayers: 0,
      refusedOnScaledLayers: 0,
      touched: 0,
    };
  }

  const baseGrid = chartToCodeGrid(chartBase);
  const beforeGrid = chartToCodeGrid(lastComposite);
  const afterGrid = chartToCodeGrid(editedByUser);
  const H = baseGrid.length;
  const W = H > 0 ? baseGrid[0].length : 0;

  const layerEdits = new Map<string, LayerCellEdit[]>();
  /** layerId -> "row:col" already recorded, so an upscaled layer's block
   *  doesn't produce scale^2 identical edits. */
  const seenPerLayer = new Map<string, Set<string>>();
  let touched = 0, baseWrites = 0, discarded = 0, refused = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (beforeGrid[y][x] === afterGrid[y][x]) continue;
      touched++;
      const code = afterGrid[y][x];

      // Who owns this canvas cell? Topmost layer painting a non-sentinel cell
      // here -- the identical rule hitTest uses to decide what a click selects.
      let owner: Layer | null = null;
      let ownerLocal: { row: number; col: number } | null = null;
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        const local = localCellOf(layer, x, y);
        if (!local) continue;
        if (layer.cells[local.row][local.col] === sentinel) continue;
        owner = layer;
        ownerLocal = local;
        break;
      }

      if (!owner || !ownerLocal) {
        // Owned by nothing -> genuinely a background edit.
        baseGrid[y][x] = code;
        baseWrites++;
        continue;
      }

      if (!isMovable(owner)) {
        // Border (or any anchored layer): rebuilt from config every recompose,
        // so an edit here cannot be kept. Crucially we do NOT fall back to
        // writing the base -- that is precisely the path that destroyed the
        // border stitches in the reported bug.
        discarded++;
        continue;
      }

      if (!blockFullyCovered(owner, ownerLocal, code, afterGrid, W, H)) {
        refused++;
        continue;
      }

      // Deduplicate: on an upscaled layer one native cell covers a
      // scale x scale block, so all scale^2 canvas cells resolve to the SAME
      // native cell and would otherwise be recorded scale^2 times. Harmless
      // when applied (same value written repeatedly) but it inflates the edit
      // counts the caller reports to the user, so collapse it here.
      const key = `${ownerLocal.row}:${ownerLocal.col}`;
      let seen = seenPerLayer.get(owner.id);
      if (!seen) { seen = new Set<string>(); seenPerLayer.set(owner.id, seen); }
      if (seen.has(key)) continue;
      seen.add(key);

      let list = layerEdits.get(owner.id);
      if (!list) { list = []; layerEdits.set(owner.id, list); }
      list.push({ row: ownerLocal.row, col: ownerLocal.col, code });
    }
  }

  if (touched === 0) {
    return {
      base: chartBase,
      layerEdits: empty,
      discardedOnRebuiltLayers: 0,
      refusedOnScaledLayers: 0,
      touched: 0,
    };
  }

  const base = baseWrites === 0 ? chartBase : rebuild(baseGrid, chartBase, editedByUser);

  return {
    base,
    layerEdits,
    discardedOnRebuiltLayers: discarded,
    refusedOnScaledLayers: refused,
    touched,
  };
}

function rebuild(grid: string[][], chartBase: ChartData, edited: ChartData): ChartData {
  const entryByCode = new Map<string, ChartPaletteEntry>();
  for (const p of chartBase.palette) entryByCode.set(p.id, p);
  for (const p of edited.palette) if (!entryByCode.has(p.id)) entryByCode.set(p.id, p);
  return codeGridToChart(grid, (code) => entryByCode.get(code));
}

/**
 * Apply attributed edits to a layer's native cells, returning NEW cells.
 * Pure -- never mutates the input, matching layer-model's convention.
 */
export function applyLayerEdits(
  layer: Layer,
  edits: readonly LayerCellEdit[],
): Cell[][] {
  if (edits.length === 0) return layer.cells;
  const next = layer.cells.map((row) => row.slice());
  for (const e of edits) {
    if (e.row < 0 || e.col < 0 || e.row >= layer.height || e.col >= layer.width) continue;
    next[e.row][e.col] = e.code;
  }
  return next;
}
