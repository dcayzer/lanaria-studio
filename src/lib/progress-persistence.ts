// Progress persistence (editing suite, §14.1).
//
// progress-tracking.ts (shipped, commit f755103) tracks stitch completion in
// memory; "persistence per user, per saved chart" was left as a wiring concern.
// This is that layer: a compact, edit-resilient on-disk form plus a
// store-agnostic interface, so it drops onto Supabase (or any KV store) later.
//
// Design:
//   - COMPACT: run-length encode the done/not-done bitmap. A mostly-finished
//     background (the common case) collapses to a handful of runs, so a
//     100x100 chart that's all-but-a-few done serialises to a short string,
//     not 10,000 flags.
//   - EDIT-RESILIENT: progress is POSITIONAL -- "I stitched these physical
//     cells". Re-colouring a cell doesn't un-stitch it, so a colour edit at the
//     same dimensions preserves progress untouched. A RESIZE genuinely can't be
//     auto-mapped, so reconcile flags needsMigration rather than silently
//     corrupting the count. Dimensions are stored and checked on load.
//   - STORE-AGNOSTIC: an async get/set/remove interface + a stable key scheme.
//
// RECONCILE BEFORE WIRING: align ProgressSnapshot.done with progress-tracking.ts's
// actual completed-cell representation (a Set<number> of flat indices is
// assumed here). Sentinel/NOT_STITCHABLE cells should never be in `done` --
// that stays progress-tracking's rule; this layer just stores what it's given.

const FORMAT = "P1";

export interface ProgressSnapshot {
  width: number;
  height: number;
  /** Flat indices (y*width + x) marked complete. */
  done: Iterable<number>;
}

/** Normalised, de-duplicated, validated completed-index set. */
function normaliseDone(done: Iterable<number>, size: number): Set<number> {
  const set = new Set<number>();
  for (const i of done) {
    if (!Number.isInteger(i) || i < 0 || i >= size) {
      throw new Error(`progress: done index ${i} out of range for grid of ${size} cells.`);
    }
    set.add(i);
  }
  return set;
}

/** Compact, versioned string: FORMAT|W|H|run0.run1... where runs alternate
 *  starting with the count of NOT-done cells (run0 may be 0). */
export function serializeProgress(snapshot: ProgressSnapshot): string {
  const { width, height } = snapshot;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error("progress: width/height must be non-negative integers.");
  }
  const size = width * height;
  const done = normaliseDone(snapshot.done, size);

  const runs: number[] = [];
  let current = 0; // 0 = not-done run first, by convention
  let runLen = 0;
  for (let i = 0; i < size; i++) {
    const v = done.has(i) ? 1 : 0;
    if (v === current) {
      runLen++;
    } else {
      runs.push(runLen);
      current = v;
      runLen = 1;
    }
  }
  if (size > 0) runs.push(runLen);

  return `${FORMAT}|${width}|${height}|${runs.join(".")}`;
}

export function deserializeProgress(serialized: string): ProgressSnapshot {
  const parts = serialized.split("|");
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new Error(`progress: unrecognised format "${serialized.slice(0, 16)}...".`);
  }
  const width = Number(parts[1]);
  const height = Number(parts[2]);
  const size = width * height;
  const runs = parts[3] === "" ? [] : parts[3].split(".").map(Number);

  const done: number[] = [];
  let value = 0;
  let i = 0;
  let total = 0;
  for (const run of runs) {
    if (!Number.isInteger(run) || run < 0) throw new Error("progress: corrupt run length.");
    if (value === 1) for (let k = 0; k < run; k++) done.push(i + k);
    i += run;
    total += run;
    value ^= 1;
  }
  if (total !== size) {
    throw new Error(`progress: run lengths sum to ${total}, expected ${size} (corrupt or wrong dimensions).`);
  }
  return { width, height, done };
}

export interface ReconcileResult {
  ok: boolean;
  snapshot?: ProgressSnapshot;
  needsMigration?: boolean;
  missing?: boolean;
  reason?: string;
}

/** Check a loaded snapshot against the CURRENT chart dimensions. Same dims ->
 *  valid (colour edits don't affect positional progress). Different dims ->
 *  needsMigration, so the caller decides (keep nothing / ask the user) rather
 *  than trusting a mis-mapped count. */
export function reconcileProgress(
  loaded: ProgressSnapshot,
  current: { width: number; height: number },
): ReconcileResult {
  if (loaded.width === current.width && loaded.height === current.height) {
    return { ok: true, snapshot: loaded };
  }
  return {
    ok: false,
    needsMigration: true,
    reason: `Canvas resized from ${loaded.width}x${loaded.height} to ${current.width}x${current.height}; positional stitch progress can't be auto-mapped.`,
  };
}

// ---------------------------------------------------------------------------
// Store-agnostic persistence.
// ---------------------------------------------------------------------------

export interface ProgressStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Stable key: one progress record per (user, chart). */
export function progressKey(userId: string, chartId: string): string {
  return `progress:${userId}:${chartId}`;
}

export async function saveProgress(
  store: ProgressStore,
  userId: string,
  chartId: string,
  snapshot: ProgressSnapshot,
): Promise<void> {
  await store.save(progressKey(userId, chartId), serializeProgress(snapshot));
}

/** Load + reconcile in one step. Returns {missing} if nothing stored yet,
 *  {needsMigration} if the chart was resized, or {ok, snapshot} to use. */
export async function loadProgress(
  store: ProgressStore,
  userId: string,
  chartId: string,
  current: { width: number; height: number },
): Promise<ReconcileResult> {
  const raw = await store.load(progressKey(userId, chartId));
  if (raw == null) return { ok: false, missing: true };
  const loaded = deserializeProgress(raw);
  return reconcileProgress(loaded, current);
}

export async function clearProgress(
  store: ProgressStore,
  userId: string,
  chartId: string,
): Promise<void> {
  await store.remove(progressKey(userId, chartId));
}

/** A trivial in-memory ProgressStore -- handy for tests and as a reference
 *  implementation of the interface. Not for production (no persistence). */
export class MemoryProgressStore implements ProgressStore {
  private map = new Map<string, string>();
  async load(key: string): Promise<string | null> { return this.map.has(key) ? this.map.get(key)! : null; }
  async save(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async remove(key: string): Promise<void> { this.map.delete(key); }
}
