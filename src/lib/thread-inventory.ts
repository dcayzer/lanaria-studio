/**
 * thread-inventory.ts — Delaney's thread stash, and reconciliation against the
 * Thread Shopping List (§25.3).
 *
 * Deliberately decoupled from ThreadShoppingList.tsx and StitchChart.tsx, the same
 * architectural pattern already used for Tile Fill, the Motif Library and the
 * shopping list itself: this module knows nothing about React and nothing about
 * charts. Its only input is (a) what you own and (b) what the existing
 * thread-calculator-bridge already computed you need.
 */

/** A product unit as the thread calculator already reports it. Never compared across units. */
export type ThreadUnit = 'skein' | 'card' | 'hank' | 'spool';

/** One line of what Delaney actually owns. */
export interface StashEntry {
  /** Brand as the app already spells it, e.g. "Appletons". Compared case-insensitively. */
  brand: string;
  /** Thread code, e.g. "241". Compared case-insensitively, whitespace-trimmed. */
  code: string;
  /** Optional human name, for display only — never used for matching. */
  name?: string;
  /** How many whole units are on hand. Fractions allowed (a half-used skein). */
  quantity: number;
  unit: ThreadUnit;
  /** Free-text, e.g. "Cotswolds box, second drawer". Display only. */
  location?: string;
  /** ISO date this line was last edited. Display only. */
  updatedAt?: string;
}

/**
 * One requirement row, as produced by thread-calculator-bridge's shopping list.
 * Deliberately a narrow structural shape rather than an import of the bridge's own
 * type — this module must not force a dependency direction that doesn't exist yet.
 */
export interface RequirementRow {
  brand: string;
  code: string;
  name?: string;
  /** Low end of the calculator's "buy N-M" range. */
  needMin: number;
  /** High end of the calculator's "buy N-M" range. Equal to needMin when it isn't a range. */
  needMax: number;
  unit: ThreadUnit;
}

export type StockStatus =
  /** On hand covers even the top of the calculator's range. Buy nothing. */
  | 'sufficient'
  /** Covers the bottom of the range but not the top. Might be enough; might not. */
  | 'likely-sufficient'
  /** Below even the low end. Definitely need more. */
  | 'short'
  /** Nothing recorded for this colour at all — distinct from recording a zero. */
  | 'not-in-stash'
  /**
   * Owned, but recorded in a different unit than the calculator quoted.
   * Deliberately NOT silently converted — a skein and a hank are not interchangeable
   * and guessing here would produce a confidently wrong "you have enough".
   */
  | 'unit-mismatch';

export interface ReconciledRow extends RequirementRow {
  status: StockStatus;
  /** Units on hand in the SAME unit as the requirement. 0 when not-in-stash or unit-mismatch. */
  onHand: number;
  /** How many more to buy to clear the top of the range. 0 when sufficient. Null when unknowable. */
  shortfallToMax: number | null;
  /** How many more to buy to clear the bottom of the range. 0 when at or above it. Null when unknowable. */
  shortfallToMin: number | null;
  /** Present only for unit-mismatch, so the UI can explain rather than just warn. */
  stashUnit?: ThreadUnit;
  stashQuantity?: number;
}

export interface ReconciliationSummary {
  rows: ReconciledRow[];
  /** Colours needing a definite purchase (status 'short' or 'not-in-stash'). */
  mustBuy: number;
  /** Colours that may need topping up (status 'likely-sufficient'). */
  mayNeedMore: number;
  /** Colours fully covered. */
  covered: number;
  /** Colours whose stash line couldn't be compared (status 'unit-mismatch'). */
  uncomparable: number;
}

/** Matching key. Brand AND code both matter — Appletons 241 is not DMC 241. */
export function stashKey(brand: string, code: string): string {
  return `${brand.trim().toLowerCase()}::${code.trim().toLowerCase()}`;
}

/**
 * Collapses a stash list into a lookup. Duplicate lines for the same brand+code AND
 * unit are summed (two half-skeins in two boxes is one skein's worth), which is the
 * behaviour a physical stash actually has. Duplicates in DIFFERENT units are kept
 * separately and will surface as a unit-mismatch rather than being merged.
 */
export function indexStash(stash: StashEntry[]): Map<string, Map<ThreadUnit, number>> {
  const index = new Map<string, Map<ThreadUnit, number>>();
  for (const entry of stash) {
    const key = stashKey(entry.brand, entry.code);
    let byUnit = index.get(key);
    if (!byUnit) {
      byUnit = new Map<ThreadUnit, number>();
      index.set(key, byUnit);
    }
    byUnit.set(entry.unit, (byUnit.get(entry.unit) ?? 0) + entry.quantity);
  }
  return index;
}

/** Rounds up to a whole purchasable unit — you cannot buy 0.4 of a skein. */
function unitsToBuy(shortfall: number): number {
  return shortfall <= 0 ? 0 : Math.ceil(shortfall);
}

/**
 * The core reconciliation. Pure, synchronous, no I/O — so it can be unit-tested
 * exhaustively and called on every render without cost.
 */
export function reconcileStash(
  requirements: RequirementRow[],
  stash: StashEntry[],
): ReconciliationSummary {
  const index = indexStash(stash);
  const rows: ReconciledRow[] = requirements.map((req) => {
    const byUnit = index.get(stashKey(req.brand, req.code));

    if (!byUnit || byUnit.size === 0) {
      return {
        ...req,
        status: 'not-in-stash',
        onHand: 0,
        shortfallToMin: unitsToBuy(req.needMin),
        shortfallToMax: unitsToBuy(req.needMax),
      };
    }

    const onHand = byUnit.get(req.unit);

    if (onHand === undefined) {
      // Owned in some unit, but not the one quoted. Report it; do not convert.
      const [stashUnit, stashQuantity] = [...byUnit.entries()][0];
      return {
        ...req,
        status: 'unit-mismatch',
        onHand: 0,
        shortfallToMin: null,
        shortfallToMax: null,
        stashUnit,
        stashQuantity,
      };
    }

    const shortfallToMin = unitsToBuy(req.needMin - onHand);
    const shortfallToMax = unitsToBuy(req.needMax - onHand);

    let status: StockStatus;
    if (onHand >= req.needMax) status = 'sufficient';
    else if (onHand >= req.needMin) status = 'likely-sufficient';
    else status = 'short';

    return { ...req, status, onHand, shortfallToMin, shortfallToMax };
  });

  return {
    rows,
    mustBuy: rows.filter((r) => r.status === 'short' || r.status === 'not-in-stash').length,
    mayNeedMore: rows.filter((r) => r.status === 'likely-sufficient').length,
    covered: rows.filter((r) => r.status === 'sufficient').length,
    uncomparable: rows.filter((r) => r.status === 'unit-mismatch').length,
  };
}

/**
 * The "what do I actually need to order" list — only rows that need buying, with the
 * quantity reduced by what's already owned. This is what a Copy/Export button should
 * emit, NOT the raw shopping list, which is the whole point of the feature.
 *
 * Deliberately quotes a range, matching the calculator's own honesty about ranges,
 * rather than collapsing to a single number the calculator never claimed.
 */
export function buildTopUpList(summary: ReconciliationSummary): ReconciledRow[] {
  return summary.rows.filter(
    (r) => r.status === 'short' || r.status === 'not-in-stash' || r.status === 'likely-sufficient',
  );
}

/**
 * Applies a completed purchase back into the stash — so ordering thread and then
 * owning it isn't a separate manual data-entry chore. Returns a NEW array; never mutates.
 */
export function applyPurchase(
  stash: StashEntry[],
  purchases: Array<{ brand: string; code: string; name?: string; quantity: number; unit: ThreadUnit }>,
  now: string,
): StashEntry[] {
  const next = stash.map((e) => ({ ...e }));
  for (const p of purchases) {
    if (p.quantity <= 0) continue;
    const existing = next.find(
      (e) => stashKey(e.brand, e.code) === stashKey(p.brand, p.code) && e.unit === p.unit,
    );
    if (existing) {
      existing.quantity += p.quantity;
      existing.updatedAt = now;
    } else {
      next.push({
        brand: p.brand,
        code: p.code,
        name: p.name,
        quantity: p.quantity,
        unit: p.unit,
        updatedAt: now,
      });
    }
  }
  return next;
}

/**
 * Deducts a finished project's thread from the stash. Separate from applyPurchase and
 * deliberately clamped at zero — going negative would mean the stash is wrong, and a
 * negative skein count on screen reads as a bug rather than as information.
 */
export function consumeFromStash(
  stash: StashEntry[],
  used: Array<{ brand: string; code: string; quantity: number; unit: ThreadUnit }>,
  now: string,
): StashEntry[] {
  const next = stash.map((e) => ({ ...e }));
  for (const u of used) {
    const existing = next.find(
      (e) => stashKey(e.brand, e.code) === stashKey(u.brand, u.code) && e.unit === u.unit,
    );
    if (!existing) continue;
    existing.quantity = Math.max(0, existing.quantity - u.quantity);
    existing.updatedAt = now;
  }
  return next;
}
