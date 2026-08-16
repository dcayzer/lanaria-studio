// Motif Library — read/add path.
//
// A motif is a small piece of hand-charted artwork stored as a grid of thread
// codes (with the `LAYER_SENTINEL` marking transparent/background cells, same
// convention layer-model.ts uses). Two audiences live in the same table:
//   - Preloaded motifs: rows with user_id = null, readable by everyone
//     (anon + authenticated). Seeded server-side; never editable from the app.
//   - Personal motifs: rows with user_id = auth.uid(), readable and editable
//     only by their owner.
// RLS enforces both; this module just does the fetch + partition and the
// motif -> Layer conversion.
//
// The "add to chart" path is a ONE-SHOT bake into chartBase (not a live
// draggable layer) for now -- see the scope note in the plan. The heavy
// lifting is delegated to applyLayersToChart from chart-layer-compositor.ts
// so this module stays a thin, palette-aware adapter.

import type { ChartData, ChartPaletteEntry } from "@/components/StitchChart";
import type { ThreadBrand, ThreadColor } from "@/data/threadPalettes";
import { supabase } from "@/integrations/supabase/client";
import { applyLayersToChart } from "./chart-layer-compositor";
import { type Layer, makeLayer } from "./layer-model";

export interface MotifRecord {
  id: string;
  /** null = preloaded (shipped with the app). Non-null = a user's own motif. */
  userId: string | null;
  name: string;
  brand: ThreadBrand;
  width: number;
  height: number;
  /** Row-major `cells[row][col]`; transparent cells hold the layer sentinel. */
  cells: string[][];
  thumbnailUrl: string | null;
  updatedAt: string;
}

interface MotifRow {
  id: string;
  user_id: string | null;
  name: string;
  brand: string;
  width: number;
  height: number;
  cells: unknown;
  thumbnail_url: string | null;
  updated_at: string;
}

function rowToRecord(row: MotifRow): MotifRecord | null {
  // Defensive: `cells` is jsonb -- validate shape before handing it downstream.
  // A malformed row shouldn't crash the whole dialog, just skip it.
  const cells = row.cells;
  if (!Array.isArray(cells)) return null;
  if (cells.length !== row.height) return null;
  for (const r of cells) {
    if (!Array.isArray(r) || r.length !== row.width) return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    brand: row.brand as ThreadBrand,
    width: row.width,
    height: row.height,
    cells: cells as string[][],
    thumbnailUrl: row.thumbnail_url,
    updatedAt: row.updated_at,
  };
}

/**
 * Fetch every motif visible to the caller (RLS decides which those are) and
 * partition into preloaded (user_id null) vs mine (owned by the caller).
 * Server-side filtered by brand: a mismatched-brand motif never reaches the
 * client, so `applyLayersToChart` can't hit an unknown thread code at runtime.
 */
export async function listMotifs(brand: ThreadBrand): Promise<{
  mine: MotifRecord[];
  preloaded: MotifRecord[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("motifs")
    .select("id, user_id, name, width, height, cells, brand, thumbnail_url, updated_at")
    .eq("brand", brand)
    .order("updated_at", { ascending: false });
  if (error) return { mine: [], preloaded: [], error: error.message };
  const mine: MotifRecord[] = [];
  const preloaded: MotifRecord[] = [];
  for (const row of (data ?? []) as MotifRow[]) {
    const rec = rowToRecord(row);
    if (!rec) continue;
    if (rec.userId === null) preloaded.push(rec);
    else mine.push(rec);
  }
  return { mine, preloaded, error: null };
}

/**
 * Save a new personal motif to the library from extracted chart cells.
 * `cells` is a flat, row-major array (length w*h) as produced by
 * StitchChart's onSaveAsMotif callback -- ChartPaletteEntry|null per cell,
 * null meaning "not part of the selection" (a lasso gap). Converted here to
 * the nested string[][] grid the `cells` jsonb column expects, with null
 * entries becoming `sentinel` (the same layer-transparency convention used
 * everywhere else) so a saved motif with gaps composites correctly later via
 * motifToLayer/applyLayersToChart, exactly like any other motif.
 *
 * Explicitly NOT doing automatic background removal here -- §11.2 of the
 * project's own plan flags that as needing real images to validate against
 * before building it. This saves the selection exactly as charted; the user
 * decides what to select.
 */
export async function saveMotif(
  name: string,
  brand: ThreadBrand,
  width: number,
  height: number,
  cells: (ChartPaletteEntry | null)[],
  sentinel: string,
  userId: string,
): Promise<{ id: string | null; error: string | null }> {
  if (cells.length !== width * height) {
    return { id: null, error: `cell count ${cells.length} does not match ${width}x${height}` };
  }
  const grid: string[][] = [];
  for (let r = 0; r < height; r++) {
    const row: string[] = [];
    for (let c = 0; c < width; c++) {
      const entry = cells[r * width + c];
      row.push(entry ? entry.id : sentinel);
    }
    grid.push(row);
  }
  const { data, error } = await supabase
    .from("motifs")
    .insert({
      user_id: userId,
      name,
      brand,
      width,
      height,
      cells: grid,
    })
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: data.id as string, error: null };
}

/** Default centred offset for a motif placed on a canvas of the given size. */
export function centeredOffset(
  motif: MotifRecord,
  canvasW: number,
  canvasH: number,
  scale: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.floor((canvasW - motif.width * scale) / 2)),
    y: Math.max(0, Math.floor((canvasH - motif.height * scale) / 2)),
  };
}

/**
 * Wrap a motif in a Layer suitable for `applyLayersToChart`. Cells pass
 * through verbatim -- the sentinel convention already matches layer-model.ts,
 * so no re-encoding is needed.
 */
export function motifToLayer(
  motif: MotifRecord,
  layerId: string,
  canvasW: number,
  canvasH: number,
  opts?: { offset?: { x: number; y: number }; scale?: number },
): Layer {
  const scale = opts?.scale ?? 1;
  const offset = opts?.offset ?? centeredOffset(motif, canvasW, canvasH, scale);
  return makeLayer({
    id: layerId,
    kind: "motif",
    cells: motif.cells,
    offset,
    scale,
  });
}

/**
 * One-shot bake: composite the motif onto `chartBase` and return the new
 * base. Overlapping cells (non-sentinel motif cells) overwrite whatever was
 * underneath -- the same behaviour as text/monogram overlays today.
 * Out-of-bounds motif cells are clipped by paintLayer (already handled).
 */
export function insertMotifIntoChart(
  chartBase: ChartData,
  motif: MotifRecord,
  brandPalette: ThreadColor[],
  sentinel: string,
  opts?: { offset?: { x: number; y: number }; scale?: number },
): ChartData {
  const layer = motifToLayer(motif, `motif-${motif.id}`, chartBase.width, chartBase.height, opts);
  return applyLayersToChart(chartBase, [layer], brandPalette, sentinel);
}

/**
 * Every motif the caller owns, across ALL brands, newest first. Distinct from
 * `listMotifs(brand)` -- that one is for the in-context picker while charting
 * (brand-filtered, so a mismatched-brand motif can never reach
 * applyLayersToChart). This one is for browsing your whole library in
 * Account, where there's no "current brand" to filter by.
 */
export async function listMyMotifs(): Promise<{ motifs: MotifRecord[]; error: string | null }> {
  const { data, error } = await supabase
    .from("motifs")
    .select("id, user_id, name, width, height, cells, brand, thumbnail_url, updated_at")
    .not("user_id", "is", null)
    .order("updated_at", { ascending: false });
  if (error) return { motifs: [], error: error.message };
  const motifs: MotifRecord[] = [];
  for (const row of (data ?? []) as MotifRow[]) {
    const rec = rowToRecord(row);
    if (rec) motifs.push(rec);
  }
  return { motifs, error: null };
}

export async function renameMotif(id: string, name: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("motifs").update({ name }).eq("id", id);
  return { error: error?.message ?? null };
}

export async function deleteMotif(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("motifs").delete().eq("id", id);
  return { error: error?.message ?? null };
}
