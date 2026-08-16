// ============================================================================
// Tessella Chart Engine — Skeleton Junction Repair (Phase 1)
// ============================================================================
// Zhang-Suen thinning is known to erode cross junctions: the skeleton of a
// "+" shaped region frequently comes out as four disconnected arms with a
// void at the centre, because the thinning conditions delete the centre
// pixels of the crossing early.
//
// This module repairs that erosion AFTER thinning, before the skeleton is
// mapped to grid cells: it finds skeleton endpoints (pixels with exactly one
// skeleton neighbour) and, for each pair of endpoints within a small radius
// whose arm directions point toward each other, draws the missing bridge
// pixels between them.
//
// Called from detectLineSegments in supabase/functions/chart/index.ts,
// immediately after the Zhang-Suen loop and before the "Map skeleton pixels
// to output grid cells" step. See INTEGRATION.md.
// ============================================================================

/**
 * Repairs eroded junctions in a thinned bitmap in place.
 * @param bmp     1 = skeleton pixel, 0 = empty. Mutated in place.
 * @param compW   bitmap width
 * @param compH   bitmap height
 * @param maxGap  maximum endpoint-to-endpoint distance to bridge (px)
 * @returns number of bridge pixels added
 */
export function repairJunctionErosion(
  bmp: Uint8Array,
  compW: number,
  compH: number,
  maxGap = 3,
): number {
  const idxOf = (x: number, y: number) => y * compW + x;
  const inB = (x: number, y: number) => x >= 0 && x < compW && y >= 0 && y < compH;

  // 1) Find endpoints: skeleton pixels with exactly one 8-neighbour, plus
  //    their outgoing arm direction (from the neighbour toward the endpoint,
  //    i.e. the direction the line "wants" to continue).
  type Endpoint = { x: number; y: number; dx: number; dy: number };
  const endpoints: Endpoint[] = [];
  for (let y = 0; y < compH; y++) {
    for (let x = 0; x < compW; x++) {
      if (!bmp[idxOf(x, y)]) continue;
      let nb = 0, nx = 0, ny = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (inB(xx, yy) && bmp[idxOf(xx, yy)]) { nb++; nx = xx; ny = yy; }
        }
      }
      if (nb === 1) {
        // Arm direction: from the single neighbour toward this endpoint.
        const dx = Math.sign(x - nx), dy = Math.sign(y - ny);
        endpoints.push({ x, y, dx, dy });
      }
    }
  }
  if (endpoints.length < 2) return 0;

  // 2) Bridge endpoint pairs that are close AND facing each other.
  //    "Facing": the vector from A to B has positive dot product with A's
  //    arm direction, and negative with B's (B points back toward A).
  let added = 0;
  const bridged = new Set<number>();
  for (let i = 0; i < endpoints.length; i++) {
    if (bridged.has(i)) continue;
    let bestJ = -1, bestD = Infinity;
    for (let j = i + 1; j < endpoints.length; j++) {
      if (bridged.has(j)) continue;
      const a = endpoints[i], b = endpoints[j];
      const vx = b.x - a.x, vy = b.y - a.y;
      const d = Math.max(Math.abs(vx), Math.abs(vy));       // Chebyshev distance
      if (d === 0 || d > maxGap) continue;
      const dotA = vx * a.dx + vy * a.dy;                    // A points toward B
      const dotB = -vx * b.dx + -vy * b.dy;                  // B points toward A
      if (dotA <= 0 || dotB <= 0) continue;
      if (d < bestD) { bestD = d; bestJ = j; }
    }
    if (bestJ < 0) continue;
    const a = endpoints[i], b = endpoints[bestJ];
    // 3) Draw the straight bridge (Bresenham) between the two endpoints.
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
    let err = dx - dy;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ii = idxOf(x, y);
      if (!bmp[ii]) { bmp[ii] = 1; added++; }
      if (x === b.x && y === b.y) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    bridged.add(i);
    bridged.add(bestJ);
  }
  return added;
}
