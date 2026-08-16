// Glyph layers: turns text/monograms into LAYERS (see layer-model.ts) rather
// than destructively stamping a chart.
//
// Supports two glyph sources behind one interface:
//   1. The built-in 5x7 bitmap font (legacy default, fixed-width).
//   2. Delaney's hand-charted alphabets (src/data/hand-charted-fonts.ts),
//      which have per-glyph widths AND per-glyph heights, and in one case
//      (Shadow Serif) a second colour.
//
// BACKWARD COMPATIBILITY: with no `fontId`, every formula below reduces to
// the original fixed 5x7 arithmetic (fixedW=5, boxH=7), so output is
// byte-identical to before. Existing saved designs must not shift.
//
// VERTICAL ALIGNMENT: hand-charted glyph boxes are TOP-ALIGNED within the
// font's boxH. That is not an approximation -- it was measured against the
// real charted data: the only glyphs whose ink falls below the shared
// baseline are true descenders (g/j/p/q/y) and authentic Copperplate
// flourishes, which is exactly the behaviour wanted. No per-glyph baseline
// metrics are needed or invented.
//
// The glyph's own cells are always copied verbatim -- layout (position,
// spacing, wrapping, scale) is the only thing computed. Hand-charted
// lettering artwork is never re-interpreted.

import type { Layer, Quarter } from "./layer-model";
import { makeLayer, rotateCells } from "./layer-model";
import type { ThreadColor } from "../data/threadPalettes";
import { findHandFont, type HandFont } from "../data/hand-charted-fonts";

export type TextAlign = "left" | "center" | "right";

export type TextSpec = {
  text: string;
  fontCss: string;
  color: string | null;
  align?: TextAlign;
  boxWidthCells?: number;
  /** Hand-charted font id. Omit/unknown -> built-in 5x7 font. */
  fontId?: string | null;
  /** Thread colour for cell value 2 (two-colour fonts only). */
  shadowColor?: string | null;
  /** Quarter-turn rotation applied after layout. Lossless. */
  rotation?: Quarter;
  /** Stitches of horizontal gap between adjacent glyphs within a word/line.
   *  Omit for the original default (1, same as the old hardcoded CHAR_SPACING)
   *  so any TextSpec that predates this field renders byte-identical to before. */
  letterSpacing?: number;
};

export type MonogramSpec = {
  initials: string[];
  colors: (string | null)[];
  count: 1 | 2 | 3;
  fontCss: string;
  fontId?: string | null;
  shadowColor?: string | null;
  /** Quarter-turn rotation applied after layout. Lossless. */
  rotation?: Quarter;
};

const FONT_W = 5;
const FONT_H = 7;
const CHAR_SPACING = 1;
const MONOGRAM_SPACING = CHAR_SPACING + 1;
const LINE_SPACING = 1;

const FONT: Record<string, string[]> = {
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01110","10001","10000","10000","10000","10001","01110"],
  "D": ["11110","10001","10001","10001","10001","10001","11110"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01110","10001","10000","10111","10001","10001","01111"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["01110","00100","00100","00100","00100","00100","01110"],
  "J": ["00111","00010","00010","00010","00010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","10001","11001","10101","10011","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","11011","10001"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11110","00001","00001","01110","00001","00001","11110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00010","01100"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","00100","00100"],
  ",": ["00000","00000","00000","00000","00100","00100","01000"],
  "!": ["00100","00100","00100","00100","00100","00000","00100"],
  "?": ["01110","10001","00001","00010","00100","00000","00100"],
  "'": ["00100","00100","00000","00000","00000","00000","00000"],
  '"': ["01010","01010","00000","00000","00000","00000","00000"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  "_": ["00000","00000","00000","00000","00000","00000","11111"],
  "&": ["01100","10010","10010","01100","10101","10010","01101"],
  "(": ["00010","00100","01000","01000","01000","00100","00010"],
  ")": ["01000","00100","00010","00010","00010","00100","01000"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"],
  ":": ["00000","00100","00100","00000","00100","00100","00000"],
  ";": ["00000","00100","00100","00000","00100","00100","01000"],
  "+": ["00000","00100","00100","11111","00100","00100","00000"],
  "#": ["01010","01010","11111","01010","11111","01010","01010"],
  "*": ["00000","10101","01110","11111","01110","10101","00000"],
};

/**
 * One interface over both glyph sources. The legacy instance sets fixedW/boxH
 * so every generalized formula below collapses to the original 5x7 arithmetic.
 */
type GlyphSource = {
  boxH: number;
  /** Fixed advance width, or null when glyphs vary in width. */
  fixedW: number | null;
  /** Reference width used to size wrapping. */
  refW: number;
  /** Advance used for a space when the font has no space glyph. */
  spaceW: number;
  colours: 1 | 2;
  /** Case forced on input, or null to leave it alone. */
  forceCase: "upper" | "lower" | null;
  rows(ch: string): string[] | null;
  /** Rows to shift this glyph down when drawing, to sit it on the baseline. */
  offsetFor(ch: string): number;
  /** Real ink-bounding-box advance width for one glyph -- the rightmost
   *  column with any ink across all rows, plus 1. Only used for
   *  hand-charted fonts (fixedW null); the legacy 5x7 font's fixedW always
   *  short-circuits advanceFor before this is called, so it stays
   *  byte-identical by construction. */
  inkWidthFor(ch: string): number;
  /** Manual advance reduction after this glyph, in stitches. 0 for fonts/
   *  glyphs without an override -- see HandFont.kernAfter for why this
   *  exists and is not computed. */
  kernAfterFor(ch: string): number;
};

const LEGACY_SOURCE: GlyphSource = {
  boxH: FONT_H,
  fixedW: FONT_W,
  refW: FONT_W,
  spaceW: FONT_W,
  colours: 1,
  forceCase: "upper",
  rows: (ch) => FONT[ch] || FONT[ch.toUpperCase()] || FONT["?"],
  // Built-in 5x7 is uniform; a zero offset keeps output byte-identical.
  offsetFor: () => 0,
  inkWidthFor: () => FONT_W,
  kernAfterFor: () => 0,
};

function handSource(font: HandFont): GlyphSource {
  const keys = Object.keys(font.glyphs);
  const widths = keys.map((k) => font.glyphs[k][0]?.length ?? 0);
  const maxW = widths.length ? Math.max(...widths) : 1;
  const hasUpper = keys.some((k) => k >= "A" && k <= "Z");
  const hasLower = keys.some((k) => k >= "a" && k <= "z");

  // Sit every glyph on the font's baseline. Hand-charted glyphs vary slightly
  // in box padding, which top-alignment alone exposes as letters floating
  // high or sitting low. dev >= 2 is a real descender/flourish and is left
  // untouched -- measured across all 291 glyphs, genuine descents are 2+ rows
  // and nothing real sits exactly 1 row below the baseline.
  const inkBottom = (rows: string[]): number => {
    let last = -1;
    for (let r = 0; r < rows.length; r++) {
      if (/[12]/.test(rows[r])) last = r;
    }
    return last;
  };
  const rawOffset: Record<string, number> = {};
  for (const k of keys) {
    const ib = inkBottom(font.glyphs[k]);
    if (ib < 0) { rawOffset[k] = 0; continue; }
    const dev = ib - font.baseline;
    rawOffset[k] = dev <= 1 ? -dev : 0;
  }
  // Normalise so no glyph is pushed above row 0, then size the box to fit.
  const minOff = Math.min(0, ...Object.values(rawOffset));
  const offset: Record<string, number> = {};
  for (const k of keys) offset[k] = rawOffset[k] - minOff;
  const effectiveBoxH = Math.max(
    ...keys.map((k) => font.glyphs[k].length + offset[k]),
  );

  // Real ink-bounding-box width: the rightmost column with any ink ("1" or
  // "2") across every row of the glyph, plus 1. This is what letterSpacing
  // was supposed to be spacing FROM -- the stored grid width includes
  // padding that varies a lot per glyph and was never being trimmed.
  const inkWidthOf = (rows: string[]): number => {
    let maxCol = -1;
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== "0" && c > maxCol) maxCol = c;
      }
    }
    return maxCol + 1;
  };
  const inkW: Record<string, number> = {};
  for (const k of keys) inkW[k] = Math.max(1, inkWidthOf(font.glyphs[k]));

  return {
    boxH: effectiveBoxH,
    fixedW: null,
    refW: maxW,
    // No hand-charted font includes a space glyph, so give the space a real
    // advance derived from the font's own scale rather than collapsing words.
    spaceW: Math.max(2, Math.round(maxW / 3)),
    colours: font.colours,
    // An uppercase-only font must not receive lowercase input (and vice
    // versa) or every glyph would miss. Fonts covering both cases are left
    // alone so mixed-case text renders as typed.
    forceCase: hasUpper && !hasLower ? "upper" : hasLower && !hasUpper ? "lower" : null,
    rows: (ch) =>
      font.glyphs[ch] ?? font.glyphs[ch.toUpperCase()] ?? font.glyphs[ch.toLowerCase()] ?? null,
    offsetFor: (ch) =>
      offset[ch] ?? offset[ch.toUpperCase()] ?? offset[ch.toLowerCase()] ?? 0,
    inkWidthFor: (ch) =>
      inkW[ch] ?? inkW[ch.toUpperCase()] ?? inkW[ch.toLowerCase()] ?? maxW,
    kernAfterFor: (ch) =>
      font.kernAfter?.[ch] ?? font.kernAfter?.[ch.toUpperCase()] ?? font.kernAfter?.[ch.toLowerCase()] ?? 0,
  };
}

function sourceFor(fontId: string | null | undefined): GlyphSource {
  if (!fontId) return LEGACY_SOURCE;
  const f = findHandFont(fontId);
  return f ? handSource(f) : LEGACY_SOURCE;
}

/** Advance width of one character. A glyph the font doesn't have takes no space. */
function advanceFor(src: GlyphSource, ch: string): number {
  const rows = src.rows(ch);
  if (rows) return src.fixedW ?? Math.max(1, src.inkWidthFor(ch) - src.kernAfterFor(ch));
  if (ch === " ") return src.spaceW;
  return 0;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function nearestThread(hex: string, palette: ThreadColor[]): ThreadColor {
  const [r, g, b] = hexToRgb(hex);
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const [pr, pg, pb] = hexToRgb(p.hex);
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function measureWidth(str: string, scale: number, spacing: number, src: GlyphSource): number {
  const chars = [...str];
  if (chars.length === 0) return 0;
  let w = 0;
  for (const ch of chars) w += advanceFor(src, ch);
  return w * scale + (chars.length - 1) * spacing * scale;
}

function chooseScale(
  str: string, maxCellsW: number, maxCellsH: number, preferred: number, spacing: number, src: GlyphSource,
): number {
  let s = preferred;
  while (s > 1 && (measureWidth(str, s, spacing, src) > maxCellsW || src.boxH * s > maxCellsH)) s--;
  return Math.max(1, s);
}

export function canvasScaleFor(gridW: number, gridH: number): 1 | 2 | 3 {
  const canvasMin = Math.min(gridW, gridH);
  return canvasMin >= 240 ? 3 : canvasMin >= 140 ? 2 : 1;
}

/** Rows for one character in a given font, or null if that font lacks it.
 *  Pass null/undefined fontId for the built-in 5x7 font. UI preview helper. */
export function glyphRowsFor(fontId: string | null | undefined, ch: string): string[] | null {
  return sourceFor(fontId).rows(ch);
}

/** Glyph box height for a font (built-in 5x7 when fontId is null). UI preview helper. */
export function glyphBoxH(fontId: string | null | undefined): number {
  return sourceFor(fontId).boxH;
}

/** Lay a sample string out with the real engine and return a plain 0/1/2 grid
 *  for UI previews. '0' empty, '1' main colour, '2' second colour. */
export function previewGrid(
  fontId: string | null | undefined,
  sample: string,
  rotation: Quarter = 0,
  letterSpacing?: number,
): string[][] {
  const src = sourceFor(fontId);
  const str =
    src.forceCase === "upper" ? sample.toUpperCase()
    : src.forceCase === "lower" ? sample.toLowerCase()
    : sample;
  const spacing = letterSpacing ?? CHAR_SPACING;
  const { cells } = rasterizeBlock(
    [str], measureWidth(str, 1, spacing, src), "left", spacing,
    () => "1", "0", src, "2",
  );
  return rotateCells(cells, rotation);
}



function wrapWords(str: string, nativeMaxW: number, spacing: number, src: GlyphSource): string[] {
  const words = str.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (measureWidth(candidate, 1, spacing, src) <= nativeMaxW) current = candidate;
    else { lines.push(current); current = words[i]; }
  }
  lines.push(current);
  return lines;
}

function chooseBlockLayout(
  str: string, gridW: number, gridH: number, boxWidthCells: number,
  preferred: number, spacing: number, src: GlyphSource,
): { lines: string[]; scale: number; nativeRefW: number } {
  const maxCanvasH = Math.floor(gridH * 0.9);
  let scale = preferred;
  while (scale >= 1) {
    const nativeMaxW = Math.max(src.refW, Math.floor(boxWidthCells / scale));
    const lines = wrapWords(str, nativeMaxW, spacing, src);
    const blockH = lines.length * src.boxH * scale + Math.max(0, lines.length - 1) * LINE_SPACING * scale;
    if (blockH <= maxCanvasH || scale === 1) return { lines, scale, nativeRefW: nativeMaxW };
    scale--;
  }
  const nativeMaxW = Math.max(src.refW, boxWidthCells);
  return { lines: wrapWords(str, nativeMaxW, spacing, src), scale: 1, nativeRefW: nativeMaxW };
}

function rasterizeBlock(
  lines: string[],
  nativeRefW: number,
  align: TextAlign,
  spacing: number,
  colorForChar: (lineIndex: number, charIndex: number, ch: string) => string | null,
  sentinel: string,
  src: GlyphSource,
  secondary: string | null,
): { cells: string[][]; width: number; height: number } {
  const totalH = lines.length * src.boxH + Math.max(0, lines.length - 1) * LINE_SPACING;
  const width = Math.max(1, nativeRefW);
  const cells: string[][] = Array.from(
    { length: Math.max(1, totalH) },
    () => new Array<string>(width).fill(sentinel),
  );
  let rowOffset = 0;
  lines.forEach((line, li) => {
    const chars = [...line];
    const lineW = measureWidth(line, 1, spacing, src);
    let colOffset: number;
    if (align === "left") colOffset = 0;
    else if (align === "right") colOffset = width - lineW;
    else colOffset = Math.floor((width - lineW) / 2);
    let cx = colOffset;
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      const code = colorForChar(li, ci, ch);
      const g = src.rows(ch);
      if (code && g) {
        // Per-glyph vertical offset sits each glyph on the font's baseline
        // (see handSource for the rule). Legacy 5x7 returns 0 so behaviour
        // is unchanged.
        const gOff = src.offsetFor(ch);
        for (let r = 0; r < g.length; r++) {
          const row = g[r];
          for (let c = 0; c < row.length; c++) {
            const v = row[c];
            if (v === "0") continue;
            // Value 2 = the font's second colour. If no shadow colour was
            // chosen, fall back to the primary so the glyph still renders
            // (monochrome) rather than losing cells.
            const cellCode = v === "2" ? (secondary ?? code) : code;
            const X = cx + c;
            const Y = rowOffset + r + gOff;
            if (X >= 0 && X < width && Y >= 0 && Y < cells.length) cells[Y][X] = cellCode;
          }
        }
      }
      cx += advanceFor(src, ch) + spacing;
    }
    rowOffset += src.boxH + LINE_SPACING;
  });
  return { cells, width, height: cells.length };
}

/** Shared layout decision used by both textToLayer and measureTextOnCanvas.
 *  Keeping this in one place is what makes the on-screen footprint the same
 *  thing that will actually be charted -- previously the preview used an
 *  arbitrary CSS font size, so a user could see "tiny text" in the preview,
 *  chart it, and get 3 of 7 letters because it silently overflowed. */
function planTextLayout(
  text: TextSpec,
  gridW: number,
  gridH: number,
): { src: GlyphSource; str: string; lines: string[]; scale: number; nativeRefW: number; spacing: number } {
  const src = sourceFor(text.fontId);
  const str =
    src.forceCase === "upper" ? text.text.toUpperCase()
    : src.forceCase === "lower" ? text.text.toLowerCase()
    : text.text;
  const spacing = text.letterSpacing ?? CHAR_SPACING;

  if (text.boxWidthCells && text.boxWidthCells > 0) {
    const layout = chooseBlockLayout(
      str, gridW, gridH, text.boxWidthCells, canvasScaleFor(gridW, gridH), spacing, src,
    );
    return { src, str, lines: layout.lines, scale: layout.scale, nativeRefW: layout.nativeRefW, spacing };
  }

  let scale = chooseScale(str, Math.floor(gridW * 0.9), Math.floor(gridH * 0.4), canvasScaleFor(gridW, gridH), spacing, src);
  let lines = [str];
  let nativeRefW = measureWidth(str, 1, spacing, src);
  // A hand-charted font can be far wider per glyph than the old 5x7 (Patchwork
  // Large is 26 cells per letter), so even at scale 1 a short word can exceed
  // the canvas. Wrap rather than letting it run off the edge and get clipped
  // during charting -- silent truncation is much worse than a second line.
  if (nativeRefW * scale > Math.floor(gridW * 0.95)) {
    const layout = chooseBlockLayout(
      str, gridW, gridH, Math.floor(gridW * 0.9), scale, spacing, src,
    );
    lines = layout.lines;
    scale = layout.scale;
    nativeRefW = layout.nativeRefW;
  }
  return { src, str, lines, scale, nativeRefW, spacing };
}

/** On-canvas size in stitches of the text as it will actually be charted.
 *  Returns null when there's nothing to draw. */
export function measureTextOnCanvas(
  text: TextSpec | null,
  gridW: number,
  gridH: number,
): { w: number; h: number; lines: number } | null {
  if (!text || !text.text.trim() || !text.color) return null;
  const { src, lines, scale, nativeRefW } = planTextLayout(text, gridW, gridH);
  const nativeH = lines.length * src.boxH + Math.max(0, lines.length - 1) * LINE_SPACING;
  const w = nativeRefW * scale;
  const h = nativeH * scale;
  // Rotation is lossless reindexing; for 90/270 the reported footprint swaps
  // so the "will chart at W x H stitches" hint stays truthful.
  const rot = text.rotation ?? 0;
  const swap = rot === 90 || rot === 270;
  return { w: swap ? h : w, h: swap ? w : h, lines: lines.length };
}

export function textToLayer(
  id: string,
  text: TextSpec | null,
  gridW: number,
  gridH: number,
  brandPalette: ThreadColor[],
  sentinel: string,
  textPos?: { x: number; y: number },
): Layer | null {
  const hasText = !!(text && text.text.trim() && text.color);
  if (!hasText || !text || !brandPalette.length) return null;

  const { src, lines, scale, nativeRefW, spacing } = planTextLayout(text, gridW, gridH);
  const align: TextAlign = text.align ?? "center";
  const thread = nearestThread(text.color!.startsWith("#") ? text.color! : `#${text.color!}`, brandPalette);
  const secondary =
    src.colours === 2 && text.shadowColor
      ? nearestThread(text.shadowColor.startsWith("#") ? text.shadowColor : `#${text.shadowColor}`, brandPalette).code
      : null;

  const { cells, width: nativeW, height: nativeH } = rasterizeBlock(
    lines, nativeRefW, align, spacing, () => thread.code, sentinel, src, secondary,
  );
  // Quarter-turn rotation is lossless (pure reindex). Derive the on-canvas
  // size from the ROTATED grid so a rotated block still centres on textPos.
  const rot: Quarter = text.rotation ?? 0;
  const rotatedCells = rotateCells(cells, rot);
  const rotW = rotatedCells[0]?.length ?? nativeW;
  const rotH = rotatedCells.length || nativeH;
  const onCanvasW = rotW * scale;
  const onCanvasH = rotH * scale;
  const cxFrac = textPos?.x ?? 0.5;
  const cyFrac = textPos?.y ?? 0.86;
  const x = Math.floor(cxFrac * gridW - onCanvasW / 2);
  const y = Math.floor(cyFrac * gridH - onCanvasH / 2);

  return makeLayer({ id, kind: "letter", cells: rotatedCells, offset: { x, y }, scale });
}

export function monogramToLayer(
  id: string,
  monogram: MonogramSpec | null,
  gridW: number,
  gridH: number,
  brandPalette: ThreadColor[],
  sentinel: string,
  monogramPos?: { x: number; y: number },
): Layer | null {
  const initsActive = monogram ? monogram.initials.slice(0, monogram.count).filter((v) => v) : [];
  if (!monogram || !initsActive.length || !brandPalette.length) return null;

  const src = sourceFor(monogram.fontId);
  const n = monogram.count;
  const raw = Array.from({ length: n }, (_, i) => monogram.initials[i] || " ").join("");
  const str =
    src.forceCase === "upper" ? raw.toUpperCase()
    : src.forceCase === "lower" ? raw.toLowerCase()
    : raw;

  let scale: number = canvasScaleFor(gridW, gridH);
  const combinedWidth = (s: number) => measureWidth(str, s, MONOGRAM_SPACING, src);
  while (scale > 1 && combinedWidth(scale) > Math.floor(gridW * 0.9)) scale--;
  while (scale > 1 && src.boxH * scale > Math.floor(gridH * 0.4)) scale--;

  const secondary =
    src.colours === 2 && monogram.shadowColor
      ? nearestThread(
          monogram.shadowColor.startsWith("#") ? monogram.shadowColor : `#${monogram.shadowColor}`,
          brandPalette,
        ).code
      : null;

  const colorForChar = (_li: number, i: number, ch: string): string | null => {
    if (ch === " " || !(monogram.initials[i] || "")) return null;
    const hex = monogram.colors[i] ?? "#3B4F35";
    const normalized = hex.startsWith("#") ? hex : `#${hex}`;
    return nearestThread(normalized, brandPalette).code;
  };

  const { cells } = rasterizeBlock(
    [str], measureWidth(str, 1, MONOGRAM_SPACING, src), "left", MONOGRAM_SPACING,
    colorForChar, sentinel, src, secondary,
  );
  // Rotation swaps width/height; use the rotated grid's real dimensions
  // (not combinedWidth / boxH) so a rotated monogram stays centred on
  // monogramPos.
  const rot: Quarter = monogram.rotation ?? 0;
  const rotatedCells = rotateCells(cells, rot);
  const rotW = rotatedCells[0]?.length ?? 0;
  const rotH = rotatedCells.length;
  const onCanvasW = rotW * scale;
  const onCanvasH = rotH * scale;
  const cxFrac = monogramPos?.x ?? 0.5;
  const cyFrac = monogramPos?.y ?? 0.14;
  const x = Math.floor(cxFrac * gridW - onCanvasW / 2);
  const y = Math.floor(cyFrac * gridH - onCanvasH / 2);

  return makeLayer({ id, kind: "monogram", cells: rotatedCells, offset: { x, y }, scale });
}

