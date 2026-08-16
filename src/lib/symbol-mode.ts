// Symbol / print mode (editing suite, §15.4 item 1; §15.5).
//
// Confirmed against the real StitchChart.tsx: symbols are ALWAYS drawn
// alongside colour -- there is no colour-off toggle. The chart already carries
// a symMap, so this is a render-mode decision + a decodable key, not new chart
// data. This module is pure logic; the actual canvas drawing stays in
// StitchChart.tsx (needs credits).
//
// What it provides:
//   1. resolveSymbols  -- one symbol per palette index, honouring any existing
//      symMap/palette symbols and filling gaps uniquely, so symbol mode always
//      renders even for colours that were never assigned a glyph.
//   2. cellRender      -- per palette index, in 'colour' | 'symbol' | 'both'
//      mode: what to fill, whether/what symbol to draw. Sentinel cells
//      (NOT_STITCHABLE, §8.7) render blank in every mode.
//   3. buildLegend     -- the decodable key pairing symbol <-> code <-> name
//      <-> colour <-> stitch count, so a printed symbol chart can be read.
//   4. buildPrintSet   -- Delaney's double-sided idea (§15.5): the same chart
//      as a colour page + a symbol page sharing one legend, so two greens that
//      read identically in colour can be told apart on the symbol side.
//
// RECONCILE BEFORE WIRING (same discipline as the other sandbox modules): the
// real symMap shape (object vs array; keyed by palette index vs thread code)
// and the palette entry field names must be checked against StitchChart.tsx's
// exported ChartData before use. Both symMap forms are accepted here.

export type RenderMode = "colour" | "symbol" | "both";

export interface PaletteColourLike {
  code: string;
  name?: string;
  /** Display colour, e.g. "#3B4F35". */
  hex: string;
  /** A symbol already assigned to this colour, if any. */
  symbol?: string;
}

/** symMap as the chart may carry it: index->glyph object, or glyph[] aligned
 *  to palette order. Undefined means "assign everything from scratch". */
export type SymMap = Record<number, string> | string[] | undefined;

export interface SymbolOptions {
  /** Palette index treated as NOT_STITCHABLE (§8.7); renders blank. */
  sentinelIndex?: number;
  /** Ink colour for symbols on the printed/symbol side. */
  symbolInk?: string;
  /** Override the glyph pool used to fill unassigned colours. */
  glyphPool?: string[];
}

// Curated, legibility-ordered glyph pool. Deliberately excludes visually
// ambiguous pairs early (no bare O/0, I/l/1) so a printed symbol chart stays
// readable at small size. Grows into punctuation/symbols only after letters
// and clear digits are exhausted.
export const DEFAULT_GLYPH_POOL: string[] = [
  "A","B","C","D","E","F","G","H","J","K","L","M","N","P","Q","R","S","T","U","V","W","X","Y","Z",
  "2","3","4","5","6","7","9",
  "a","b","c","d","e","f","g","h","k","m","n","p","q","r","s","t","u","w","y",
  "+","=","/","\\","#","%","&","@","*","<",">","~","^","!","?",
];

export interface ResolvedSymbols {
  /** symbol for each palette index. */
  byIndex: string[];
  /** true if there were more colours than available distinct glyphs. */
  poolExhausted: boolean;
  warnings: string[];
}

function symFromMap(symMap: SymMap, i: number): string | undefined {
  if (symMap == null) return undefined;
  if (Array.isArray(symMap)) return symMap[i] || undefined;
  return symMap[i] || undefined;
}

/** Assign one distinct symbol per palette index, preferring any existing
 *  symMap / palette.symbol, filling the rest from the pool without collisions. */
export function resolveSymbols(
  palette: PaletteColourLike[],
  symMap?: SymMap,
  options: SymbolOptions = {},
): ResolvedSymbols {
  const pool = options.glyphPool ?? DEFAULT_GLYPH_POOL;
  const byIndex: string[] = new Array(palette.length).fill("");
  const used = new Set<string>();
  const warnings: string[] = [];

  // Pass 1: take existing symbols (symMap wins, then palette.symbol), keeping
  // the first occurrence when two colours claim the same glyph.
  for (let i = 0; i < palette.length; i++) {
    if (options.sentinelIndex === i) continue;
    const existing = symFromMap(symMap, i) ?? palette[i]?.symbol;
    if (existing && !used.has(existing)) {
      byIndex[i] = existing;
      used.add(existing);
    }
  }

  // Pass 2: fill any still-empty index from the pool.
  let poolExhausted = false;
  let cursor = 0;
  for (let i = 0; i < palette.length; i++) {
    if (options.sentinelIndex === i) continue;
    if (byIndex[i]) continue;
    while (cursor < pool.length && used.has(pool[cursor])) cursor++;
    if (cursor >= pool.length) {
      poolExhausted = true;
      // Last-resort: number the overflow so it's still distinct, if not pretty.
      let n = 1;
      let g = `{${n}}`;
      while (used.has(g)) { n++; g = `{${n}}`; }
      byIndex[i] = g;
      used.add(g);
    } else {
      byIndex[i] = pool[cursor];
      used.add(pool[cursor]);
    }
  }
  if (poolExhausted) {
    warnings.push(
      "More colours than distinct glyphs in the pool; overflow colours got numbered placeholders. A chart this colour-heavy is hard to read as symbols -- consider reducing colours (chartability guidance) before printing symbol-only.",
    );
  }
  return { byIndex, poolExhausted, warnings };
}

export interface CellRender {
  /** Sentinel / not-stitchable: draw nothing at all. */
  blank: boolean;
  /** Fill colour hex, or null for no fill (white paper in symbol mode). */
  fill: string | null;
  drawSymbol: boolean;
  symbol: string;
  symbolInk: string;
}

/** Decide how a single cell renders in the given mode. */
export function cellRender(
  mode: RenderMode,
  paletteIndex: number,
  palette: PaletteColourLike[],
  symbols: string[],
  options: SymbolOptions = {},
): CellRender {
  const ink = options.symbolInk ?? "#111111";
  if (options.sentinelIndex === paletteIndex) {
    return { blank: true, fill: null, drawSymbol: false, symbol: "", symbolInk: ink };
  }
  const entry = palette[paletteIndex];
  const symbol = symbols[paletteIndex] ?? "";
  const hex = entry?.hex ?? "#000000";
  switch (mode) {
    case "colour":
      return { blank: false, fill: hex, drawSymbol: false, symbol: "", symbolInk: ink };
    case "symbol":
      // Colour off -> white paper + black symbol. Cheap to print, and two
      // similar colours become distinguishable by glyph (§15.5).
      return { blank: false, fill: null, drawSymbol: true, symbol, symbolInk: ink };
    case "both":
    default:
      return { blank: false, fill: hex, drawSymbol: true, symbol, symbolInk: ink };
  }
}

export interface LegendRow {
  paletteIndex: number;
  symbol: string;
  code: string;
  name?: string;
  hex: string;
  count?: number;
}

/** The decodable key. countsByIndex (e.g. from outUsage) is optional; when
 *  present, rows carry stitch counts and are sorted most-used first -- the
 *  order a stitcher actually wants a shopping/coverage key in. */
export function buildLegend(
  palette: PaletteColourLike[],
  symbols: string[],
  countsByIndex?: number[],
  options: SymbolOptions = {},
): LegendRow[] {
  const rows: LegendRow[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (options.sentinelIndex === i) continue;
    const entry = palette[i];
    if (!entry) continue;
    rows.push({
      paletteIndex: i,
      symbol: symbols[i] ?? "",
      code: entry.code,
      name: entry.name,
      hex: entry.hex,
      count: countsByIndex?.[i],
    });
  }
  if (countsByIndex) rows.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return rows;
}

export interface PrintChartSpec {
  /** Render each cell twice: once for the colour page, once for the symbol
   *  page. These are the two modes to feed the same grid through. */
  colourMode: RenderMode;
  symbolMode: RenderMode;
  symbols: string[];
  legend: LegendRow[];
  warnings: string[];
}

/** Delaney's double-sided chart (§15.5): one colour side, one symbol side, a
 *  single shared key. Resolves symbols once so both sides + legend agree. */
export function buildPrintSet(
  palette: PaletteColourLike[],
  symMap?: SymMap,
  countsByIndex?: number[],
  options: SymbolOptions = {},
): PrintChartSpec {
  const resolved = resolveSymbols(palette, symMap, options);
  const legend = buildLegend(palette, resolved.byIndex, countsByIndex, options);
  return {
    colourMode: "colour",
    symbolMode: "symbol",
    symbols: resolved.byIndex,
    legend,
    warnings: resolved.warnings,
  };
}
