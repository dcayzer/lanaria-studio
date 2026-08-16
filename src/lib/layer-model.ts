// Motif Library — layer data model + z-order operations.
//
// This is the composition layer that sits ONE LEVEL UP from the chart engine.
// Instead of destructively stamping borders/text into a single flat grid (the
// old stampBorderOnChart / stampTextOnChart path, which loses what was
// underneath), a design is an ORDERED LIST OF LAYERS. Each layer keeps its own
// cells; the stack is flattened to a flat grid only at render time (see
// compositor.ts). This mirrors the model -> render shift already made for
// windows in the chart engine, applied at the composition level.
//
// Charting (what a glyph's stitches look like) and layout (where it sits, what
// order it renders in) are ORTHOGONAL. A layer's `cells` are hand-verified
// artwork, copied verbatim into the composite and never re-interpreted. Moving
// an object only changes its `offset`; the cells never change.
//
// Z-ORDER INVARIANT:
//   background (bottom, implicit)  <  border (if any)  <  free layers (top)
//   - Exactly one background; it is NOT a member of `layers` — it is the
//     implicit fill beneath everything, so nothing can ever be moved below it.
//   - At most one border. If present it is `layers[0]` and is never draggable
//     and never reordered. The only thing underneath a border is background.
//   - Free layers (motif / letter / number / monogram) are `layers[1..]` (or
//     `layers[0..]` when there is no border). They reorder freely AMONG
//     THEMSELVES but can never be pushed below the border or the background.
//
// All operations are pure: they return new arrays/objects and never mutate
// their inputs.

export type LayerKind =
  | "border"
  | "motif"
  | "letter"
  | "number"
  | "monogram";

/**
 * A single grid cell. A cell is either a thread code (e.g. "991A", "DMC 310")
 * or the transparency sentinel — a per-brand reserved "background only" code
 * (e.g. Appletons 991B). Background removal happens ONCE at motif-save time and
 * writes the sentinel into background cells; everything downstream just reads
 * it rather than re-detecting edges. The sentinel itself is supplied to the
 * compositor, not hard-coded here, because it differs by brand.
 */
export type Cell = string;

export type Quarter = 0 | 90 | 180 | 270;

/**
 * Rotate a cell grid by a quarter turn, clockwise. LOSSLESS: cells are only
 * reindexed, never resampled or blended, so hand-charted artwork survives
 * exactly. Quarter turns are the only rotations offered for precisely this
 * reason -- stitches are grid-aligned, and an arbitrary angle would have to
 * resample, producing jagged edges that cannot be stitched.
 * Dimensions swap for 90/270.
 */
export function rotateCells(cells: string[][], deg: Quarter): string[][] {
  if (deg === 0 || cells.length === 0) return cells;
  const h = cells.length;
  const w = cells[0].length;
  if (deg === 180) {
    const out: string[][] = [];
    for (let r = h - 1; r >= 0; r--) {
      const row: string[] = [];
      for (let c = w - 1; c >= 0; c--) row.push(cells[r][c]);
      out.push(row);
    }
    return out;
  }
  const out: string[][] = Array.from({ length: w }, () => new Array<string>(h));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (deg === 90) out[c][h - 1 - r] = cells[r][c];
      else out[w - 1 - c][r] = cells[r][c];
    }
  }
  return out;
}

export interface Layer {
  readonly id: string;
  readonly kind: LayerKind;
  /**
   * Native charted cells, row-major: `cells[row][col]`, with `height` rows of
   * `width` columns. This is the verbatim hand-charted artwork. Never mutated
   * or re-interpreted by layout operations.
   */
  readonly cells: Cell[][];
  /** Native width in stitches. Invariant: cells[r].length === width. */
  readonly width: number;
  /** Native height in stitches. Invariant: cells.length === height. */
  readonly height: number;
  /** Top-left position of the layer on the composite canvas, in stitches. */
  readonly offset: { readonly x: number; readonly y: number };
  /**
   * Integer upscale factor, >= 1. Motifs scale UP only. Shrinking below native
   * is lossy (a 1-stitch line vanishes on any downscale), so it is disallowed:
   * each motif is stored at its native charted size and only ever enlarged, one
   * native cell becoming a `scale` x `scale` block.
   */
  readonly scale: number;
}

/** A whole design: canvas dimensions, background fill, and the layer stack. */
export interface ChartDocument {
  /** Canvas width in stitches (rectangular grid — real cut canvas). */
  readonly width: number;
  /** Canvas height in stitches. */
  readonly height: number;
  /** The background fill thread code. Fills the whole canvas beneath all layers. */
  readonly background: Cell;
  /** Ordered bottom -> top. Border (if any) is index 0; free layers follow. */
  readonly layers: readonly Layer[];
}

// ---------------------------------------------------------------------------
// Predicates & small helpers
// ---------------------------------------------------------------------------

/** Border and background are anchored; only free layers can be moved/reordered. */
export function isMovable(layer: Layer): boolean {
  return layer.kind !== "border";
}

/** True if the stack currently contains a border layer. */
export function hasBorder(layers: readonly Layer[]): boolean {
  return layers.length > 0 && layers[0].kind === "border";
}

/**
 * The lowest index a FREE layer may occupy. Free layers must always sit above
 * the border, so this is 1 when a border is present and 0 otherwise.
 */
export function freeFloorIndex(layers: readonly Layer[]): number {
  return hasBorder(layers) ? 1 : 0;
}

function indexOf(layers: readonly Layer[], id: string): number {
  return layers.findIndex((l) => l.id === id);
}

/** Clamp a requested scale to the allowed range: integer, >= 1 (never shrink). */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.max(1, Math.round(scale));
}

/** Scaled on-canvas dimensions of a layer (native size x integer scale). */
export function scaledSize(layer: Layer): { width: number; height: number } {
  return { width: layer.width * layer.scale, height: layer.height * layer.scale };
}

// ---------------------------------------------------------------------------
// Construction / validation
// ---------------------------------------------------------------------------

/**
 * Build a validated layer. Throws on inconsistent dimensions rather than
 * silently accepting a malformed grid — a corrupt layer would surface as a
 * wrong render much later, so fail loudly at construction.
 */
export function makeLayer(input: {
  id: string;
  kind: LayerKind;
  cells: Cell[][];
  offset?: { x: number; y: number };
  scale?: number;
}): Layer {
  const { id, kind, cells } = input;
  const height = cells.length;
  const width = height > 0 ? cells[0].length : 0;
  if (height === 0 || width === 0) {
    throw new Error(`makeLayer(${id}): cells must be a non-empty grid`);
  }
  for (let r = 0; r < height; r++) {
    if (cells[r].length !== width) {
      throw new Error(
        `makeLayer(${id}): row ${r} has width ${cells[r].length}, expected ${width}`,
      );
    }
  }
  return {
    id,
    kind,
    cells,
    width,
    height,
    offset: input.offset ?? { x: 0, y: 0 },
    scale: clampScale(input.scale ?? 1),
  };
}

// ---------------------------------------------------------------------------
// Add / remove
// ---------------------------------------------------------------------------

/**
 * Add a layer. A border always takes index 0 (replacing any existing border);
 * every other kind is appended to the TOP of the stack. Returns a new array.
 */
export function addLayer(layers: readonly Layer[], layer: Layer): Layer[] {
  if (layer.kind === "border") {
    const withoutBorder = layers.filter((l) => l.kind !== "border");
    return [layer, ...withoutBorder];
  }
  return [...layers, layer];
}

/** Remove a layer by id. Returns a new array (unchanged if id not found). */
export function removeLayer(layers: readonly Layer[], id: string): Layer[] {
  return layers.filter((l) => l.id !== id);
}

// ---------------------------------------------------------------------------
// Z-order operations (PowerPoint-style)
// ---------------------------------------------------------------------------
//
// Each returns a NEW array. A border (index 0) is never moved and free layers
// are never pushed below `freeFloorIndex`. Requesting a z-op on the border, or
// on an unknown id, is a no-op.

function moveWithinFreeBand(
  layers: readonly Layer[],
  id: string,
  destIndex: number,
): Layer[] {
  const from = indexOf(layers, id);
  if (from < 0) return [...layers];
  if (layers[from].kind === "border") return [...layers]; // border never moves
  const floor = freeFloorIndex(layers);
  const top = layers.length - 1;
  const to = Math.max(floor, Math.min(top, destIndex));
  if (to === from) return [...layers];
  const next = [...layers];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Move a layer to the very top of the stack (frontmost). */
export function bringToFront(layers: readonly Layer[], id: string): Layer[] {
  return moveWithinFreeBand(layers, id, layers.length - 1);
}

/** Move a layer to just above the border (backmost free position). */
export function sendToBack(layers: readonly Layer[], id: string): Layer[] {
  return moveWithinFreeBand(layers, id, freeFloorIndex(layers));
}

/** Move a layer one step towards the front. */
export function bringForward(layers: readonly Layer[], id: string): Layer[] {
  const from = indexOf(layers, id);
  if (from < 0) return [...layers];
  return moveWithinFreeBand(layers, id, from + 1);
}

/** Move a layer one step towards the back (never past the border). */
export function sendBackward(layers: readonly Layer[], id: string): Layer[] {
  const from = indexOf(layers, id);
  if (from < 0) return [...layers];
  return moveWithinFreeBand(layers, id, from - 1);
}

// ---------------------------------------------------------------------------
// Move & scale (layout only — cells are never touched)
// ---------------------------------------------------------------------------

/** Set a movable layer's absolute offset. Border/unknown id: no-op. */
export function setOffset(
  layers: readonly Layer[],
  id: string,
  offset: { x: number; y: number },
): Layer[] {
  return layers.map((l) =>
    l.id === id && isMovable(l) ? { ...l, offset: { ...offset } } : l,
  );
}

/** Translate a movable layer by (dx, dy). Border/unknown id: no-op. */
export function translate(
  layers: readonly Layer[],
  id: string,
  dx: number,
  dy: number,
): Layer[] {
  return layers.map((l) =>
    l.id === id && isMovable(l)
      ? { ...l, offset: { x: l.offset.x + dx, y: l.offset.y + dy } }
      : l,
  );
}

/**
 * Set a layer's integer upscale factor. The value is clamped to an integer
 * >= 1, so an attempt to shrink below native size is refused (coerced to 1x)
 * rather than silently destroying the artwork.
 */
export function setScale(
  layers: readonly Layer[],
  id: string,
  scale: number,
): Layer[] {
  return layers.map((l) =>
    l.id === id ? { ...l, scale: clampScale(scale) } : l,
  );
}

// ---------------------------------------------------------------------------
// Hit testing (for click-to-select / drag)
// ---------------------------------------------------------------------------

/**
 * The native cell value a layer shows at canvas point (x, y), accounting for
 * offset and integer scale, or `null` if the point is outside the layer's
 * scaled footprint. Mirrors the compositor's coordinate mapping exactly so
 * selection and render agree.
 */
export function cellAtPoint(layer: Layer, x: number, y: number): Cell | null {
  const localX = x - layer.offset.x;
  const localY = y - layer.offset.y;
  if (localX < 0 || localY < 0) return null;
  const col = Math.floor(localX / layer.scale);
  const row = Math.floor(localY / layer.scale);
  if (row >= layer.height || col >= layer.width) return null;
  return layer.cells[row][col];
}

/**
 * Topmost MOVABLE layer whose cell at (x, y) is not the transparency sentinel.
 * Used to decide which object a click selects. The border is skipped (it is not
 * draggable); the background is implicit and never selectable. Returns null if
 * the click lands on empty/transparent space.
 */
export function hitTest(
  doc: ChartDocument,
  x: number,
  y: number,
  sentinel: Cell,
): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    if (!isMovable(layer)) continue;
    const cell = cellAtPoint(layer, x, y);
    if (cell !== null && cell !== sentinel) return layer;
  }
  return null;
}
