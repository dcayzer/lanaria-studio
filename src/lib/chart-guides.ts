// Ruler ticks, geographic centre, and centre guide lines.
//
// These are pure geometry helpers the chart renderer (StitchChart.tsx) will
// consume to DRAW the actual rulers/marks — this module decides WHERE the
// ticks, centre symbol, and centre lines go, in grid-cell coordinates; the
// renderer turns those into pixels. Kept separate so the placement logic is
// testable without a canvas.

// ---------------------------------------------------------------------------
// Rulers
// ---------------------------------------------------------------------------

export interface RulerTick {
  /** Cell index along the axis (0-based). */
  index: number;
  /** Label to show (usually the 1-based count). Empty string for minor ticks. */
  label: string;
  major: boolean;
}

/**
 * Ruler ticks for one axis of `length` cells. Majors every `majorEvery` cells
 * (default 10, the needlepoint convention — heavy lines every 10 stitches),
 * with a labelled tick at each major and at the final cell. Minor ticks every
 * `minorEvery` (default 5) if you want them; set minorEvery to 0 for majors
 * only.
 *
 * Labels are 1-based stitch counts (stitchers count "stitch 10, 20, 30"),
 * while `index` stays 0-based for rendering math.
 */
export function rulerTicks(
  length: number,
  majorEvery = 10,
  minorEvery = 5,
): RulerTick[] {
  const ticks: RulerTick[] = [];
  for (let i = 0; i < length; i++) {
    const count = i + 1; // 1-based
    const isMajor = count % majorEvery === 0;
    const isMinor = minorEvery > 0 && count % minorEvery === 0 && !isMajor;
    if (isMajor) {
      ticks.push({ index: i, label: String(count), major: true });
    } else if (isMinor) {
      ticks.push({ index: i, label: "", major: false });
    }
  }
  // Always mark the final stitch so the ruler shows the true total, even if it
  // isn't a multiple of majorEvery.
  if (length > 0) {
    const last = length - 1;
    if (!ticks.some((t) => t.index === last)) {
      ticks.push({ index: last, label: String(length), major: true });
    }
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Geographic centre + centre guide lines
// ---------------------------------------------------------------------------

export interface CenterMark {
  /**
   * Cell the centre symbol sits in. For an odd dimension there's a true middle
   * cell; for an even dimension the centre falls on a GRID LINE between two
   * cells, so we report the lower-index cell and flag it.
   */
  cellX: number;
  cellY: number;
  /** True if the centre lies on the line between cells on that axis (even dim). */
  betweenX: boolean;
  betweenY: boolean;
  /**
   * Exact centre in fractional cell coordinates — cellsWide/2, cellsHigh/2.
   * The renderer uses this to place the symbol precisely (on a line for even
   * dims, in a cell centre for odd), independent of the cell rounding above.
   */
  exactX: number;
  exactY: number;
}

/**
 * The chart's geographic centre — where a stitcher is told to start, so the
 * design ends up centred on their physical canvas. This is the CANVAS/GRID
 * centre (width/2, height/2), deliberately NOT the centre-of-mass of the
 * stitched design, because the instruction "start from the middle of your
 * canvas" is about the canvas, not the motif.
 */
export function geographicCenter(width: number, height: number): CenterMark {
  const exactX = width / 2;
  const exactY = height / 2;
  return {
    cellX: Math.floor((width - 1) / 2),
    cellY: Math.floor((height - 1) / 2),
    betweenX: width % 2 === 0,
    betweenY: height % 2 === 0,
    exactX,
    exactY,
  };
}

export interface CenterLines {
  /** X position (in fractional cell units) of the vertical centre line. */
  vertical: number;
  /** Y position (in fractional cell units) of the horizontal centre line. */
  horizontal: number;
  /** True when that line runs along a grid line rather than through cell centres. */
  verticalOnGridLine: boolean;
  horizontalOnGridLine: boolean;
}

/**
 * The two centre guide lines (one vertical, one horizontal) that help a user
 * chart evenly and symmetrically. Positions are in fractional cell units so
 * the renderer multiplies by cell size directly. For an even dimension the
 * line sits exactly on the grid line between the two middle cells (which reads
 * cleanly); for an odd dimension it runs down the middle of the centre cell.
 */
export function centerLines(width: number, height: number): CenterLines {
  return {
    vertical: width / 2,
    horizontal: height / 2,
    verticalOnGridLine: width % 2 === 0,
    horizontalOnGridLine: height % 2 === 0,
  };
}
