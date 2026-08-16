// Motif Library — compositor.
//
// Flattens an ordered layer stack (see layer-model.ts) into the final flat
// stitch grid that the chart engine / renderer consumes. This is the render
// step of the composition-level "model -> render" split: layers stay editable
// and independent until this point, where they collapse to one grid.
//
// Rules:
//   - The background fills the whole canvas first (it is always the bottom).
//   - Layers are painted bottom -> top. Because painting overwrites, the
//     TOPMOST non-transparent layer wins at any cell — exactly the z-order the
//     layer model encodes (border above background, motifs/text above border).
//   - A cell equal to the transparency SENTINEL is skipped, so a motif's
//     removed background does not overwrite whatever sits beneath it.
//   - Glyph and motif cells are copied VERBATIM. The only transform is the
//     integer upscale: one native cell becomes a `scale` x `scale` block. There
//     is no resampling, colour mixing, or edge re-interpretation — hand-charted
//     artwork survives byte-for-byte (at 1x) or as exact blocks (at Nx).
//   - Anything outside the canvas is clipped silently.
//
// Pure: does not mutate the document or its layers.

import type { Cell, ChartDocument, Layer } from "./layer-model";

/** A flattened grid, row-major: grid[row][col]. */
export type Grid = Cell[][];

function blankGrid(width: number, height: number, fill: Cell): Grid {
  const grid: Grid = new Array(height);
  for (let r = 0; r < height; r++) {
    grid[r] = new Array(width).fill(fill);
  }
  return grid;
}

/**
 * Paint one layer into an existing grid (mutates `grid` in place — this is an
 * internal helper; the public `composite` builds a fresh grid each call).
 */
function paintLayer(
  grid: Grid,
  layer: Layer,
  canvasW: number,
  canvasH: number,
  sentinel: Cell,
): void {
  const { cells, width, height, scale } = layer;
  const ox = layer.offset.x;
  const oy = layer.offset.y;

  for (let r = 0; r < height; r++) {
    const row = cells[r];
    for (let c = 0; c < width; c++) {
      const value = row[c];
      if (value === sentinel) continue; // transparent — let lower layers show

      // Native cell (r, c) expands to a scale x scale block on the canvas.
      const blockX0 = ox + c * scale;
      const blockY0 = oy + r * scale;

      for (let dy = 0; dy < scale; dy++) {
        const y = blockY0 + dy;
        if (y < 0 || y >= canvasH) continue;
        const gridRow = grid[y];
        for (let dx = 0; dx < scale; dx++) {
          const x = blockX0 + dx;
          if (x < 0 || x >= canvasW) continue;
          gridRow[x] = value;
        }
      }
    }
  }
}

/**
 * Flatten a document into a single grid.
 *
 * @param doc       The design (canvas dims, background fill, ordered layers).
 * @param sentinel  The per-brand "background only" thread code that marks a
 *                  cell as transparent. Cells equal to it are not painted.
 */
export function composite(doc: ChartDocument, sentinel: Cell): Grid {
  const { width, height, background, layers } = doc;
  const grid = blankGrid(width, height, background);
  // layers are already ordered bottom -> top; paint in order.
  for (const layer of layers) {
    paintLayer(grid, layer, width, height, sentinel);
  }
  return grid;
}

/**
 * Convenience: the flattened cell value at a single canvas point, without
 * building the whole grid. Same result as `composite(doc, sentinel)[y][x]`.
 * Useful for cheap previews / probes.
 */
export function compositeCellAt(
  doc: ChartDocument,
  x: number,
  y: number,
  sentinel: Cell,
): Cell {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) {
    // Off-canvas has no defined value; return background for safety.
    return doc.background;
  }
  // Top -> bottom: first non-transparent covering cell wins.
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    const localX = x - layer.offset.x;
    const localY = y - layer.offset.y;
    if (localX < 0 || localY < 0) continue;
    const col = Math.floor(localX / layer.scale);
    const row = Math.floor(localY / layer.scale);
    if (row >= layer.height || col >= layer.width) continue;
    const value = layer.cells[row][col];
    if (value !== sentinel) return value;
  }
  return doc.background;
}
