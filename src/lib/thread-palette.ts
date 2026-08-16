// Thread palette schema + validator (§8.1 / §8.2 / §11.2 / §11.3).
//
// The bridge between thread-match.ts (perceptual colour) and
// thread-calculator.ts (how much to buy). It exists to solve one specific
// danger:
//
//   CIEDE2000 is accurate to 1e-4. Thread swatch hex scraped from retailer
//   product photos is NOT colorimetrically reliable -- the vendors themselves
//   disclaim it ("colours may vary due to screen settings and lighting; for
//   the best colour match, physical thread colour cards are recommended").
//   Running precise maths over imprecise input FAILS SILENTLY: the matcher
//   returns a confident ΔE00 for a shade that is simply wrong, and a customer
//   buys the wrong thread. Nothing downstream can detect this.
//
// So every shade carries PROVENANCE, and matching can be gated on it. An
// unmeasured shade is usable for a rough preview but must never be presented
// as a confident recommendation without the caller opting in explicitly.
// This is the same discipline the calculator already applies to strand
// guidance (throw rather than borrow another thread's numbers).
//
// RECONCILE BEFORE WIRING: align with the real ../data/threadPalettes shape.
// This module is deliberately a SUPERSET -- toThreadColors() emits exactly the
// ThreadColorLike that thread-match.ts consumes, so the matcher needs no
// change either way.

import type { Lab, ThreadColorLike } from "./thread-match";
import { hexToLab } from "./thread-match";

/** How a shade's colour value was obtained. Ordered worst -> best. */
export type Provenance =
  | "unverified"        // origin unknown. Never trust.
  | "screen-estimate"   // eyeballed/sampled from a photo. Indicative only.
  | "retailer-web"      // a retailer's published swatch. Vendor-disclaimed.
  | "manufacturer-web"  // the manufacturer's own published swatch.
  | "manufacturer-card" // transcribed from a physical colour card.
  | "measured";         // spectro/colorimeter reading of real thread. Truth.

const PROVENANCE_RANK: Record<Provenance, number> = {
  unverified: 0,
  "screen-estimate": 1,
  "retailer-web": 2,
  "manufacturer-web": 3,
  "manufacturer-card": 4,
  measured: 5,
};

/** Provenance at or above this needs no colour-accuracy caveat beyond the
 *  standard one. Below it, the palette carries a stronger disclaimer.
 *
 *  PRODUCT DECISION (15 July, Delaney): Tessella ships with a colour-accuracy
 *  disclaimer -- "colours may look different on screen; check your physical
 *  shade card before colour-matching" -- rather than waiting on measured data.
 *  This is industry-standard practice (every DMC chart site, every retailer,
 *  and Stitchmate all carry the same caveat) and it unblocks launch. So
 *  provenance is NOT a gate on shipping; it decides how strongly to word the
 *  disclaimer, and it leaves a clean upgrade path if shade cards land later. */
export const TRUSTED_PROVENANCE: Provenance = "manufacturer-card";

export function isTrusted(p: Provenance): boolean {
  return PROVENANCE_RANK[p] >= PROVENANCE_RANK[TRUSTED_PROVENANCE];
}

/** The user-facing colour-accuracy disclaimer for a palette. Worded by the
 *  WEAKEST provenance present, since that's the real accuracy floor. */
export function paletteDisclaimer(brand: ThreadBrand): string {
  const shades = brand.shades.filter((s) => !s.discontinued);
  if (shades.length === 0) return "";
  let worst: Provenance = "measured";
  for (const s of shades) {
    if (PROVENANCE_RANK[s.provenance] < PROVENANCE_RANK[worst]) worst = s.provenance;
  }
  const base =
    "Screen colours are indicative. Always check a physical shade card before matching colours or buying thread.";
  switch (worst) {
    case "measured":
      return "Colours measured from real thread. " + base;
    case "manufacturer-card":
      return `${brand.name} colours transcribed from the manufacturer's physical shade card. ` + base;
    case "manufacturer-web":
      return `${brand.name} colours are the manufacturer's published values. ` + base;
    case "retailer-web":
      return `${brand.name} colours are taken from published swatches and are approximate. ` + base;
    case "screen-estimate":
    case "unverified":
    default:
      return `${brand.name} colours are estimates and may differ noticeably from real thread. ` + base;
  }
}

export interface ThreadShade {
  /** Manufacturer's code, e.g. "241" (Appletons) or "VS005" (Vineyard). */
  code: string;
  name?: string;
  /** sRGB hex. Optional if lab is given. */
  hex?: string;
  /** Preferred when measured -- skips the sRGB round-trip entirely. */
  lab?: Lab;
  provenance: Provenance;
  /** Free-text: which card, which spectro, which page. Kept for auditability. */
  source?: string;
  /** Reserved background-only sentinel shade (§11.2, e.g. Appletons 991B). */
  backgroundSentinel?: boolean;
  /** Shade withdrawn by the manufacturer -- excluded from matching by default
   *  so a chart never recommends a thread nobody can buy. */
  discontinued?: boolean;
}

export interface ThreadBrand {
  /** Stable id, e.g. "appletons-crewel". Where a matching calculator product
   *  exists, USE THE SAME KEY -- that's how a matched shade becomes costable. */
  id: string;
  name: string;
  /** The KnownThreadKey in thread-calculator.ts, when one exists. Kept as a
   *  plain string so this module never hard-imports the calculator's union. */
  calculatorKey?: string;
  shades: ThreadShade[];
  /** Codes actually available IN THIS PRODUCT LINE, when the shade list is a
   *  superset of it. The real case this exists for: the published DMC RGB
   *  tables are all *floss* tables (~489 shades), but DMC Perle #5 stocks only
   *  ~292 of those codes. DMC dyes to match across lines, so the floss colour
   *  value is right -- but recommending a code Perle #5 doesn't stock sends a
   *  customer after thread that doesn't exist. A colour-accuracy disclaimer
   *  cannot cover this: it's not "this green looks different", it's "this
   *  thread isn't real".
   *
   *  When set, toThreadColors() emits only these codes. When undefined, every
   *  shade is treated as available (the normal case for a single-line brand
   *  like Appletons Crewel). */
  availableCodes?: readonly string[];
  /** Expected shade count from the manufacturer, if known -- lets the
   *  validator report "you have 180 of a stated 250" rather than silently
   *  matching against a partial palette. */
  expectedShadeCount?: number;
}

export interface PaletteIssue {
  level: "error" | "warning";
  brandId: string;
  code?: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: PaletteIssue[];
  shadeCount: number;
  trustedCount: number;
  /** Fraction of shades at or above TRUSTED_PROVENANCE (0..1). */
  trustedFraction: number;
}

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Validate a brand's palette. Errors block use; warnings are advisory. */
export function validateBrand(brand: ThreadBrand): ValidationReport {
  const issues: PaletteIssue[] = [];
  const seen = new Map<string, number>();
  let trusted = 0;

  if (!brand.id) issues.push({ level: "error", brandId: brand.id, message: "Brand has no id." });
  if (brand.shades.length === 0) {
    issues.push({ level: "error", brandId: brand.id, message: "Brand has no shades." });
  }

  for (const s of brand.shades) {
    if (!s.code) {
      issues.push({ level: "error", brandId: brand.id, message: "A shade has no code." });
      continue;
    }
    seen.set(s.code, (seen.get(s.code) ?? 0) + 1);

    if (!s.hex && !s.lab) {
      issues.push({ level: "error", brandId: brand.id, code: s.code, message: "Shade has neither hex nor lab." });
    }
    if (s.hex && !HEX_RE.test(s.hex)) {
      issues.push({ level: "error", brandId: brand.id, code: s.code, message: `Invalid hex "${s.hex}".` });
    }
    if (!s.provenance) {
      issues.push({ level: "error", brandId: brand.id, code: s.code, message: "Shade has no provenance. Every colour must record where it came from." });
    } else if (isTrusted(s.provenance)) {
      trusted++;
    } else {
      issues.push({
        level: "warning",
        brandId: brand.id,
        code: s.code,
        message: `Provenance "${s.provenance}" is below "${TRUSTED_PROVENANCE}" -- indicative only, not safe for a confident thread recommendation.`,
      });
    }
  }

  for (const [code, n] of seen) {
    if (n > 1) {
      issues.push({ level: "error", brandId: brand.id, code, message: `Duplicate code appears ${n} times.` });
    }
  }

  const sentinels = brand.shades.filter((s) => s.backgroundSentinel);
  if (sentinels.length > 1) {
    issues.push({
      level: "error",
      brandId: brand.id,
      message: `${sentinels.length} shades marked backgroundSentinel; §11.2 reserves exactly one per brand.`,
    });
  }

  if (brand.availableCodes) {
    const codes = new Set(brand.shades.map((s) => normaliseCode(s.code)));
    const missing = brand.availableCodes.filter((c) => !codes.has(normaliseCode(c)));
    if (missing.length > 0) {
      issues.push({
        level: "error",
        brandId: brand.id,
        message: `availableCodes lists ${missing.length} code(s) with no matching shade (e.g. "${missing[0]}") -- the line stocks a colour this palette has no value for.`,
      });
    }
    const avail = new Set(brand.availableCodes.map(normaliseCode));
    const usable = brand.shades.filter((s) => avail.has(normaliseCode(s.code))).length;
    if (usable === 0) {
      issues.push({ level: "error", brandId: brand.id, message: "availableCodes excludes every shade; nothing would be matchable." });
    }
  }

  if (brand.expectedShadeCount != null && brand.shades.length !== brand.expectedShadeCount) {
    issues.push({
      level: "warning",
      brandId: brand.id,
      message: `Palette has ${brand.shades.length} shades but the manufacturer states ${brand.expectedShadeCount}. Matching against a partial palette silently returns the nearest shade you HAPPEN to have, not the nearest that exists.`,
    });
  }

  const shadeCount = brand.shades.length;
  return {
    ok: !issues.some((i) => i.level === "error"),
    issues,
    shadeCount,
    trustedCount: trusted,
    trustedFraction: shadeCount > 0 ? trusted / shadeCount : 0,
  };
}

/** Codes that name the SAME thread differently across sources. DMC's own name
 *  for its white is BLANC (as Wool Warehouse lists it); the community datasets
 *  render it "White". Same skein, two labels -- so they must collapse to one
 *  canonical code or an availability filter silently drops the thread.
 *  Canonical form is DMC's own. */
const CODE_ALIASES: Record<string, string> = {
  WHITE: "BLANC",
  BLANC: "BLANC",
  ECRU: "ECRU",
  "SNOW WHITE": "B5200",
};

/** Normalise a thread code to its canonical manufacturer form.
 *
 *  REAL CASE (found 15 July): Wool Warehouse -- Delaney's actual UK supplier --
 *  zero-pads DMC codes to four digits on their Art. 115/5 product pages
 *  ("0321" Red, "0310" Black, "0645" Grey), while DMC's own numbering and every
 *  colour dataset use "321"/"310"/"645". Four-digit codes ("3847", "3865") are
 *  unpadded and must be left alone. Feeding a retailer's list straight into
 *  availableCodes without this would silently match NOTHING and -- because
 *  availableCodes fails closed -- empty the whole palette.
 *
 *  Note DMC's own 01-35 range is genuinely written both ways ("03" on the
 *  shade card and at Yarntree, "3" in some datasets); this collapses them to
 *  the unpadded form so the two can never diverge. */
export function normaliseCode(code: string): string {
  const c = code.trim().toUpperCase();
  if (CODE_ALIASES[c]) return CODE_ALIASES[c];
  if (!/^\d+$/.test(c)) return c;       // B5200, and anything else named
  const stripped = c.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

export interface ToThreadColorsOptions {
  /** Only emit shades at/above TRUSTED_PROVENANCE (default false). */
  trustedOnly?: boolean;
  /** Include the reserved background sentinel shade (default false -- it is
   *  not a real colour choice, §11.2). */
  includeSentinel?: boolean;
  /** Include discontinued shades (default false). */
  includeDiscontinued?: boolean;
}

/** Shade + its brand, as consumed by thread-match.ts. */
export interface PaletteThreadColor extends ThreadColorLike {
  brandId: string;
  provenance: Provenance;
  calculatorKey?: string;
}

/** Project a brand's palette into the matcher's input type, applying the
 *  filters above. Lab is resolved eagerly so a large palette isn't converted
 *  once per comparison. */
export function toThreadColors(
  brand: ThreadBrand,
  opts: ToThreadColorsOptions = {},
): PaletteThreadColor[] {
  const available = brand.availableCodes ? new Set(brand.availableCodes.map(normaliseCode)) : null;
  const out: PaletteThreadColor[] = [];
  for (const s of brand.shades) {
    // Availability is checked FIRST and is not overridable: a shade the line
    // doesn't stock must never reach the matcher, whatever the other filters
    // say. Emitting it would recommend unbuyable thread. Codes are normalised
    // on BOTH sides so a retailer's zero-padded list ("0321") matches the
    // manufacturer's canonical code ("321").
    if (available && !available.has(normaliseCode(s.code))) continue;
    if (!opts.includeSentinel && s.backgroundSentinel) continue;
    if (!opts.includeDiscontinued && s.discontinued) continue;
    if (opts.trustedOnly && !isTrusted(s.provenance)) continue;
    const lab = s.lab ?? (s.hex ? hexToLab(s.hex) : undefined);
    if (!lab) continue; // validateBrand already errors on this
    out.push({
      code: s.code,
      name: s.name,
      hex: s.hex,
      lab,
      brandId: brand.id,
      provenance: s.provenance,
      calculatorKey: brand.calculatorKey,
    });
  }
  return out;
}

/** Guard for §11.3: motifs are locked to ONE brand. Throws on a mixed set
 *  rather than silently matching across brands, which would need a
 *  brand-to-brand translation layer that does not exist. */
export function assertSingleBrand(colors: PaletteThreadColor[]): string {
  const brands = new Set(colors.map((c) => c.brandId));
  if (brands.size > 1) {
    throw new Error(
      `assertSingleBrand: palette mixes brands [${[...brands].join(", ")}]. §11.3 locks a design to one brand; cross-brand matching needs a translation layer that doesn't exist yet.`,
    );
  }
  return [...brands][0] ?? "";
}

/** Roll-up across brands, for a "is our colour data actually ready?" readout. */
export function validatePalettes(brands: ThreadBrand[]): ValidationReport {
  const issues: PaletteIssue[] = [];
  let shadeCount = 0;
  let trustedCount = 0;
  const ids = new Set<string>();
  for (const b of brands) {
    if (ids.has(b.id)) {
      issues.push({ level: "error", brandId: b.id, message: "Duplicate brand id." });
    }
    ids.add(b.id);
    const r = validateBrand(b);
    issues.push(...r.issues);
    shadeCount += r.shadeCount;
    trustedCount += r.trustedCount;
  }
  return {
    ok: !issues.some((i) => i.level === "error"),
    issues,
    shadeCount,
    trustedCount,
    trustedFraction: shadeCount > 0 ? trustedCount / shadeCount : 0,
  };
}
