import { useEffect, useMemo, useRef, useState } from "react";
import { SwatchPicker } from "@/components/SwatchPicker";
import type { ThreadColor } from "@/data/threadPalettes";
import { drawShapeOutline } from "@/lib/canvasShapeOutline";
import type { CanvasShape } from "@/lib/canvasShapes";
import { NOT_STITCHABLE } from "@/lib/canvas-shape-mask";
import { setStitched, progressStats, type ProgressGrid } from "@/lib/progress-tracking";
import { regionAt } from "@/lib/flood-fill";
import { resolveSymbols, cellRender, type RenderMode, type PaletteColourLike } from "@/lib/symbol-mode";
import { findConfetti, planConfettiCleanup, planSingleRegionCleanup, dominantSurroundingColour } from "@/lib/confetti-cleanup";
import { rulerTicks, geographicCenter, centerLines } from "@/lib/chart-guides";
import { brushCells, brushStroke, type BrushShape } from "@/lib/brush";
import { lineCells, rectCells, ellipseCells, triangleCells, type Point as ShapePoint } from "@/lib/shape-tools";
import { cellAtPoint, type Layer as LayerModelLayer } from "@/lib/layer-model";
import {
  Brush,
  Shapes as ShapesIcon,
  PaintBucket,
  Grid3x3,
  SquareDashed,
  Lasso as LassoIcon,
  Stamp,
  Sparkles,
  SquareCheckBig,
  Eye,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

export type ChartPaletteEntry = {
  id: string;
  name: string;
  family?: string;
  hex: string;
};

export type ChartSection = {
  name: string;
  paletteIndexes: number[];
};

export type ChartData = {
  width: number;
  height: number;
  palette: ChartPaletteEntry[];
  symMap: Record<string, string> | string[];
  usage: Record<string, number> | number[];
  sections: ChartSection[];
  pixelsRLE: Array<[number, number]>;
};

/** A positioned grid on the canvas, for hit-testing/dragging. Deliberately
 *  generic -- StitchChart still doesn't know what a "motif" IS (no library,
 *  no Supabase, no brand); it only knows this is a grid of thread codes at an
 *  offset, exactly the same decoupling Tile Fill already uses. */
export type PlacedMotifView = {
  id: string;
  name: string;
  cells: string[][];
  width: number;
  height: number;
  offset: { x: number; y: number };
  scale: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Bargello patterns — numeric step progressions (matches prototype exactly).
// ─────────────────────────────────────────────────────────────────────────────
export const BARGELLO_PATTERNS = [
  { id: "flame",      name: "Classic Flame", steps: [1,1,1,1,2,2,2,2,1,1,1,1,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1], bandHeight: 4 },
  { id: "peaks",      name: "Sharp Peaks",   steps: [2,2,2,2,2,-2,-2,-2,-2,-2], bandHeight: 3 },
  { id: "gentlewave", name: "Gentle Wave",   steps: [1,1,1,0,1,1,1,0,-1,-1,-1,0,-1,-1,-1,0], bandHeight: 5 },
  { id: "pinnacle",   name: "Pinnacle",      steps: [1,2,3,2,1,-1,-2,-3,-2,-1], bandHeight: 3 },
] as const;

function bargelloColumnOffsets(
  pattern: { steps: readonly number[] },
  width: number,
): number[] {
  const steps = pattern.steps;
  const n = steps.length;
  const offsets = new Array<number>(width);
  let cum = 0;
  for (let col = 0; col < width; col++) {
    offsets[col] = cum;
    cum += steps[col % n];
  }
  const min = Math.min(...offsets);
  for (let col = 0; col < width; col++) offsets[col] -= min;
  return offsets;
}

const SYMBOLS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*+=?<>/\\|~○●□■△▲▽▼◇◆☆★";

export type FillSpec =
  | { type: "solid"; colours: ThreadColor[] }
  | {
      type: "stripes";
      colours: ThreadColor[];
      stripeWidth: number;
      orientation: "horizontal" | "vertical";
    }
  | { type: "bargello"; colours: ThreadColor[]; patternId: string }
  | { type: "gingham"; colours: ThreadColor[]; blockSize: number };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function expandRLE(rle: Array<[number, number]>, total: number): Uint16Array {
  const out = new Uint16Array(total);
  let i = 0;
  for (const [idx, len] of rle) {
    for (let n = 0; n < len && i < total; n++) out[i++] = idx;
  }
  return out;
}

function symbolFor(symMap: ChartData["symMap"], idx: number, paletteId: string): string {
  if (Array.isArray(symMap)) return symMap[idx] ?? "";
  return symMap[paletteId] ?? symMap[String(idx)] ?? "";
}

function usageFor(usage: ChartData["usage"], idx: number, paletteId: string): number {
  if (Array.isArray(usage)) return usage[idx] ?? 0;
  return usage[paletteId] ?? usage[String(idx)] ?? 0;
}

function normalizeMap<T>(
  src: Record<string, T> | T[],
  length: number,
  fallback: T,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (let i = 0; i < length; i++) {
    if (Array.isArray(src)) out[String(i)] = src[i] ?? fallback;
    else out[String(i)] = src[String(i)] ?? fallback;
  }
  return out;
}

// Rebuild palette / usage / symbols / sections / RLE from a flat index array.
export function rebuildChart(
  width: number,
  height: number,
  oldPalette: ChartPaletteEntry[],
  pxIdx: Uint16Array,
): Pick<
  ChartData,
  "palette" | "usage" | "symMap" | "sections" | "pixelsRLE" | "width" | "height"
> {
  // first-seen order in pxIdx → new palette
  const seen = new Map<number, number>(); // oldIdx → newIdx
  const newPalette: ChartPaletteEntry[] = [];
  for (let i = 0; i < pxIdx.length; i++) {
    const oi = pxIdx[i];
    if (!seen.has(oi)) {
      seen.set(oi, newPalette.length);
      newPalette.push(oldPalette[oi]);
    }
  }
  const usage: Record<string, number> = {};
  for (let i = 0; i < pxIdx.length; i++) {
    const ni = seen.get(pxIdx[i])!;
    usage[String(ni)] = (usage[String(ni)] ?? 0) + 1;
  }
  const symMap: Record<string, string> = {};
  newPalette.forEach((_, i) => {
    symMap[String(i)] = SYMBOLS[i % SYMBOLS.length];
  });
  const sectionMap = new Map<string, number[]>();
  newPalette.forEach((p, i) => {
    const fam = p.family ?? "Other";
    const list = sectionMap.get(fam) ?? [];
    list.push(i);
    sectionMap.set(fam, list);
  });
  const sections = [...sectionMap.entries()].map(([name, paletteIndexes]) => ({
    name,
    paletteIndexes,
  }));
  const pixelsRLE: Array<[number, number]> = [];
  if (pxIdx.length > 0) {
    let runIdx = seen.get(pxIdx[0])!;
    let runLen = 1;
    for (let i = 1; i < pxIdx.length; i++) {
      const ni = seen.get(pxIdx[i])!;
      if (ni === runIdx) runLen++;
      else {
        pixelsRLE.push([runIdx, runLen]);
        runIdx = ni;
        runLen = 1;
      }
    }
    pixelsRLE.push([runIdx, runLen]);
  }
  return { width, height, palette: newPalette, usage, symMap, sections, pixelsRLE };
}

function threadToEntry(c: ThreadColor): ChartPaletteEntry {
  return { id: c.code, name: c.name, family: c.family, hex: c.hex };
}

// Build a blank chart of `width × height` stitches, all filled with a single
// thread colour. Produces the same ChartData shape the chart edge function
// returns, so all existing chart tools work on it unchanged.
export function buildBlankChart(
  width: number,
  height: number,
  fill: ThreadColor,
): ChartData {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const total = w * h;
  const pxIdx = new Uint16Array(total); // all zeros → palette[0]
  const entry = threadToEntry(fill);
  return rebuildChart(w, h, [entry], pxIdx) as ChartData;
}


// Swap one palette entry for another colour across the whole chart (with merge).
function replaceColor(
  chart: ChartData,
  oldIdx: number,
  newColor: ThreadColor,
): ChartData {
  const existingNewIdx = chart.palette.findIndex((p) => p.id === newColor.code);
  if (existingNewIdx === oldIdx) return chart;

  const usageObj = normalizeMap<number>(chart.usage, chart.palette.length, 0);
  const symObj = normalizeMap<string>(chart.symMap, chart.palette.length, "");

  let newPalette: ChartPaletteEntry[];
  let oldToNew: number[];

  if (existingNewIdx >= 0) {
    newPalette = chart.palette.filter((_, i) => i !== oldIdx);
    const survivorNewIdx =
      existingNewIdx > oldIdx ? existingNewIdx - 1 : existingNewIdx;
    oldToNew = chart.palette.map((_, i) => {
      if (i === oldIdx) return survivorNewIdx;
      return i < oldIdx ? i : i - 1;
    });
  } else {
    newPalette = chart.palette.map((p, i) =>
      i === oldIdx ? threadToEntry(newColor) : p,
    );
    oldToNew = chart.palette.map((_, i) => i);
  }

  const newUsage: Record<string, number> = {};
  const newSym: Record<string, string> = {};
  for (let i = 0; i < chart.palette.length; i++) {
    if (existingNewIdx >= 0 && i === oldIdx) continue;
    const ni = oldToNew[i];
    if (newSym[String(ni)] === undefined) newSym[String(ni)] = symObj[i] ?? "";
  }
  for (let i = 0; i < chart.palette.length; i++) {
    const ni = oldToNew[i];
    newUsage[String(ni)] = (newUsage[String(ni)] ?? 0) + (usageObj[i] ?? 0);
    if (newSym[String(ni)] === undefined) newSym[String(ni)] = symObj[i] ?? "";
  }

  const sectionMap = new Map<string, number[]>();
  newPalette.forEach((p, i) => {
    const fam = p.family ?? "Other";
    const list = sectionMap.get(fam) ?? [];
    list.push(i);
    sectionMap.set(fam, list);
  });
  const sections = [...sectionMap.entries()].map(([name, paletteIndexes]) => ({
    name,
    paletteIndexes,
  }));

  const newRLE: Array<[number, number]> = [];
  for (const [idx, len] of chart.pixelsRLE) {
    const ni = oldToNew[idx];
    const last = newRLE[newRLE.length - 1];
    if (last && last[0] === ni) last[1] += len;
    else newRLE.push([ni, len]);
  }

  return {
    ...chart,
    palette: newPalette,
    usage: newUsage,
    symMap: newSym,
    sections,
    pixelsRLE: newRLE,
  };
}

// Apply a background fill over a mask of stitch indexes. Mirrors prototype's
// applyBackgroundFill: works in flat-pixel space then rebuilds chart metadata.
function applyBackgroundFill(
  chart: ChartData,
  mask: Set<number>,
  fill: FillSpec,
): ChartData {
  const cols = (fill.colours || []).filter(Boolean);
  if (cols.length === 0 || mask.size === 0) return chart;

  const { width, height } = chart;
  const total = width * height;
  const pxIdx = expandRLE(chart.pixelsRLE, total);

  // Map ThreadColors to existing-or-appended palette indexes.
  const palette = chart.palette.slice();
  const colorIdx = (c: ThreadColor): number => {
    const existing = palette.findIndex((p) => p.id === c.code);
    if (existing >= 0) return existing;
    palette.push(threadToEntry(c));
    return palette.length - 1;
  };
  const colIdxs = cols.map(colorIdx);

  if (fill.type === "solid") {
    for (const idx of mask) pxIdx[idx] = colIdxs[0];
  } else if (fill.type === "stripes") {
    const w = Math.max(1, fill.stripeWidth || 4);
    for (const idx of mask) {
      const row = Math.floor(idx / width);
      const col = idx % width;
      const band =
        fill.orientation === "vertical" ? Math.floor(col / w) : Math.floor(row / w);
      pxIdx[idx] = colIdxs[band % colIdxs.length];
    }
  } else if (fill.type === "bargello") {
    const pattern =
      BARGELLO_PATTERNS.find((p) => p.id === fill.patternId) ?? BARGELLO_PATTERNS[0];
    const offsets = bargelloColumnOffsets(pattern, width);
    const bh = pattern.bandHeight;
    for (const idx of mask) {
      const row = Math.floor(idx / width);
      const col = idx % width;
      const band = Math.floor((row + offsets[col]) / bh);
      pxIdx[idx] = colIdxs[((band % colIdxs.length) + colIdxs.length) % colIdxs.length];
    }
  } else if (fill.type === "gingham") {
    // Classic woven check: two perpendicular bands of "main" alternating with
    // "base" every blockSize stitches. Base+base -> lightest (colIdxs[0]),
    // one band main -> the blend (colIdxs[1]), both bands main -> full main
    // (colIdxs[2]) -- the exact structure of Delaney's own charted gingham
    // motif (4-stitch blocks, Appletons 338/335/331 as base/blend/main).
    const bs = Math.max(1, fill.blockSize || 4);
    for (const idx of mask) {
      const row = Math.floor(idx / width);
      const col = idx % width;
      const hMain = Math.floor(col / bs) % 2 === 1;
      const vMain = Math.floor(row / bs) % 2 === 1;
      const toneIdx = hMain && vMain ? 2 : hMain || vMain ? 1 : 0;
      pxIdx[idx] = colIdxs[Math.min(toneIdx, colIdxs.length - 1)];
    }
  }

  return { ...chart, ...rebuildChart(width, height, palette, pxIdx) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
const BASE_CELL = 18;

/** Rail/panel ids: every editing Mode plus the display-only "view" panel. */
type PanelId = Exclude<Mode, "none"> | "view";

/** Rail grouping -- purely presentational; the tools themselves are unchanged. */
const TOOL_GROUPS: { caption: string; tools: { id: PanelId; label: string; Icon: LucideIcon }[] }[] = [
  {
    caption: "Paint",
    tools: [
      { id: "paint", label: "Paint", Icon: Brush },
      { id: "shapes", label: "Shapes", Icon: ShapesIcon },
      { id: "background", label: "Background", Icon: PaintBucket },
      { id: "tileFill", label: "Tile Fill", Icon: Grid3x3 },
    ],
  },
  {
    caption: "Arrange",
    tools: [
      { id: "select", label: "Select", Icon: SquareDashed },
      { id: "lasso", label: "Lasso", Icon: LassoIcon },
      { id: "motifs", label: "Motifs", Icon: Stamp },
    ],
  },
  {
    caption: "Review",
    tools: [
      { id: "cleanup", label: "Cleanup", Icon: Sparkles },
      { id: "progress", label: "Progress", Icon: SquareCheckBig },
    ],
  },
  { caption: "View", tools: [{ id: "view", label: "View", Icon: Eye }] },
];

type Mode = "none" | "background" | "paint" | "select" | "progress" | "tileFill" | "lasso" | "cleanup" | "shapes" | "motifs";
type SelRect = { r0: number; c0: number; r1: number; c1: number };
type Clipboard = { w: number; h: number; cells: (ChartPaletteEntry | null)[] };
type Floating = {
  row: number;
  col: number;
  w: number;
  h: number;
  srcW: number;
  srcH: number;
  // Nullable per-cell entries: null means "not part of the lifted/pasted
  // shape" (a lasso selection's gaps within its own bounding box). A plain
  // rectangle selection just never produces any nulls -- existing behaviour
  // is byte-for-byte unchanged. sampleFloating/stampFloating/the draw effect
  // ALL already treat a falsy entry as "skip this cell, leave whatever's
  // underneath", which is exactly right: a selection that partly overlapped
  // the shape boundary should only relocate its REAL stitchable content.
  cells: (ChartPaletteEntry | null)[];
  // If lifted from the chart (vs pasted from clipboard), the original area to
  // clear when applying. Origin cells are visually replaced by `bgEntry` while
  // the floating layer is in play, so a Move actually removes the source.
  // `mask`: relative indices (r*w+c) within the origin rect that were
  // actually part of the lifted selection. Undefined = clear the WHOLE
  // rect (today's rectangle-select behaviour, unchanged). Defined = only
  // clear those specific cells (lasso lift) -- a lasso move must not blank
  // out chart content that was never part of the selection just because it
  // sat inside the selection's bounding box.
  origin?: { row: number; col: number; w: number; h: number; mask?: Set<number> };
  bgEntry?: ChartPaletteEntry;
  lockAspect?: boolean;
};
type FloatHandle = "move" | "nw" | "ne" | "sw" | "se";

function normRect(s: SelRect): SelRect {
  return {
    r0: Math.min(s.r0, s.r1),
    c0: Math.min(s.c0, s.c1),
    r1: Math.max(s.r0, s.r1),
    c1: Math.max(s.c0, s.c1),
  };
}

// ── Lasso (freeform select) helpers ─────────────────────────────────────────
// Standard even-odd ray-casting point-in-polygon test. Same algorithm already
// used elsewhere in this project (the stocking canvas-shape safe-rect
// computation) -- proven correct there, reused here rather than a new one.
type LassoPoint = { x: number; y: number };

function pointInPolygon(x: number, y: number, poly: LassoPoint[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Rasterize a freehand-drawn path (points in fractional CELL-space
 * coordinates) into the set of grid cell indices whose centre falls inside
 * the closed polygon. Fewer than 3 points, or a polygon entirely off-grid,
 * safely returns an empty set rather than throwing.
 */
function rasterizeLassoSelection(
  points: LassoPoint[],
  gridW: number,
  gridH: number,
): Set<number> {
  const sel = new Set<number>();
  if (points.length < 3) return sel;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const c0 = Math.max(0, Math.floor(minX));
  const c1 = Math.min(gridW - 1, Math.ceil(maxX));
  const r0 = Math.max(0, Math.floor(minY));
  const r1 = Math.min(gridH - 1, Math.ceil(maxY));
  for (let r = r0; r <= r1; r++) {
    const cy = r + 0.5;
    for (let c = c0; c <= c1; c++) {
      const cx = c + 0.5;
      if (pointInPolygon(cx, cy, points)) sel.add(r * gridW + c);
    }
  }
  return sel;
}

// ── Pinch-zoom helper ────────────────────────────────────────────────────────
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}
function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function StitchChart({
  chart,
  palette,
  onChange,
  canvasShape,
  canvasWidthInches,
  canvasHeightInches,
  progress,
  onProgressChange,
  tileFillMotifName,
  onTileFillPickMotif,
  onTileFillApply,
  onSaveAsMotif,
  placedMotifs,
  motifSentinel,
  onMotifMove,
  onMotifRemove,
  onMotifReorder,
  onMotifFlatten,
  onMotifRotate,
  onMotifResize,
  onAddMotifFromLibrary,
  progressOnly,
}: {
  chart: ChartData;
  palette?: ThreadColor[];
  onChange?: (chart: ChartData) => void;
  /** Non-rectangular canvas outline/mask support. Omit, or pass "rectangle",
   *  for no outline -- both are safe no-ops (drawShapeOutline itself no-ops
   *  for rectangle, since shapeOutline() returns null for it). */
  canvasShape?: CanvasShape;
  canvasWidthInches?: number;
  canvasHeightInches?: number;
  /** Stitch-completion tracking (progress-tracking.ts). Controlled, like
   *  chart/onChange -- omit both to hide the Progress tool entirely. */
  progress?: ProgressGrid;
  onProgressChange?: (grid: ProgressGrid) => void;
  /** Progress-only presentation: the Progress tool is the ONLY rail entry and
   *  is selected on mount. Used by the Account page's Progress section, which
   *  marks stitches on a chosen SAVED design rather than the live chart.
   *  Progress is deliberately NOT a chart-toolbar tool any more. */
  progressOnly?: boolean;
  /** Tile Fill mode -- name of the motif currently chosen to fill with, or
   *  null/undefined if none chosen yet. Purely for display; StitchChart
   *  doesn't know what a motif IS, only whether one has been picked. */
  tileFillMotifName?: string | null;
  /** Called when the user wants to choose/change the fill motif. The parent
   *  owns motif-selection UI (the Motif Library dialog). */
  onTileFillPickMotif?: () => void;
  /** Called with the flood-selected region (flat y*width+x indices) when the
   *  user hits Apply. The parent performs the actual fill (it has the motif
   *  cell data StitchChart doesn't) and feeds the result back via the normal
   *  chart/onChange flow -- same as every other commit path. */
  onTileFillApply?: (region: number[], scale: number) => void;
  /** Called with the extracted cells when saving current selection as a personal motif. */
  onSaveAsMotif?: (cells: (ChartPaletteEntry | null)[], w: number, h: number) => void;
  /** Motifs placed as live layers, bottom-to-top. Omit to hide the Motifs tool. */
  placedMotifs?: PlacedMotifView[];
  /** The layer-transparency sentinel code, so hit-testing skips transparent cells. */
  motifSentinel?: string;
  onMotifMove?: (id: string, offset: { x: number; y: number }) => void;
  onMotifRemove?: (id: string) => void;
  onMotifReorder?: (id: string, direction: "forward" | "backward") => void;
  onMotifFlatten?: (id: string) => void;
  onMotifRotate?: (id: string) => void;
  onMotifResize?: (id: string, scale: number) => void;

  /** Called when the user wants to browse the library to add a new motif.
   *  The parent owns motif-selection UI (the Motif Library dialog). */
  onAddMotifFromLibrary?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixels = useMemo(
    () => expandRLE(chart.pixelsRLE, chart.width * chart.height),
    [chart],
  );

  // History
  const [past, setPast] = useState<ChartData[]>([]);
  const [future, setFuture] = useState<ChartData[]>([]);
  const lastEmittedRef = useRef<ChartData>(chart);
  useEffect(() => {
    if (chart !== lastEmittedRef.current) {
      // External chart change (e.g. fresh generation) — reset history.
      setPast([]);
      setFuture([]);
      setFloating(null);
      lastEmittedRef.current = chart;
    }
  }, [chart]);

  const commit = (next: ChartData, prevForHistory?: ChartData) => {
    const prev = prevForHistory ?? chart;
    setPast((p) => [...p.slice(-49), prev]);
    setFuture([]);
    lastEmittedRef.current = next;
    onChange?.(next);
  };
  const undo = () => {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [chart, ...f].slice(0, 50));
    lastEmittedRef.current = prev;
    onChange?.(prev);
  };
  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p.slice(-49), chart]);
    lastEmittedRef.current = next;
    onChange?.(next);
  };

  // Modes
  const [mode, setMode] = useState<Mode>(progressOnly ? "progress" : "none");
  // Display-only View panel (view mode + guides). Independent of `mode` so the
  // editing state machine is untouched.
  const [viewOpen, setViewOpen] = useState(false);
  // >=880px: vertical left rail. <880px: bottom bar + sheet panel.
  const [isWide, setIsWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 880px)");
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Background-mode selection (per-stitch set)
  const [selection, setSelection] = useState<Set<number>>(new Set());
  // Tile-fill mode: flood-selected region (flat indices), populated by a
  // single click via regionAt rather than background-mode's drag-multi-select.
  const [tileFillSelection, setTileFillSelection] = useState<Set<number>>(new Set());
  // Integer tile scale (1x/2x/3x) for the region-based Tile Fill tool below --
  // upscale only, matching the same "never shrink a charted motif" rule
  // tile-fill.ts's buildTileFillLayer now enforces.
  const [tileFillScale, setTileFillScale] = useState(1);
  // Lasso mode: the live freehand trace (fractional cell-space points, for
  // drawing the in-progress path) and the finalized rasterized selection
  // once the pointer lifts.
  const [lassoDragPoints, setLassoDragPoints] = useState<LassoPoint[]>([]);
  const [lassoSelection, setLassoSelection] = useState<Set<number>>(new Set());
  // Confetti cleanup mode
  const [confettiMaxSize, setConfettiMaxSize] = useState(3);
  const [confettiPreview, setConfettiPreview] = useState<{ paletteIdx: number; cells: number[] }[]>([]);
  // Step-through review: index into confettiPreview currently being shown,
  // or null when not reviewing. Indices explicitly marked "keep" (not
  // confetti) live in confettiSkipped so "Change all remaining" never
  // overrides that decision.
  const [confettiReviewIdx, setConfettiReviewIdx] = useState<number | null>(null);
  const [confettiSkipped, setConfettiSkipped] = useState<Set<number>>(new Set());
  const lassoDragRef = useRef<{ active: boolean; points: LassoPoint[] }>({
    active: false,
    points: [],
  });
  // Set right before liftLassoSelection() switches mode to "select" so the
  // floating layer it just created survives the mode-reset effect below
  // (which otherwise unconditionally clears `floating` on every mode
  // change -- correct for every OTHER transition, wrong for this one).
  const preserveFloatingOnModeChangeRef = useRef(false);

  // Select-mode rectangle
  const [selRect, setSelRect] = useState<SelRect | null>(null);
  // No-tool "peek select": read-only measuring rectangle. Never commits.
  const [peekRect, setPeekRect] = useState<SelRect | null>(null);
  const [peekCursor, setPeekCursor] = useState<{ x: number; y: number } | null>(null);
  const peekRef = useRef<{ active: boolean; r0: number; c0: number }>({ active: false, r0: 0, c0: 0 });
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [floating, setFloating] = useState<Floating | null>(null);
  const floatDragRef = useRef<
    | {
        kind: FloatHandle;
        startCellX: number;
        startCellY: number;
        orig: Floating;
      }
    | null
  >(null);

  // Paint colour (shared with select-mode "Fill")
  const [paintColor, setPaintColor] = useState<ThreadColor | null>(null);
  // Paint mode: "count only" toggle -- when on, dragging traces and counts
  // distinct stitches crossed WITHOUT painting them (a measuring tool). When
  // off (default), the live count still shows during a normal paint stroke,
  // it just also paints -- both share the same touched-cell tracking.
  const [paintCountOnly, setPaintCountOnly] = useState(false);
  const [paintStrokeCount, setPaintStrokeCount] = useState(0);
  // Variable brush (brush.ts)
  const [brushSize, setBrushSize] = useState(1);
  const [brushShape, setBrushShape] = useState<BrushShape>("square");
  const [paintHoverCell, setPaintHoverCell] = useState<{ x: number; y: number } | null>(null);
  // Shapes mode (shape-tools.ts) -- line/rectangle, drawn in the shared
  // paintColor (same colour Paint/Lasso/Select "Fill" already use, per
  // Delaney's own choice -- no separate colour picker for this tool).
  const [shapeKind, setShapeKind] = useState<"line" | "rect" | "circle" | "triangle">("line");
  const [rectFillMode, setRectFillMode] = useState<"outline" | "filled">("outline");
  const [shapeThickness, setShapeThickness] = useState(1);
  const [shapeStart, setShapeStart] = useState<{ x: number; y: number } | null>(null);
  const [shapeEnd, setShapeEnd] = useState<{ x: number; y: number } | null>(null);
  const shapeDragRef = useRef<{ active: boolean }>({ active: false });

  // Motifs mode -- select/drag a placed motif that still has its identity.
  // The commit-on-pointer-up pattern (see onPointerUp) intentionally mirrors
  // Select mode's floating layer: live moves stay LOCAL so we don't fire a
  // full recomposeChart per mousemove on large charts.
  const [selectedMotifId, setSelectedMotifId] = useState<string | null>(null);
  const [motifDrag, setMotifDrag] = useState<{
    id: string;
    startCellX: number;
    startCellY: number;
    origOffset: { x: number; y: number };
    offset: { x: number; y: number };
  } | null>(null);

  // Background fill settings
  const [fillType, setFillType] = useState<"solid" | "stripes" | "bargello" | "gingham">("solid");
  const [solidColor, setSolidColor] = useState<ThreadColor | null>(null);
  const [stripeColors, setStripeColors] = useState<(ThreadColor | null)[]>([null, null]);
  const [stripeWidth, setStripeWidth] = useState(4);
  const [stripeOrientation, setStripeOrientation] = useState<"horizontal" | "vertical">(
    "horizontal",
  );
  const [bargelloColors, setBargelloColors] = useState<(ThreadColor | null)[]>([
    null,
    null,
    null,
  ]);
  const [bargelloPatternId, setBargelloPatternId] = useState<string>(
    BARGELLO_PATTERNS[0].id,
  );
  // Gingham background fill -- 3 thread shades matching Delaney's own charted
  // check: [base (light), blend (mid), main (dark)].
  const [ginghamColors, setGinghamColors] = useState<(ThreadColor | null)[]>([null, null, null]);
  const [ginghamBlockSize, setGinghamBlockSize] = useState(4);

  const [zoom, setZoom] = useState(1);
  const cellSize = BASE_CELL * zoom;
  // Colour/Symbol/Both view mode + rulers/centre guides toggle
  const [viewMode, setViewMode] = useState<RenderMode>("both");
  const [showGuides, setShowGuides] = useState(false);


  // Live overlay state used during a paint stroke (so one undo reverses the
  // whole stroke). When set, the canvas draws from these arrays instead of
  // the committed chart prop.
  const [live, setLive] = useState<{
    pixels: Uint16Array;
    palette: ChartPaletteEntry[];
  } | null>(null);

  // Pointer drag refs
  const bgDragRef = useRef<{ add: boolean; active: boolean }>({
    add: true,
    active: false,
  });
  const paintRef = useRef<{
    active: boolean;
    lastIdx: number | null;
    startChart: ChartData | null;
    touched: Set<number>;
  }>({ active: false, lastIdx: null, startChart: null, touched: new Set() });
  const selectRef = useRef<{ active: boolean; r0: number; c0: number }>({
    active: false,
    r0: 0,
    c0: 0,
  });
  const progressDragRef = useRef<{ add: boolean; active: boolean }>({
    add: true,
    active: false,
  });
  // Two-finger pinch-to-zoom. Tracks every currently-down pointer by id;
  // when a second finger lands, we snapshot the distance between the two
  // and the zoom level at that moment, then scale zoom by the change in
  // distance on subsequent moves. Any other in-progress single-pointer
  // gesture (paint stroke, selection drag, floating-layer drag, lasso
  // trace) is reset the instant a second pointer arrives, so the second
  // finger can never be misread as continuing that gesture.
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ initialDist: number; initialZoom: number } | null>(null);

  // Reset transient state when mode changes
  useEffect(() => {
    setSelection(new Set());
    setTileFillSelection(new Set());
    setSelRect(null);
    setLive(null);
    if (preserveFloatingOnModeChangeRef.current) {
      preserveFloatingOnModeChangeRef.current = false;
    } else {
      setFloating(null);
    }
    setLassoSelection(new Set());
    setLassoDragPoints([]);
    lassoDragRef.current = { active: false, points: [] };
    setPaintStrokeCount(0);
    paintRef.current.touched = new Set();
    setConfettiPreview([]);
    setConfettiReviewIdx(null);
    setConfettiSkipped(new Set());
    setPaintHoverCell(null);
    setShapeStart(null);
    setShapeEnd(null);
    shapeDragRef.current.active = false;
    setSelectedMotifId(null);
    setMotifDrag(null);
    setPeekRect(null);
    setPeekCursor(null);
    peekRef.current = { active: false, r0: 0, c0: 0 };
  }, [mode]);

  // ── Floating layer helpers ────────────────────────────────────────────────
  const sampleFloating = (f: Floating, fr: number, fc: number) => {
    const sr = Math.min(f.srcH - 1, Math.max(0, Math.floor((fr * f.srcH) / Math.max(1, f.h))));
    const sc = Math.min(f.srcW - 1, Math.max(0, Math.floor((fc * f.srcW) / Math.max(1, f.w))));
    const entry = f.cells[sr * f.srcW + sc];
    // Never move/paste the "outside the finished shape" sentinel -- both call
    // sites (live preview render, and stampFloating) already treat a null
    // return as "skip this cell, leave whatever's underneath", which is
    // exactly right: a selection that partly overlapped the shape boundary
    // should only relocate its REAL stitchable content.
    if (entry?.id === NOT_STITCHABLE) return null;
    return entry;
  };
  // Returns 4 handle bboxes (NW, NE, SW, SE) in canvas pixels.
  const floatingHandles = (f: Floating) => {
    const hs = Math.max(22, cellSize * 1.2); // big enough for touch
    const x0 = f.col * cellSize;
    const y0 = f.row * cellSize;
    const x1 = (f.col + f.w) * cellSize;
    const y1 = (f.row + f.h) * cellSize;
    return {
      nw: { x0: x0 - hs / 2, y0: y0 - hs / 2, x1: x0 + hs / 2, y1: y0 + hs / 2 },
      ne: { x0: x1 - hs / 2, y0: y0 - hs / 2, x1: x1 + hs / 2, y1: y0 + hs / 2 },
      sw: { x0: x0 - hs / 2, y0: y1 - hs / 2, x1: x0 + hs / 2, y1: y1 + hs / 2 },
      se: { x0: x1 - hs / 2, y0: y1 - hs / 2, x1: x1 + hs / 2, y1: y1 + hs / 2 },
    };
  };
  const hitFloatingHandle = (
    f: Floating,
    px: number,
    py: number,
  ): FloatHandle | null => {
    const hs = floatingHandles(f);
    for (const k of ["nw", "ne", "sw", "se"] as const) {
      const b = hs[k];
      if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) return k;
    }
    return null;
  };
  const isInsideFloating = (f: Floating, x: number, y: number) =>
    x >= f.col && x < f.col + f.w && y >= f.row && y < f.row + f.h;

  // Most common colour found in the 1-cell ring just outside `rect`.
  // Used to compute a fill colour for the source area when a Move happens.
  const dominantNeighbourColor = (rect: {
    r0: number;
    c0: number;
    r1: number;
    c1: number;
  }): ChartPaletteEntry => {
    const counts = new Map<number, number>();
    const w = chart.width;
    const h = chart.height;
    const inside = (r: number, c: number) =>
      r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
    for (let r = rect.r0 - 1; r <= rect.r1 + 1; r++) {
      for (let c = rect.c0 - 1; c <= rect.c1 + 1; c++) {
        if (r < 0 || c < 0 || r >= h || c >= w) continue;
        if (inside(r, c)) continue;
        const onEdge =
          r === rect.r0 - 1 ||
          r === rect.r1 + 1 ||
          c === rect.c0 - 1 ||
          c === rect.c1 + 1;
        if (!onEdge) continue;
        const idx = pixels[r * w + c];
        if (chart.palette[idx]?.id === NOT_STITCHABLE) continue; // never pick the mask sentinel as a fill colour
        counts.set(idx, (counts.get(idx) ?? 0) + 1);
      }
    }
    let bestIdx = 0;
    let best = -1;
    for (const [k, v] of counts) {
      if (v > best) {
        best = v;
        bestIdx = k;
      }
    }
    return chart.palette[bestIdx] ?? chart.palette[0];
  };

  // Drawing
  const drawPixels = live?.pixels ?? pixels;
  const drawPalette = live?.palette ?? chart.palette;

  // Thread-code grid, used both for progress stats (excluding NOT_STITCHABLE
  // cells from the total) and for the progress-mode NOT_STITCHABLE guard.
  const codeGrid = useMemo(() => {
    const g: string[][] = [];
    for (let y = 0; y < chart.height; y++) {
      const row: string[] = [];
      for (let x = 0; x < chart.width; x++) {
        row.push(drawPalette[drawPixels[y * chart.width + x]]?.id ?? "");
      }
      g.push(row);
    }
    return g;
  }, [chart.width, chart.height, drawPixels, drawPalette]);

  const progressStatsValue = useMemo(
    () => (progress ? progressStats(progress, codeGrid) : null),
    [progress, codeGrid],
  );

  // Palette index treated as "outside the finished shape" -- render blank in
  // every view mode.
  // Colours already on the canvas, most-used first -- Paint's quick-pick row.
  const usedColours = useMemo(() => {
    if (!palette) return [];
    const counts = new Map<string, number>();
    chart.palette.forEach((p, i) => {
      if (p.id === NOT_STITCHABLE) return;
      counts.set(p.id, usageFor(chart.usage, i, p.id));
    });
    return palette
      .filter((c) => counts.has(c.code))
      .sort((a, b) => (counts.get(b.code) ?? 0) - (counts.get(a.code) ?? 0));
  }, [chart.palette, chart.usage, palette]);

  const notStitchableIdx = useMemo(
    () => drawPalette.findIndex((p) => p.id === NOT_STITCHABLE),
    [drawPalette],
  );

  // Single source of truth for symbols, shared by the canvas render AND the
  // Colour Key -- reuses symbol-mode.ts's resolveSymbols so canvas glyphs
  // and legend glyphs are provably identical per colour.
  const paletteLike: PaletteColourLike[] = useMemo(
    () => drawPalette.map((e) => ({ code: e.id, name: e.name, hex: e.hex })),
    [drawPalette],
  );
  const existingSymArray: string[] = useMemo(
    () => drawPalette.map((e, i) => symbolFor(chart.symMap, i, e.id)),
    [drawPalette, chart.symMap],
  );
  const resolvedSymbols = useMemo(
    () =>
      resolveSymbols(paletteLike, existingSymArray, {
        sentinelIndex: notStitchableIdx >= 0 ? notStitchableIdx : undefined,
      }),
    [paletteLike, existingSymArray, notStitchableIdx],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = chart.width * cellSize;
    const h = chart.height * cellSize;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.font = `${Math.floor(cellSize * 0.6)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Pre-identify near-white non-background palette entries. These threads
    // (e.g. Off White 991, White 992) have a hex nearly identical to the
    // blank canvas, so they look like holes in the chart even though the
    // stitcher should stitch there. Render them as light grey (#DCDCDC) so
    // salt rim beads, lime pith lines, and pale highlights are all visible.
    const _palLums = drawPalette.map((e) => {
      const h = e.hex.replace("#", "");
      return (
        (0.299 * parseInt(h.slice(0, 2), 16) +
          0.587 * parseInt(h.slice(2, 4), 16) +
          0.114 * parseInt(h.slice(4, 6), 16)) /
        255
      );
    });
    const _maxLum = Math.max(..._palLums);
    // Any palette entry with luminance > 0.90 that is NOT the brightest
    // (background) entry is a near-white design thread — show it visibly.
    const _nearWhiteDesign = new Set(
      _palLums.flatMap((lum, i) =>
        lum > 0.90 && lum < _maxLum - 0.005 ? [i] : [],
      ),
    );
    for (let y = 0; y < chart.height; y++) {
      for (let x = 0; x < chart.width; x++) {
        const idx = drawPixels[y * chart.width + x];
        const entry = drawPalette[idx];
        if (!entry) continue;
        const rendered = cellRender(viewMode, idx, paletteLike, resolvedSymbols.byIndex, {
          sentinelIndex: notStitchableIdx >= 0 ? notStitchableIdx : undefined,
        });
        if (rendered.blank) continue;
        if (rendered.fill !== null) {
          ctx.fillStyle = _nearWhiteDesign.has(idx) ? "#DCDCDC" : rendered.fill;
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
        if (rendered.drawSymbol && rendered.symbol) {
          if (rendered.fill !== null) {
            const hex = rendered.fill.replace("#", "");
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            ctx.fillStyle = luminance > 0.55 ? "#1a1a1a" : "#ffffff";
          } else {
            ctx.fillStyle = rendered.symbolInk;
          }
          ctx.fillText(rendered.symbol, x * cellSize + cellSize / 2, y * cellSize + cellSize / 2 + 1);
        }
      }
    }

    // Progress overlay -- shown whenever a progress grid exists, regardless
    // of the current tool, so completed stitches stay visible while painting
    // or selecting. NOT_STITCHABLE cells never show as done -- there is
    // nothing to stitch there.
    if (progress) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let y = 0; y < chart.height; y++) {
        for (let x = 0; x < chart.width; x++) {
          if (!progress[y]?.[x]) continue;
          if (codeGrid[y]?.[x] === NOT_STITCHABLE) continue;
          const cx0 = x * cellSize;
          const cy0 = y * cellSize;
          // Solid red square -- deliberately opaque, not tinted, so it reads
          // unambiguously as "done" at any zoom level rather than blending
          // with the thread colour underneath.
          ctx.fillStyle = "#DC2626";
          ctx.fillRect(cx0, cy0, cellSize, cellSize);
          // Checkmark drawn as a stroked path (not a text glyph) so the
          // thickness is guaranteed and consistent across fonts/zoom, rather
          // than depending on how "bold" a unicode ✓ happens to render.
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = Math.max(2, cellSize * 0.18);
          ctx.beginPath();
          ctx.moveTo(cx0 + cellSize * 0.22, cy0 + cellSize * 0.52);
          ctx.lineTo(cx0 + cellSize * 0.42, cy0 + cellSize * 0.72);
          ctx.lineTo(cx0 + cellSize * 0.80, cy0 + cellSize * 0.28);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // grid
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= chart.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize + 0.5, 0);
      ctx.lineTo(x * cellSize + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= chart.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize + 0.5);
      ctx.lineTo(w, y * cellSize + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= chart.width; x += 10) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize + 0.5, 0);
      ctx.lineTo(x * cellSize + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= chart.height; y += 10) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize + 0.5);
      ctx.lineTo(w, y * cellSize + 0.5);
      ctx.stroke();
    }

    // Non-rectangular canvas outline (display only -- not charted into cells).
    if (canvasShape && canvasShape !== "rectangle" && canvasWidthInches && canvasHeightInches) {
      drawShapeOutline(ctx, canvasShape, 0, 0, w, h, canvasWidthInches, canvasHeightInches);
    }

    // background-mode per-stitch selection
    if (mode === "background" && selection.size > 0) {
      ctx.fillStyle = "rgba(255, 215, 0, 0.45)";
      for (const idx of selection) {
        const x = idx % chart.width;
        const y = Math.floor(idx / chart.width);
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }

    // tile-fill-mode flood-selected region
    if (mode === "tileFill" && tileFillSelection.size > 0) {
      ctx.fillStyle = "rgba(139, 92, 246, 0.35)"; // violet -- distinct from background mode's gold
      for (const idx of tileFillSelection) {
        const x = idx % chart.width;
        const y = Math.floor(idx / chart.width);
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }

    // lasso-mode finalized selection
    if (mode === "lasso" && lassoSelection.size > 0) {
      ctx.fillStyle = "rgba(6, 182, 212, 0.35)"; // cyan -- distinct from every other mode's highlight colour
      for (const idx of lassoSelection) {
        const x = idx % chart.width;
        const y = Math.floor(idx / chart.width);
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }

    // lasso-mode live freehand trace (while actively dragging)
    if (mode === "lasso" && lassoDragPoints.length > 1) {
      ctx.strokeStyle = "rgba(6, 182, 212, 0.9)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(lassoDragPoints[0].x * cellSize, lassoDragPoints[0].y * cellSize);
      for (let i = 1; i < lassoDragPoints.length; i++) {
        ctx.lineTo(lassoDragPoints[i].x * cellSize, lassoDragPoints[i].y * cellSize);
      }
      // Also show the implied closing edge back to the start point, since
      // that's the edge rasterizeLassoSelection actually uses to close the
      // polygon -- what you see while dragging should match what you get.
      ctx.lineTo(lassoDragPoints[0].x * cellSize, lassoDragPoints[0].y * cellSize);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // paint-mode brush footprint preview
    if (mode === "paint" && paintHoverCell) {
      const footprint = brushCells(paintHoverCell.x, paintHoverCell.y, brushSize, chart.width, chart.height, brushShape);
      ctx.save();
      ctx.strokeStyle = "rgba(59, 130, 246, 0.9)";
      ctx.lineWidth = 1.5;
      for (const c of footprint) {
        ctx.strokeRect(c.x * cellSize + 1, c.y * cellSize + 1, cellSize - 2, cellSize - 2);
      }
      ctx.restore();
    }

    // cleanup-mode confetti preview -- current spot bold red, pending spots
    // faint orange, kept spots muted grey.
    if (mode === "cleanup" && confettiPreview.length > 0) {
      ctx.save();
      confettiPreview.forEach((region, i) => {
        const isCurrent = i === confettiReviewIdx;
        const isKept = confettiSkipped.has(i);
        ctx.fillStyle = isCurrent
          ? "rgba(220, 38, 38, 0.45)"
          : isKept
            ? "rgba(107, 114, 128, 0.18)"
            : "rgba(234, 88, 12, 0.20)";
        ctx.strokeStyle = isCurrent
          ? "rgba(220, 38, 38, 0.95)"
          : isKept
            ? "rgba(107, 114, 128, 0.55)"
            : "rgba(234, 88, 12, 0.5)";
        ctx.lineWidth = isCurrent ? 2.5 : 1;
        for (const idxCell of region.cells) {
          const x = idxCell % chart.width;
          const y = Math.floor(idxCell / chart.width);
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
          ctx.strokeRect(x * cellSize + 1, y * cellSize + 1, cellSize - 2, cellSize - 2);
        }
      });
      ctx.restore();
    }

    // shapes-mode live preview -- drawn in the actual selected paint colour
    // (not a placeholder highlight) so what's previewed while dragging
    // matches exactly what commits on release.
    if (mode === "shapes" && shapeStart && shapeEnd && paintColor) {
      const notStitchableIdxPreview = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
      const dims = { width: chart.width, height: chart.height };
      const effectiveThicknessPreview =
        (shapeKind === "rect" || shapeKind === "circle" || shapeKind === "triangle") && rectFillMode === "filled"
          ? 1
          : shapeThickness;
      const previewOpts = {
        thickness: effectiveThicknessPreview,
        cells: pixels,
        sentinel: notStitchableIdxPreview >= 0 ? notStitchableIdxPreview : undefined,
      };
      const previewResult =
        shapeKind === "line" ? lineCells(shapeStart, shapeEnd, dims, previewOpts)
        : shapeKind === "circle" ? ellipseCells(shapeStart, shapeEnd, dims, rectFillMode, previewOpts)
        : shapeKind === "triangle" ? triangleCells(shapeStart, shapeEnd, dims, rectFillMode, previewOpts)
        : rectCells(shapeStart, shapeEnd, dims, rectFillMode, previewOpts);
      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = paintColor.hex;
      for (const i of previewResult.cells) {
        const x = i % chart.width;
        const y = Math.floor(i / chart.width);
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
      ctx.restore();
    }

    // motifs-mode: outlines for placed motifs + live drag ghost. Violet
    // stroked outline distinguishes selection from every other mode
    // (Tile Fill uses violet FILL; this is a stroke in a different mode).
    if (mode === "motifs" && placedMotifs && placedMotifs.length > 0) {
      const hexById = new Map<string, string>();
      for (const p of chart.palette) hexById.set(p.id, p.hex);
      ctx.save();
      for (const pm of placedMotifs) {
        const isDragging = motifDrag?.id === pm.id;
        const isSelected = selectedMotifId === pm.id;
        if (!isSelected && !isDragging) continue;
        const drawOffset = isDragging ? motifDrag!.offset : pm.offset;
        // Drag ghost: draw actual motif cells at previewed offset.
        if (isDragging) {
          ctx.globalAlpha = 0.7;
          for (let r = 0; r < pm.height; r++) {
            for (let c = 0; c < pm.width; c++) {
              const code = pm.cells[r]?.[c];
              if (!code || code === motifSentinel) continue;
              const hex = hexById.get(code);
              if (!hex) continue;
              for (let dy = 0; dy < pm.scale; dy++) {
                const y = drawOffset.y + r * pm.scale + dy;
                if (y < 0 || y >= chart.height) continue;
                for (let dx = 0; dx < pm.scale; dx++) {
                  const x = drawOffset.x + c * pm.scale + dx;
                  if (x < 0 || x >= chart.width) continue;
                  ctx.fillStyle = hex;
                  ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
                }
              }
            }
          }
          ctx.globalAlpha = 1;
        }
        // Selection / drag outline.
        const rx = drawOffset.x * cellSize;
        const ry = drawOffset.y * cellSize;
        const rw = pm.width * pm.scale * cellSize;
        const rh = pm.height * pm.scale * cellSize;
        ctx.strokeStyle = "rgba(139, 92, 246, 0.95)";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }


    // no-tool peek-select measuring rectangle -- warm amber, distinct from
    // Select (blue), Background (gold), Lasso (cyan) and Tile Fill (violet).
    if (mode === "none" && peekRect) {
      const s = normRect(peekRect);
      const rx = s.c0 * cellSize;
      const ry = s.r0 * cellSize;
      const rw = (s.c1 - s.c0 + 1) * cellSize;
      const rh = (s.r1 - s.r0 + 1) * cellSize;
      ctx.fillStyle = "rgba(217, 119, 6, 0.16)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(217, 119, 6, 0.9)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
      ctx.setLineDash([]);
      // Stitch count excluding NOT_STITCHABLE cells (curved canvases).
      let stitchable = 0;
      for (let y = s.r0; y <= s.r1; y++) {
        if (y < 0 || y >= chart.height) continue;
        for (let x = s.c0; x <= s.c1; x++) {
          if (x < 0 || x >= chart.width) continue;
          if (drawPixels[y * chart.width + x] === notStitchableIdx) continue;
          stitchable++;
        }
      }
      const label = `${s.c1 - s.c0 + 1}×${s.r1 - s.r0 + 1} · ${stitchable} st`;
      ctx.font = `${Math.max(11, Math.floor(cellSize * 0.7))}px ui-sans-serif, system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + 10;
      const th = Math.max(16, Math.floor(cellSize * 0.9));
      const lx = peekCursor
        ? Math.max(2, Math.min(w - tw - 2, peekCursor.x + 12))
        : Math.max(2, rx);
      const ly = peekCursor
        ? Math.max(2, Math.min(h - th - 2, peekCursor.y - th - 8))
        : Math.max(2, ry - th - 4);
      ctx.fillStyle = "rgba(180, 83, 9, 0.95)";
      ctx.fillRect(lx, ly, tw, th);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + tw / 2, ly + th / 2);
    }

    // select-mode rectangle
    if (mode === "select" && selRect) {
      const s = normRect(selRect);
      const rx = s.c0 * cellSize;
      const ry = s.r0 * cellSize;
      const rw = (s.c1 - s.c0 + 1) * cellSize;
      const rh = (s.r1 - s.r0 + 1) * cellSize;
      ctx.fillStyle = "rgba(56, 132, 255, 0.18)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(20, 80, 200, 0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
      ctx.setLineDash([]);
    }

    // floating paste layer (movable + resizable)
    if (mode === "select" && floating) {
      // First, repaint the source/origin rect with the background colour so
      // the user sees the move clearing the original location live.
      if (floating.origin && floating.bgEntry) {
        const o = floating.origin;
        ctx.fillStyle = floating.bgEntry.hex;
        if (o.mask) {
          // Lasso lift: only clear cells actually part of the selection,
          // not the whole bounding rectangle.
          for (const relIdx of o.mask) {
            const rr = Math.floor(relIdx / o.w);
            const rc = relIdx % o.w;
            ctx.fillRect(
              (o.col + rc) * cellSize,
              (o.row + rr) * cellSize,
              cellSize,
              cellSize,
            );
          }
        } else {
          ctx.fillRect(
            o.col * cellSize,
            o.row * cellSize,
            o.w * cellSize,
            o.h * cellSize,
          );
        }
      }
      for (let r = 0; r < floating.h; r++) {
        for (let c = 0; c < floating.w; c++) {
          const R = floating.row + r;
          const C = floating.col + c;
          if (R < 0 || R >= chart.height || C < 0 || C >= chart.width) continue;
          const entry = sampleFloating(floating, r, c);
          if (!entry) continue;
          ctx.fillStyle = entry.hex;
          ctx.fillRect(C * cellSize, R * cellSize, cellSize, cellSize);
        }
      }
      const fx = floating.col * cellSize;
      const fy = floating.row * cellSize;
      const fw = floating.w * cellSize;
      const fh = floating.h * cellSize;
      ctx.strokeStyle = "rgba(20, 160, 80, 0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(fx + 1, fy + 1, fw - 2, fh - 2);
      ctx.setLineDash([]);
      // Live size badge
      const label = `${floating.w}×${floating.h}`;
      ctx.font = `${Math.max(11, Math.floor(cellSize * 0.7))}px ui-sans-serif, system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + 10;
      const th = Math.max(16, Math.floor(cellSize * 0.9));
      const lx = Math.max(2, fx + fw / 2 - tw / 2);
      const ly = Math.max(2, fy - th - 4);
      ctx.fillStyle = "rgba(20, 160, 80, 0.95)";
      ctx.fillRect(lx, ly, tw, th);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + tw / 2, ly + th / 2);
      // 4 corner handles (touch-friendly)
      const handles = floatingHandles(floating);
      for (const k of ["nw", "ne", "sw", "se"] as const) {
        const b = handles[k];
        ctx.fillStyle = "rgba(20, 160, 80, 1)";
        ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0 - 1, b.y1 - b.y0 - 1);
      }
    }

    // Rulers (chart-guides.ts) -- overlay on the top/left edge of the grid.
    if (showGuides) {
      ctx.save();
      const tickBand = Math.max(10, Math.min(16, cellSize * 0.55));
      ctx.font = `${Math.max(8, Math.floor(cellSize * 0.32))}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(0, 0, w, tickBand);
      for (const tick of rulerTicks(chart.width)) {
        const x = tick.index * cellSize + cellSize / 2;
        ctx.strokeStyle = "rgba(17,17,17,0.7)";
        ctx.lineWidth = tick.major ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, tick.major ? tickBand : tickBand * 0.5);
        ctx.stroke();
        if (tick.label) {
          ctx.fillStyle = "rgba(17,17,17,0.85)";
          ctx.textAlign = "center";
          ctx.fillText(tick.label, x, 1);
        }
      }
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(0, 0, tickBand, h);
      for (const tick of rulerTicks(chart.height)) {
        const y = tick.index * cellSize + cellSize / 2;
        ctx.strokeStyle = "rgba(17,17,17,0.7)";
        ctx.lineWidth = tick.major ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(tick.major ? tickBand : tickBand * 0.5, y);
        ctx.stroke();
        if (tick.label) {
          ctx.fillStyle = "rgba(17,17,17,0.85)";
          ctx.textAlign = "left";
          ctx.save();
          ctx.translate(1, y);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(tick.label, 0, 0);
          ctx.restore();
        }
      }
      ctx.restore();

      // Geographic centre mark
      const centre = geographicCenter(chart.width, chart.height);
      const ccx = centre.exactX * cellSize;
      const ccy = centre.exactY * cellSize;
      ctx.save();
      ctx.strokeStyle = "rgba(17,17,17,0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ccx, ccy, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ccx - 11, ccy);
      ctx.lineTo(ccx - 4, ccy);
      ctx.moveTo(ccx + 4, ccy);
      ctx.lineTo(ccx + 11, ccy);
      ctx.moveTo(ccx, ccy - 11);
      ctx.lineTo(ccx, ccy - 4);
      ctx.moveTo(ccx, ccy + 4);
      ctx.lineTo(ccx, ccy + 11);
      ctx.stroke();
      ctx.restore();
    }

    // Centre guide lines — visible while positioning a floating item OR when
    // the Guides toggle is on.
    if (floating || showGuides) {
      const guideLines = centerLines(chart.width, chart.height);
      const cx = guideLines.vertical * cellSize;
      const cy = guideLines.horizontal * cellSize;
      ctx.strokeStyle = "rgba(245, 158, 11, 0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, 0);
      ctx.lineTo(cx + 0.5, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, cy + 0.5);
      ctx.lineTo(w, cy + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      if (floating) {
        const floatCX = (floating.col + floating.w / 2) * cellSize;
        const floatCY = (floating.row + floating.h / 2) * cellSize;
        const threshold = cellSize * 0.5;
        const snapH = Math.abs(floatCX - cx) < threshold;
        const snapV = Math.abs(floatCY - cy) < threshold;

        if (snapH || snapV) {
          const sx = snapH ? cx : floatCX;
          const sy = snapV ? cy : floatCY;
          ctx.fillStyle = "rgba(245, 158, 11, 0.35)";
          ctx.beginPath();
          ctx.arc(sx, sy, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
          ctx.beginPath();
          ctx.arc(sx, sy, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(sx - 8, sy);
          ctx.lineTo(sx + 8, sy);
          ctx.moveTo(sx, sy - 8);
          ctx.lineTo(sx, sy + 8);
          ctx.stroke();
        }
      }
    }
  }, [chart, drawPixels, drawPalette, selection, selRect, mode, cellSize, floating, canvasShape, canvasWidthInches, canvasHeightInches, progress, codeGrid, tileFillSelection, lassoSelection, lassoDragPoints, viewMode, paletteLike, resolvedSymbols, notStitchableIdx, confettiPreview, showGuides, paintHoverCell, brushSize, brushShape, shapeStart, shapeEnd, shapeKind, rectFillMode, shapeThickness, paintColor, placedMotifs, selectedMotifId, motifDrag, motifSentinel, confettiReviewIdx, confettiSkipped]);

  const canEdit = !!palette && !!onChange && palette.length > 0;

  const cellFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / cellSize);
    const y = Math.floor((e.clientY - rect.top) / cellSize);
    if (x < 0 || y < 0 || x >= chart.width || y >= chart.height) return null;
    return { x, y, idx: y * chart.width + x };
  };

  // ── Paint helpers ──────────────────────────────────────────────────────────
  const paintIdxInLive = (
    base: { pixels: Uint16Array; palette: ChartPaletteEntry[] },
    idx: number,
    color: ThreadColor,
  ) => {
    let cIdx = base.palette.findIndex((p) => p.id === color.code);
    let nextPal = base.palette;
    if (cIdx < 0) {
      nextPal = base.palette.slice();
      nextPal.push(threadToEntry(color));
      cIdx = nextPal.length - 1;
    }
    if (base.pixels[idx] === cIdx && nextPal === base.palette) return base;
    const nextPx = new Uint16Array(base.pixels);
    nextPx[idx] = cIdx;
    return { pixels: nextPx, palette: nextPal };
  };

  const traceLineCells = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    gridW: number,
  ): number[] => {
    const out: number[] = [];
    let x = x0, y = y0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      out.push(y * gridW + x);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return out;
  };

  // Topmost placed motif with a non-transparent cell at (x, y). Iterates the
  // array back-to-front because later entries render on top (same order
  // buildOverlayLayers pushes them in). Uses cellAtPoint from layer-model so
  // hit-testing and rendering are provably driven by the same math.
  const motifAtCell = (x: number, y: number): PlacedMotifView | null => {
    if (!placedMotifs) return null;
    for (let i = placedMotifs.length - 1; i >= 0; i--) {
      const pm = placedMotifs[i];
      const asLayer = { ...pm, kind: "motif" } as unknown as LayerModelLayer;
      const cell = cellAtPoint(asLayer, x, y);
      if (cell !== null && cell !== motifSentinel) return pm;
    }
    return null;
  };

  // ── Pointer handlers ───────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Pinch-zoom tracking happens BEFORE any mode-specific logic, and for
    // EVERY pointer (even when mode === "none", so pinch-zoom works while
    // just viewing the chart too -- the zoom controls themselves aren't
    // gated behind an editing mode either). Record this pointer regardless.
    {
      const rectEl = e.currentTarget.getBoundingClientRect();
      activePointersRef.current.set(e.pointerId, {
        x: e.clientX - rectEl.left,
        y: e.clientY - rectEl.top,
      });
      if (activePointersRef.current.size === 2) {
        // Second finger just landed -- cancel any single-pointer gesture
        // already in flight so it can't be corrupted by this new pointer,
        // then start pinch tracking.
        bgDragRef.current.active = false;
        progressDragRef.current.active = false;
        paintRef.current.active = false;
        paintRef.current.lastIdx = null;
        setLive(null);
        selectRef.current.active = false;
        floatDragRef.current = null;
        lassoDragRef.current = { active: false, points: [] };
        setLassoDragPoints([]);
        const pts = Array.from(activePointersRef.current.values());
        pinchRef.current = {
          initialDist: pointerDistance(pts[0], pts[1]),
          initialZoom: zoom,
        };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        return;
      }
      if (activePointersRef.current.size > 2) {
        // Third+ finger -- ignore entirely, keep pinching with the first two.
        return;
      }
    }

    if (mode === "none") {
      // Peek select -- drag to measure, nothing is written to the chart.
      // Touch-only: skip this entirely so a single-finger touch swipe with
      // no tool selected falls through to native scroll instead of being
      // captured for measuring. Peek-select remains fully available for
      // mouse/pen, where there's no scroll-vs-measure conflict.
      if (e.pointerType === "touch") return;
      const peekCell = cellFromEvent(e);
      if (!peekCell) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      peekRef.current = { active: true, r0: peekCell.y, c0: peekCell.x };
      setPeekRect({ r0: peekCell.y, c0: peekCell.x, r1: peekCell.y, c1: peekCell.x });
      const rectEl = e.currentTarget.getBoundingClientRect();
      setPeekCursor({ x: e.clientX - rectEl.left, y: e.clientY - rectEl.top });
      return;
    }
    const cell = cellFromEvent(e);
    if (!cell) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (mode === "background") {
      const add = !selection.has(cell.idx);
      bgDragRef.current = { add, active: true };
      setSelection((prev) => {
        const next = new Set(prev);
        if (add) next.add(cell.idx);
        else next.delete(cell.idx);
        return next;
      });
      return;
    }
    if (mode === "lasso") {
      const rectEl = e.currentTarget.getBoundingClientRect();
      const px = (e.clientX - rectEl.left) / cellSize;
      const py = (e.clientY - rectEl.top) / cellSize;
      lassoDragRef.current = { active: true, points: [{ x: px, y: py }] };
      setLassoDragPoints([{ x: px, y: py }]);
      setLassoSelection(new Set());
      return;
    }
    if (mode === "paint") {
      if (!paintColor && !paintCountOnly) return;
      const footprint = brushCells(cell.x, cell.y, brushSize, chart.width, chart.height, brushShape);
      const footprintIdxs = footprint.map((c) => c.y * chart.width + c.x);
      paintRef.current.touched = new Set(footprintIdxs);
      setPaintStrokeCount(paintRef.current.touched.size);
      if (paintCountOnly) {
        paintRef.current.active = true;
        paintRef.current.lastIdx = cell.idx;
        paintRef.current.startChart = null;
        return;
      }
      const base = live ?? {
        pixels: new Uint16Array(pixels),
        palette: chart.palette.slice(),
      };
      let next = base;
      for (const idx of footprintIdxs) next = paintIdxInLive(next, idx, paintColor!);
      setLive(next);
      paintRef.current.active = true;
      paintRef.current.lastIdx = cell.idx;
      paintRef.current.startChart = chart;
      return;
    }
    if (mode === "progress") {
      if (!progress || !onProgressChange) return;
      if (codeGrid[cell.y]?.[cell.x] === NOT_STITCHABLE) return;
      const currentlyDone = progress[cell.y]?.[cell.x] ?? false;
      const add = !currentlyDone;
      progressDragRef.current = { add, active: true };
      onProgressChange(setStitched(progress, cell.x, cell.y, add));
      return;
    }
    if (mode === "tileFill") {
      const notStitchableIdx = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
      const region = regionAt(
        { cells: pixels, width: chart.width, height: chart.height },
        cell.x, cell.y,
        notStitchableIdx >= 0 ? { sentinel: notStitchableIdx } : {},
      );
      setTileFillSelection(new Set(region));
      return;
    }
    if (mode === "cleanup") {
      if (!canEdit) return;
      const notStitchableIdx2 = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
      const grid = { cells: pixels, width: chart.width, height: chart.height };
      const single = planSingleRegionCleanup(
        grid, cell.x, cell.y, confettiMaxSize,
        notStitchableIdx2 >= 0 ? { sentinel: notStitchableIdx2 } : {},
      );
      // No-op if the clicked region is too large (a real design area, not
      // confetti -- refuse to touch it rather than guess) or has no
      // determinable surrounding colour. Each click is its own undo step,
      // same granularity as a single Paint tap.
      if (single) {
        const px = new Uint16Array(pixels);
        for (const i of single.changed) px[i] = single.replacement;
        commit({ ...chart, ...rebuildChart(chart.width, chart.height, chart.palette.slice(), px) });
      }
      return;
    }
    if (mode === "shapes") {
      if (!paintColor) return;
      shapeDragRef.current.active = true;
      setShapeStart({ x: cell.x, y: cell.y });
      setShapeEnd({ x: cell.x, y: cell.y });
      return;
    }
    if (mode === "motifs") {
      const hit = motifAtCell(cell.x, cell.y);
      if (hit) {
        setSelectedMotifId(hit.id);
        setMotifDrag({
          id: hit.id,
          startCellX: cell.x,
          startCellY: cell.y,
          origOffset: hit.offset,
          offset: hit.offset,
        });
      } else {
        setSelectedMotifId(null);
      }
      return;
    }
    if (mode === "select") {
      if (floating) {
        const rectEl = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rectEl.left;
        const py = e.clientY - rectEl.top;
        const corner = hitFloatingHandle(floating, px, py);
        if (corner) {
          floatDragRef.current = {
            kind: corner,
            startCellX: cell.x,
            startCellY: cell.y,
            orig: floating,
          };
          return;
        }
        if (isInsideFloating(floating, cell.x, cell.y)) {
          floatDragRef.current = {
            kind: "move",
            startCellX: cell.x,
            startCellY: cell.y,
            orig: floating,
          };
          return;
        }
      }
      selectRef.current = { active: true, r0: cell.y, c0: cell.x };
      setSelRect({ r0: cell.y, c0: cell.x, r1: cell.y, c1: cell.x });
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Pinch in progress: update this pointer's tracked position, rescale
    // zoom from the change in distance, and skip every other kind of
    // handling entirely while 2 fingers are down.
    if (activePointersRef.current.has(e.pointerId)) {
      const rectEl = e.currentTarget.getBoundingClientRect();
      activePointersRef.current.set(e.pointerId, {
        x: e.clientX - rectEl.left,
        y: e.clientY - rectEl.top,
      });
    }
    if (pinchRef.current && activePointersRef.current.size >= 2) {
      const pts = Array.from(activePointersRef.current.values()).slice(0, 2);
      const dist = pointerDistance(pts[0], pts[1]);
      const { initialDist, initialZoom } = pinchRef.current;
      if (initialDist > 0) {
        setZoom(clampZoom(initialZoom * (dist / initialDist)));
      }
      return;
    }

    if (mode === "none") {
      // Defensive: touch never starts a peek-select drag (see onPointerDown).
      if (e.pointerType === "touch") return;
      if (!peekRef.current.active) return;
      const peekCell = cellFromEvent(e);
      if (!peekCell) return;
      setPeekRect({
        r0: peekRef.current.r0,
        c0: peekRef.current.c0,
        r1: peekCell.y,
        c1: peekCell.x,
      });
      const rectEl = e.currentTarget.getBoundingClientRect();
      setPeekCursor({ x: e.clientX - rectEl.left, y: e.clientY - rectEl.top });
      return;
    }
    const cell = cellFromEvent(e);
    if (!cell) return;

    if (mode === "paint") {
      // Track hover position regardless of active-drag state, so the brush
      // footprint preview follows the pointer even before a stroke starts.
      setPaintHoverCell({ x: cell.x, y: cell.y });
    }

    if (mode === "background" && bgDragRef.current.active) {
      setSelection((prev) => {
        const had = prev.has(cell.idx);
        if (bgDragRef.current.add ? had : !had) return prev;
        const next = new Set(prev);
        if (bgDragRef.current.add) next.add(cell.idx);
        else next.delete(cell.idx);
        return next;
      });
      return;
    }
    if (mode === "lasso" && lassoDragRef.current.active) {
      const rectEl = e.currentTarget.getBoundingClientRect();
      const px = (e.clientX - rectEl.left) / cellSize;
      const py = (e.clientY - rectEl.top) / cellSize;
      const pts = lassoDragRef.current.points;
      const last = pts[pts.length - 1];
      // Throttle to avoid an unbounded number of points on a slow drag --
      // only record a new point once the pointer has moved a meaningful
      // distance (a quarter of a cell) since the last recorded one.
      if (!last || Math.hypot(px - last.x, py - last.y) > 0.25) {
        const nextPts = [...pts, { x: px, y: py }];
        lassoDragRef.current.points = nextPts;
        setLassoDragPoints(nextPts);
      }
      return;
    }
    if (mode === "paint" && paintRef.current.active) {
      const last = paintRef.current.lastIdx;
      if (last == null) return;
      const lx = last % chart.width;
      const ly = Math.floor(last / chart.width);
      if (lx === cell.x && ly === cell.y) return;
      // Stamp the brush footprint along the stroke once, shared by both the
      // "paint" and "count only" cases -- painting is conditional on the
      // result, but the distinct-cell count is always derived from the same
      // trace, so the two can never disagree about which cells the stroke
      // crossed. brushStroke (brush.ts) supersedes the plain single-cell
      // Bresenham tracer this used before brush-size wiring: at size 1 it's
      // 92-100% cell-for-cell consistent with strict Bresenham (verified),
      // and correctly stamps the full footprint at every step for size > 1.
      const tracedCells = brushStroke(lx, ly, cell.x, cell.y, brushSize, chart.width, chart.height, brushShape);
      const traced = tracedCells.map((c) => c.y * chart.width + c.x);
      for (const idx of traced) paintRef.current.touched.add(idx);
      setPaintStrokeCount(paintRef.current.touched.size);
      paintRef.current.lastIdx = cell.idx;
      if (!paintCountOnly && paintColor) {
        setLive((cur) => {
          const base = cur ?? {
            pixels: new Uint16Array(pixels),
            palette: chart.palette.slice(),
          };
          let next = base;
          for (const idx of traced) next = paintIdxInLive(next, idx, paintColor);
          return next;
        });
      }
      return;
    }
    if (mode === "progress" && progressDragRef.current.active) {
      if (!progress || !onProgressChange) return;
      if (codeGrid[cell.y]?.[cell.x] === NOT_STITCHABLE) return;
      onProgressChange(setStitched(progress, cell.x, cell.y, progressDragRef.current.add));
      return;
    }
    if (mode === "shapes" && shapeDragRef.current.active) {
      setShapeEnd({ x: cell.x, y: cell.y });
      return;
    }
    if (mode === "motifs" && motifDrag) {
      setMotifDrag((d) =>
        d
          ? { ...d, offset: { x: d.origOffset.x + (cell.x - d.startCellX), y: d.origOffset.y + (cell.y - d.startCellY) } }
          : d,
      );
      return;
    }
    if (mode === "select" && floatDragRef.current) {
      const d = floatDragRef.current;
      if (d.kind === "move") {
        const dr = cell.y - d.startCellY;
        const dc = cell.x - d.startCellX;
        setFloating({ ...d.orig, row: d.orig.row + dr, col: d.orig.col + dc });
      } else {
        // Corner resize. Anchor = opposite corner of the dragged one.
        const o = d.orig;
        const anchorX =
          d.kind === "ne" || d.kind === "se" ? o.col : o.col + o.w;
        const anchorY =
          d.kind === "sw" || d.kind === "se" ? o.row : o.row + o.h;
        // Pointer cell defines the new dragged corner (inclusive).
        const dragX =
          d.kind === "ne" || d.kind === "se" ? cell.x + 1 : cell.x;
        const dragY =
          d.kind === "sw" || d.kind === "se" ? cell.y + 1 : cell.y;
        let newW = Math.max(1, Math.abs(dragX - anchorX));
        let newH = Math.max(1, Math.abs(dragY - anchorY));
        if (o.lockAspect !== false) {
          const ratio = o.srcW / o.srcH;
          // Use whichever axis grew more (vs original) to drive the scale.
          const sW = newW / o.srcW;
          const sH = newH / o.srcH;
          const s = Math.max(sW, sH);
          newW = Math.max(1, Math.round(o.srcW * s));
          newH = Math.max(1, Math.round(o.srcH * s));
          // (ratio kept implicit via srcW/srcH)
          void ratio;
        }
        const newCol =
          d.kind === "ne" || d.kind === "se" ? anchorX : anchorX - newW;
        const newRow =
          d.kind === "sw" || d.kind === "se" ? anchorY : anchorY - newH;
        setFloating({ ...o, w: newW, h: newH, col: newCol, row: newRow });
      }
      return;
    }
    if (mode === "select" && selectRef.current.active) {
      setSelRect({
        r0: selectRef.current.r0,
        c0: selectRef.current.c0,
        r1: cell.y,
        c1: cell.x,
      });
      return;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchRef.current = null;
      // Deliberately do NOT resume any single-pointer gesture for whichever
      // finger might still be down -- it was already reset when the pinch
      // started, and silently resuming it from wherever it left off risks
      // an unintended paint/select jump. The user just presses again.
    }
    if (mode === "none") {
      // Leave peekRect + its count on screen until the next drag starts.
      peekRef.current = { active: false, r0: 0, c0: 0 };
      return;
    }
    if (mode === "background") {
      bgDragRef.current.active = false;
    } else if (mode === "lasso" && lassoDragRef.current.active) {
      const pts = lassoDragRef.current.points;
      lassoDragRef.current = { active: false, points: [] };
      setLassoDragPoints([]);
      setLassoSelection(rasterizeLassoSelection(pts, chart.width, chart.height));
    } else if (mode === "progress") {
      progressDragRef.current.active = false;
    } else if (mode === "paint" && paintRef.current.active) {
      paintRef.current.active = false;
      paintRef.current.lastIdx = null;
      if (paintCountOnly) {
        // Measuring only -- nothing to commit. Leave paintStrokeCount
        // showing the final tally until the next stroke starts (pointerDown
        // resets it), matching how a measuring tool's last reading persists.
        return;
      }
      // Commit live as a single history entry (vs startChart).
      const start = paintRef.current.startChart;
      const liveSnap = live;
      paintRef.current.startChart = null;
      if (start && liveSnap) {
        const rebuilt: ChartData = {
          ...chart,
          ...rebuildChart(chart.width, chart.height, liveSnap.palette, liveSnap.pixels),
        };
        setLive(null);
        commit(rebuilt, start);
      } else {
        setLive(null);
      }
    } else if (mode === "shapes" && shapeDragRef.current.active) {
      shapeDragRef.current.active = false;
      if (canEdit && paintColor && shapeStart && shapeEnd) {
        const notStitchableIdxShape = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
        const dims = { width: chart.width, height: chart.height };
        const effectiveThickness =
          (shapeKind === "rect" || shapeKind === "circle" || shapeKind === "triangle") && rectFillMode === "filled"
            ? 1
            : shapeThickness;
        const opts = {
          thickness: effectiveThickness,
          cells: pixels,
          sentinel: notStitchableIdxShape >= 0 ? notStitchableIdxShape : undefined,
        };
        const a: ShapePoint = shapeStart;
        const b: ShapePoint = shapeEnd;
        const result =
          shapeKind === "line" ? lineCells(a, b, dims, opts)
          : shapeKind === "circle" ? ellipseCells(a, b, dims, rectFillMode, opts)
          : shapeKind === "triangle" ? triangleCells(a, b, dims, rectFillMode, opts)
          : rectCells(a, b, dims, rectFillMode, opts);
        if (result.cells.length > 0) {
          let next: { pixels: Uint16Array; palette: ChartPaletteEntry[] } = { pixels: new Uint16Array(pixels), palette: chart.palette.slice() };
          for (const i of result.cells) next = paintIdxInLive(next, i, paintColor);
          commit({ ...chart, ...rebuildChart(chart.width, chart.height, next.palette, next.pixels) });
        }
      }
      setShapeStart(null);
      setShapeEnd(null);
    } else if (mode === "select") {
      selectRef.current.active = false;
      floatDragRef.current = null;
    } else if (mode === "motifs") {
      // Commit ONLY on pointer-up, and only if the offset actually changed --
      // a plain tap-to-select must not trigger a recomposeChart pass.
      if (motifDrag) {
        const moved =
          motifDrag.offset.x !== motifDrag.origOffset.x ||
          motifDrag.offset.y !== motifDrag.origOffset.y;
        if (moved) onMotifMove?.(motifDrag.id, motifDrag.offset);
      }
      setMotifDrag(null);
    }
  };

  // Background-key "tap colour to select all"
  const toggleAllOfColor = (paletteIdx: number) => {
    setSelection((prev) => {
      const next = new Set(prev);
      const allIndexes: number[] = [];
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] === paletteIdx) allIndexes.push(i);
      }
      const allSelected = allIndexes.every((i) => next.has(i));
      if (allSelected) for (const i of allIndexes) next.delete(i);
      else for (const i of allIndexes) next.add(i);
      return next;
    });
  };

  // ── Background fill ────────────────────────────────────────────────────────
  const buildFill = (): FillSpec | null => {
    if (fillType === "solid") {
      if (!solidColor) return null;
      return { type: "solid", colours: [solidColor] };
    }
    if (fillType === "stripes") {
      const cols = stripeColors.filter((c): c is ThreadColor => !!c);
      if (cols.length < 2) return null;
      return {
        type: "stripes",
        colours: cols,
        stripeWidth,
        orientation: stripeOrientation,
      };
    }
    if (fillType === "gingham") {
      const cols = ginghamColors.filter((c): c is ThreadColor => !!c);
      if (cols.length < 3) return null;
      return { type: "gingham", colours: cols, blockSize: ginghamBlockSize };
    }
    const cols = bargelloColors.filter((c): c is ThreadColor => !!c);
    if (cols.length < 3) return null;
    return { type: "bargello", colours: cols, patternId: bargelloPatternId };
  };

  const applyFill = () => {
    if (!canEdit || selection.size === 0) return;
    const fill = buildFill();
    if (!fill) return;
    const next = applyBackgroundFill(chart, selection, fill);
    commit(next);
    setSelection(new Set());
  };

  const fillReady = !!buildFill() && selection.size > 0;

  // ── Lasso-mode actions ─────────────────────────────────────────────────────
  // Bounding box of the current lasso selection, or null if empty. Every
  // lasso action operates within this box, using the selection Set to decide
  // which cells inside it are actually included (vs a gap in the freeform
  // shape).
  const lassoBBox = (() => {
    if (lassoSelection.size === 0) return null;
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    for (const idx of lassoSelection) {
      const r = Math.floor(idx / chart.width);
      const c = idx % chart.width;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
    }
    return { r0, c0, r1, c1, w: c1 - c0 + 1, h: r1 - r0 + 1 };
  })();

  const copyLassoSelection = () => {
    if (!lassoBBox) return;
    const { r0, c0, w, h } = lassoBBox;
    const cells: (ChartPaletteEntry | null)[] = [];
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const R = r0 + r, C = c0 + c;
        if (!lassoSelection.has(R * chart.width + C)) {
          cells.push(null); // outside the freeform shape, but inside its bbox
          continue;
        }
        const idx = pixels[R * chart.width + C];
        cells.push(chart.palette[idx]);
      }
    }
    setClipboard({ w, h, cells });
  };

  // Same extraction as copyLassoSelection, but reports to the parent instead
  // of the clipboard -- the parent owns naming + the actual Supabase save.
  const saveLassoAsMotif = () => {
    if (!lassoBBox || !onSaveAsMotif) return;
    const { r0, c0, w, h } = lassoBBox;
    const cells: (ChartPaletteEntry | null)[] = [];
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const R = r0 + r, C = c0 + c;
        if (!lassoSelection.has(R * chart.width + C)) {
          cells.push(null);
          continue;
        }
        const idx = pixels[R * chart.width + C];
        cells.push(chart.palette[idx]);
      }
    }
    onSaveAsMotif(cells, w, h);
  };

  // Lift the lasso selection into a floating layer -- same "move in place"
  // model as liftSelection, generalized to a non-rectangular mask. Cells
  // outside the freeform shape (but inside its bbox) become null in `cells`
  // (never painted when the layer is dropped) and are excluded from
  // `origin.mask` (never cleared from the source location either).
  const liftLassoSelection = () => {
    if (!lassoBBox || !canEdit) return;
    const { r0, c0, w, h } = lassoBBox;
    const cells: (ChartPaletteEntry | null)[] = [];
    const mask = new Set<number>();
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const R = r0 + r, C = c0 + c;
        if (!lassoSelection.has(R * chart.width + C)) {
          cells.push(null);
          continue;
        }
        mask.add(r * w + c);
        const idx = pixels[R * chart.width + C];
        cells.push(chart.palette[idx]);
      }
    }
    const bgEntry = dominantNeighbourColor({ r0, c0, r1: lassoBBox.r1, c1: lassoBBox.c1 });
    preserveFloatingOnModeChangeRef.current = true;
    setFloating({
      row: r0,
      col: c0,
      w,
      h,
      srcW: w,
      srcH: h,
      cells,
      origin: { row: r0, col: c0, w, h, mask },
      bgEntry,
      lockAspect: true,
    });
    setLassoSelection(new Set());
    // Reuse Select mode's existing floating-layer drag/resize/Apply/Cancel UI
    // wholesale rather than duplicating it for lasso -- the floating layer
    // itself doesn't know or care whether it came from a rectangle or a
    // freeform lift.
    setMode("select");
  };

  const fillLassoWithPaint = () => {
    if (!lassoBBox || !paintColor || !canEdit || lassoSelection.size === 0) return;
    const pal = chart.palette.slice();
    let cIdx = pal.findIndex((p) => p.id === paintColor.code);
    if (cIdx < 0) {
      pal.push(threadToEntry(paintColor));
      cIdx = pal.length - 1;
    }
    const px = new Uint16Array(pixels);
    for (const idx of lassoSelection) px[idx] = cIdx;
    commit({ ...chart, ...rebuildChart(chart.width, chart.height, pal, px) });
    setLassoSelection(new Set());
  };

  const clearLassoSelection = () => { setLassoSelection(new Set()); setLassoSwapIdx(null); };

  /**
   * Thread colours actually present inside the lasso, with how many stitches
   * of each. Drives the swap list below, so the user only ever sees colours
   * that are really in their selection.
   */
  const lassoColours = useMemo(() => {
    if (lassoSelection.size === 0) return [];
    const counts = new Map<number, number>();
    for (const idx of lassoSelection) {
      const p = pixels[idx];
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([pi]) => chart.palette[pi] && chart.palette[pi].id !== NOT_STITCHABLE)
      .map(([paletteIdx, count]) => ({ paletteIdx, count, entry: chart.palette[paletteIdx] }))
      .sort((a, b) => b.count - a.count);
  }, [lassoSelection, pixels, chart.palette]);

  /** Which colour inside the selection the user is currently swapping. */
  const [lassoSwapIdx, setLassoSwapIdx] = useState<number | null>(null);

  /**
   * Replace ONE colour, but only where it appears inside the lasso. The same
   * thread elsewhere on the chart is deliberately left alone -- that is the
   * whole point of scoping the swap to a selection.
   */
  const swapColourInLasso = (fromPaletteIdx: number, to: ThreadColor) => {
    if (!canEdit || lassoSelection.size === 0) return;
    const pal = chart.palette.slice();
    let toIdx = pal.findIndex((p) => p.id === to.code);
    if (toIdx < 0) {
      pal.push(threadToEntry(to));
      toIdx = pal.length - 1;
    }
    if (toIdx === fromPaletteIdx) return;
    const px = new Uint16Array(pixels);
    let changed = 0;
    for (const idx of lassoSelection) {
      if (px[idx] === fromPaletteIdx) { px[idx] = toIdx; changed++; }
    }
    if (!changed) return;
    commit({ ...chart, ...rebuildChart(chart.width, chart.height, pal, px) });
    setLassoSwapIdx(null);
  };

  // ── Confetti cleanup actions ────────────────────────────────────────────────
  // Some flagged spots are real detail (an eye, a highlight dot), not
  // confetti -- a blanket "fill them all" pass wrecks those. Scanning seeds a
  // STEP-THROUGH review: one region highlighted at a time, decide keep-or-
  // change, move to the next.
  const scanForConfetti = () => {
    const notStitchableIdx = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
    const grid = { cells: pixels, width: chart.width, height: chart.height };
    const found = findConfetti(
      grid, confettiMaxSize, notStitchableIdx >= 0 ? { sentinel: notStitchableIdx } : {},
    );
    setConfettiPreview(found);
    setConfettiSkipped(new Set());
    setConfettiReviewIdx(found.length > 0 ? 0 : null);
  };
  const advanceConfettiReview = () => {
    setConfettiReviewIdx((idx) => {
      if (idx == null) return null;
      const next = idx + 1;
      return next < confettiPreview.length ? next : null;
    });
  };
  const changeCurrentConfettiSpot = () => {
    if (!canEdit || confettiReviewIdx == null) return;
    const region = confettiPreview[confettiReviewIdx];
    if (!region) return;
    const notStitchableIdx = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
    const grid = { cells: pixels, width: chart.width, height: chart.height };
    const dom = dominantSurroundingColour(
      grid, region.cells, notStitchableIdx >= 0 ? { sentinel: notStitchableIdx } : {},
    );
    if (dom != null) {
      const px = new Uint16Array(pixels);
      for (const i of region.cells) px[i] = dom;
      commit({ ...chart, ...rebuildChart(chart.width, chart.height, chart.palette.slice(), px) });
    }
    advanceConfettiReview();
  };
  const keepCurrentConfettiSpot = () => {
    if (confettiReviewIdx == null) return;
    setConfettiSkipped((prev) => new Set(prev).add(confettiReviewIdx));
    advanceConfettiReview();
  };
  const changeAllRemainingConfetti = () => {
    if (!canEdit || confettiReviewIdx == null) return;
    const notStitchableIdx = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
    const grid = { cells: pixels, width: chart.width, height: chart.height };
    const px = new Uint16Array(pixels);
    let changed = false;
    for (let i = confettiReviewIdx; i < confettiPreview.length; i++) {
      if (confettiSkipped.has(i)) continue;
      const region = confettiPreview[i];
      const dom = dominantSurroundingColour(
        grid, region.cells, notStitchableIdx >= 0 ? { sentinel: notStitchableIdx } : {},
      );
      if (dom == null) continue;
      for (const idxCell of region.cells) px[idxCell] = dom;
      changed = true;
    }
    if (changed) {
      commit({ ...chart, ...rebuildChart(chart.width, chart.height, chart.palette.slice(), px) });
    }
    setConfettiReviewIdx(null);
  };

  // ── Select-mode actions ────────────────────────────────────────────────────
  const selSize = (() => {
    if (!selRect) return null;
    const s = normRect(selRect);
    return { w: s.c1 - s.c0 + 1, h: s.r1 - s.r0 + 1, s };
  })();

  const copySelection = () => {
    if (!selSize) return;
    const { s, w, h } = selSize;
    const cells: ChartPaletteEntry[] = [];
    for (let r = s.r0; r <= s.r1; r++) {
      for (let c = s.c0; c <= s.c1; c++) {
        const idx = pixels[r * chart.width + c];
        cells.push(chart.palette[idx]);
      }
    }
    setClipboard({ w, h, cells });
  };

  // Same extraction as copySelection, but reports to the parent instead of
  // the clipboard -- the parent owns naming + the actual Supabase save.
  const saveSelectionAsMotif = () => {
    if (!selSize || !onSaveAsMotif) return;
    const { s, w, h } = selSize;
    const cells: (ChartPaletteEntry | null)[] = [];
    for (let r = s.r0; r <= s.r1; r++) {
      for (let c = s.c0; c <= s.c1; c++) {
        const idx = pixels[r * chart.width + c];
        cells.push(chart.palette[idx]);
      }
    }
    onSaveAsMotif(cells, w, h);
  };

  // Turn the current selection into a floating layer so it can be moved /
  // resized in place (no clipboard required). Source cells stay where they
  // are until the user moves the floating layer away.
  const liftSelection = () => {
    if (!selSize || !canEdit) return;
    const { s, w, h } = selSize;
    const cells: ChartPaletteEntry[] = [];
    for (let r = s.r0; r <= s.r1; r++) {
      for (let c = s.c0; c <= s.c1; c++) {
        const idx = pixels[r * chart.width + c];
        cells.push(chart.palette[idx]);
      }
    }
    const bgEntry = dominantNeighbourColor(s);
    setFloating({
      row: s.r0,
      col: s.c0,
      w,
      h,
      srcW: w,
      srcH: h,
      cells,
      origin: { row: s.r0, col: s.c0, w, h },
      bgEntry,
      lockAspect: true,
    });
    setSelRect(null);
  };

  const pasteClipboard = () => {
    if (!clipboard || !canEdit) return;
    // Apply any pending floating layer first so a second paste doesn't drop it.
    let baseChart = chart;
    if (floating) {
      baseChart = stampFloating(baseChart, floating) ?? baseChart;
      commit(baseChart);
    }
    const r0 = selSize ? selSize.s.r0 : 0;
    const c0 = selSize ? selSize.s.c0 : 0;
    setFloating({
      row: r0,
      col: c0,
      w: clipboard.w,
      h: clipboard.h,
      srcW: clipboard.w,
      srcH: clipboard.h,
      cells: clipboard.cells.slice(),
      lockAspect: true,
    });
  };

  const stampFloating = (target: ChartData, f: Floating): ChartData | null => {
    const tgtPixels = expandRLE(target.pixelsRLE, target.width * target.height);
    const pal = target.palette.slice();
    const findOrAdd = (e: ChartPaletteEntry) => {
      const i = pal.findIndex((p) => p.id === e.id);
      if (i >= 0) return i;
      pal.push(e);
      return pal.length - 1;
    };
    const px = new Uint16Array(tgtPixels);
    let touched = false;
    // Clear origin rect first (MOVE semantics — fill source with background).
    if (f.origin && f.bgEntry) {
      const bgIdx = findOrAdd(f.bgEntry);
      const o = f.origin;
      for (let r = 0; r < o.h; r++) {
        for (let c = 0; c < o.w; c++) {
          if (o.mask && !o.mask.has(r * o.w + c)) continue; // lasso lift: only clear selected cells
          const R = o.row + r;
          const C = o.col + c;
          if (R < 0 || R >= target.height || C < 0 || C >= target.width) continue;
          px[R * target.width + C] = bgIdx;
          touched = true;
        }
      }
    }
    for (let r = 0; r < f.h; r++) {
      for (let c = 0; c < f.w; c++) {
        const R = f.row + r;
        const C = f.col + c;
        if (R < 0 || R >= target.height || C < 0 || C >= target.width) continue;
        const entry = sampleFloating(f, r, c);
        if (!entry) continue;
        px[R * target.width + C] = findOrAdd(entry);
        touched = true;
      }
    }
    if (!touched) return null;
    return { ...target, ...rebuildChart(target.width, target.height, pal, px) };
  };

  const applyFloating = () => {
    if (!floating || !canEdit) return;
    const next = stampFloating(chart, floating);
    setFloating(null);
    if (next) commit(next);
  };
  const cancelFloating = () => setFloating(null);
  const scaleFloating = (factor: number) => {
    if (!floating) return;
    setFloating({
      ...floating,
      w: Math.max(1, Math.round(floating.w * factor)),
      h: Math.max(1, Math.round(floating.h * factor)),
    });
  };
  const resetFloatingSize = () => {
    if (!floating) return;
    setFloating({ ...floating, w: floating.srcW, h: floating.srcH });
  };

  const transformSelection = (kind: "mirrorH" | "mirrorV" | "rot180" | "rot90") => {
    if (!selSize || !canEdit) return;
    const { s, w, h } = selSize;
    if (kind === "rot90" && w !== h) return;
    const reg: number[] = [];
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        reg.push(pixels[(s.r0 + r) * chart.width + (s.c0 + c)]);
      }
    }
    const at = (r: number, c: number) => reg[r * w + c];
    const px = new Uint16Array(pixels);
    const put = (r: number, c: number, val: number) => {
      px[(s.r0 + r) * chart.width + (s.c0 + c)] = val;
    };
    if (kind === "mirrorH") {
      for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++) put(r, c, at(r, w - 1 - c));
    } else if (kind === "mirrorV") {
      for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++) put(r, c, at(h - 1 - r, c));
    } else if (kind === "rot180") {
      for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++) put(r, c, at(h - 1 - r, w - 1 - c));
    } else if (kind === "rot90") {
      for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++) put(r, c, at(w - 1 - c, r));
    }
    commit({
      ...chart,
      ...rebuildChart(chart.width, chart.height, chart.palette.slice(), px),
    });
  };

  const fillSelectionWithPaint = () => {
    if (!selSize || !paintColor || !canEdit) return;
    const { s } = selSize;
    const pal = chart.palette.slice();
    let cIdx = pal.findIndex((p) => p.id === paintColor.code);
    if (cIdx < 0) {
      pal.push(threadToEntry(paintColor));
      cIdx = pal.length - 1;
    }
    const px = new Uint16Array(pixels);
    for (let r = s.r0; r <= s.r1; r++) {
      for (let c = s.c0; c <= s.c1; c++) {
        px[r * chart.width + c] = cIdx;
      }
    }
    commit({ ...chart, ...rebuildChart(chart.width, chart.height, pal, px) });
  };

  // Touch-action is unconditionally "none" now, not mode-dependent as
  // before -- pinch-zoom needs to reliably intercept a second finger
  // regardless of which tool (if any) is active, and touch-action is a
  // static per-element setting the browser locks in at gesture start, so
  // toggling it dynamically based on pointer count would not reliably
  // suppress native pinch/scroll on the second finger's own touchstart.
  // Known, accepted tradeoff: native single-finger touch-scroll INSIDE the
  // canvas is sacrificed in favour of reliable custom pinch-zoom -- the
  // wrapping div's own scrollbars/mouse-drag still work on desktop, and
  // pinch-zoom becomes the primary mobile navigation method.
  // Active tool modes legitimately need exclusive single-finger control (that's
  // the tool's own gesture, not a scroll). With no tool selected, single-finger
  // touch should scroll the page like anything else -- only pinch (2 fingers)
  // is special-cased in onPointerDown/onPointerMove regardless of touch-action,
  // so this doesn't affect zoom.
  const canvasTouchAction = mode === "none" ? "pan-x pan-y" : "none";
  const canvasCursor =
    mode === "paint" ? "crosshair" : mode === "select" ? "crosshair" : mode === "background" ? "crosshair" : "default";

  const activePanel: PanelId | null = viewOpen ? "view" : mode === "none" ? null : mode;
  const panelTitle =
    activePanel === "view"
      ? "View"
      : activePanel
        ? (TOOL_GROUPS.flatMap((g) => g.tools).find((t) => t.id === activePanel)?.label ?? "")
        : "";

  const railButton = (t: { id: PanelId; label: string; Icon: LucideIcon }) => {
    const active = activePanel === t.id;
    return (
      <button
        key={t.id}
        type="button"
        onClick={() => {
          if (t.id === "view") {
            setViewOpen((v) => !v);
            return;
          }
          setViewOpen(false);
          setMode((cur) => (cur === t.id ? "none" : (t.id as Mode)));
        }}
        className={`flex ${isWide ? "w-full" : "w-auto"} min-w-[68px] shrink-0 flex-none flex-col items-center gap-1 rounded-md border px-2 py-2 text-center transition-colors ${
          active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-card text-foreground hover:border-primary/50"
        }`}
        aria-pressed={active}
      >
        <t.Icon size={18} strokeWidth={1.75} aria-hidden="true" />
        <span className="text-[10px] leading-tight whitespace-nowrap">{t.label}</span>
      </button>
    );
  };

  const rail = (
    <div
      className={
        isWide
          ? "w-[92px] shrink-0 space-y-3 rounded-md border border-border bg-card/40 p-2"
          : "flex w-full max-w-full flex-nowrap items-stretch gap-3 overflow-x-auto overflow-y-hidden border-t border-border bg-card px-3 py-2"
      }
    >
      {TOOL_GROUPS.map((g, gi) => {
        const tools = g.tools.filter((t) =>
          progressOnly
            ? t.id === "progress"
            : t.id === "progress"
              ? false
              : t.id === "view" || canEdit,
        );
        if (tools.length === 0) return null;
        return (
          <div
            key={g.caption}
            className={
              isWide
                ? gi > 0
                  ? "space-y-1 border-t border-border pt-3"
                  : "space-y-1"
                : gi > 0
                  ? "flex shrink-0 flex-none flex-nowrap items-stretch gap-1.5 border-l border-border pl-3"
                  : "flex shrink-0 flex-none flex-nowrap items-stretch gap-1.5"
            }
          >
            {isWide && (
              <p className="px-1 pb-1 text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                {g.caption}
              </p>
            )}
            {isWide ? (
              <div className="space-y-1">{tools.map(railButton)}</div>
            ) : (
              tools.map(railButton)
            )}
          </div>
        );
      })}
    </div>
  );

  const panel = activePanel && (
    <div
      className={
        isWide
          ? "w-[320px] shrink-0 space-y-3 rounded-md border border-border bg-background/60 p-2"
          : "max-h-[52vh] space-y-3 overflow-y-auto border-t border-border bg-background p-3 shadow-lg"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{panelTitle}</span>
        <button
          type="button"
          onClick={() => {
            setViewOpen(false);
            setMode("none");
          }}
          className="rounded border border-border bg-card px-2 py-0.5 text-xs"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      {activePanel === "view" && (
        <div className="space-y-3 rounded-md border border-border bg-card p-3">
      {/* View mode: colour / symbol / both -- a viewing preference, not an
          edit tool, so it applies regardless of which tool (if any) is active. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">View:</span>
        {(["colour", "symbol", "both"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setViewMode(m)}
            className={`rounded border px-2 py-1 text-xs capitalize ${
              viewMode === m
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-foreground"
            }`}
          >
            {m}
          </button>
        ))}
        {resolvedSymbols.warnings.length > 0 && viewMode !== "colour" && (
          <span className="text-[11px] italic text-amber-700" title={resolvedSymbols.warnings.join(" ")}>
            ⚠ some symbols overflowed the glyph pool
          </span>
        )}
      </div>
      {/* Guides: rulers, geographic centre mark, centre lines (chart-guides.ts) --
          off by default, a viewing aid like Zoom/View, not an edit tool. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Guides:</span>
        <button
          type="button"
          onClick={() => setShowGuides((v) => !v)}
          className={`rounded border px-3 py-1 text-xs ${
            showGuides
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-foreground"
          }`}
        >
          {showGuides ? "On" : "Off"}
        </button>
        {showGuides && (
          <span className="text-xs text-muted-foreground">
            Rulers, centre mark & guide lines — a tick's number counts stitches, matching how
            you'd count on the physical canvas.
          </span>
        )}
      </div>
        </div>
      )}
      {/* Paint controls */}
      {mode === "paint" && canEdit && palette && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-3">
          <span className="text-sm font-medium">Paint colour:</span>
          <div className="flex w-full flex-col gap-2">
            {usedColours.length === 0 ? (
              <span className="text-xs italic text-muted-foreground">
                No colours on this chart yet
              </span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {usedColours.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => setPaintColor(c)}
                    title={`${c.name} (${c.code})`}
                    aria-label={`${c.name} (${c.code})`}
                    aria-pressed={paintColor?.code === c.code}
                    className={`h-7 w-7 rounded border ${
                      paintColor?.code === c.code
                        ? "border-primary ring-2 ring-primary"
                        : "border-border"
                    }`}
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
            )}
            <SwatchPicker
              palette={palette}
              value={paintColor}
              onChange={setPaintColor}
              triggerLabel="More colours"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            Brush size:
            <input
              type="range"
              min={1}
              max={9}
              step={1}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value) || 1)}
              className="w-24"
            />
            <span className="w-4 text-center tabular-nums">{brushSize}</span>
          </label>
          <div className="flex gap-1">
            {(["square", "round"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setBrushShape(s)}
                className={`rounded border px-2 py-1 text-xs capitalize ${
                  brushShape === s
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={paintCountOnly}
              onChange={(e) => setPaintCountOnly(e.target.checked)}
            />
            Count only (measure, don't paint)
          </label>
          <span className="text-xs font-medium">
            {paintStrokeCount > 0 ? `${paintStrokeCount} st this stroke` : ""}
          </span>
          <span className="text-xs text-muted-foreground">
            Tap or drag on the chart. One undo reverses the whole stroke.
          </span>
        </div>
      )}
      {/* Cleanup controls */}
      {mode === "cleanup" && canEdit && (
        <div className="space-y-3 rounded-md border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            A manual, last-ditch finishing pass -- not a substitute for engine quality. Click any
            stray stitch to clean just that spot, or scan the whole chart and review each flagged
            spot one at a time -- some flagged spots are real detail (an eye, a highlight), not
            confetti, so nothing changes until you say so.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              Max confetti size:
              <input
                type="number"
                min={1}
                max={10}
                value={confettiMaxSize}
                onChange={(e) => setConfettiMaxSize(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                className="w-14 rounded border border-border bg-background px-2 py-1 text-xs"
              />
              stitches
            </label>
            <button
              type="button"
              onClick={scanForConfetti}
              className="rounded border border-border bg-background px-3 py-1 text-xs"
            >
              Scan for confetti
            </button>
          </div>
          {confettiPreview.length > 0 && confettiReviewIdx != null && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-red-500/40 bg-red-50/60 p-2 dark:bg-red-900/20">
              <span className="text-xs font-medium">
                Spot {confettiReviewIdx + 1} of {confettiPreview.length} — highlighted in red
              </span>
              <button
                type="button"
                onClick={changeCurrentConfettiSpot}
                className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground"
              >
                Change this spot
              </button>
              <button
                type="button"
                onClick={keepCurrentConfettiSpot}
                className="rounded border border-border bg-background px-3 py-1 text-xs"
                title="This is real detail, not confetti -- leave it as-is"
              >
                Keep (not confetti)
              </button>
              <button
                type="button"
                onClick={changeAllRemainingConfetti}
                className="rounded border border-border bg-background px-3 py-1 text-xs"
                title="Change every remaining spot except ones you've already chosen to keep"
              >
                Change all remaining
              </button>
            </div>
          )}
          {confettiPreview.length > 0 && confettiReviewIdx == null && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-emerald-500/40 bg-emerald-50/60 p-2 dark:bg-emerald-900/20">
              <span className="text-xs font-medium text-emerald-800 dark:text-emerald-200">
                Reviewed all {confettiPreview.length} spot{confettiPreview.length === 1 ? "" : "s"}
                {confettiSkipped.size > 0 ? ` — kept ${confettiSkipped.size}.` : "."}
              </span>
              <button
                type="button"
                onClick={() => { setConfettiPreview([]); setConfettiSkipped(new Set()); }}
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                Clear preview
              </button>
            </div>
          )}
        </div>
      )}
      {/* Shapes controls */}
      {mode === "shapes" && canEdit && palette && (
        <div className="space-y-3 rounded-md border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Colour:</span>
            <SwatchPicker palette={palette} value={paintColor} onChange={setPaintColor} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Shape:</span>
            {(["line", "rect", "circle", "triangle"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setShapeKind(k)}
                className={`rounded border px-3 py-1 text-xs ${
                  shapeKind === k
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground"
                }`}
              >
                {k === "line" ? "Line" : k === "rect" ? "Rectangle" : k === "circle" ? "Circle" : "Triangle"}
              </button>
            ))}
            {(shapeKind === "rect" || shapeKind === "circle" || shapeKind === "triangle") && (
              <>
                <span className="text-xs text-muted-foreground">·</span>
                {(["outline", "filled"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setRectFillMode(f)}
                    className={`rounded border px-3 py-1 text-xs capitalize ${
                      rectFillMode === f
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </>
            )}
          </div>
          {!((shapeKind === "rect" || shapeKind === "circle" || shapeKind === "triangle") && rectFillMode === "filled") && (
            <label className="flex items-center gap-2 text-xs">
              Thickness:
              <input
                type="range"
                min={1}
                max={6}
                step={1}
                value={shapeThickness}
                onChange={(e) => setShapeThickness(Number(e.target.value) || 1)}
                className="w-24"
              />
              <span className="w-4 text-center tabular-nums">{shapeThickness}</span>
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Drag on the chart from one corner/end to the other. Release to commit — one undo
            reverses the whole shape.
          </p>
        </div>
      )}
      {/* Motifs controls */}
      {mode === "motifs" && canEdit && (
        <div className="space-y-3 rounded-md border border-border bg-card p-3">
          {onAddMotifFromLibrary && (
            <button
              type="button"
              onClick={onAddMotifFromLibrary}
              className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground"
            >
              Add from Motif Library
            </button>
          )}
          {!placedMotifs || placedMotifs.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              No placed motifs yet. Add one from the Motif Library and it'll stay movable
              here until you flatten it.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Tap a motif on the chart to select it, then drag to move.
              </p>
              <ul className="space-y-1">
                {[...placedMotifs].reverse().map((pm) => {
                  const isSel = selectedMotifId === pm.id;
                  return (
                    <li
                      key={pm.id}
                      onClick={() => setSelectedMotifId(pm.id)}
                      className={`cursor-pointer rounded border px-2 py-1.5 ${
                        isSel
                          ? "border-primary bg-primary/10"
                          : "border-border bg-background"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium">{pm.name}</span>
                        <div className="flex flex-wrap gap-1">
                          {onMotifReorder && (
                            <>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onMotifReorder(pm.id, "forward"); }}
                                className="rounded border border-border bg-background px-2 py-0.5 text-[11px]"
                              >
                                Bring forward
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onMotifReorder(pm.id, "backward"); }}
                                className="rounded border border-border bg-background px-2 py-0.5 text-[11px]"
                              >
                                Send back
                              </button>
                            </>
                          )}
                          {onMotifRotate && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onMotifRotate(pm.id); }}
                              className="rounded border border-border bg-background px-2 py-0.5 text-[11px]"
                            >
                              Rotate 90°
                            </button>
                          )}
                          {onMotifFlatten && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onMotifFlatten(pm.id); }}
                              className="rounded border border-border bg-background px-2 py-0.5 text-[11px]"
                            >
                              Flatten
                            </button>
                          )}
                          {onMotifResize && (
                            <div className="flex items-center gap-1 rounded border border-border bg-background px-1 py-0.5">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onMotifResize(pm.id, pm.scale - 1); }}
                                disabled={pm.scale <= 1}
                                className="px-1.5 text-[11px] disabled:opacity-40"
                                title="Smaller"
                              >
                                −
                              </button>
                              <span className="text-[11px] tabular-nums">{pm.scale}×</span>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onMotifResize(pm.id, pm.scale + 1); }}
                                disabled={pm.scale >= 10}
                                className="px-1.5 text-[11px] disabled:opacity-40"
                                title="Larger"
                              >
                                +
                              </button>
                            </div>
                          )}
                          {onMotifRemove && (

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (window.confirm(`Remove "${pm.name}" from the chart?`)) onMotifRemove(pm.id);
                              }}
                              className="rounded border border-destructive/50 bg-background px-2 py-0.5 text-[11px] text-destructive"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] italic text-muted-foreground">
                A placed motif always draws on top of painting. Flatten it to bake it into
                the chart permanently and paint over it.
              </p>
            </>
          )}
        </div>
      )}
      {/* Lasso controls */}
      {mode === "lasso" && canEdit && palette && (
        <div className="space-y-3 rounded-md border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Freeform selection:</span>
            <span className="text-xs text-muted-foreground">
              {lassoSelection.size > 0
                ? `${lassoSelection.size} stitches`
                : "Draw a shape on the chart to select an area"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Fill colour:</span>
            <SwatchPicker palette={palette} value={paintColor} onChange={setPaintColor} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={fillLassoWithPaint}
              disabled={lassoSelection.size === 0 || !paintColor}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Fill
            </button>
            <button
              type="button"
              onClick={copyLassoSelection}
              disabled={lassoSelection.size === 0}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={pasteClipboard}
              disabled={!clipboard}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Paste{clipboard ? ` (${clipboard.w}×${clipboard.h})` : ""}
            </button>
            {onSaveAsMotif && (
              <button
                type="button"
                onClick={saveLassoAsMotif}
                disabled={lassoSelection.size === 0}
                className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                title="Save this selection to your Motif Library"
              >
                Save as Motif
              </button>
            )}
            <button
              type="button"
              onClick={liftLassoSelection}
              disabled={lassoSelection.size === 0}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
              title="Move the selected stitches; original is cleared with the surrounding colour"
            >
              Move
            </button>
            <button
              type="button"
              onClick={clearLassoSelection}
              disabled={lassoSelection.size === 0}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Clear selection
            </button>
          </div>
          {lassoColours.length > 0 && (
            <div className="space-y-2 rounded border border-border bg-background/60 p-2">
              <p className="text-xs font-medium">
                Colours in this selection — tap one to change it here only
              </p>
              {lassoColours.map(({ paletteIdx, count, entry }) => (
                <div key={paletteIdx} className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setLassoSwapIdx(lassoSwapIdx === paletteIdx ? null : paletteIdx)}
                    className={
                      "flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-xs " +
                      (lassoSwapIdx === paletteIdx ? "border-primary bg-primary/10" : "border-border bg-background")
                    }
                  >
                    <span
                      className="h-5 w-5 shrink-0 rounded-sm border border-border"
                      style={{ background: entry.hex }}
                    />
                    <span className="flex-1 truncate">{entry.name ?? entry.id}</span>
                    <span className="tabular-nums text-muted-foreground">{count} st</span>
                  </button>
                  {lassoSwapIdx === paletteIdx && (
                    <div className="flex flex-wrap items-center gap-2 pl-7">
                      <span className="text-xs text-muted-foreground">Change to:</span>
                      <SwatchPicker
                        palette={palette}
                        value={null}
                        onChange={(nc) => { if (nc) swapColourInLasso(paletteIdx, nc); }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] italic text-muted-foreground">
            Move switches to Select mode automatically -- Apply/Cancel and the resize
            handles are the exact same floating-layer controls Select's own Move uses.
          </p>
        </div>
      )}
      {/* Select controls */}
      {mode === "select" && canEdit && palette && (
        <div className="space-y-3 rounded-md border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Selection:</span>
            <span className="text-xs text-muted-foreground">
              {selSize
                ? `${selSize.w} × ${selSize.h} stitches`
                : "Drag on the chart to select an area"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copySelection}
              disabled={!selSize}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Copy
            </button>
            {onSaveAsMotif && (
              <button
                type="button"
                onClick={saveSelectionAsMotif}
                disabled={!selSize}
                className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                title="Save this selection to your Motif Library"
              >
                Save as Motif
              </button>
            )}
            <button
              type="button"
              onClick={liftSelection}
              disabled={!selSize}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
              title="Move the selected stitches; original is cleared with the surrounding colour"
            >
              Move
            </button>
            <button
              type="button"
              onClick={liftSelection}
              disabled={!selSize}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
              title="Resize the selected stitches; drag any corner handle"
            >
              Resize
            </button>
            <button
              type="button"
              onClick={pasteClipboard}
              disabled={!clipboard}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Paste{clipboard ? ` (${clipboard.w}×${clipboard.h})` : ""}
            </button>
            <button
              type="button"
              onClick={() => transformSelection("mirrorH")}
              disabled={!selSize}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Flip Horizontal
            </button>
            <button
              type="button"
              onClick={() => transformSelection("mirrorV")}
              disabled={!selSize}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Flip Vertical
            </button>
            <button
              type="button"
              onClick={() => transformSelection("rot180")}
              disabled={!selSize}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Rotate 180°
            </button>
            {selSize && selSize.w === selSize.h && (
              <button
                type="button"
                onClick={() => transformSelection("rot90")}
                className="rounded border border-border bg-background px-3 py-1 text-xs"
              >
                Rotate 90°
              </button>
            )}
            <button
              type="button"
              onClick={fillSelectionWithPaint}
              disabled={!selSize || !paintColor}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Fill
            </button>
            <button
              type="button"
              onClick={() => setSelRect(null)}
              disabled={!selSize}
              className="rounded border border-border bg-background px-3 py-1 text-xs disabled:opacity-50"
            >
              Deselect
            </button>
          </div>
          {floating && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-emerald-500/40 bg-emerald-50/60 p-2 dark:bg-emerald-900/20">
              <span className="text-xs font-medium text-emerald-800 dark:text-emerald-200">
                {floating.origin ? "Move / Resize" : "Floating paste"}: {floating.w} × {floating.h} stitches
              </span>
              <span className="text-xs text-muted-foreground">
                Drag inside to move · drag any green corner to resize
                {floating.origin ? " · original location clears on Apply" : ""}
              </span>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={floating.lockAspect !== false}
                  onChange={(e) =>
                    setFloating((f) =>
                      f ? { ...f, lockAspect: e.target.checked } : f,
                    )
                  }
                />
                Lock aspect ratio
              </label>
              <button
                type="button"
                onClick={() => scaleFloating(0.5)}
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                ½×
              </button>
              <button
                type="button"
                onClick={() => scaleFloating(2)}
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                2×
              </button>
              <button
                type="button"
                onClick={resetFloatingSize}
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                Original size
              </button>
              <button
                type="button"
                onClick={applyFloating}
                className="rounded border border-emerald-600 bg-emerald-600 px-3 py-1 text-xs text-white"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={cancelFloating}
                className="rounded border border-border bg-background px-3 py-1 text-xs"
              >
                Cancel
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Fill colour:</span>
            <SwatchPicker palette={palette} value={paintColor} onChange={setPaintColor} />
          </div>
        </div>
      )}
      {/* Progress controls */}
      {mode === "progress" && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-3">
          <span className="text-xs text-muted-foreground">
            Tap or drag to mark stitches complete.
          </span>
          {progressStatsValue && (
            <span className="text-xs font-medium">
              {progressStatsValue.completed} / {progressStatsValue.totalStitchable} st ({progressStatsValue.percent}%)
            </span>
          )}
        </div>
      )}
      {/* Tile Fill controls */}
      {mode === "tileFill" && canEdit && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-3">
          <span className="text-xs text-muted-foreground">
            Tap any coloured area to select it — the whole connected patch fills at once.
          </span>
          <span className="text-xs text-muted-foreground">
            Selected: {tileFillSelection.size} st
          </span>
          <button
            type="button"
            onClick={onTileFillPickMotif}
            className="rounded border border-border bg-background px-3 py-1 text-xs"
          >
            {tileFillMotifName ? `Motif: ${tileFillMotifName}` : "Choose motif…"}
          </button>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Scale:</span>
            {([0.5, 1, 2, 3] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  // Only 1/2x needs the destructive-sampling warning, and only
                  // when actually switching TO it (not on every render, and
                  // not when it's already the active scale).
                  if (s === 0.5 && tileFillScale !== 0.5) {
                    const ok = window.confirm(
                      "Shrinking to \u00bd size samples the dominant colour of each 2\u00d72 block. On motifs with fine 1-stitch detail this can lose some of that detail. Flat colour-block motifs (most needlepoint) hold up well. Continue?",
                    );
                    if (!ok) return;
                  }
                  setTileFillScale(s);
                }}
                className={`rounded border px-2 py-1 text-xs ${
                  tileFillScale === s
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground"
                }`}
              >
                {s === 0.5 ? "\u00bdx" : `${s}x`}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              if (!onTileFillApply || tileFillSelection.size === 0) return;
              onTileFillApply(Array.from(tileFillSelection), tileFillScale);
              setTileFillSelection(new Set());
            }}
            disabled={tileFillSelection.size === 0 || !tileFillMotifName}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            Apply tile fill
          </button>
          <button
            type="button"
            onClick={() => setTileFillSelection(new Set())}
            disabled={tileFillSelection.size === 0}
            className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
          >
            Clear selection
          </button>
        </div>
      )}
      {/* Background controls (selection hint) */}
      {mode === "background" && canEdit && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-3">
          <span className="text-xs text-muted-foreground">
            Drag on the chart or tap a colour in the key to select stitches.
          </span>
          <span className="text-xs text-muted-foreground">
            Selected: {selection.size} st
          </span>
          <button
            type="button"
            onClick={() => setSelection(new Set())}
            disabled={selection.size === 0}
            className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
          >
            Clear selection
          </button>
        </div>
      )}
      {mode === "background" && canEdit && palette && (
        <div className="rounded-md border border-border bg-card p-4">
          <h4 className="font-serif text-lg">Background Fill</h4>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["solid", "stripes", "gingham", "bargello"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFillType(t)}
                className={`rounded border px-3 py-1 text-xs capitalize ${
                  fillType === t
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {fillType === "solid" && (
              <div className="flex items-center gap-3">
                <span className="text-sm">Thread:</span>
                <SwatchPicker
                  palette={palette}
                  value={solidColor}
                  onChange={setSolidColor}
                />
              </div>
            )}

            {fillType === "stripes" && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">Threads (2–4):</span>
                  {stripeColors.map((c, i) => (
                    <SwatchPicker
                      key={i}
                      palette={palette}
                      value={c}
                      onChange={(nc) =>
                        setStripeColors((arr) => {
                          const next = arr.slice();
                          next[i] = nc;
                          return next;
                        })
                      }
                    />
                  ))}
                  {stripeColors.length < 4 && (
                    <button
                      type="button"
                      onClick={() => setStripeColors((a) => [...a, null])}
                      className="rounded border border-border bg-background px-2 py-1 text-xs"
                    >
                      + Add
                    </button>
                  )}
                  {stripeColors.length > 2 && (
                    <button
                      type="button"
                      onClick={() => setStripeColors((a) => a.slice(0, -1))}
                      className="rounded border border-border bg-background px-2 py-1 text-xs"
                    >
                      − Remove
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    Width:
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={stripeWidth}
                      onChange={(e) =>
                        setStripeWidth(Math.max(1, Number(e.target.value) || 1))
                      }
                      className="w-16 rounded border border-border bg-background px-2 py-1 text-sm"
                    />
                    st
                  </label>
                  <div className="flex gap-2">
                    {(["horizontal", "vertical"] as const).map((o) => (
                      <button
                        key={o}
                        type="button"
                        onClick={() => setStripeOrientation(o)}
                        className={`rounded border px-3 py-1 text-xs capitalize ${
                          stripeOrientation === o
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background"
                        }`}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {fillType === "gingham" && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Base (light):</span>
                    <SwatchPicker
                      palette={palette}
                      value={ginghamColors[0]}
                      onChange={(nc) =>
                        setGinghamColors((arr) => { const next = arr.slice(); next[0] = nc; return next; })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Blend (mid):</span>
                    <SwatchPicker
                      palette={palette}
                      value={ginghamColors[1]}
                      onChange={(nc) =>
                        setGinghamColors((arr) => { const next = arr.slice(); next[1] = nc; return next; })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Main (dark):</span>
                    <SwatchPicker
                      palette={palette}
                      value={ginghamColors[2]}
                      onChange={(nc) =>
                        setGinghamColors((arr) => { const next = arr.slice(); next[2] = nc; return next; })
                      }
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  Check size:
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={ginghamBlockSize}
                    onChange={(e) => setGinghamBlockSize(Math.max(1, Number(e.target.value) || 1))}
                    className="w-16 rounded border border-border bg-background px-2 py-1 text-sm"
                  />
                  st per band
                </label>
                <p className="text-xs italic text-muted-foreground">
                  Classic woven check: pick a light base, a dark main, and the mid blend where they
                  cross -- like your original gingham motif's 4-stitch check.
                </p>
              </>
            )}

            {fillType === "bargello" && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm">Pattern:</span>
                  <select
                    value={bargelloPatternId}
                    onChange={(e) => setBargelloPatternId(e.target.value)}
                    className="rounded border border-border bg-background px-2 py-1 text-sm"
                  >
                    {BARGELLO_PATTERNS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">Threads (3–5):</span>
                  {bargelloColors.map((c, i) => (
                    <SwatchPicker
                      key={i}
                      palette={palette}
                      value={c}
                      onChange={(nc) =>
                        setBargelloColors((arr) => {
                          const next = arr.slice();
                          next[i] = nc;
                          return next;
                        })
                      }
                    />
                  ))}
                  {bargelloColors.length < 5 && (
                    <button
                      type="button"
                      onClick={() => setBargelloColors((a) => [...a, null])}
                      className="rounded border border-border bg-background px-2 py-1 text-xs"
                    >
                      + Add
                    </button>
                  )}
                  {bargelloColors.length > 3 && (
                    <button
                      type="button"
                      onClick={() => setBargelloColors((a) => a.slice(0, -1))}
                      className="rounded border border-border bg-background px-2 py-1 text-xs"
                    >
                      − Remove
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={applyFill}
              disabled={!fillReady}
              className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              Apply fill
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className={`space-y-6${isWide ? "" : " pb-[180px]"}`} style={isWide ? undefined : { paddingBottom: "calc(180px + env(safe-area-inset-bottom))" }}>
      {/* Persistent strip: Undo/Redo + Zoom -- always visible, never moves. */}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <>
            <button
              type="button"
              onClick={undo}
              disabled={past.length === 0}
              className="flex items-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <Undo2 size={15} aria-hidden="true" /> Undo
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={future.length === 0}
              className="flex items-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <Redo2 size={15} aria-hidden="true" /> Redo
            </button>
            <div className="mx-2 h-6 w-px bg-border" />
          </>
        )}
      {/* Zoom */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Zoom:</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.1, +(z - 0.25).toFixed(2)))}
          className="rounded border border-border bg-card px-2 py-1 text-xs"
          aria-label="Zoom out"
        >
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <span className="w-12 text-center text-xs font-medium">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
          className="rounded border border-border bg-card px-2 py-1 text-xs"
          aria-label="Zoom in"
        >
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="rounded border border-border bg-card px-2 py-1 text-xs"
        >
          Reset
        </button>
      </div>
      </div>

      {/* Anchored canvas: rail + panel are flex siblings of the canvas, so
          opening or closing a tool panel never shifts the canvas. */}
      {mode === "none" && (
        <p className="text-xs text-muted-foreground">
          No tool selected — drag on the chart to measure an area.
        </p>
      )}

      <div className={isWide ? "flex items-start gap-4" : "space-y-4"}>
        {isWide ? (
          <>
            {rail}
            {panel}
          </>
        ) : (
          <div className="fixed inset-x-0 bottom-0 z-40 flex flex-col bg-background" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
            {panel}
            {rail}
          </div>
        )}
        <div className="min-w-0 flex-1">
      <div className="overflow-auto rounded-md border border-border bg-white p-3">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            cursor: canvasCursor,
            touchAction: canvasTouchAction,
          }}
        />
      </div>
        </div>
      </div>

      <div>
        <h3 className="font-serif text-xl">Colour Key</h3>
        {canEdit && mode === "none" && (
          <p className="mt-1 text-xs text-muted-foreground">
            Tap any swatch to swap it for another shade across the whole chart.
          </p>
        )}
        {mode === "background" && (
          <p className="mt-1 text-xs text-muted-foreground">
            Tap a colour row to select every stitch of that shade.
          </p>
        )}
        <div className="mt-4 space-y-6">
          {chart.sections
            .filter((section) =>
              section.paletteIndexes.some((idx) => chart.palette[idx]?.id !== NOT_STITCHABLE),
            )
            .map((section) => (
              <div key={section.name}>
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  {section.name}
                </p>
                <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {section.paletteIndexes.map((idx) => {
                    const entry = chart.palette[idx];
                    if (!entry) return null;
                    if (entry.id === NOT_STITCHABLE) return null;
                    const sym = symbolFor(chart.symMap, idx, entry.id);
                  const count = usageFor(chart.usage, idx, entry.id);
                  const current: ThreadColor | null = palette
                    ? palette.find((c) => c.code === entry.id) ?? {
                        code: entry.id,
                        name: entry.name,
                        family: entry.family ?? "Other",
                        hex: entry.hex,
                      }
                    : null;
                  const rowContent = (
                    <>
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border font-mono text-sm"
                        style={{ backgroundColor: entry.hex, color: "#000" }}
                      >
                        {sym}
                      </span>
                      <div className="min-w-0 flex-1 text-sm text-left">
                        <div className="truncate font-medium">{entry.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {entry.id}
                          {entry.family ? ` · ${entry.family}` : ""} · {count} st
                        </div>
                      </div>
                    </>
                  );
                  if (mode === "background") {
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() => toggleAllOfColor(idx)}
                          className="flex w-full items-center gap-3 rounded border border-border bg-card px-3 py-2 hover:border-primary"
                        >
                          {rowContent}
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li
                      key={entry.id}
                      className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2"
                    >
                      {rowContent}
                      {canEdit && palette && mode === "none" && (
                        <SwatchPicker
                          compact
                          palette={palette}
                          value={current}
                          onChange={(c) => commit(replaceColor(chart, idx, c))}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
