// Thread estimation calculator.
//
// Converts stitched cell counts (from the chart engine's outUsage) into
// physical thread quantities to buy, per colour. Built from data gathered
// 9-10 July: a specific per-product coverage table, a mesh-dependent
// single-strand fallback rate, and a strand-count model for threads whose
// yardage scales with how many strands are held in the needle together.
//
// DESIGN NOTE ON THE BASELINE (revised 10 July): originally a single flat
// constant (1.75 yd/sq-in), then corrected to be MESH-DEPENDENT after
// comparing against stitchmate.app/guides/needlepoint-thread-guide, whose
// per-mesh figures (10:1.0, 13:1.3, 18:2.0 metres/sq-in) sit much closer to
// directly-measured single-strand products (Milan 1.5, Silk & Ivory 1.44 at
// 13-mesh) than the old flat 1.75 did. The physical reasoning holds up:
// finer mesh means more, smaller stitches per square inch, and per-stitch
// overhead (going up/down through the canvas) doesn't shrink as fast as
// stitch length does, so finer mesh consistently uses more yarn per area.
// The old flat 1.75 is kept as a rougher fallback ONLY for mesh counts
// without a specific sourced figure (12, 14, 16, 22, etc).
//
// DESIGN NOTE ON "DIVISIBLE": originally modelled around six-strand
// embroidery floss, then corrected 10 July -- Appletons crewel wool is NOT
// floss (it's an indivisible 2-ply wool) but behaves identically for this
// calculator's purposes: it is used as multiple strands held together in
// the needle, and total yardage consumed scales with however many strands
// are used, for the same physical reason (more parallel thread material
// laid per stitch). The category really means "strand count in the needle
// varies by mesh and matters", not "literally splittable". Per-thread
// products get THEIR OWN strand-by-mesh guidance rather than sharing one
// generic table -- floss and crewel wool do not use the same strand counts
// at the same mesh, and conflating them was a real mistake caught and
// corrected this session.
//
// KNOWN UNRESOLVED CONFLICT (10 July): stitchmate.app's table gives
// Appleton crewel wool as 2 strands @ 13-mesh / 1 strand @ 18-mesh -- this
// DISAGREES with the calculator's existing 18-mesh figure (2 strands),
// which is confirmed against the user's own real project (stronger
// evidence than a general guide). The confirmed figure is kept unchanged;
// the conflict is surfaced in this product's notes every time it's used,
// rather than silently picking a side. See KNOWN_THREADS["appletons-crewel"].

export type StitchType = "basketweave" | "continental" | "decorative";
export type StrandType = "single" | "divisible";

export interface MeshStrandsGuidance {
  kind: "strands";
  min: number;
  max: number;
  /** true if confirmed against a real project, not just a general source. */
  confirmed?: boolean;
  /** WHY min and max differ. These look identical in the data but mean very
   *  different things, and conflating them misleads the user:
   *   - "tension": the range is REAL. Different stitchers genuinely land at
   *     different points depending on how tightly they stitch. No amount of
   *     further sourcing collapses it to one number; the honest UI message is
   *     "3-4 depending on your tension".
   *   - "uncertainty": we don't know the true figure yet. A better source
   *     WOULD collapse it. The honest message is "3-4, not yet verified".
   *  Undefined on legacy entries means unclassified, not "no range". */
  rangeReason?: "tension" | "uncertainty";
  /** Set when the combination physically WORKS but is not recommended -- a
   *  third state between clean guidance and "not-appropriate". Surfaced as a
   *  note so the user is warned, not blocked: their canvas, their call.
   *  Sourced 15 July: Appletons tapestry at 13-mesh is the real case --
   *  people do it, but it drags and crewel is the better choice. */
  discouragedReason?: string;
  /** set when a second source disagrees with this figure -- surfaced in
   *  notes every time this guidance is used, never silently dropped. */
  conflictNote?: string;
  /** true once the user has explicitly reviewed conflictNote and confirmed
   *  which figure is correct for their practice -- changes the note's tone
   *  from "still needs checking" to "explained, already settled". */
  conflictResolved?: boolean;
}
export interface MeshNotAppropriate {
  kind: "not-appropriate";
  reason: string;
}
export type MeshGuidance = MeshStrandsGuidance | MeshNotAppropriate;

export interface ThreadProduct {
  name: string;
  /** yards per skein/card. null if not yet sourced -- unitsNeeded will be
   *  null rather than a guessed number. */
  yardsPerUnit: number | null;
  strandType: StrandType;
  /** For single-strand-type products: sq inches one unit covers at
   *  basketweave, keyed by mesh count. Only present where sourced. */
  sqInPerUnitByMesh?: Partial<Record<number, number>>;
  /** For divisible-type products: guidance at specific mesh counts. Only
   *  present where sourced -- NOT shared across products. Can mark a mesh
   *  as "not-appropriate" (thread physically doesn't work there) rather
   *  than merely undocumented. */
  strandGuidanceByMesh?: Partial<Record<number, MeshGuidance>>;
}

const YD_PER_M = 1.0936133;

// Seed dataset. Single-strand-type entries sourced 9 July from
// @thestitchladi "Thread Math" series (coverage table). Appletons added
// and refined 10 July: initial strand data from general sources plus a
// real project data point (18 mesh / 2 strands, crewel) confirmed
// directly by the user; skein yardages sourced directly from the user;
// tapestry wool strand data and the crewel-wool conflict both sourced
// from stitchmate.app/guides/needlepoint-thread-guide.
export const KNOWN_THREADS = {
  "essentials-card": { name: "Essentials (card)", yardsPerUnit: 10, strandType: "single", sqInPerUnitByMesh: { 18: 4 } },
  "essentials-skein": { name: "Essentials (skein)", yardsPerUnit: 30, strandType: "single", sqInPerUnitByMesh: { 18: 16 } },
  "milan-card": { name: "Milan (card)", yardsPerUnit: 10, strandType: "single", sqInPerUnitByMesh: { 13: 5 } },
  "milan-skein": { name: "Milan (skein)", yardsPerUnit: 30, strandType: "single", sqInPerUnitByMesh: { 13: 20 } },
  "pepper-pot": { name: "Pepper Pot", yardsPerUnit: 30, strandType: "single", sqInPerUnitByMesh: { 13: 20, 18: 15 } },
  "planet-earth-silk": { name: "Planet Earth Silk", yardsPerUnit: 30, strandType: "single", sqInPerUnitByMesh: { 13: 20 } },
  // Silk & Ivory: 50/50 silk/Merino wool, non-strandable single-ply.
  // Coverage EXTENDED 15 July from the distributor-level table reproduced by
  // Poppypointe (28.8 yd skein covering ~20 sq in @13, 19 @14, 17 @16, 15
  // @18), which independently CORROBORATES the existing 13-mesh figure of 20
  // already sourced 9 July from @thestitchladi -- two independent sources
  // agreeing, so 13-mesh is now the best-attested figure in the dataset.
  // 14-mesh matters specifically for brick door-stop canvases (BRICK_MESHES).
  // Minor unresolved variance, recorded not smoothed over: Fire & Iris
  // (fireandirisdesigns.com, Apr 2024) states ~19 sq in @13 rather than 20.
  // 20 is kept (2 sources vs 1, and it is the manufacturer-side figure); the
  // spread is ~5%, well inside the "these figures are estimates" caveat the
  // source itself carries. Not worth a conflictNote at this magnitude.
  "silk-and-ivory": { name: "Silk & Ivory", yardsPerUnit: 28.8, strandType: "single", sqInPerUnitByMesh: { 13: 20, 14: 19, 16: 17, 18: 15 } },
  "vineyard-silk-classic": {
    name: "Vineyard Silk Classic",
    // Sourced 15 July from multiple retailers (needlepointtoo, Rittenhouse,
    // Salty Yarns, Stitch Therapy, Sunshine Needlepoint) + the Wiltex
    // product description. 100% silk, NON-STRANDABLE -> single-strand type,
    // consistent across every source. 239 solid colours in the Classic line.
    // Yardage: 30 yd is the near-universal figure; two retailers hedge to
    // "28 to 30 yd skeins". 30 adopted (the modal, and the manufacturer-side
    // figure); the hedge only ever means MORE thread than assumed, so a
    // 30-yd assumption is the conservative direction for a buy estimate.
    yardsPerUnit: 30,
    strandType: "single",
    // DELIBERATELY EMPTY -- no sq-in-per-skein coverage figure exists in any
    // source found (unlike Silk & Ivory, whose distributor publishes one).
    // Falls back to the mesh-dependent single-strand baseline automatically,
    // exactly as dmc-perle-5 does, rather than borrowing another silk's
    // numbers. A useful corroborating cross-reference for that fallback:
    // Wiltex describe each Vineyard strand as equivalent to 1 strand of
    // perle #5 -- the very thread that already relies on the same baseline,
    // so the two products degrade to the same rate for the same reason.
    // Mesh suitability is genuinely DISPUTED across sources and deliberately
    // NOT encoded as guidance (this is a single-strand product, so mesh only
    // selects a coverage/baseline rate here, never a strand count):
    //   - Salty Yarns / Stitch Therapy / Rittenhouse: covers 13-18 mesh
    //   - needlepointtoo: suitable for 14-18 count
    //   - Sunshine Needlepoint / Rittenhouse product copy: BEST suited to 18
    // Net honest state: usable across roughly 13-18, best at 18. No source
    // calls any mesh in that range not-appropriate, so no "not-appropriate"
    // entry is fabricated -- absence of a claim is not a claim.
    sqInPerUnitByMesh: {},
  },
  "dmc-perle-3": {
    name: "DMC Pearl Cotton #3 (15m skein)",
    // CONFIRMED directly by Delaney: DMC size 3 comes in 15m skeins.
    // The heavier perle size, used on coarser canvas (roughly 12-14 mesh)
    // where #5 gives thin coverage.
    yardsPerUnit: 15 * YD_PER_M, // ~16.40 yards per skein
    strandType: "single", // non-divisible, exactly as #5
    // No product-specific coverage sourced -- falls back to the mesh
    // baseline, which is the right behaviour here: thread LENGTH per stitch
    // is set by stitch geometry and mesh, not by how thick the thread is, so
    // the same baseline applies to #3 and #5 alike.
    sqInPerUnitByMesh: {},
  },
  "dmc-perle-5": {
    name: "DMC Pearl Cotton #5 (25m skein)",
    // CONFIRMED directly by Delaney: DMC size 5 comes in BOTH 15m and 25m
    // skeins, but more colour options are available in 25m -- so 25m is
    // adopted as the baseline here, deliberately not the smaller size, so a
    // colour that only exists at 25m is never mis-costed against a 15m
    // assumption it doesn't actually come in.
    yardsPerUnit: 25 * YD_PER_M, // ~27.34 yards per skein
    strandType: "single", // confirmed by stitchmate.app: "good coverage on 13-mesh", non-divisible, single strand
    sqInPerUnitByMesh: {}, // product-specific coverage not yet sourced -- falls back to mesh-dependent baseline
  },
  "appletons-crewel": {
    name: "Appletons Crewel Wool",
    // Sourced 10 July directly from the user: "Crewel Wool (2-ply): each
    // skein contains 25 meters (approx. 27 yards)."
    yardsPerUnit: 25 * YD_PER_M, // ~27.34 yards per skein
    strandType: "divisible",
    strandGuidanceByMesh: {
      12: {
        // SOURCED 15 July directly from Delaney's own stitching practice --
        // the same provenance class as the 18-mesh figure below, i.e. the
        // strongest evidence in this dataset (real practice, not a guide).
        kind: "strands", min: 3, max: 4, confirmed: true, rangeReason: "tension",
      },
      14: {
        // SOURCED 15 July from Delaney's own practice. 14-mesh is a general
        // canvas option selectable for ANY shape -- corrected 15 July; an
        // earlier note in this project wrongly treated 14 as brick-only, so
        // this unblocks a mainstream path, not an edge case.
        kind: "strands", min: 2, max: 3, confirmed: true, rangeReason: "tension",
      },
      18: {
        kind: "strands", min: 2, max: 2, confirmed: true, conflictResolved: true, // confirmed against the user's own real project
        conflictNote: "stitchmate.app's table gives 1 strand at 18-mesh for Appleton crewel wool. RESOLVED 10 July: the user explicitly reviewed this and confirmed 2 strands is correct for their practice -- 1 strand \"wouldn't have good coverage at all.\" Kept as a note (not deleted) since it explains why this figure might look surprising against a generic guide, not because it's still in doubt.",
      },
      13: {
        kind: "strands", min: 3, max: 4, confirmed: false, // general source (Google AI overview), not yet project-verified
        conflictNote: "stitchmate.app's table gives 2 strands at 13-mesh for Appleton crewel wool -- differs from this general-source figure (3-4). Neither is project-confirmed; treat both as provisional until verified against a real project.",
      },
    },
  },
  "appletons-tapestry": {
    name: "Appletons Tapestry Wool",
    // Sourced 10 July directly from the user: "Tapestry Wool (4-ply): each
    // skein contains 10 meters (approx. 11 yards)." Confirmed 10 July as
    // ALSO actively used.
    yardsPerUnit: 10 * YD_PER_M, // ~10.94 yards per skein
    strandType: "divisible",
    // Strand-by-mesh, sourced and revised 10 July:
    //   - stitchmate.app originally gave 10-mesh (1 strand) and marked
    //     13-mesh/18-mesh "too thick".
    //   - User first corrected this to "usable at 10, 12, AND 13 mesh"
    //     (disputing Stitchmate's 13-mesh claim), then WALKED BACK the
    //     13-mesh part specifically ("wait -- maybe just do Appletons
    //     tapestry for 10 and 12 mesh"), same session.
    //   - NET RESULT: 10-mesh usable (1 strand, general source). 12-mesh
    //     usable per the user, strand count not yet sourced. 13-mesh
    //     status is back to GENUINELY UNKNOWN -- neither confirmed usable
    //     nor confirmed not-appropriate; Stitchmate's "too thick" claim is
    //     NOT reinstated (it was disputed, then the dispute itself was
    //     walked back -- the honest state is "uncertain", not "reverts to
    //     the original source"). 18-mesh's "too thick" stands, never
    //     disputed. No entry exists for 12 or 13 mesh below -- both
    //     correctly throw the generic "no guidance sourced" error (an
    //     honest "we don't know yet"), never the "not appropriate" one.
    strandGuidanceByMesh: {
      10: { kind: "strands", min: 1, max: 1, confirmed: false }, // general source, not yet project-verified
      12: {
        // SOURCED 15 July from Delaney's own practice: "1 is fine for
        // coverage". This closes the gap the master list flagged -- 12-mesh
        // was already recorded as confirmed-usable, but the strand count was
        // never captured, which left the whole product throwing at every mesh
        // the app offers. One number; the thread is now live.
        kind: "strands", min: 1, max: 1, confirmed: true,
      },
      13: {
        // RESOLVED 15 July from Delaney, closing a long-open dispute:
        // Stitchmate said "too thick"; the user disputed it; then walked the
        // dispute back; status has sat at "genuinely unknown" ever since.
        // The real answer is neither pole: people DO stitch tapestry wool at
        // 13-mesh, but it causes a lot of friction (dragging through the
        // canvas) and crewel is preferred. So: usable-but-discouraged, not
        // impossible. Stitchmate was directionally right but overstated.
        // The strand count is FORCED rather than guessed: 12-mesh uses 1, a
        // finer mesh can never need MORE, and 1 is the floor for an
        // indivisible wool -- so 13-mesh is necessarily 1.
        kind: "strands", min: 1, max: 1, confirmed: true,
        discouragedReason:
          "Tapestry wool works at 13-mesh but drags through the canvas -- lots of friction. Appletons crewel is preferred at this mesh.",
      },
      14: {
        // SOURCED 15 July from Delaney: tapestry wool is not used at 14-mesh.
        kind: "not-appropriate",
        reason: "Appletons tapestry wool is too thick for 14-mesh canvas -- use Appletons crewel wool instead.",
      },
      18: { kind: "not-appropriate", reason: "Too thick for 18-mesh canvas (source: stitchmate.app; never disputed)." },
      // 12: confirmed usable by the user, strand count not yet sourced.
      // 13: genuinely unknown -- a claim was made then walked back; treat
      // as unconfirmed either way, not as reverting to Stitchmate's
      // original (also-unconfirmed-by-the-user) "too thick" claim.
    },
  },
} as const satisfies Record<string, ThreadProduct>;

export type KnownThreadKey = keyof typeof KNOWN_THREADS;

// Mesh-dependent single-strand baseline, sourced 10 July from
// stitchmate.app/guides/needlepoint-thread-guide, "How much to buy" table
// (given in metres/sq-in, converted to yards here). See file header for
// why this replaced the old flat constant.
const MESH_BASELINE_YD_PER_SQIN: Partial<Record<number, number>> = {
  10: 1.0 * YD_PER_M, // ~1.094
  13: 1.3 * YD_PER_M, // ~1.422
  18: 2.0 * YD_PER_M, // ~2.187
};
// Fallback for mesh counts with no specific sourced figure (e.g. 12, 14,
// 16, 22). Originally the ONLY baseline (see design note above); now a
// rough average kept only for undocumented mesh counts.
export const FALLBACK_BASELINE_YD_PER_SQIN_SINGLE_STRAND = 1.75;
export const SAFETY_MARGIN_YD_PER_SQIN_SINGLE_STRAND = 2.0;

/** Baselines DERIVED by interpolation between the sourced figures above.
 *  These are NOT measurements. Kept in a separate table so they can never be
 *  mistaken for sourced data, and so a real figure can retire one by simply
 *  moving it up into MESH_BASELINE_YD_PER_SQIN.
 *
 *  WHY (decided 15 July): 12- and 14-mesh are two of the four meshes the app
 *  actually offers, and both fell through to the flat 1.75 rate this project
 *  already records as SUPERSEDED. That flat rate over-orders by ~33% at
 *  12-mesh and ~11% at 14-mesh, inflating every shopping list on mainstream
 *  meshes. 14-mesh is a general option for any shape, not brick-only
 *  (corrected 15 July), so this is not a niche path.
 *
 *  VALIDATED, not asserted: Silk & Ivory is the only thread with a complete
 *  sourced mesh table (13/14/16/18), so it is a real fixture for the
 *  interpolation METHOD. Hiding its 14- and 16-mesh figures and predicting
 *  them from only its 13 and 18 values reproduces the true figures to within
 *  +1.33% and +2.00% -- and both errors fall on the OVER-order side, the safe
 *  direction for a buy estimate. verify-strand-data.ts runs that check as a
 *  standing test, so if anyone ever doubts these numbers the evidence re-runs.
 *
 *    12-mesh: interpolated between 10 (1.0 m) and 13 (1.3 m) -> 1.20 m
 *    14-mesh: interpolated between 13 (1.3 m) and 18 (2.0 m) -> 1.44 m
 *
 *  The sourced points are NOT collinear (10->13 climbs 0.1 m per mesh step;
 *  13->18 climbs 0.14), so each value is interpolated between its OWN two
 *  neighbours rather than fitted to one line across the whole range. */
const MESH_BASELINE_DERIVED_YD_PER_SQIN: Partial<Record<number, number>> = {
  12: 1.2 * YD_PER_M,  // ~1.312 (was 1.75 -- a 33% over-order)
  14: 1.44 * YD_PER_M, // ~1.575 (was 1.75 -- an 11% over-order)
};

export type BaselineProvenance = "sourced" | "derived" | "fallback";

export function baselineForMesh(mesh: number): { rate: number; sourced: boolean; provenance: BaselineProvenance } {
  const r = MESH_BASELINE_YD_PER_SQIN[mesh];
  if (r != null) return { rate: r, sourced: true, provenance: "sourced" };
  const d = MESH_BASELINE_DERIVED_YD_PER_SQIN[mesh];
  // `sourced` stays accurate for a derived rate -- it is not a measurement --
  // but provenance lets the note say WHICH kind of non-sourced rate it is.
  if (d != null) return { rate: d, sourced: false, provenance: "derived" };
  return { rate: FALLBACK_BASELINE_YD_PER_SQIN_SINGLE_STRAND, sourced: false, provenance: "fallback" };
}

// Basketweave uses "about a third more thread than continental" (source:
// @thestitchladi). basketweave = continental * 4/3  =>  continental =
// basketweave * 3/4. All tabulated/baseline rates are basketweave rates.
export const CONTINENTAL_FACTOR = 0.75;

// GENERIC fallback strand-count range by mesh, sourced from DMC six-strand
// floss guidance specifically. Only used for the `generic` divisible path
// when no product-specific strandsUsed is given -- NEVER used to fill in
// gaps for a specific KNOWN product (a known product with no guidance at a
// given mesh should be flagged as needing real data, not silently given a
// different thread's numbers -- that conflation was a real mistake this
// session, caught and corrected).
export function recommendedStrandsGeneric(mesh: number): { min: number; max: number; extrapolated: boolean } {
  if (mesh >= 18) return { min: 2, max: 4, extrapolated: false };
  if (mesh >= 13) return { min: 3, max: 4, extrapolated: false };
  if (mesh >= 10) return { min: 4, max: 6, extrapolated: false };
  return { min: 5, max: 8, extrapolated: true }; // coarser than any documented mesh
}

export interface GenericThreadInput {
  yardsPerUnit: number;
  strandType: StrandType;
  strandsUsed?: number; // required for meaningful precision if divisible
}

export interface CalcInput {
  cellCount: number; // stitches of this colour, from outUsage
  mesh: number; // holes per inch
  stitchType: StitchType;
  knownThreadKey?: KnownThreadKey;
  generic?: GenericThreadInput;
  strandsUsed?: number; // overrides any guidance/default when using knownThreadKey with a divisible product
  safetyMargin?: boolean; // use 2.0 yd/sq-in flat rate instead of the mesh-dependent baseline
}

export interface CalcResult {
  sqInches: number;
  yardsNeeded: number;
  yardsPerSqInUsed: number;
  yardsPerUnit: number | null;
  /** null when yardsPerUnit is unknown -- cannot compute units, not zero. */
  unitsNeeded: number | null;
  /** The honest span, not a single fake-precise figure. Where strand guidance
   *  is a tension-driven range (e.g. crewel at 12-mesh is 3-4 strands), a
   *  loose stitcher genuinely needs the top of the range and a tight one the
   *  bottom -- no further sourcing collapses that. min === max when there is
   *  no known variability. yardsNeeded/unitsNeeded remain the midpoint.
   *
   *  PRODUCT DECISION (15 July, Delaney): the UI shows the RANGE, with a blurb
   *  at the point of ordering explaining that it depends on tension and stitch
   *  -- rather than quoting one number that is wrong for most stitchers. */
  yardsRange: { min: number; max: number };
  /** null for the same reason unitsNeeded is null (unknown skein size). */
  unitsRange: { min: number; max: number } | null;
  /** Point-of-order blurb. null when there is no range to explain. */
  orderBlurb: string | null;
  notes: string[];
}

const EPS = 1e-9; // guards against float noise pushing an exact boundary up a whole unit

function ceilSafe(x: number): number {
  return Math.ceil(x - EPS);
}

export function calcThreadNeeded(input: CalcInput): CalcResult {
  if (!input.knownThreadKey && !input.generic) {
    throw new Error("calcThreadNeeded: must provide either knownThreadKey or generic");
  }
  const notes: string[] = [];
  const sqInches = input.cellCount / (input.mesh * input.mesh);

  let yardsPerSqIn: number;
  let yardsPerUnit: number | null;
  // Set only where guidance genuinely spans a range. yardsPerSqIn scales
  // LINEARLY with strand count, so the yardage range is derived exactly by
  // ratio from the midpoint rather than by re-running the whole calculation.
  let strandsRange: { min: number; max: number; reason?: "tension" | "uncertainty" } | null = null;
  const { rate: baseRate, sourced: baseRateSourced, provenance: baseRateProvenance } = input.safetyMargin
    ? { rate: SAFETY_MARGIN_YD_PER_SQIN_SINGLE_STRAND, sourced: true, provenance: "sourced" as BaselineProvenance }
    : baselineForMesh(input.mesh);
  // The baseline's provenance note is emitted LAZILY -- only at the sites
  // where baseRate is genuinely consumed. A single-strand product WITH
  // tabulated coverage at this mesh never touches baseRate, so announcing
  // "using the general fallback" there would be a FALSE provenance note, and
  // these notes exist precisely to tell the user where a number came from.
  // Found 15 July: latent until Silk & Ivory gained 14/16-mesh coverage --
  // the first case of tabulated coverage at a mesh with no sourced baseline,
  // which is the exact combination that exposes it. Previously only 13 and 18
  // had tabulated figures, and both have sourced baselines, so it never fired
  // wrongly. Behaviour-preserving for every prior case; only suppresses a
  // note that was never true.
  let baselineNoteEmitted = false;
  const noteBaselineProvenance = (): void => {
    if (baselineNoteEmitted) return;
    baselineNoteEmitted = true;
    if (input.safetyMargin || baseRateSourced) return;
    if (baseRateProvenance === "derived") {
      notes.push(`No baseline rate is directly sourced at ${input.mesh} mesh; using a DERIVED rate (${baseRate.toFixed(3)} yd/sq in) interpolated between the sourced neighbouring meshes. The interpolation method reproduces Silk & Ivory's real 14- and 16-mesh figures to within 2%, erring toward over-ordering. More reliable than the generic fallback, but still not a measurement.`);
    } else {
      notes.push(`No mesh-specific baseline rate sourced for ${input.mesh} mesh; using the general fallback (${FALLBACK_BASELINE_YD_PER_SQIN_SINGLE_STRAND} yd/sq in) rather than a mesh-tuned figure.`);
    }
  };

  if (input.knownThreadKey) {
    const product: ThreadProduct = KNOWN_THREADS[input.knownThreadKey];
    yardsPerUnit = product.yardsPerUnit;
    if (yardsPerUnit == null) {
      notes.push(`${product.name}'s yards-per-unit is not yet sourced -- yardsNeeded is computable but unitsNeeded cannot be, rather than guessing a skein size.`);
    }

    if (product.strandType === "single") {
      const sqInPerUnit = product.sqInPerUnitByMesh?.[input.mesh];
      if (sqInPerUnit != null && yardsPerUnit != null) {
        yardsPerSqIn = yardsPerUnit / sqInPerUnit;
        notes.push(`Using tabulated ${product.name} coverage at ${input.mesh} mesh (${sqInPerUnit} sq in per unit).`);
      } else {
        yardsPerSqIn = baseRate;
        noteBaselineProvenance();
        notes.push(`No tabulated coverage for ${product.name} at ${input.mesh} mesh; using single-strand baseline rate (${baseRate.toFixed(3)} yd/sq in). Treat with more caution than a tabulated figure.`);
      }
    } else {
      // divisible known product: use ITS OWN strand guidance, never another
      // product's/generic's numbers -- flag clearly if this exact mesh
      // isn't sourced for this specific product yet, and distinguish
      // "not appropriate at this mesh" from "no data yet".
      let strands = input.strandsUsed;
      if (strands == null) {
        const g = product.strandGuidanceByMesh?.[input.mesh];
        if (g == null) {
          throw new Error(`calcThreadNeeded: no strand guidance sourced for ${product.name} at ${input.mesh} mesh, and no strandsUsed override given. Provide strandsUsed explicitly, or source this product's guidance at this mesh before using it -- do not substitute another thread's strand table.`);
        }
        if (g.kind === "not-appropriate") {
          throw new Error(`calcThreadNeeded: ${product.name} is not appropriate for ${input.mesh} mesh. ${g.reason} Choose a different thread for this mesh count.`);
        }
        strands = (g.min + g.max) / 2;
        // Keep the SPAN, not just the midpoint -- the UI shows the range.
        if (g.max > g.min) strandsRange = { min: g.min, max: g.max, reason: g.rangeReason };
        notes.push(`No strandsUsed given; using sourced guidance for ${product.name} at ${input.mesh} mesh (${strands} strands${g.confirmed ? ", confirmed against a real project" : ", general source only, not yet project-verified"}).`);
        if (g.conflictNote) notes.push(`${g.conflictResolved ? "NOTE (previously conflicting, now resolved)" : "CONFLICTING SOURCE (unresolved)"}: ${g.conflictNote}`);
        if (g.discouragedReason) notes.push(`NOT RECOMMENDED: ${g.discouragedReason}`);
      } else {
        notes.push(`Using explicit strandsUsed override (${strands}) for ${product.name}.`);
      }
      noteBaselineProvenance();
      yardsPerSqIn = baseRate * strands;
    }
  } else {
    const g = input.generic!;
    yardsPerUnit = g.yardsPerUnit;
    if (g.strandType === "single") {
      yardsPerSqIn = baseRate;
      noteBaselineProvenance();
      notes.push(`Generic single-strand thread; using baseline rate (${baseRate.toFixed(3)} yd/sq in).`);
    } else {
      let strands = g.strandsUsed;
      if (strands == null) {
        const rec = recommendedStrandsGeneric(input.mesh);
        strands = (rec.min + rec.max) / 2;
        // The generic table is floss-sourced guidance applied to a thread we
        // have no specific data for, so its span is UNCERTAINTY (a better
        // source would collapse it), not tension (which no source collapses).
        if (rec.max > rec.min) strandsRange = { min: rec.min, max: rec.max, reason: "uncertainty" };
        notes.push(`No strand count given; using GENERIC (floss-sourced) midpoint (${strands} strands) for ${input.mesh} mesh${rec.extrapolated ? " (extrapolated beyond documented mesh range)" : ""}. This generic table was sourced from embroidery floss, not your specific thread -- provide strandsUsed for a precise estimate on other thread types.`);
      }
      noteBaselineProvenance();
      yardsPerSqIn = baseRate * strands;
      notes.push(`Divisible thread at ${strands} strands: ${baseRate.toFixed(3)} x ${strands} = ${yardsPerSqIn.toFixed(3)} yd/sq in.`);
    }
  }

  if (input.stitchType === "continental") {
    yardsPerSqIn *= CONTINENTAL_FACTOR;
    notes.push(`Adjusted for continental stitch (x${CONTINENTAL_FACTOR}; basketweave uses about a third more).`);
  } else if (input.stitchType === "decorative") {
    notes.push("Decorative stitches typically use MORE thread than basketweave; no sourced multiplier exists. This estimate uses the basketweave rate as a FLOOR, not a final figure -- budget extra.");
  }

  const yardsNeeded = sqInches * yardsPerSqIn;
  const unitsNeeded = (yardsPerUnit != null && yardsPerUnit > 0 && yardsNeeded > 0) ? ceilSafe(yardsNeeded / yardsPerUnit) : (yardsPerUnit == null ? null : 0);

  // Derive the span by ratio off the midpoint. Exact, because yardsPerSqIn is
  // strictly proportional to strand count and every other factor (coverage,
  // continental multiplier, area) is already baked into yardsNeeded.
  const mid = strandsRange ? (strandsRange.min + strandsRange.max) / 2 : 1;
  const yardsRange = strandsRange
    ? { min: yardsNeeded * (strandsRange.min / mid), max: yardsNeeded * (strandsRange.max / mid) }
    : { min: yardsNeeded, max: yardsNeeded };

  const unitsRange = yardsPerUnit != null && yardsPerUnit > 0
    ? {
        min: yardsRange.min > 0 ? ceilSafe(yardsRange.min / yardsPerUnit) : 0,
        max: yardsRange.max > 0 ? ceilSafe(yardsRange.max / yardsPerUnit) : 0,
      }
    : null;

  // Blurb shown at the point of ordering. Only where there's a real span to
  // explain -- a fixed figure gets no popup, so the warning keeps its meaning.
  let orderBlurb: string | null = null;
  if (strandsRange && unitsRange && unitsRange.max > unitsRange.min) {
    const stitchBit = input.stitchType === "decorative"
      ? " Decorative stitches use more again, so treat even the upper figure as a floor."
      : input.stitchType === "continental"
        ? " This assumes continental stitch; basketweave would use about a third more."
        : " This assumes basketweave; continental uses about a third less.";
    const reasonBit = strandsRange.reason === "uncertainty"
      ? `Guidance for this thread at ${input.mesh} mesh spans ${strandsRange.min}-${strandsRange.max} strands and isn't yet confirmed against a real project`
      : `How many strands you need at ${input.mesh} mesh depends on your stitching tension -- looser stitching needs more (${strandsRange.min}-${strandsRange.max} strands)`;
    orderBlurb = `${reasonBit}, so you'll need roughly ${unitsRange.min}-${unitsRange.max} skeins of this colour.${stitchBit} If you're between sizes, buy the higher number: running out mid-project usually means a new dye lot, which can show as a visible colour shift.`;
  } else if (strandsRange && unitsRange) {
    // Range exists but rounds to the same skein count -- no decision to make.
    orderBlurb = null;
  }

  return { sqInches, yardsNeeded, yardsPerSqInUsed: yardsPerSqIn, yardsPerUnit, unitsNeeded, yardsRange, unitsRange, orderBlurb, notes };
}

// Whole-project convenience wrapper: one plan per colour.
export interface ColourThreadPlan extends CalcInput {
  colourId: string;
}

export function calcProjectThreadNeeds(plans: ColourThreadPlan[]): Record<string, CalcResult> {
  const out: Record<string, CalcResult> = {};
  for (const plan of plans) out[plan.colourId] = calcThreadNeeded(plan);
  return out;
}
