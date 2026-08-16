// Composite layers (border / text / monogram — see layer-model.ts) onto an
// EXISTING ChartData, which may already hold a full multi-colour image
// (from the chart edge function), not just a flat fill.
//
// compositor.ts's `composite()` only knows how to paint onto a scalar
// `background` colour — fine for the abstract layer-model tests, but the
// real base is usually an image-derived chart with hundreds of distinct
// thread codes. This module bridges that gap: it expands the base chart's
// palette-indexed pixels into a code grid, paints the layers on top (same
// bottom-to-top, sentinel-skipping logic as compositor.ts), and rebuilds a
// proper ChartData — reusing whichever ChartPaletteEntry each code already
// had (from the base chart's own palette, or from resolving a NEW code
// against the brand palette for codes a layer introduces that the base
// didn't already contain).
//
// This is the function index.tsx's chart-generation flow would call in place
// of today's stampTextOnChart / stampBorderOnChart — see the wiring sketch.

import type { ChartData, ChartPaletteEntry } from "@/components/StitchChart";
import type { ThreadColor } from "@/data/threadPalettes";
import type { Layer } from "./layer-model";

function threadToEntry(c: ThreadColor): ChartPaletteEntry {
  return { id: c.code, name: c.name, family: c.family, hex: c.hex };
}

/** Expand a ChartData's RLE pixels into a row-major grid of thread CODES. */
export function chartToCodeGrid(chart: ChartData): string[][] {
  const total = chart.width * chart.height;
  const flat = new Array<string>(total);
  let i = 0;
  for (const [idx, len] of chart.pixelsRLE) {
    const code = chart.palette[idx]?.id ?? "";
    for (let n = 0; n < len && i < total; n++) flat[i++] = code;
  }
  const grid: string[][] = [];
  for (let y = 0; y < chart.height; y++) {
    grid.push(flat.slice(y * chart.width, (y + 1) * chart.width));
  }
  return grid;
}

/**
 * Rebuild a ChartData from a code grid, given a lookup for what
 * ChartPaletteEntry each code corresponds to. Codes with no entry in the
 * lookup are skipped (defensive — should not happen if callers only ever
 * introduce codes the lookup covers).
 */
export function codeGridToChart(
  grid: string[][],
  entryFor: (code: string) => ChartPaletteEntry | undefined,
): ChartData {
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  const seen = new Map<string, number>();
  const palette: ChartPaletteEntry[] = [];
  const pxIdx = new Uint16Array(width * height);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const code = grid[y][x];
      let idx = seen.get(code);
      if (idx === undefined) {
        const entry = entryFor(code);
        if (!entry) {
          throw new Error(`codeGridToChart: no palette entry for code "${code}"`);
        }
        idx = palette.length;
        palette.push(entry);
        seen.set(code, idx);
      }
      pxIdx[i++] = idx;
    }
  }

  const SYMBOLS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*+=?<>/\\|~○●□■△▲▽▼◇◆☆★";
  const usage: Record<string, number> = {};
  const symMap: Record<string, string> = {};
  palette.forEach((_, idx) => {
    symMap[String(idx)] = SYMBOLS[idx % SYMBOLS.length];
  });
  for (let n = 0; n < pxIdx.length; n++) {
    const k = String(pxIdx[n]);
    usage[k] = (usage[k] ?? 0) + 1;
  }
  const sectionMap = new Map<string, number[]>();
  palette.forEach((p, idx) => {
    const fam = p.family ?? "Other";
    const list = sectionMap.get(fam) ?? [];
    list.push(idx);
    sectionMap.set(fam, list);
  });
  const sections = [...sectionMap.entries()].map(([name, paletteIndexes]) => ({
    name,
    paletteIndexes,
  }));
  const pixelsRLE: Array<[number, number]> = [];
  if (pxIdx.length > 0) {
    let runIdx = pxIdx[0];
    let runLen = 1;
    for (let n = 1; n < pxIdx.length; n++) {
      if (pxIdx[n] === runIdx) runLen++;
      else {
        pixelsRLE.push([runIdx, runLen]);
        runIdx = pxIdx[n];
        runLen = 1;
      }
    }
    pixelsRLE.push([runIdx, runLen]);
  }

  return { width, height, palette, usage, symMap, sections, pixelsRLE };
}

/**
 * Paint one layer's cells onto an existing code grid, in place. Same
 * bottom-to-top, sentinel-skipping, integer-block-expansion semantics as
 * compositor.ts's paintLayer — duplicated here rather than imported because
 * it operates on string[][] (mutable, chart-sized) instead of building a
 * fresh Grid, and clips the same way.
 */
function paintLayerOntoCodeGrid(
  grid: string[][],
  layer: Layer,
  canvasW: number,
  canvasH: number,
  sentinel: string,
): void {
  const { cells, width, height, scale } = layer;
  const ox = layer.offset.x;
  const oy = layer.offset.y;
  for (let r = 0; r < height; r++) {
    const row = cells[r];
    for (let c = 0; c < width; c++) {
      const value = row[c];
      if (value === sentinel) continue;
      const blockX0 = ox + c * scale;
      const blockY0 = oy + r * scale;
      for (let dy = 0; dy < scale; dy++) {
        const y = blockY0 + dy;
        if (y < 0 || y >= canvasH) continue;
        for (let dx = 0; dx < scale; dx++) {
          const x = blockX0 + dx;
          if (x < 0 || x >= canvasW) continue;
          grid[y][x] = value;
        }
      }
    }
  }
}

/**
 * Composite layers (bottom -> top) onto an EXISTING chart (image-derived or
 * blank) and return a fresh ChartData. `brandPalette` is only used to resolve
 * ChartPaletteEntry metadata for any thread codes a layer introduces that the
 * base chart didn't already contain (layers store already-RESOLVED codes —
 * see glyph-layers.ts / border-layers.ts — so no colour matching happens
 * here, only palette-entry lookup).
 */
export function applyLayersToChart(
  base: ChartData,
  layers: Layer[],
  brandPalette: ThreadColor[],
  sentinel: string,
): ChartData {
  if (layers.length === 0) return base;
  const grid = chartToCodeGrid(base);
  for (const layer of layers) {
    paintLayerOntoCodeGrid(grid, layer, base.width, base.height, sentinel);
  }

  const baseEntryByCode = new Map<string, ChartPaletteEntry>();
  for (const p of base.palette) baseEntryByCode.set(p.id, p);
  const brandEntryByCode = new Map<string, ChartPaletteEntry>();
  for (const t of brandPalette) brandEntryByCode.set(t.code, threadToEntry(t));

  return codeGridToChart(
    grid,
    (code) => baseEntryByCode.get(code) ?? brandEntryByCode.get(code),
  );
}
