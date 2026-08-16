// Assembles a full four-sided border frame from one of Delaney's hand-charted
// corner+run designs (see hand-charted-borders.ts) at any target grid size.
//
// THE CORE RULE, discovered the hard way across many rounds of visual review:
// every strip (one edge's worth of corner + run) places its corner ONLY at
// its own near end (local column 0) and STOPS the run before reaching the far
// end's territory (the last `cornerWidth` columns are left blank). Rotating
// that one strip four ways and taking the cell-wise max naturally lands each
// of the 4 corners from a DIFFERENT rotation's near end, with zero overlap.
//
// Placing a second corner copy at a strip's far end, or letting the run
// extend all the way to the far edge, both cause the same family of bugs:
// two corner motifs (or a corner and a run motif) landing on the same cells,
// which reads as smushed/doubled shapes or a filled-in stitch that should be
// open. If you're tempted to "fix" a seam by adding more coverage, check
// whether you're re-introducing this instead.

import type { HandBorder } from "../data/hand-charted-borders";

type Grid = number[][]; // grid[row][col], 0 = empty

function parseRows(rows: string[]): Grid {
  return rows.map((r) => r.split("").map(Number));
}

function emptyGrid(h: number, w: number): Grid {
  return Array.from({ length: h }, () => new Array<number>(w).fill(0));
}

function placeMax(dst: Grid, src: Grid, atRow: number, atCol: number) {
  for (let r = 0; r < src.length; r++) {
    for (let c = 0; c < src[0].length; c++) {
      const v = src[r][c];
      if (!v) continue;
      const dr = atRow + r;
      const dc = atCol + c;
      if (dr < 0 || dc < 0 || dr >= dst.length || dc >= dst[0].length) continue;
      dst[dr][dc] = Math.max(dst[dr][dc], v);
    }
  }
}

function slice(g: Grid, r0: number, r1: number, c0: number, c1: number): Grid {
  return g.slice(r0, r1).map((row) => row.slice(c0, c1));
}

/** Rotate a grid 90° * k counter-clockwise (matches numpy.rot90 convention). */
function rot90(g: Grid, k: number): Grid {
  let out = g;
  const n = ((k % 4) + 4) % 4;
  for (let i = 0; i < n; i++) {
    const h = out.length, w = out[0].length;
    const next = emptyGrid(w, h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        next[w - 1 - c][r] = out[r][c];
      }
    }
    out = next;
  }
  return out;
}

function compositeFourRotations(strip: Grid, N: number, ch: number): Grid {
  return compositeRectFrame(strip, strip, N, N, ch);
}

/**
 * Rectangle-capable compositor. The horizontal strip (length W) supplies the
 * top and bottom edges; the vertical strip (length H) supplies the left and
 * right. Corner placement is unchanged from the square case and still lands
 * each of the four corners from a DIFFERENT strip end, with zero overlap:
 * bottom-left from the h-strip's near end, bottom-right from the v-strip's,
 * top-right from the h-strip's rotated near end, top-left from the v-strip's.
 * Verified zero cell collisions across portrait, landscape and square sizes.
 * When W === H this produces byte-identical output to the old square path.
 */
function compositeRectFrame(hStrip: Grid, vStrip: Grid, W: number, H: number, ch: number): Grid {
  const canvas = emptyGrid(H, W);
  placeMax(canvas, rot90(hStrip, 0), H - ch, 0);   // bottom edge
  placeMax(canvas, rot90(vStrip, 1), 0, W - ch);   // right edge
  placeMax(canvas, rot90(hStrip, 2), 0, 0);        // top edge
  placeMax(canvas, rot90(vStrip, 3), 0, 0);        // left edge
  return canvas;
}

function buildSimpleStrip(border: HandBorder, N: number): Grid {
  const g = parseRows(border.rows);
  const H = g.length;
  const cw = border.corner.width;
  const ch = border.corner.height;
  const r0 = H - ch;
  const corner = slice(g, r0, H, 0, cw);
  const rep = border.runRepeat && border.runRepeat > 0 ? border.runRepeat : 1;
  const unit = slice(g, r0, H, cw, cw + rep);

  const strip = emptyGrid(ch, N);
  placeMax(strip, corner, 0, 0);
  const stop = N - cw;
  let col = cw;
  while (col + rep <= stop) {
    placeMax(strip, unit, 0, col);
    col += rep;
  }
  return strip;
}

function buildSpacerAlternatingStrip(border: HandBorder, N: number): Grid {
  const g = parseRows(border.rows);
  const H = g.length;
  const cw = border.corner.width;
  const ch = border.corner.height;
  const r0 = H - ch;
  const corner = slice(g, r0, H, 0, cw);
  const rep = border.runRepeat ?? 8;
  const motifW = rep - 1; // one spacer column + the motif
  // flowerA: the motif as charted in the run, starting immediately at cw --
  // no leading spacer here, since the corner's own trailing spacer already
  // provides the gap (this is exactly the bug that caused a doubled-gap
  // regression during review: adding a second spacer where one already existed).
  const flowerA = slice(g, r0, H, cw, cw + motifW);
  // flowerB: the corner's OWN motif colouring, reused directly (not re-derived)
  const flowerB = slice(g, r0, H, 1, 1 + motifW);

  const strip = emptyGrid(ch, N);
  placeMax(strip, corner, 0, 0);
  const stop = N - cw;
  let col = cw;
  if (col + motifW <= stop) {
    placeMax(strip, flowerA, 0, col);
    col += motifW;
  }
  let i = 1;
  while (col + 1 + motifW <= stop) {
    col += 1; // spacer
    placeMax(strip, i % 2 === 1 ? flowerB : flowerA, 0, col);
    col += motifW;
    i += 1;
  }
  return strip;
}

function buildPieceListStrip(border: HandBorder, N: number): Grid {
  const g = parseRows(border.rows);
  const H = g.length;
  const cw = border.corner.width;
  const ch = border.corner.height;
  const r0 = H - ch;
  const corner = slice(g, r0, H, 0, cw);
  const [w1, w2] = border.pieceWidths ?? [5, 7];
  const piece1 = slice(g, r0, H, cw, cw + w1);
  const piece2 = slice(g, r0, H, cw + w1, cw + w1 + w2);

  const strip = emptyGrid(ch, N);
  placeMax(strip, corner, 0, 0);
  const stop = N - cw;
  let col = cw;
  let i = 0;
  const pieces = [piece1, piece2];
  const widths = [w1, w2];
  while (true) {
    const w = widths[i % 2];
    if (col + w > stop) break;
    placeMax(strip, pieces[i % 2], 0, col);
    col += w;
    i += 1;
  }
  return strip;
}

/**
 * "lShaped" borders (currently: Ladder) chart the corner's horizontal run
 * AND its vertical run as genuinely different data -- not a rotation of one
 * another -- so they need their own compositor rather than the single-strip
 * rotate-four-ways approach used everywhere else.
 */
function buildLShapedFrame(border: HandBorder, N: number): Grid {
  const g = parseRows(border.rows);
  const H = g.length;
  const cw = border.corner.width;
  const ch = border.corner.height;
  const r0 = H - ch;
  const corner = slice(g, r0, H, 0, cw);
  const rep = border.runRepeat ?? 2;
  const hUnit = slice(g, r0, H, cw, cw + rep);
  const vUnit = slice(g, 5, 7, 0, cw);

  const piece = emptyGrid(N, N);
  placeMax(piece, corner, N - ch, 0);

  const hStop = N - cw;
  let col = cw;
  while (col + rep <= hStop) {
    placeMax(piece, hUnit, N - ch, col);
    col += rep;
  }

  const topStop = N - ch;
  let row = topStop - 2;
  while (row - 2 >= ch) {
    placeMax(piece, vUnit, row, 0);
    row -= 2;
  }

  const canvas = emptyGrid(N, N);
  for (let rot = 0; rot < 4; rot++) {
    placeMax(canvas, rot90(piece, rot), 0, 0);
  }
  return canvas;
}

/**
 * Tile a hand-charted border to fill a frame of targetW x targetH stitches.
 * Pass one argument for a square frame (targetH defaults to targetW).
 * N should comfortably exceed 2 * corner size; the run length is rounded
 * down to a whole number of repeats so nothing lands half-finished against
 * a corner. Returns a grid of colour-role values (0 = empty), which may be
 * slightly larger or smaller than requested on each axis independently.
 */
export function tileHandBorder(border: HandBorder, targetW: number, targetH: number = targetW): Grid {
  const cw = border.corner.width;
  const ch = border.corner.height;
  const rep = border.runRepeat && border.runRepeat > 0 ? border.runRepeat : 1;
  // Each axis is rounded independently to a whole number of repeats, so a
  // wide canvas gets a wide frame instead of a square one centred in it.
  const fitAxis = (target: number): number => {
    const usable = Math.max(rep, target - 2 * cw);
    const k = Math.max(1, Math.round(usable / rep));
    return 2 * cw + k * rep;
  };
  const W = fitAxis(targetW);
  const H = fitAxis(targetH);

  // "lShaped" (currently only Ladder) charts its vertical arm as genuinely
  // DIFFERENT data from its horizontal one, and its compositor rotates a
  // single L-shaped piece four ways about the origin -- which only closes
  // into a frame when the piece is square. Supporting rectangles here needs
  // its own design pass (the two unrotated corners have no charted data),
  // so it stays square-and-centred rather than being silently mis-assembled.
  if (border.tiling === "lShaped") {
    return buildLShapedFrame(border, Math.min(W, H));
  }

  const buildStrip = (len: number): Grid => {
    switch (border.tiling) {
      case "spacerAlternating": return buildSpacerAlternatingStrip(border, len);
      case "pieceList": return buildPieceListStrip(border, len);
      case "simple":
      default: return buildSimpleStrip(border, len);
    }
  };

  return compositeRectFrame(buildStrip(W), buildStrip(H), W, H, ch);
}

/** Convenience: tile then convert to a flat cell array using a role->thread map, for direct use as a Layer's cells. */
export function tileHandBorderToCells(
  border: HandBorder,
  targetN: number,
  roleToCode: (role: number) => string | null,
  sentinel: string,
): string[][] {
  const grid = tileHandBorder(border, targetN);
  return grid.map((row) =>
    row.map((v) => {
      if (!v) return sentinel;
      const code = roleToCode(v);
      return code ?? sentinel;
    }),
  );
}
