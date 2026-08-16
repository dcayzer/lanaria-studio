// ============================================================================
// Tessella Chart Engine — Golden Regression Harness (Phase 0)
// ============================================================================
// Runs the chart edge function against a fixed set of golden source images
// and validates the output two ways:
//
//   1. STRUCTURAL ASSERTIONS — properties any correct chart must satisfy
//      (complete lines, uniform frames, equal panes, congruent pairs).
//      These survive intentional visual changes.
//   2. BASELINE DIFF — cell-level comparison against an approved snapshot.
//      Any diff fails with a coordinate list; re-approve intentional changes
//      with --approve.
//
// Usage (Deno, from repo root):
//   deno run --allow-net --allow-read --allow-write --allow-env \
//     tests/run-goldens.ts                    # run all goldens
//   deno run ... tests/run-goldens.ts --approve   # snapshot current as baseline
//
// Configuration via env:
//   CHART_ENDPOINT   e.g. http://127.0.0.1:54321/functions/v1/chart
//                    (supabase functions serve) or the deployed URL
//   CHART_AUTH       optional bearer token
//
// Golden images live in tests/goldens/*.png, uploaded to a public bucket or
// served locally; each has a sidecar JSON with the request parameters and
// (after --approve) an approved baseline grid.
//
// WORKFLOW RULE (from the technical plan): no deploy without a green run.
// ============================================================================

import { assertStructure } from "./structural-assertions.ts";
import { buildStructuralModel } from "./structural-model.ts";
import type { PaletteEntry } from "./structural-model.ts";

interface GoldenSpec {
  name: string;
  imageUrl: string;                 // URL the chart function can fetch
  params: Record<string, unknown>;  // brand, mesh, sizes, mode, cleanupLevel
  /** Names of structural assertion rules expected to be relevant; all rules
   *  always run, this list is documentation. */
  focus?: string[];
}

interface ChartResponse {
  width: number;
  height: number;
  palette: PaletteEntry[];
  pixelsRLE: Array<[number, number]>;
  usage: Record<string, number>;
}

const GOLDENS_DIR = new URL("./goldens/", import.meta.url).pathname;
const ENDPOINT = Deno.env.get("CHART_ENDPOINT") ?? "http://127.0.0.1:54321/functions/v1/chart";
const AUTH = Deno.env.get("CHART_AUTH");
const APPROVE = Deno.args.includes("--approve");
const ONLY = Deno.args.find((a) => a.startsWith("--only="))?.slice(7);

function decodeRLE(rle: Array<[number, number]>, n: number): Uint16Array {
  const grid = new Uint16Array(n);
  let i = 0;
  for (const [idx, len] of rle) {
    for (let k = 0; k < len; k++) grid[i++] = idx;
  }
  if (i !== n) throw new Error(`RLE decoded ${i} cells, expected ${n}`);
  return grid;
}

async function loadSpecs(): Promise<GoldenSpec[]> {
  const specs: GoldenSpec[] = [];
  for await (const entry of Deno.readDir(GOLDENS_DIR)) {
    if (!entry.name.endsWith(".spec.json")) continue;
    const spec = JSON.parse(await Deno.readTextFile(GOLDENS_DIR + entry.name)) as GoldenSpec;
    specs.push(spec);
  }
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

async function runOne(spec: GoldenSpec): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AUTH ? { Authorization: `Bearer ${AUTH}` } : {}),
    },
    body: JSON.stringify({ imageUrl: spec.imageUrl, ...spec.params }),
  });
  if (!res.ok) {
    lines.push(`  HTTP ${res.status}: ${await res.text()}`);
    return { ok: false, lines };
  }
  const data = (await res.json()) as ChartResponse;
  const { width: W, height: H, palette } = data;
  const grid = decodeRLE(data.pixelsRLE, W * H);

  let ok = true;

  // ---- 1. Structural assertions -----------------------------------------
  // The model here is rebuilt from the OUTPUT grid; for assertion purposes
  // segment evidence isn't available client-side, so frame detection runs
  // colour-only with the stamp-evidence gate disabled (empty set ⇒ gate off,
  // matching buildStructuralModel's `segmentStampedCells.size > 0` guard).
  const model = buildStructuralModel(grid, W, H, palette, new Set());
  const fails = assertStructure(grid, W, H, palette, model);
  if (fails.length) {
    ok = false;
    for (const f of fails) lines.push(`  STRUCT ${f.rule}: ${f.detail}`);
  } else {
    lines.push(`  struct ✓ (${model.frames.length} frames, ${model.freeLines.length} free lines)`);
  }

  // ---- 2. Baseline diff ---------------------------------------------------
  const baselinePath = `${GOLDENS_DIR}${spec.name}.baseline.json`;
  if (APPROVE) {
    await Deno.writeTextFile(baselinePath, JSON.stringify({ W, H, grid: Array.from(grid) }));
    lines.push(`  baseline approved (${W}x${H})`);
  } else {
    try {
      const base = JSON.parse(await Deno.readTextFile(baselinePath)) as { W: number; H: number; grid: number[] };
      if (base.W !== W || base.H !== H) {
        ok = false;
        lines.push(`  DIFF dimensions: baseline ${base.W}x${base.H} vs ${W}x${H}`);
      } else {
        const diffs: string[] = [];
        for (let i = 0; i < grid.length && diffs.length < 12; i++) {
          if (grid[i] !== base.grid[i]) diffs.push(`(${(i / W) | 0},${i % W}) ${base.grid[i]}→${grid[i]}`);
        }
        let total = 0;
        for (let i = 0; i < grid.length; i++) if (grid[i] !== base.grid[i]) total++;
        if (total) {
          ok = false;
          lines.push(`  DIFF ${total} cells changed vs baseline; first: ${diffs.join(", ")}`);
          lines.push(`  (re-approve intentional changes with --approve --only=${spec.name})`);
        } else {
          lines.push(`  baseline ✓`);
        }
      }
    } catch {
      lines.push(`  no baseline yet — run with --approve to snapshot`);
    }
  }

  return { ok, lines };
}

const specs = await loadSpecs();
if (!specs.length) {
  console.log(`No golden specs found in ${GOLDENS_DIR}`);
  console.log(`Create e.g. margarita.spec.json:`);
  console.log(JSON.stringify({
    name: "margarita",
    imageUrl: "https://<project>.supabase.co/storage/v1/object/public/designs/goldens/margarita.png",
    params: { brand: "appletons", mesh: 13, finishedWidthInches: 6, finishedHeightInches: 6, mode: "motif", cleanupLevel: "tidy" },
  }, null, 2));
  Deno.exit(1);
}

let anyFail = false;
for (const spec of specs) {
  if (ONLY && spec.name !== ONLY) continue;
  console.log(`\n■ ${spec.name}`);
  const { ok, lines } = await runOne(spec);
  for (const l of lines) console.log(l);
  if (!ok) anyFail = true;
}
console.log(anyFail ? "\n✗ GOLDENS FAILED — do not deploy" : "\n✓ all goldens green");
Deno.exit(anyFail ? 1 : 0);
