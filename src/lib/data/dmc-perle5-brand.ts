// DMC Coton Perle #5 (Art. 115/5) brand definition for thread-palette.ts.
//
// WHAT availableCodes MEANS HERE (Delaney, 15 July): it is the set of shades
// that EXIST in DMC Perle #5 -- NOT the set one retailer happens to stock.
// Tessella's users buy from many shops; filtering to a single supplier's
// inventory would tell a user that a real thread doesn't exist just because
// Delaney's shop skips it. The distinction is load-bearing, so it is spelled
// out rather than implied by the file's origin.
//
// PROVENANCE OF THE CODE LIST: transcribed from Wool Warehouse's Art. 115/5
// shade dropdown (a UK stockist), 301 solid codes, variegated deliberately
// excluded per Delaney. Wool Warehouse is the SOURCE of the evidence, not the
// DEFINITION of the range.
//
// WHY THAT SOURCE IS TRUSTWORTHY FOR THIS PURPOSE: Yarntree's live catalogue
// independently states 304 solid colours for Art. 115/5. Wool Warehouse's
// dropdown yields 301. Those converge within 3 codes, which is itself the
// evidence that WW carries effectively the entire range rather than a subset.
// The corollary matters: the long absences in the WW list (150-169, 3761-3790,
// 3824-3843, 3848-3864) CANNOT be stock gaps -- if they were, the two counts
// would differ by 20+, not 3. They are floss-only codes that Perle #5 never
// spun. So the list is a near-complete picture of the product line, not of a
// shop's shelves.
//
// KNOWN GAP, DELIBERATELY LEFT VISIBLE: expectedShadeCount is set to 304, so
// validateBrand() emits a warning until the last ~3 codes are found. The gap
// stays loud rather than silently shipping a palette that looks complete.
//
// COLOUR PROVENANCE: manufacturer-web. Values come from the consensus DMC
// dataset (sharlagelfand/dmc, seanockert/rgb-to-dmc and floss.maxxmint.com all
// agree exactly), whose `row` field maps position-for-position onto DMC's
// physical Mouliné shade card -- so it was compiled card-in-hand. The codes are
// card-derived; the colour VALUES may still have been eyeballed rather than
// measured, which is why this is not manufacturer-card. DMC dyes to match
// across product lines, so a floss colour value is correct for the same code in
// Perle #5.
//
// RESOLVED 19 July -- the 7 codes below (0001, 0003, 0030, 0032, 0033, 0034,
// 0035, DMC's newest solid range) previously had no verified hex, since the
// 454-colour consensus dataset the rest of this palette draws from predates
// them entirely. Delaney supplied real product-listing photos of the physical
// thread; each hex value is a median pixel sample from those photos (crop
// verified against clean thread texture before use, not text/edges). This is
// meaningfully LESS reliable than the manufacturer-web consensus data used for
// every other shade -- camera colour cast, JPEG compression, and screen
// calibration all introduce real error a manufacturer-stated value wouldn't
// have -- so these 7 are tagged with a distinct, lower provenance tier
// ("screen-estimate") below, and paletteDisclaimer() (thread-palette.ts)
// automatically words the palette's overall disclaimer around the weakest
// provenance present, so this honestly downgrades the caveat shown to users.
// Names ("Grey", "Purple", "Pink, Purple", "Pink") are the retailer listing's
// own generic category labels, not DMC's official shade name -- none was
// available from any source checked.

import type { ThreadBrand, ThreadShade } from "../thread-palette";
import perle5 from "./dmc-perle5.json";

const raw = perle5 as Record<string, { name: string; hex: string; supplierCode: string }>;

// The 7 photo-derived codes above -- everything else in the raw data still
// comes from the manufacturer-web consensus dataset.
const SCREEN_ESTIMATE_CODES = new Set(["1", "3", "30", "32", "33", "34", "35"]);

const shades: ThreadShade[] = Object.entries(raw).map(([code, v]) => ({
  code,
  name: v.name,
  hex: v.hex,
  provenance: SCREEN_ESTIMATE_CODES.has(code) ? "screen-estimate" : "manufacturer-web",
  source: SCREEN_ESTIMATE_CODES.has(code)
    ? "photo-derived: median pixel sample from a real product-listing photo of the physical thread (supplied by Delaney, 19 July), crop-verified against clean thread texture before use -- not manufacturer data"
    : "consensus DMC dataset (sharlagelfand/seanockert/maxxmint agree); Excel corruption repaired from RGB; 309 and 210 arbitrated against the Rose lightness ladder and sharlagelfand respectively",
}));

export const DMC_PERLE_5: ThreadBrand = {
  id: "dmc-perle-5",
  name: "DMC Coton Perle #5",
  // Same key as thread-calculator.ts's KNOWN_THREADS entry, so a matched shade
  // is immediately costable through thread-calculator-bridge.ts.
  calculatorKey: "dmc-perle-5",
  shades,
  // All 301 known codes now have a colour value (the last 7 closed 19 July,
  // see the screen-estimate note above) -- still 3 short of the true 304,
  // which expectedShadeCount keeps visibly flagged rather than silently
  // absorbed.
  availableCodes: shades.map((s) => s.code),
  expectedShadeCount: 304,
};
