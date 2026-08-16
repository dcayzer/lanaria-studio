// Client-side stamping of lettering and monograms onto a ChartData grid.
// Uses a fixed 5x7 bitmap font so each character maps directly to stitches —
// no anti-aliased font rasterisation, no colour matching, no shading.

import {
  rebuildChart,
  type ChartData,
  type ChartPaletteEntry,
} from "@/components/StitchChart";
import type { ThreadColor } from "@/data/threadPalettes";

export type TextSpec = {
  text: string;
  fontCss: string; // retained for API compatibility; ignored (bitmap font)
  color: string | null;
};

export type MonogramSpec = {
  initials: string[];
  colors: (string | null)[];
  count: 1 | 2 | 3;
  fontCss: string; // retained for API compatibility; ignored
};

const FONT_W = 5;
const FONT_H = 7;
const CHAR_SPACING = 1; // empty stitch columns between glyphs

// 5x7 bitmap font. Each glyph is 7 strings of length 5, '1' = stitch on.
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

function glyph(ch: string): string[] {
  return FONT[ch] || FONT[ch.toUpperCase()] || FONT["?"];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
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

function threadToEntry(c: ThreadColor): ChartPaletteEntry {
  return { id: c.code, name: c.name, family: c.family, hex: c.hex };
}

// Stamp a string at integer cell (x,y) with the given scale (cells per font pixel).
function stampString(
  px: Uint16Array,
  gridW: number,
  gridH: number,
  str: string,
  cellX: number,
  cellY: number,
  scale: number,
  ci: number,
) {
  const chars = [...str];
  let cx = cellX;
  for (let n = 0; n < chars.length; n++) {
    const g = glyph(chars[n]);
    for (let r = 0; r < FONT_H; r++) {
      const row = g[r];
      for (let c = 0; c < FONT_W; c++) {
        if (row[c] !== "1") continue;
        // paint a scale x scale block
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const X = cx + c * scale + dx;
            const Y = cellY + r * scale + dy;
            if (X >= 0 && X < gridW && Y >= 0 && Y < gridH) {
              px[Y * gridW + X] = ci;
            }
          }
        }
      }
    }
    cx += (FONT_W + CHAR_SPACING) * scale;
  }
}

function measureWidth(str: string, scale: number) {
  const n = [...str].length;
  if (n === 0) return 0;
  return n * FONT_W * scale + (n - 1) * CHAR_SPACING * scale;
}

function chooseScale(str: string, maxCellsW: number, maxCellsH: number, preferred: number) {
  let s = preferred;
  while (s > 1 && (measureWidth(str, s) > maxCellsW || FONT_H * s > maxCellsH)) {
    s--;
  }
  return Math.max(1, s);
}

export async function stampTextOnChart(
  chart: ChartData,
  text: TextSpec | null,
  monogram: MonogramSpec | null,
  brandPalette: ThreadColor[],
  positions?: {
    textPos?: { x: number; y: number };
    monogramPos?: { x: number; y: number };
  },
): Promise<ChartData> {
  const hasText = !!(text && text.text.trim() && text.color);
  const initsActive = monogram
    ? monogram.initials.slice(0, monogram.count).filter((v) => v)
    : [];
  const hasMono = initsActive.length > 0;
  if (!hasText && !hasMono) return chart;
  if (!brandPalette.length) return chart;

  const gridW = chart.width;
  const gridH = chart.height;
  const total = gridW * gridH;
  const px = new Uint16Array(total);
  {
    let i = 0;
    for (const [idx, len] of chart.pixelsRLE) {
      for (let n = 0; n < len && i < total; n++) px[i++] = idx;
    }
  }

  const workingPalette: ChartPaletteEntry[] = [...chart.palette];
  const byId = new Map<string, number>();
  workingPalette.forEach((p, i) => byId.set(p.id, i));

  const ensureColor = (hex: string): number => {
    const normalized = hex.startsWith("#") ? hex : `#${hex}`;
    const thread = nearestThread(normalized, brandPalette);
    const existing = byId.get(thread.code);
    if (existing !== undefined) return existing;
    workingPalette.push(threadToEntry(thread));
    const idx = workingPalette.length - 1;
    byId.set(thread.code, idx);
    return idx;
  };

  // Canvas-driven font multiple: whole-number 1×, 2× or 3× (nearest-neighbour)
  // chosen by canvas size — larger canvases use a bigger multiple.
  const canvasMin = Math.min(gridW, gridH);
  const canvasScale: 1 | 2 | 3 =
    canvasMin >= 240 ? 3 : canvasMin >= 140 ? 2 : 1;

  // Monogram — each initial in its own colour, centred on monogramPos.
  if (hasMono && monogram) {
    const n = monogram.count;
    // Reduce scale only if it physically wouldn't fit.
    let scale: number = canvasScale;
    const combinedWidth = (s: number) =>
      n * FONT_W * s + (n - 1) * (CHAR_SPACING + 1) * s;
    while (scale > 1 && combinedWidth(scale) > Math.floor(gridW * 0.9)) scale--;
    while (scale > 1 && FONT_H * scale > Math.floor(gridH * 0.4)) scale--;
    const totalW = combinedWidth(scale);
    const cxFrac = positions?.monogramPos?.x ?? 0.5;
    const cyFrac = positions?.monogramPos?.y ?? 0.14;
    const startX = Math.floor(cxFrac * gridW - totalW / 2);
    const y = Math.floor(cyFrac * gridH - (FONT_H * scale) / 2);
    let cx = startX;
    for (let i = 0; i < n; i++) {
      const ch = (monogram.initials[i] || "").toUpperCase();
      if (ch) {
        const color = monogram.colors[i] ?? "#3B4F35";
        const ci = ensureColor(color);
        stampString(px, gridW, gridH, ch, cx, y, scale, ci);
      }
      cx += (FONT_W + CHAR_SPACING + 1) * scale;
    }
  }

  // Text — centred on textPos.
  if (hasText && text) {
    const ci = ensureColor(text.color!);
    const str = text.text.toUpperCase();
    const scale = chooseScale(str, Math.floor(gridW * 0.9), Math.floor(gridH * 0.4), canvasScale);
    const w = measureWidth(str, scale);
    const cxFrac = positions?.textPos?.x ?? 0.5;
    const cyFrac = positions?.textPos?.y ?? 0.86;
    const x = Math.floor(cxFrac * gridW - w / 2);
    const y = Math.floor(cyFrac * gridH - (FONT_H * scale) / 2);
    stampString(px, gridW, gridH, str, x, y, scale, ci);
  }


  return rebuildChart(gridW, gridH, workingPalette, px) as ChartData;
}
