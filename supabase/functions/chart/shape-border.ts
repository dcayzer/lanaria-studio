export const NOT_STITCHABLE_NUM = -1;
export const NOT_STITCHABLE = NOT_STITCHABLE_NUM;

export interface ShapeGrid {
  width: number;
  height: number;
  cells: number[];
}

function isStitchable(grid: ShapeGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
  return grid.cells[y * grid.width + x] !== NOT_STITCHABLE_NUM;
}

export function edgeDepthMap(grid: ShapeGrid): number[] {
  const { width, height, cells } = grid;
  const depth = new Array<number>(width * height).fill(-1);
  const queue: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (cells[i] === NOT_STITCHABLE_NUM) continue;
      const onBoundary =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        !isStitchable(grid, x - 1, y) ||
        !isStitchable(grid, x + 1, y) ||
        !isStitchable(grid, x, y - 1) ||
        !isStitchable(grid, x, y + 1);
      if (onBoundary) {
        depth[i] = 0;
        queue.push(i);
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    const d = depth[i];
    const neighbours: Array<[number, number]> = [
      [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (cells[ni] === NOT_STITCHABLE_NUM) continue;
      if (depth[ni] !== -1) continue;
      depth[ni] = d + 1;
      queue.push(ni);
    }
  }

  return depth;
}

export interface ShapeBorderResult {
  depth: number[];
  cellCount: number;
  collapsed: boolean;
}

export function buildShapeBorder(grid: ShapeGrid, bandCount: number): ShapeBorderResult {
  if (!Number.isInteger(bandCount) || bandCount < 1) {
    throw new Error(`bandCount must be a positive integer, got ${bandCount}`);
  }
  const full = edgeDepthMap(grid);
  let hasInterior = false;
  for (const d of full) { if (d >= bandCount) { hasInterior = true; break; } }
  const collapsed = !hasInterior;
  const depth = full.map((d) => (d >= 0 && d < bandCount ? d : -1));
  let cellCount = 0;
  for (const d of depth) if (d !== -1) cellCount++;
  return { depth, cellCount, collapsed };
}

export function interiorAfterBorder(grid: ShapeGrid, bandCount: number): ShapeGrid {
  const depths = edgeDepthMap(grid);
  const cells = grid.cells.map((c, i) =>
    depths[i] >= 0 && depths[i] < bandCount ? NOT_STITCHABLE_NUM : c,
  );
  return { width: grid.width, height: grid.height, cells };
}

export function colourRing(ring: ShapeBorderResult, colours: number[]): number[] {
  return ring.depth.map((d) => {
    if (d < 0 || colours.length === 0) return NOT_STITCHABLE_NUM;
    return colours[Math.min(d, colours.length - 1)];
  });
}
