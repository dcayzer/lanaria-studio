// Request-scope diagnostics collector.
//
// Edge logs roll off within the hour, so the numbers that explain a specific
// generation must travel WITH the durable grid capture that
// structural-model.ts uploads to the `chart-debug` bucket. Modules record
// into this object as the run proceeds; the capture serialises it under a
// top-level `diag` key. Purely additive — nothing here influences charting.
//
// Module scope is safe here because a Deno edge isolate handles one chart
// request at a time; `resetChartDiag()` is called at the start of a run so
// values can never bleed between generations sharing a warm isolate.

export interface ChartDiag {
  /** reserveDarkNeutrals success payload, or null if it skipped. */
  darkReserved: unknown | null;
  /** Protected (vivid/dark-neutral) clusters and the thread each resolved to. */
  protectedThreads: unknown[];
  /** One entry per dark line segment considered by the stamper. */
  darkSegments: unknown[];
  /** Output palette with per-thread cell counts after stamping. */
  paletteWithUsage: string[];
  /** Hexes of threads admitted into the palette by the line-segment stamper. */
  segmentAdmitted: string[];
  /** Seed-anchored segment colour clusters with counts and pixel sums. */
  segColourClusters: unknown[];
  /** Source image statistics as the engine actually receives it. */
  sourceStats: unknown | null;
}

export const CHART_DIAG: ChartDiag = {
  darkReserved: null,
  protectedThreads: [],
  darkSegments: [],
  paletteWithUsage: [],
  segmentAdmitted: [],
  segColourClusters: [],
  sourceStats: null,
};

export function resetChartDiag(): void {
  CHART_DIAG.darkReserved = null;
  CHART_DIAG.protectedThreads = [];
  CHART_DIAG.darkSegments = [];
  CHART_DIAG.paletteWithUsage = [];
  CHART_DIAG.segmentAdmitted = [];
  CHART_DIAG.segColourClusters = [];
  CHART_DIAG.sourceStats = null;
}
