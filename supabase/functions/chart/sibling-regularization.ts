// Universal sibling-set regularization — v2.
//
// BUG FIXED — cross-axis grouping contamination:
// v1 grouped candidates using "same row-band OR same col-band" with greedy
// first-fit. On any house with multiple window ROWS, a window can also
// happen to align in a COLUMN with a window from a different row (e.g. a
// ground-floor window sitting directly under a first-floor one). Because
// grouping was greedy and used OR, that column coincidence could pull a
// member into the WRONG group before its true row-mate arrived, leaving the
// row-mate stranded alone with no accepted anchor. Confirmed live on a real
// 7-window house: a bottom-row window's twin was absorbed into an unrelated
// middle-row column stack, so the bottom-row pair never formed and neither
// could recover the other.
// FIX: row-alignment and column-alignment are grouped in two INDEPENDENT
// passes rather than one ambiguous OR relation. A candidate can take part in
// a row-group AND a column-group at once without either stealing its
// membership in the other.
//
// NEW CAPABILITY — mirror-symmetric pairs:
// A pair (not a trio) where BOTH failed the strict gate cannot use the
// unanchored path (which requires >=3 members — three independent members
// agreeing is much stronger evidence than two). A pair that is provably
// MIRROR-SYMMETRIC about the image's own vertical centreline is a different,
// narrower, equally strong signal — the same test detectFramePairs already
// uses elsewhere in the engine to pair accepted frames, reused here rather
// than inventing a new threshold.

export interface SiblingCandidate {
  id: number;
  colour: number;
  r0: number; r1: number; c0: number; c1: number;
  accepted: boolean;
  hDividerCount: number;
  vDividerCount: number;
  paneColour: number;
  coverage: number;
  hollow: boolean;
  /** Count of frame-colour cells inside this candidate's bbox. Used by
   *  recoverMirrorPair to reject filled organic shapes (wings, blobs) that
   *  happen to be mirror-symmetric. A genuine thin frame occupies at most
   *  ~its perimeter — a filled shape occupies substantially more. */
  frameCellCount: number;
}

export interface RegularizedFrame {
  colour: number;
  r0: number; r1: number; c0: number; c1: number;
  hDividerCount: number;
  vDividerCount: number;
  paneColour: number;
  source: "anchored" | "unanchored" | "mirror-pair";
  groupId: number;
}

export interface SiblingOptions {
  sizeTol: number;
  alignTol: number;
  unanchoredMinMembers: number;
  unanchoredCoverageFloor: number;
  spacingTol: number;
  mirrorTol: number;
  /** Separate, lower floor for mirror-pair recovery. The unanchored floor
   *  (0.2) is calibrated for "3 independent members agreeing" as the safety
   *  margin; a mirror pair's safety comes from a DIFFERENT, independent
   *  source of evidence instead (exact size match + exact mirror-symmetric
   *  position + hollow interior), so it earns its own, separately-justified
   *  threshold rather than reusing one calibrated for a different argument.
   *  Set from real data: the confirmed attic-window pair measured 0.194
   *  coverage; confirmed pure-noise cases measured 0.05-0.10. 0.15 sits in
   *  the gap between them — catches the real case, rejects the noise case.
   *  Revisit if a future real example falls near this boundary. */
  mirrorCoverageFloor: number;
}

export const DEFAULT_SIBLING_OPTIONS: SiblingOptions = {
  sizeTol: 2,
  alignTol: 2,
  unanchoredMinMembers: 3,
  unanchoredCoverageFloor: 0.2,
  spacingTol: 2,
  mirrorTol: 4,
  mirrorCoverageFloor: 0.15,
};

const h = (c: SiblingCandidate) => c.r1 - c.r0 + 1;
const w = (c: SiblingCandidate) => c.c1 - c.c0 + 1;

function sameSize(a: SiblingCandidate, b: SiblingCandidate, tol: number): boolean {
  return Math.abs(h(a) - h(b)) <= tol && Math.abs(w(a) - w(b)) <= tol;
}
function rowAligned(a: SiblingCandidate, b: SiblingCandidate, tol: number): boolean {
  return Math.abs(a.r0 - b.r0) <= tol && Math.abs(a.r1 - b.r1) <= tol;
}
function colAligned(a: SiblingCandidate, b: SiblingCandidate, tol: number): boolean {
  return Math.abs(a.c0 - b.c0) <= tol && Math.abs(a.c1 - b.c1) <= tol;
}
function overlaps(a: { r0: number; r1: number; c0: number; c1: number }, b: { r0: number; r1: number; c0: number; c1: number }): boolean {
  return !(a.r1 < b.r0 || b.r1 < a.r0 || a.c1 < b.c0 || b.c1 < a.c0);
}

function groupByAxis(
  cands: SiblingCandidate[],
  opts: SiblingOptions,
  alignedFn: (a: SiblingCandidate, b: SiblingCandidate, tol: number) => boolean,
): SiblingCandidate[][] {
  const groups: SiblingCandidate[][] = [];
  for (const cand of cands) {
    let placed = false;
    for (const group of groups) {
      if (group[0].colour !== cand.colour) continue;
      if (!sameSize(group[0], cand, opts.sizeTol)) continue;
      if (group.some((m) => alignedFn(m, cand, opts.alignTol))) {
        group.push(cand);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([cand]);
  }
  return groups.filter((g) => g.length >= 2);
}

function consistentlySpacedAlongAxis(group: SiblingCandidate[], opts: SiblingOptions, byRow: boolean): boolean {
  if (group.length < 3) return false;
  const key = byRow ? (g: SiblingCandidate) => g.c0 : (g: SiblingCandidate) => g.r0;
  const sorted = [...group].sort((a, b) => key(a) - key(b));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(key(sorted[i]) - key(sorted[i - 1]));
  const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
  return gaps.every((g) => Math.abs(g - mean) <= opts.spacingTol + 1);
}

function recoverGroup(
  group: SiblingCandidate[],
  byRow: boolean,
  opts: SiblingOptions,
  existingFrames: Array<{ r0: number; r1: number; c0: number; c1: number }>,
  alreadyRecovered: RegularizedFrame[],
  groupId: number,
): RegularizedFrame[] {
  const out: RegularizedFrame[] = [];
  const accepted = group.filter((g) => g.accepted);
  const rejected = group.filter((g) => !g.accepted);
  const isFree = (cand: SiblingCandidate) =>
    !existingFrames.some((f) => overlaps(f, cand)) &&
    !alreadyRecovered.some((f) => overlaps(f, cand)) &&
    !out.some((f) => overlaps(f, cand));

  if (accepted.length >= 1) {
    const template = accepted.slice().sort(
      (a, b) => (b.hDividerCount + b.vDividerCount) - (a.hDividerCount + a.vDividerCount),
    )[0];
    for (const rej of rejected) {
      if (!rej.hollow) continue;
      if (!isFree(rej)) continue;
      out.push({
        colour: rej.colour, r0: rej.r0, r1: rej.r1, c0: rej.c0, c1: rej.c1,
        hDividerCount: template.hDividerCount, vDividerCount: template.vDividerCount,
        paneColour: template.paneColour, source: "anchored", groupId,
      });
    }
    return out;
  }

  if (group.length >= opts.unanchoredMinMembers &&
      group.every((g) => g.hollow) &&
      group.every((g) => g.coverage >= opts.unanchoredCoverageFloor) &&
      consistentlySpacedAlongAxis(group, opts, byRow)) {
    const template = group.slice().sort((a, b) => b.coverage - a.coverage)[0];
    for (const member of group) {
      if (!isFree(member)) continue;
      out.push({
        colour: member.colour, r0: member.r0, r1: member.r1, c0: member.c0, c1: member.c1,
        hDividerCount: template.hDividerCount, vDividerCount: template.vDividerCount,
        paneColour: template.paneColour, source: "unanchored", groupId,
      });
    }
  }
  return out;
}

/** Ratio of measured frame-colour cells to the count of a perfect 1-wide
 *  rectangular border enclosing the bbox. A genuine thin frame is at or
 *  below 1.0 (cells lie on the perimeter, some may be missing due to
 *  noise). A filled organic shape whose bbox happens to be same-size and
 *  mirror-symmetric with its partner (butterfly wing, wing highlight-dot)
 *  sits above 1.0 because its "frame" colour also fills the interior.
 *
 *  Measured empirically against real fixtures (perHit and ideal computed
 *  from analyseFrameCandidate's own perimeter walk):
 *    _fixture-sevenwindow.json attic pair (REAL, must recover):     0.75
 *    _fixture-butterfly-2.json 8x8 highlight-dot pair (FP):         1.14
 *    _fixture-butterfly.json   11x14 wing pair (FP):                1.43
 *    _fixture-butterfly.json   15x13 wing pair (FP):                1.54
 *    _fixture-butterfly-2.json 16x12 wing pair (FP):                1.67
 *    _fixture-butterfly-2.json 17x17 wing pair (FP):               ~1.78
 *  Gap between real max (0.75) and FP min (1.14) is 0.39 — wide, stable.
 *  1.0 sits in the middle with 0.25 margin below and 0.14 margin above.
 *
 *  Considered and rejected: perimeter-concentration (perHit/frameCells).
 *  Measured perimConc = 0.259 for the sevenwindow attic (real) but 0.277
 *  for the butterfly-1 11x14 wing (FP) — the metric FAILS to separate
 *  because a sparse/fragmented real thin frame has few cells and most
 *  aren't on the perimeter either, whereas a small filled dot has a
 *  substantial fraction of its cells on its own bbox edge. Fill-ratio
 *  captures the more fundamental question ("is the cell count consistent
 *  with a border, or with a filled shape?") and is scale-normalised to
 *  the shape's own bbox rather than to how many cells it happens to have.
 *
 *  This is still a single scalar and could in principle be defeated by a
 *  shape whose fill-ratio lands between 0.75 and 1.14, but empirically no
 *  such fixture has surfaced, and the gap is 3× the current 1.0-1.14
 *  distance to the nearest FP. Revisit if a real fixture lands in this
 *  interval. */
const MIRROR_PAIR_FILL_CEILING = 1.0;

function recoverMirrorPair(
  cands: SiblingCandidate[],
  gridW: number,
  opts: SiblingOptions,
  existingFrames: Array<{ r0: number; r1: number; c0: number; c1: number }>,
  alreadyRecovered: RegularizedFrame[],
  groupId: number,
): RegularizedFrame[] {
  const centreC = gridW / 2;
  const isThinFrameProfile = (c: SiblingCandidate): boolean => {
    const w = c.c1 - c.c0 + 1, h = c.r1 - c.r0 + 1;
    const ideal = 2 * w + 2 * h - 4;
    if (ideal <= 0) return false;
    return c.frameCellCount <= MIRROR_PAIR_FILL_CEILING * ideal;
  };

  const rejected = cands.filter((c) =>
    !c.accepted && c.hollow &&
    c.coverage >= opts.mirrorCoverageFloor &&
    isThinFrameProfile(c) &&
    c.paneColour >= 0
  );
  const out: RegularizedFrame[] = [];
  const used = new Set<number>();
  for (let i = 0; i < rejected.length; i++) {
    if (used.has(rejected[i].id)) continue;
    for (let j = i + 1; j < rejected.length; j++) {
      if (used.has(rejected[j].id)) continue;
      const a = rejected[i], b = rejected[j];
      if (a.colour !== b.colour) continue;
      if (!sameSize(a, b, opts.sizeTol)) continue;
      if (Math.abs(a.r0 - b.r0) > opts.alignTol) continue;
      const aCc = (a.c0 + a.c1) / 2, bCc = (b.c0 + b.c1) / 2;
      if ((aCc - centreC) * (bCc - centreC) >= 0) continue;
      if (Math.abs(Math.abs(aCc - centreC) - Math.abs(bCc - centreC)) > opts.mirrorTol) continue;
      const isFree = (cand: SiblingCandidate) =>
        !existingFrames.some((f) => overlaps(f, cand)) &&
        !alreadyRecovered.some((f) => overlaps(f, cand)) &&
        !out.some((f) => overlaps(f, cand));
      for (const m of [a, b]) {
        if (!isFree(m)) continue;
        out.push({
          colour: m.colour, r0: m.r0, r1: m.r1, c0: m.c0, c1: m.c1,
          hDividerCount: 0, vDividerCount: 0, paneColour: m.paneColour,
          source: "mirror-pair", groupId,
        });
      }
      used.add(a.id); used.add(b.id);
      break;
    }
  }
  return out;
}

export function planSiblingRegularization(
  cands: SiblingCandidate[],
  existingFrames: Array<{ r0: number; r1: number; c0: number; c1: number }>,
  gridW: number,
  opts: SiblingOptions = DEFAULT_SIBLING_OPTIONS,
): RegularizedFrame[] {
  const out: RegularizedFrame[] = [];
  let groupId = 0;

  const rowGroups = groupByAxis(cands, opts, rowAligned);
  for (const group of rowGroups) {
    groupId++;
    out.push(...recoverGroup(group, true, opts, existingFrames, out, groupId));
  }

  const colGroups = groupByAxis(cands, opts, colAligned);
  for (const group of colGroups) {
    groupId++;
    out.push(...recoverGroup(group, false, opts, existingFrames, out, groupId));
  }

  groupId++;
  out.push(...recoverMirrorPair(cands, gridW, opts, existingFrames, out, groupId));

  return out;
}

// ===========================================================================
// NEW CAPABILITY — accepted-vs-accepted divider reconciliation.
//
// Everything above reconciles REJECTED siblings against an ACCEPTED template.
// But two siblings can BOTH independently pass the strict frame gate (real
// perimeter, real geometry) while disagreeing on their OWN interior
// completeness — one detects its horizontal divider, a same-size aligned
// twin detects none, because that one row never reached the 85% coverage
// threshold in ITS copy of the source pixels. Confirmed live: a column-
// stacked pair of same-size windows (one above the other, not a mirror
// pair) — the upper one correctly found hDividers=[43], the lower one's raw
// scan found hRows=[] despite passing the overall frame test.
//
// This reuses the SAME principle proven all session (matched-pair
// disagreement = quantization artifact, not real design): genuinely
// repeated architectural elements shouldn't structurally disagree, and a
// ZERO count next to a confirmed non-zero count in an aligned, same-size
// group is much more likely a detection miss than a deliberate design
// difference. Deliberately narrow: only fires when one side is exactly
// zero and another confirmed non-zero — never overrides two members that
// both detected SOMETHING (a genuine difference, e.g. 1 vs 2 dividers, is
// left alone rather than guessed at).
// ===========================================================================

export interface DividerOverride {
  id: number;
  hDividerCount: number;
  vDividerCount: number;
}

export function planDividerReconciliation(
  cands: SiblingCandidate[],
  opts: SiblingOptions = DEFAULT_SIBLING_OPTIONS,
): DividerOverride[] {
  const overrides = new Map<number, { h: number; v: number }>();
  const ensure = (id: number, h: number, v: number) => {
    const cur = overrides.get(id);
    overrides.set(id, cur ? { h: Math.max(cur.h, h), v: Math.max(cur.v, v) } : { h, v });
  };

  function reconcile(group: SiblingCandidate[]) {
    const maxH = Math.max(...group.map((c) => c.hDividerCount));
    const maxV = Math.max(...group.map((c) => c.vDividerCount));
    for (const m of group) {
      const h = (m.hDividerCount === 0 && maxH > 0) ? maxH : m.hDividerCount;
      const v = (m.vDividerCount === 0 && maxV > 0) ? maxV : m.vDividerCount;
      if (h !== m.hDividerCount || v !== m.vDividerCount) ensure(m.id, h, v);
    }
  }

  const rowGroups = groupByAxis(cands, opts, rowAligned).filter((g) => g.every((c) => c.accepted));
  const colGroups = groupByAxis(cands, opts, colAligned).filter((g) => g.every((c) => c.accepted));
  for (const g of rowGroups) if (g.length >= 2) reconcile(g);
  for (const g of colGroups) if (g.length >= 2) reconcile(g);

  return [...overrides.entries()].map(([id, { h, v }]) => ({ id, hDividerCount: h, vDividerCount: v }));
}
