// Bridge: chart engine output (outUsage / usage) -> thread-calculator plans.
//
// The master list (§8.4) named this as the remaining ARCHITECTURAL item for the
// thread calculator: turn the chart's per-colour cell counts into physical
// thread quantities to buy. calcThreadNeeded already does the per-colour
// cellCount -> sqInches -> yards math; this module is the glue that takes the
// engine's actual usage structure + a thread selection and produces a ready
// shopping list, plus a whole-project roll-up.
//
// SHAPE NOTE (deliberate): per-colour cellCount is already shape-correct for
// non-rectangular canvases (§8.6/§8.7) -- masked NOT_STITCHABLE cells are never
// painted, so they never appear in usage. Therefore thread estimation needs NO
// special handling for circles/stockings; only the WHOLE-canvas fabric-size
// figure should come from stitchableSquareInches(), never from summing usage.
// A sentinel bucket must never become a thread line, so excludeIds guards it.
//
// INTEGRATION NOTE (reconcile before shipping, same discipline as the other
// sandbox modules): the exact field names on the real ChartData -- whether the
// engine field is `outUsage` or `usage`, and whether a usage entry keys on a
// palette index, a thread code, or a colour id -- must be checked against
// StitchChart.tsx's real exported type before wiring. This module accepts all
// three plausible usage shapes (object, array-of-records, index-aligned array)
// so the caller adapts without this module having to guess a single shape.

import {
  calcThreadNeeded,
  type CalcInput,
  type CalcResult,
  type StitchType,
  type KnownThreadKey,
  type GenericThreadInput,
} from "./thread-calculator";

/** A documented default for the canvas-shape mask sentinel (§8.7). Replace the
 *  string with the real exported NOT_STITCHABLE constant at wiring time; kept
 *  configurable via excludeIds so this module never hard-depends on its value. */
export const DEFAULT_NOT_STITCHABLE_ID = "NOT_STITCHABLE";

/** Per-colour thread choice. Mirrors the knobs calcThreadNeeded accepts, minus
 *  the cellCount/mesh/stitchType that come from the chart + a single UI input. */
export interface ThreadSelection {
  knownThreadKey?: KnownThreadKey;
  generic?: GenericThreadInput;
  strandsUsed?: number;
  safetyMargin?: boolean;
}

/** Optional palette entry shape, used only to resolve a colourId/label when
 *  usage is supplied as an index-aligned number[]. Kept minimal on purpose. */
export interface PaletteEntryLike {
  id?: string;
  code?: string;
  name?: string;
}

/** The three usage shapes the real ChartData is known to possibly use. */
export type UsageInput =
  | Record<string, number>
  | Array<{ id?: string; code?: string; name?: string; count: number }>
  | number[];

export interface BuildPlansInput {
  usage: UsageInput;
  mesh: number;
  stitchType: StitchType;
  /** One selection applied to every colour, OR a per-colourId map. A per-colour
   *  map may omit colours, in which case `defaultThread` (if given) is used. */
  thread: ThreadSelection | Record<string, ThreadSelection>;
  defaultThread?: ThreadSelection;
  /** Needed only when usage is a number[] and you want real colour ids/labels. */
  palette?: PaletteEntryLike[];
  /** Ids/codes to drop entirely (e.g. the NOT_STITCHABLE sentinel). */
  excludeIds?: Iterable<string>;
  /** Drop colours with a cell count of 0 (default true). */
  dropEmpty?: boolean;
}

export interface ColourThreadPlan extends CalcInput {
  colourId: string;
  label?: string;
}

/** Normalise any of the three usage shapes into {id,label,count}[]. */
export function normaliseUsage(
  usage: UsageInput,
  palette?: PaletteEntryLike[],
): Array<{ id: string; label?: string; count: number }> {
  // number[] aligned to palette order
  if (Array.isArray(usage) && (usage.length === 0 || typeof usage[0] === "number")) {
    return (usage as number[]).map((count, i) => {
      const p = palette?.[i];
      const id = p?.id ?? p?.code ?? String(i);
      return { id, label: p?.name ?? p?.code, count };
    });
  }
  // array of records
  if (Array.isArray(usage)) {
    return (usage as Array<{ id?: string; code?: string; name?: string; count: number }>).map((e, i) => {
      const id = e.id ?? e.code ?? String(i);
      return { id, label: e.name ?? e.code, count: e.count };
    });
  }
  // object form: key -> count
  return Object.entries(usage).map(([id, count]) => ({ id, count }));
}

function selectionFor(
  colourId: string,
  thread: BuildPlansInput["thread"],
  defaultThread?: ThreadSelection,
): ThreadSelection {
  // A ThreadSelection has known/generic/strandsUsed/safetyMargin; a per-colour
  // map is any object that is NOT itself a ThreadSelection. Distinguish by
  // checking for the selection's own known keys.
  const looksLikeSelection =
    "knownThreadKey" in (thread as object) ||
    "generic" in (thread as object) ||
    "strandsUsed" in (thread as object) ||
    "safetyMargin" in (thread as object);
  if (looksLikeSelection) return thread as ThreadSelection;
  const map = thread as Record<string, ThreadSelection>;
  const sel = map[colourId] ?? defaultThread;
  if (!sel) {
    throw new Error(
      `thread-calculator-bridge: no thread selection for colour "${colourId}" and no defaultThread given.`,
    );
  }
  return sel;
}

/** Build one ColourThreadPlan per stitched colour, ready for calcThreadNeeded. */
export function buildThreadPlans(input: BuildPlansInput): ColourThreadPlan[] {
  const exclude = new Set(input.excludeIds ?? [DEFAULT_NOT_STITCHABLE_ID]);
  const dropEmpty = input.dropEmpty ?? true;
  const rows = normaliseUsage(input.usage, input.palette);
  const plans: ColourThreadPlan[] = [];
  for (const row of rows) {
    if (exclude.has(row.id)) continue;
    if (dropEmpty && row.count <= 0) continue;
    const sel = selectionFor(row.id, input.thread, input.defaultThread);
    plans.push({
      colourId: row.id,
      label: row.label,
      cellCount: row.count,
      mesh: input.mesh,
      stitchType: input.stitchType,
      knownThreadKey: sel.knownThreadKey,
      generic: sel.generic,
      strandsUsed: sel.strandsUsed,
      safetyMargin: sel.safetyMargin,
    });
  }
  return plans;
}

export interface ColourShoppingLine {
  colourId: string;
  label?: string;
  cellCount: number;
  result?: CalcResult;
  /** Present instead of `result` when calcThreadNeeded threw (e.g. a mesh with
   *  no sourced strand guidance) -- surfaced, never swallowed. */
  error?: string;
}

export interface ThreadShoppingSummary {
  lines: ColourShoppingLine[];
  totalYards: number;
  /** Sum of unitsNeeded across colours that resolved to a real unit count. */
  totalUnits: number;
  /** Colours that couldn't be computed (thrown or unknown skein size). */
  unresolved: string[];
}

/** Run the whole project and roll up a shopping summary. A per-colour throw is
 *  captured onto that line rather than aborting the whole list, so one
 *  unsourced colour never blocks the rest of the estimate. */
export function estimateProjectThreads(input: BuildPlansInput): ThreadShoppingSummary {
  const plans = buildThreadPlans(input);
  const lines: ColourShoppingLine[] = [];
  let totalYards = 0;
  let totalUnits = 0;
  const unresolved: string[] = [];

  for (const plan of plans) {
    const { colourId, label, ...calcInput } = plan;
    const cellCount = calcInput.cellCount;
    try {
      const result = calcThreadNeeded(calcInput);
      lines.push({ colourId, label, cellCount, result });
      totalYards += result.yardsNeeded;
      if (result.unitsNeeded != null) totalUnits += result.unitsNeeded;
      else unresolved.push(colourId);
    } catch (e) {
      lines.push({ colourId, label, cellCount, error: (e as Error).message });
      unresolved.push(colourId);
    }
  }
  return { lines, totalYards, totalUnits, unresolved };
}
