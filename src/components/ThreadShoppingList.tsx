// Thread Shopping List panel — surfaces the thread-calculator bridge in the UI.
// Standalone, StitchChart doesn't know about it (same pattern as Tile Fill /
// Motif Library).
//
// Usage-normalisation fix: ChartData.usage may be Record<string, number> keyed
// by STRING palette index ("0","1",...). Feeding that straight to the bridge
// would yield rows labelled "0","1","2". We flatten to an index-aligned
// number[] and pass `palette` alongside, so the bridge resolves real
// codes/names for each row.

import { useMemo, useState } from "react";
import type { ChartData, ChartPaletteEntry } from "@/components/StitchChart";
import type { ThreadBrand } from "@/data/threadPalettes";
import { NOT_STITCHABLE } from "@/lib/canvas-shape-mask";
import { estimateProjectThreads } from "@/lib/thread-calculator-bridge";
import type { KnownThreadKey, StitchType } from "@/lib/thread-calculator";
import type { StashEntry } from "@/lib/thread-inventory";
import { suggestFromStash } from "@/lib/thread-swap-bridge";

interface Props {
  chart: ChartData | null;
  meshCount: number;
  threadBrand: ThreadBrand | null;
  /** The signed-in user's thread stash, for "you already have a close match"
   *  suggestions. Omit (or pass []) to render exactly as before. */
  stash?: StashEntry[];
}


/**
 * Appletons colour numbers are the SAME whether you buy crewel or tapestry
 * wool, and DMC perle colours are the same across sizes 3 and 5 -- only the
 * thickness differs, and the right thickness is decided by canvas mesh. So
 * the brand picks the colour range; this picks the physical product.
 */
interface ThreadVariant { key: KnownThreadKey; label: string; note: string }

const BRAND_VARIANTS: Record<string, ThreadVariant[]> = {
  appletons: [
    { key: "appletons-tapestry", label: "Tapestry", note: "Thicker 4-ply, one strand. Best on 10-12 mesh." },
    { key: "appletons-crewel", label: "Crewel", note: "Finer 2-ply, several strands together. Best on 13-18 mesh." },
  ],
  dmc: [
    { key: "dmc-perle-3", label: "No. 3", note: "The heavier perle, for coarser canvas (about 12-14 mesh)." },
    { key: "dmc-perle-5", label: "No. 5", note: "The finer perle, for 16-18 mesh." },
  ],
};

/**
 * Mesh-driven default. Taken from the strand guidance already sourced in
 * thread-calculator: tapestry wool is workable at 10-12, discouraged at 13
 * and explicitly not appropriate at 14 or 18, where crewel takes over.
 */
function defaultVariantFor(brand: ThreadBrand | null, mesh: number): KnownThreadKey | null {
  if (brand === "appletons") return mesh <= 12 ? "appletons-tapestry" : "appletons-crewel";
  if (brand === "dmc") return mesh >= 16 ? "dmc-perle-5" : "dmc-perle-3";
  return null;
}

function normaliseChartUsage(chart: ChartData): number[] {
  const usage = chart.usage;
  return chart.palette.map((_, i) =>
    Array.isArray(usage) ? (usage[i] ?? 0) : (usage?.[String(i)] ?? 0),
  );
}

function fmt(n: number, dp = 1): string {
  return n.toFixed(dp);
}

export function ThreadShoppingList({ chart, meshCount, threadBrand, stash = [] }: Props) {
  const [stitchType, setStitchType] = useState<StitchType>("basketweave");
  /** null means "follow the mesh"; set only when the user overrides. */
  const [variantOverride, setVariantOverride] = useState<KnownThreadKey | null>(null);

  const variants = threadBrand ? (BRAND_VARIANTS[threadBrand] ?? []) : [];
  // An override from a previously-selected brand must not leak across, so it
  // only counts if it belongs to the brand currently chosen.
  const overrideValid = variantOverride != null && variants.some((v) => v.key === variantOverride);
  const knownThreadKey = overrideValid ? variantOverride : defaultVariantFor(threadBrand, meshCount);
  const activeVariant = variants.find((v) => v.key === knownThreadKey) ?? null;

  const summary = useMemo(() => {
    if (!chart || !knownThreadKey) return null;
    const usage = normaliseChartUsage(chart);
    return estimateProjectThreads({
      usage,
      palette: chart.palette,
      mesh: meshCount,
      stitchType,
      thread: { knownThreadKey },
      excludeIds: [NOT_STITCHABLE],
    });
  }, [chart, meshCount, stitchType, knownThreadKey]); // knownThreadKey covers the variant choice

  if (!chart) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
        Generate a chart to see your thread shopping list.
      </div>
    );
  }

  if (!knownThreadKey) {
    return (
      <div className="rounded-md border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Thread Shopping List</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose a thread brand first to see how much of each colour you'll need.
        </p>
      </div>
    );
  }

  const paletteById = new Map<string, ChartPaletteEntry>(
    chart.palette.map((p) => [p.id, p]),
  );

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Thread Shopping List</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Stitch:</span>
          {(["basketweave", "continental"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStitchType(s)}
              className={`rounded border px-2 py-1 capitalize ${
                stitchType === s
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {variants.length > 0 && (
        <div className="mt-3 rounded border border-border bg-background/60 p-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Thread:</span>
            {variants.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setVariantOverride(v.key)}
                className={`rounded border px-2 py-1 ${
                  knownThreadKey === v.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground"
                }`}
              >
                {v.label}
              </button>
            ))}
            {overrideValid && (
              <button
                type="button"
                onClick={() => setVariantOverride(null)}
                className="rounded border border-border bg-background px-2 py-1 text-muted-foreground"
                title="Go back to the thread suggested by your canvas mesh"
              >
                Use mesh default
              </button>
            )}
          </div>
          {activeVariant && (
            <p className="mt-1 text-[11px] italic text-muted-foreground">
              {activeVariant.note}
              {!overrideValid && ` Suggested for your ${meshCount}-mesh canvas.`}
            </p>
          )}
        </div>
      )}

      <ul className="mt-3 divide-y divide-border">
        {summary?.lines.map((line) => {
          const entry = paletteById.get(line.colourId);
          const hex = entry?.hex ?? "#cccccc";
          const displayName = line.label ?? entry?.name ?? line.colourId;
          const code = entry?.id ?? line.colourId;

          if (line.error) {
            return (
              <li key={line.colourId} className="flex items-start gap-3 py-2 text-sm">
                <span
                  className="mt-1 inline-block h-4 w-4 shrink-0 rounded border border-border"
                  style={{ backgroundColor: hex }}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {displayName}{" "}
                    <span className="text-xs text-muted-foreground">({code})</span>
                  </div>
                  <div className="text-xs text-amber-700">
                    Couldn't estimate: {line.error}
                  </div>
                </div>
              </li>
            );
          }

          const r = line.result!;
          const yardsText =
            r.yardsRange.min !== r.yardsRange.max
              ? `${fmt(r.yardsRange.min)}–${fmt(r.yardsRange.max)} yd`
              : `${fmt(r.yardsNeeded)} yd`;

          let unitsText: string;
          if (r.unitsNeeded == null || r.unitsRange == null) {
            unitsText = "—";
          } else if (r.unitsRange.min !== r.unitsRange.max) {
            unitsText = `${r.unitsRange.min}–${r.unitsRange.max} skeins`;
          } else {
            unitsText = `${r.unitsNeeded} skein${r.unitsNeeded === 1 ? "" : "s"}`;
          }

          return (
            <li key={line.colourId} className="flex items-start gap-3 py-2 text-sm">
              <span
                className="mt-1 inline-block h-4 w-4 shrink-0 rounded border border-border"
                style={{ backgroundColor: hex }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <div className="font-medium">
                    {displayName}{" "}
                    <span className="text-xs text-muted-foreground">({code})</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {line.cellCount.toLocaleString()} stitches
                  </div>
                </div>
                <div className="text-xs">
                  {yardsText} · {unitsText}
                </div>
                {r.orderBlurb && (
                  <p className="mt-1 text-xs italic text-muted-foreground">
                    {r.orderBlurb}
                  </p>
                )}
                {(() => {
                  if (!threadBrand) return null;
                  const s = suggestFromStash(threadBrand, code, stash);
                  if (!s) return null;
                  if (s.exact) {
                    return (
                      <p className="mt-1 text-xs font-medium text-emerald-700">
                        ✓ You have {s.onHand} {s.unit}
                        {s.onHand === 1 ? "" : "s"} of this already
                      </p>
                    );
                  }
                  return (
                    <p className="mt-1 text-[11px] text-sky-700">
                      ≈ Close match in your stash: {s.name ?? s.code} ({s.brand}), {s.onHand}{" "}
                      {s.unit}
                      {s.onHand === 1 ? "" : "s"} on hand
                    </p>
                  );
                })()}
              </div>

            </li>
          );
        })}
      </ul>

      {summary && (
        <div className="mt-3 border-t border-border pt-3 text-sm">
          <div>
            Total yardage:{" "}
            <span className="font-semibold">{fmt(summary.totalYards)} yd</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Skeins are bought per colour — a summed total across colours isn't
            meaningful, so buy the per-colour amount shown above.
          </p>
        </div>
      )}
    </div>
  );
}
