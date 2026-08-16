// Canvas shape definitions for the design page.
//
// The chart grid stays RECTANGULAR (real needlepoint canvas is cut as a
// rectangle). A shape defines which cells will be stitchable; the masking
// itself happens engine-side. This module only provides what the UI needs:
// the canvas dimensions each shape implies, and how to interpret the
// user's width/height inputs.
//
// FIXED 17 July: canvasDimsInches previously returned the FINISHED size with
// no blocking/finishing margin added, even though canvasShapeOutline.ts's
// margin math (outlineMarginFraction) assumes the margin is ALREADY baked
// into the numbers it's given. Net effect: a circle set to a 10in diameter
// was rendering as an ~8in circle inscribed in a 10x10 canvas. Also: stocking
// was still using the OLD two-independent-input model (leg width x 1.9
// multiplier) though canvasShapeOutline.ts's traced silhouette was built for
// a SINGLE height input with width derived from the measured STOCKING_ASPECT.
// Both fixed together here, verified against a corrected test suite (16/16).

import { OUTLINE_MARGIN_INCHES, STOCKING_ASPECT } from "./canvasShapeOutline";

export type CanvasShape = "rectangle" | "circle" | "oval" | "stocking" | "brick";

export const CANVAS_SHAPES: { value: CanvasShape; label: string }[] = [
  { value: "rectangle", label: "Rectangle" },
  { value: "circle", label: "Circle" },
  { value: "oval", label: "Oval" },
  { value: "stocking", label: "Stocking" },
  { value: "brick", label: "Brick / Door Stop" },
];

export const BRICK = {
  coverLength: 8.5,
  coverWidth: 4.5,
  coverDepth: 2.75,
  brickLength: 8,
  brickWidth: 4,
  brickDepth: 2,
} as const;

export const BRICK_CANVAS_WIDTH_INCHES = BRICK.coverDepth + BRICK.coverLength + BRICK.coverDepth;
export const BRICK_CANVAS_HEIGHT_INCHES = BRICK.coverDepth + BRICK.coverWidth + BRICK.coverDepth;

export const BRICK_BLURB =
  `Stitches as a cross shape that folds up around a standard brick. ` +
  `The centre panel becomes the top; the four arms fold down over the sides and ends ` +
  `(the base is left open, as it sits on the floor). ` +
  `Design area ${BRICK_CANVAS_WIDTH_INCHES}in x ${BRICK_CANVAS_HEIGHT_INCHES}in, ` +
  `finishing to roughly ${BRICK.coverLength}in x ${BRICK.coverWidth}in x ${BRICK.coverDepth}in — ` +
  `sized for a typical ${BRICK.brickLength}in x ${BRICK.brickWidth}in x ${BRICK.brickDepth}in hardware brick.`;

// Retained for backward compatibility (no longer called by canvasDimsInches).
export const STOCKING_FOOT_EXTENT = 1.9;
export function stockingGridWidthInches(legWidthInches: number): number {
  return legWidthInches * STOCKING_FOOT_EXTENT;
}

export function canvasDimsInches(
  shape: CanvasShape,
  widthInches: number,
  heightInches: number,
): { width: number; height: number } {
  if (shape === "brick") {
    return { width: BRICK_CANVAS_WIDTH_INCHES, height: BRICK_CANVAS_HEIGHT_INCHES };
  }
  if (shape === "stocking") {
    const finishedH = heightInches;
    const finishedW = finishedH * STOCKING_ASPECT;
    return {
      width: finishedW + 2 * OUTLINE_MARGIN_INCHES,
      height: finishedH + 2 * OUTLINE_MARGIN_INCHES,
    };
  }
  if (shape === "circle" || shape === "oval") {
    return {
      width: widthInches + 2 * OUTLINE_MARGIN_INCHES,
      height: heightInches + 2 * OUTLINE_MARGIN_INCHES,
    };
  }
  return { width: widthInches, height: heightInches };
}

export function hasFixedDimensions(shape: CanvasShape): boolean {
  return shape === "brick";
}

export function isSingleDimension(shape: CanvasShape): boolean {
  return shape === "circle" || shape === "stocking";
}

export function widthLabel(shape: CanvasShape): string {
  if (shape === "circle") return "Diameter (inches)";
  if (shape === "stocking") return "Finished Height, cuff to sole (inches)";
  return "Finished Width (inches)";
}

export function heightLabel(shape: CanvasShape): string {
  if (shape === "stocking") return "Height, top to bottom (inches)";
  return "Finished Height (inches)";
}
