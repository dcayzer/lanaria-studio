## Scope check first

Your call to bake the motif into `chartBase` at insert time (same treatment as the server-baked border) is architecturally sound given tonight's constraints. Justification from the code I read:

- `chartBaseRef` / `lastCompositeRef` / `recomposeChart` (index.tsx:1479-1554) are hard-wired to a **fixed** set of layer sources: border, text, monogram, each with its own dedicated position/state variable (`textPos`, `monogramPos`, `borderStyle`). Turning motifs into live layers would require a new variable-length `motifs[]` state array, position tracking per motif, dependency additions to the recompose `useEffect`, and a way for the Select/Move tool to know it's moving "a motif" vs "raw pixels". That's a materially bigger change.
- The existing Select/Move tool (`liftSelection` / `sampleFloating` in StitchChart.tsx) already works on any charted pixels via the `LAYER_SENTINEL` exclusion — so once a motif is baked, the user *can* reposition it, just without a persistent "this is a motif" identity. That's an acceptable tonight tradeoff.
- One caveat you should know: because insertion happens by folding motif pixels into `chartBase` via `mergeManualEdit`'s path, any subsequent text/monogram reposition that overlaps the motif will draw *on top* of it — same as today's text-over-border behaviour. Fine, but worth calling out. If motifs later become movable layers, they slot in at `layers[1..]` per the z-order invariant in `layer-model.ts`, no schema change needed.

Nothing else in scope looks unsound. Preloaded-empty-tonight is fine — the dialog just shows an empty section with copy.

## 1. Schema — new `motifs` table

Migration file `supabase/migrations/<ts>_motifs.sql`. Follows the exact 4-step CREATE/GRANT/RLS/POLICY structure from the existing `designs` migration.

```text
motifs
  id            uuid pk default gen_random_uuid()
  user_id       uuid null references auth.users(id) on delete cascade  -- NULL = preloaded
  name          text not null
  width         int  not null     -- native cells
  height        int  not null
  cells         jsonb not null    -- string[][] of thread codes + LAYER_SENTINEL
  thumbnail_url text null         -- optional; skip for v1, render preview from cells
  created_at    timestamptz not null default now()
  updated_at    timestamptz not null default now()
```

GRANTs: `select` to both `anon` and `authenticated` (so preloaded is readable pre-login too, matching how the app already renders publicly); `insert/update/delete` to `authenticated` only; `all` to `service_role`.

RLS policies:
- SELECT: `user_id is null or auth.uid() = user_id` — one policy covers both preloaded and own.
- INSERT: `auth.uid() = user_id` (blocks any client from writing `user_id = null`; preloaded rows are seeded server-side via a future migration).
- UPDATE / DELETE: `auth.uid() = user_id` (owner-only; preloaded rows are immutable from the client because `user_id is null` never matches `auth.uid()`).

Trigger: reuse existing `public.set_updated_at()` for `motifs_set_updated_at`. Index on `user_id`.

**Cells storage note:** `jsonb` for now — motifs are small (tens of cells per side) and this matches the `chart_data` jsonb convention in `designs`. If motifs grow, an RLE encoding is a later, non-breaking swap.

## 2. `src/lib/motif-library.ts`

Pure module — no React, no direct Supabase calls in the compositing helpers so it stays testable. Data fetching is a thin function that the UI calls.

Exports:

```text
export interface MotifRecord {
  id: string;
  userId: string | null;      // null = preloaded
  name: string;
  width: number;
  height: number;
  cells: string[][];          // uses LAYER_SENTINEL from layer-model conventions
  thumbnailUrl: string | null;
  updatedAt: string;
}

export async function listMotifs(): Promise<{
  mine: MotifRecord[];
  preloaded: MotifRecord[];
}>;
// Single Supabase select on public.motifs (RLS handles who sees what);
// partition by (userId === null) client-side.

export function motifToLayer(
  motif: MotifRecord,
  layerId: string,
  canvasW: number,
  canvasH: number,
  sentinel: string,
  opts?: { offset?: { x: number; y: number }; scale?: number },
): Layer;
// Uses makeLayer() from layer-model.ts. Default offset = centred:
//   x = floor((canvasW - motif.width * scale) / 2), same for y.
// Cells pass through verbatim (sentinel convention already matches).

export function insertMotifIntoChart(
  chartBase: ChartData,
  motif: MotifRecord,
  brandPalette: ThreadColor[],
  sentinel: string,
  canvasW: number,
  canvasH: number,
): ChartData;
// One-shot bake: builds the Layer, calls applyLayersToChart(chartBase, [layer], palette, sentinel),
// returns the new base. This is the function index.tsx calls on "Add to chart".
```

Preview rendering for the dialog uses the motif's `cells` painted into a small `<canvas>` — reuses the palette hex lookup already in `threadPalettes.ts`. No thumbnail_url needed for v1.

## 3. UI wiring in `src/routes/index.tsx`

**Button placement.** Add an "Add from Motif Library" button in the same toolbar row that already houses the Border / Text / Monogram controls in the chart-editing view (the same tab group `MyDesignsDialog` is opened from around line 2990). Same button styling as existing "My Designs" trigger.

**Dialog.** New `src/components/MotifLibraryDialog.tsx` modelled directly on `MyDesignsDialog.tsx` (same Dialog shell, loading state, empty state). Two sections stacked: "My Motifs" and "Preloaded". Preloaded shows an empty-state message tonight ("Preloaded motifs coming soon"). Each item: small canvas preview + name + "Add to chart" button. Sign-in gate on "My Motifs" mirrors the existing auth pattern (empty section + sign-in prompt when `!user`).

**"Add to chart" wiring — exact sequence** (fits the existing pipeline at index.tsx:1543-1554, no new refs, no new effect):

```text
1. Guard: chartBaseRef.current && lastCompositeRef.current && chartDataRef.current.
2. Fold pending manual edits, same as recompose effect:
     updatedBase = mergeManualEdit(chartBaseRef, lastCompositeRef, chartDataRef)
3. Bake motif into base:
     bakedBase = insertMotifIntoChart(updatedBase, motif, palette, LAYER_SENTINEL, W, H)
4. Recompose (still runs border/text/monogram overlays on top):
     next = recomposeChart(bakedBase, includeBorder)
5. chartBaseRef.current = bakedBase
   lastCompositeRef.current = next
   setChartData(next)
6. Close dialog.
```

That's it — no changes to `recomposeChart`, no new state, no new effect dependency, no touch to Select/Move code. Reposition-after-insert already works via the existing Select/Move tool.

**Edge cases handled explicitly:** motif larger than canvas → clamp offset to 0 and let `applyLayersToChart`'s existing bounds check clip (already implemented in `chart-layer-compositor.ts` paintLayer). No chart yet (`chartBaseRef` null) → button disabled with tooltip "Generate a chart first".

## 4. Credit estimate & session split

Suggested 3 sends:

- **Send A — schema + lib** (~small): migration + `src/lib/motif-library.ts`. Ends at type-check green. Cheapest of the three; migration approval is one round-trip.
- **Send B — UI + wiring** (~medium): new `MotifLibraryDialog.tsx` + the ~30-line wiring block in `index.tsx` + button in the toolbar. Largest send because it touches `index.tsx` and needs a new component file.
- **Send C — verification** (~small): manual test via Playwright — insert a hand-crafted motif row through `supabase--insert`, open dialog, add to chart, screenshot, then reposition with Select/Move to confirm no ghost. Cheap.

Rough order-of-magnitude: A is the smallest, B is 2-3x A, C is comparable to A. No image generation, no new dependencies, no changes to the chart edge function.

**Nothing in the scope call to push back on.** The only architectural note worth remembering is the reposition-without-identity tradeoff above — flagging it so it's not a surprise when a user drags a motif and then generates a text overlap.
