// Cleanup passes: interior hole-fill and gap-bridge.
//
// holeFill: enclosure-gated. A background cell that is still reachable
// from the canvas border via other background cells is, by definition,
// part of the outer background — not an enclosed resize artifact. Gating
// via borderReachableBackground (recomputed each pass) prevents hole-fill
// from eroding open negative space such as the gap between a gable and a
// roofline.
//
// gapBridge: NOT enclosure-gated. Legitimate line-gap repair (e.g. a
// 1px break in a thin stem or outline) sits next to open background that
// reaches the border, so an enclosure gate here would prevent bridging
// exactly the axis-aligned gaps this pass exists to fix. Instead,
// gapBridge is made safe by dropping its two diagonal direction pairs;
// diagonal bridging only ever thickens staircase diagonals. H/V bridging
// is retained because stems, outlines, and dividers are axis-aligned.

export function borderReachableBackground(
  grid: Uint16Array,
  W: number,
  H: number,
  bgIds: Set<number>,
): Uint8Array {
  const mask = new Uint8Array(W * H);
  const stack: number[] = [];
  const pushIfBg = (idx: number) => {
    if (mask[idx]) return;
    if (!bgIds.has(grid[idx])) return;
    mask[idx] = 1;
    stack.push(idx);
  };
  for (let c = 0; c < W; c++) { pushIfBg(c); pushIfBg((H - 1) * W + c); }
  for (let r = 0; r < H; r++) { pushIfBg(r * W); pushIfBg(r * W + (W - 1)); }
  while (stack.length) {
    const idx = stack.pop()!;
    const r = (idx / W) | 0, c = idx - r * W;
    if (r > 0) pushIfBg(idx - W);
    if (r < H - 1) pushIfBg(idx + W);
    if (c > 0) pushIfBg(idx - 1);
    if (c < W - 1) pushIfBg(idx + 1);
  }
  return mask;
}

export function holeFill(
  grid: Uint16Array,
  W: number,
  H: number,
  usage: Record<string, number>,
  bgIds: Set<number>,
  protectedPositions: Set<number>,
): number {
  let filled = 0;
  let changed = true;
  for (let pass = 0; pass < 5 && changed; pass++) {
    changed = false;
    const openBg = borderReachableBackground(grid, W, H, bgIds);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const idx = row * W + col;
        if (!bgIds.has(grid[idx])) continue;
        if (protectedPositions.has(idx)) continue;
        if (openBg[idx]) continue; // deliberate open negative space
        const nbColors: number[] = [];
        if (row > 0) { const n = grid[idx - W]; if (!bgIds.has(n)) nbColors.push(n); }
        if (row < H - 1) { const n = grid[idx + W]; if (!bgIds.has(n)) nbColors.push(n); }
        if (col > 0) { const n = grid[idx - 1]; if (!bgIds.has(n)) nbColors.push(n); }
        if (col < W - 1) { const n = grid[idx + 1]; if (!bgIds.has(n)) nbColors.push(n); }
        if (nbColors.length >= 3) {
          const counts = new Map<number, number>();
          for (const nb of nbColors) counts.set(nb, (counts.get(nb) ?? 0) + 1);
          let best = nbColors[0], bestN = 0;
          for (const [color, cnt] of counts) if (cnt > bestN) { bestN = cnt; best = color; }
          const oldId = grid[idx];
          grid[idx] = best;
          usage[String(oldId)] = Math.max(0, (usage[String(oldId)] ?? 0) - 1);
          usage[String(best)] = (usage[String(best)] ?? 0) + 1;
          changed = true;
          filled++;
        }
      }
    }
  }
  return filled;
}

export function gapBridge(
  grid: Uint16Array,
  W: number,
  H: number,
  usage: Record<string, number>,
  bgIds: Set<number>,
  protectedPositions: Set<number>,
): number {
  // Horizontal + vertical only — see header comment for rationale.
  const DIRS: [number, number][][] = [
    [[-1, 0], [1, 0]],
    [[0, -1], [0, 1]],
  ];
  let bridged = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let row = 1; row < H - 1; row++) {
      for (let col = 1; col < W - 1; col++) {
        const idx = row * W + col;
        if (!bgIds.has(grid[idx])) continue;
        if (protectedPositions.has(idx)) continue;
        for (const [[dr1, dc1], [dr2, dc2]] of DIRS) {
          const n1 = grid[(row + dr1) * W + (col + dc1)];
          const n2 = grid[(row + dr2) * W + (col + dc2)];
          if (!bgIds.has(n1) && n1 === n2) {
            const old = grid[idx];
            grid[idx] = n1;
            usage[String(old)] = Math.max(0, (usage[String(old)] ?? 0) - 1);
            usage[String(n1)] = (usage[String(n1)] ?? 0) + 1;
            bridged++;
            break;
          }
        }
      }
    }
  }
  return bridged;
}
