// Brick-shape geometry + per-slot image generation prompts.
//
// All numbers are DERIVED from the BRICK constants in canvasShapes.ts. Do not
// hardcode fractions -- the whole point is that if the cover dimensions ever
// change, everything downstream (panel rects, stitch counts, prompts) tracks
// automatically.
//
// The finished cover is a cross/plus NET on the 14x10in canvas:
//
//     .   sideTop   .
//   endL    top    endR
//     .  sideBottom  .
//
// The four "." corners are cut away during finishing and contain no design
// content -- the canvas-shape mask handles that; prompts don't need to.
//
// PROMPT MODEL (post scene-wrap removal): a single "scene wrap" prompt asking
// the model to compose a 5-panel unfolded net did not comply reliably. Instead
// each brick composition is now assembled from independently-generated SLOTS:
//   - uniform         -> one pattern that covers all five panels
//   - arms            -> one pattern covering all four arm panels
//   - armsTopBottom   -> one pattern covering sideTop + sideBottom
//   - armsLeftRight   -> one pattern covering endLeft + endRight
//   - center          -> one self-contained motif for the top face only
// Placement happens in brick-compose.ts.

import {
  BRICK,
  BRICK_CANVAS_WIDTH_INCHES,
  BRICK_CANVAS_HEIGHT_INCHES,
} from "./canvasShapes";

export type BrickPanelId =
  | "top"
  | "endLeft"
  | "endRight"
  | "sideTop"
  | "sideBottom";

export type BrickPanel = {
  id: BrickPanelId;
  /** Fractional canvas-space rect, 0..1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Real finished size of this panel, inches. */
  widthInches: number;
  heightInches: number;
};

/** Compositional modes for a brick cover. */
export type BrickPatternMode =
  | "uniform"
  | "armsPlusCenter"
  | "pairedArmsPlusCenter";

/** Independently-generated artwork slots that assemble into a brick. */
export type BrickSlotKind =
  | "uniform"
  | "arms"
  | "armsTopBottom"
  | "armsLeftRight"
  | "center";

/** Whether a slot's artwork repeats as a tile, or is one motif placed once per panel. */
export type BrickSlotContentMode = "pattern" | "single";

const canvasW = BRICK_CANVAS_WIDTH_INCHES;
const canvasH = BRICK_CANVAS_HEIGHT_INCHES;

const xL = BRICK.coverDepth / canvasW;
const xR = (BRICK.coverDepth + BRICK.coverLength) / canvasW;
const yT = BRICK.coverDepth / canvasH;
const yB = (BRICK.coverDepth + BRICK.coverWidth) / canvasH;

export const BRICK_PANELS: BrickPanel[] = [
  {
    id: "top",
    x0: xL, y0: yT, x1: xR, y1: yB,
    widthInches: BRICK.coverLength,
    heightInches: BRICK.coverWidth,
  },
  {
    id: "endLeft",
    x0: 0, y0: yT, x1: xL, y1: yB,
    widthInches: BRICK.coverDepth,
    heightInches: BRICK.coverWidth,
  },
  {
    id: "endRight",
    x0: xR, y0: yT, x1: 1, y1: yB,
    widthInches: BRICK.coverDepth,
    heightInches: BRICK.coverWidth,
  },
  {
    id: "sideTop",
    x0: xL, y0: 0, x1: xR, y1: yT,
    widthInches: BRICK.coverLength,
    heightInches: BRICK.coverDepth,
  },
  {
    id: "sideBottom",
    x0: xL, y0: yB, x1: xR, y1: 1,
    widthInches: BRICK.coverLength,
    heightInches: BRICK.coverDepth,
  },
];

export function brickPanelStitches(
  mesh: number,
): Array<BrickPanel & { widthStitches: number; heightStitches: number }> {
  return BRICK_PANELS.map((p) => ({
    ...p,
    widthStitches: Math.round(p.widthInches * mesh),
    heightStitches: Math.round(p.heightInches * mesh),
  }));
}

export function brickSmallestPanelStitches(mesh: number): number {
  const panels = brickPanelStitches(mesh);
  let min = Infinity;
  for (const p of panels) {
    if (p.widthStitches < min) min = p.widthStitches;
    if (p.heightStitches < min) min = p.heightStitches;
  }
  return min;
}

export function brickMinFeatureStitches(mesh: number): number {
  const smallest = brickSmallestPanelStitches(mesh);
  return Math.max(3, Math.floor(smallest / 10));
}

/** Which panels a slot's artwork will cover. */
export function slotPanels(slot: BrickSlotKind): BrickPanelId[] {
  switch (slot) {
    case "uniform":
      return ["top", "endLeft", "endRight", "sideTop", "sideBottom"];
    case "arms":
      return ["endLeft", "endRight", "sideTop", "sideBottom"];
    case "armsTopBottom":
      return ["sideTop", "sideBottom"];
    case "armsLeftRight":
      return ["endLeft", "endRight"];
    case "center":
      return ["top"];
  }
}

/** Rotation in degrees CLOCKWISE to apply to an ARM panel's artwork so it
 *  reads upright once that tab is folded down over its face of the brick.
 *
 *  Derivation, not preference: each arm folds about the edge it shares with
 *  the centre panel, and that fold edge always ends up at the TOP of the
 *  finished face. So each arm's content is rotated until its own fold edge
 *  is uppermost:
 *    sideBottom -- fold edge is its TOP edge     -> already up    -> 0
 *    sideTop    -- fold edge is its BOTTOM edge  -> flip          -> 180
 *    endLeft    -- fold edge is its RIGHT edge   -> right to top  -> 90  (90 clockwise)
 *    endRight   -- fold edge is its LEFT edge    -> left to top   -> 270 (90 anticlockwise)
 *
 *  The two short tabs rotate in OPPOSITE directions because they are mirror
 *  images of each other -- rotating both the same way fixes one and worsens
 *  the other.
 *
 *  "top" is the centre panel (the top face itself) and is never rotated.
 *  NOTE the naming hazard: "top" is the CENTRE panel; "sideTop" is an arm. */
export function panelFoldRotation(id: BrickPanelId): 0 | 90 | 180 | 270 {
  switch (id) {
    case "top": return 0;
    case "sideBottom": return 0;
    case "sideTop": return 180;
    case "endLeft": return 90;
    case "endRight": return 270;
  }
}

function panelById(id: BrickPanelId, mesh: number) {
  return brickPanelStitches(mesh).find((p) => p.id === id)!;
}

/** Pick the narrowest short-side stitch count across a slot's target panels.
 *  This governs how many times the repeat must fit within the panel. */
function slotShortSideStitches(slot: BrickSlotKind, mesh: number): number {
  const ids = slotPanels(slot);
  let min = Infinity;
  for (const id of ids) {
    const p = panelById(id, mesh);
    const shortSide = Math.min(p.widthStitches, p.heightStitches);
    if (shortSide < min) min = shortSide;
  }
  return min;
}

function slotDimBlurb(slot: BrickSlotKind, mesh: number): string {
  const ids = slotPanels(slot);
  const parts = ids.map((id) => {
    const p = panelById(id, mesh);
    return `${id} ${p.widthInches}in x ${p.heightInches}in (~${p.widthStitches}x${p.heightStitches} stitches)`;
  });
  return parts.join("; ");
}

/** Build the AI prompt for a single independently-generated brick slot.
 *
 *  Pattern slots (`uniform`, `arms`, `armsTopBottom`, `armsLeftRight`) request
 *  a seamless repeating all-over texture with NO focal subject. This is
 *  deliberately explicit: an earlier failure asked for "leopard print" and got
 *  a leopard-print HEART -- the model introduced an object silhouette because
 *  nothing forbade it.
 *
 *  Centre slot (`center`) requests exactly one self-contained motif on a plain
 *  flat background, sized to the centre panel's real stitch dimensions.
 *
 *  Non-centre slots also accept a `single` content mode: one motif placed once
 *  per panel (not tiled), sized to the smallest target panel so it fits every
 *  panel the slot covers. */
export function buildBrickSlotPrompt(
  slot: BrickSlotKind,
  subject: string,
  mesh: number,
  contentMode: BrickSlotContentMode = "pattern",
): string {
  const minFeat = brickMinFeatureStitches(mesh);

  if (slot === "center") {
    const top = panelById("top", mesh);
    return [
      `Render ONE self-contained motif, centred, on a plain flat solid-colour background.`,
      `The motif must fit inside a landscape rectangle of ~${top.widthStitches}x${top.heightStitches} stitches (${top.widthInches}in x ${top.heightInches}in) at ${mesh}-count needlepoint mesh.`,
      `Every design feature must be at least ${minFeat} stitches across -- anything finer is unreadable at this scale.`,
      `Do NOT render a repeating pattern, do NOT render a background scene, do NOT include any text.`,
      `The motif must be a single visually-distinct subject with clear silhouette against the plain background.`,
      `Subject: ${subject}.`,
    ].join(" ");
  }

  if (contentMode === "single") {
    // One motif placed once per panel, NOT tiled. Sized to the slot's
    // smallest target panel so it fits every panel the slot covers.
    const ids = slotPanels(slot);
    const smallest = ids
      .map((id) => panelById(id, mesh))
      .reduce((a, b) =>
        Math.min(a.widthStitches, a.heightStitches) <= Math.min(b.widthStitches, b.heightStitches) ? a : b,
      );
    return [
      `Render ONE self-contained motif, centred, on a plain flat solid-colour background.`,
      `The motif must fit inside a rectangle of ~${smallest.widthStitches}x${smallest.heightStitches} stitches (${smallest.widthInches}in x ${smallest.heightInches}in) at ${mesh}-count needlepoint mesh.`,
      `Every design feature must be at least ${minFeat} stitches across -- anything finer is unreadable at this scale.`,
      `Do NOT render a repeating pattern, do NOT render a background scene, do NOT include any text.`,
      `The motif must be a single visually-distinct subject with a clear silhouette against the plain background.`,
      `Subject: ${subject}.`,
    ].join(" ");
  }

  // Pattern slots
  const shortSide = slotShortSideStitches(slot, mesh);
  const targetRepeats = 4;
  const motifCap = Math.max(minFeat, Math.floor(shortSide / targetRepeats));
  return [
    `Render a SEAMLESS REPEATING all-over PATTERN / PRINT / TEXTURE, edge to edge, filling the entire image.`,
    `This is a textile print, NOT a picture of a thing: there must be NO single focal subject, NO horizon, NO orientation-dependent composition, and NO overall object or silhouette formed by the pattern.`,
    `Do not arrange the motif into a heart, star, letter, animal, or any recognisable outline -- the pattern must read the same no matter which way it is turned or cropped.`,
    `Target panels for this artwork: ${slotDimBlurb(slot, mesh)}, at ${mesh}-count needlepoint mesh.`,
    `The individual repeating motif must be at most ~${motifCap} stitches across so the pattern repeats at least ${targetRepeats} times across the shortest target panel dimension (${shortSide} stitches).`,
    `Every design feature within the motif must be at least ${minFeat} stitches across.`,
    `The pattern must tile cleanly and evenly with no visible seams.`,
    `Subject / theme: ${subject}.`,
  ].join(" ");
}
