// Panel-aware placement / drawing for brick canvases.
//
// Geometry is pure and unit-testable; only drawBrickComposition touches a
// canvas context. Rationale: composing panels is fiddly enough that we want
// the math checked in isolation, without a DOM.

import {
  BRICK_PANELS,
  slotPanels,
  panelFoldRotation,
  type BrickPanel,
  type BrickPanelId,
  type BrickPatternMode,
  type BrickSlotKind,
  type BrickSlotContentMode,
} from "./brick-layout";

export type PixelRect = { x: number; y: number; w: number; h: number };

/** A panel's rect in device pixels on the composed canvas. */
export function panelPixelRect(
  panel: BrickPanel,
  canvasWpx: number,
  canvasHpx: number,
): PixelRect {
  const x = Math.round(panel.x0 * canvasWpx);
  const y = Math.round(panel.y0 * canvasHpx);
  const x1 = Math.round(panel.x1 * canvasWpx);
  const y1 = Math.round(panel.y1 * canvasHpx);
  return { x, y, w: x1 - x, h: y1 - y };
}

function panelById(id: BrickPanelId): BrickPanel {
  return BRICK_PANELS.find((p) => p.id === id)!;
}

function unionPixelRect(
  ids: BrickPanelId[],
  canvasWpx: number,
  canvasHpx: number,
): PixelRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const r = panelPixelRect(panelById(id), canvasWpx, canvasHpx);
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Tiles covering `region`, tiled from the CANVAS origin (0,0), not the
 *  region's own origin. Panels that share one pattern therefore line up
 *  across the gaps between them.
 *  `mirror` checkerboards alternate tiles (flipping X by column, Y by row).
 *  That guarantees adjacent edges match even when the source isn't genuinely
 *  tileable -- but it also mirrors neighbouring tiles against each other,
 *  which ruins any DIRECTIONAL pattern (waves, vines, anything with a flow
 *  or an up). Directional artwork is the normal case for brick sides, and
 *  the generation prompts now explicitly ask for a seamless tile, so this
 *  defaults to OFF. Turn it on only for a non-directional texture whose
 *  seams visibly don't meet. */
export function tileGrid(
  region: PixelRect,
  tileW: number,
  tileH: number,
  mirror = false,
): Array<PixelRect & { flipX: boolean; flipY: boolean }> {
  const out: Array<PixelRect & { flipX: boolean; flipY: boolean }> = [];
  if (tileW <= 0 || tileH <= 0 || region.w <= 0 || region.h <= 0) return out;
  // Find the first tile column/row whose right/bottom edge is > region.x/y.
  const iStart = Math.floor(region.x / tileW);
  const jStart = Math.floor(region.y / tileH);
  const iEnd = Math.ceil((region.x + region.w) / tileW);
  const jEnd = Math.ceil((region.y + region.h) / tileH);
  for (let j = jStart; j < jEnd; j++) {
    for (let i = iStart; i < iEnd; i++) {
      out.push({
        x: i * tileW,
        y: j * tileH,
        w: tileW,
        h: tileH,
        // Use non-negative modulo in case i/j are ever negative.
        flipX: mirror && ((i % 2) + 2) % 2 === 1,
        flipY: mirror && ((j % 2) + 2) % 2 === 1,
      });
    }
  }
  return out;
}


/** The region a rotated panel's tile grid must cover. Rotating artwork about
 *  the panel centre by 90/270 swaps which dimension spans the panel, so the
 *  pre-rotation draw region is the panel rect with w/h swapped about its own
 *  centre. 0/180 leave it unchanged. */
export function rotatedDrawRegion(panel: PixelRect, rotation: 0 | 90 | 180 | 270): PixelRect {
  if (rotation === 0 || rotation === 180) return panel;
  const cx = panel.x + panel.w / 2;
  const cy = panel.y + panel.h / 2;
  return { x: cx - panel.h / 2, y: cy - panel.w / 2, w: panel.h, h: panel.w };
}


/** Fit a centre motif into the centre panel.
 *  `bbox` is the subject's real extent inside the source image, normalised
 *  0..1. Pass null to contain-fit the whole image. Preserves aspect ratio,
 *  never magnifies beyond the panel, centres within the panel. */
export function fitCenterRect(
  imgW: number,
  imgH: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null,
  panelPx: PixelRect,
): PixelRect {
  const bx0 = bbox ? Math.max(0, Math.min(1, bbox.minX)) : 0;
  const by0 = bbox ? Math.max(0, Math.min(1, bbox.minY)) : 0;
  const bx1 = bbox ? Math.max(0, Math.min(1, bbox.maxX)) : 1;
  const by1 = bbox ? Math.max(0, Math.min(1, bbox.maxY)) : 1;
  const subW = Math.max(1, (bx1 - bx0) * imgW);
  const subH = Math.max(1, (by1 - by0) * imgH);
  // When we have a bbox, the caller wants the SUBJECT sized to the panel, so
  // scaling the cropped region up is expected. When no bbox is provided the
  // caller is contain-fitting the raw image and we must not magnify it.
  const rawScale = Math.min(panelPx.w / subW, panelPx.h / subH);
  const scale = bbox ? rawScale : Math.min(rawScale, 1);
  const w = Math.round(subW * scale);
  const h = Math.round(subH * scale);
  const x = panelPx.x + Math.round((panelPx.w - w) / 2);
  const y = panelPx.y + Math.round((panelPx.h - h) / 2);
  return { x, y, w, h };
}

export type BrickSlotImages = {
  uniform?: HTMLImageElement;
  arms?: HTMLImageElement;
  armsTopBottom?: HTMLImageElement;
  armsLeftRight?: HTMLImageElement;
  center?: HTMLImageElement;
};

/** Pattern slots active per composition mode (draw order matters: uniform
 *  first, then the more-specific arm slot). */
function patternSlotsForMode(mode: BrickPatternMode): BrickSlotKind[] {
  switch (mode) {
    case "uniform":
      return ["uniform"];
    case "armsPlusCenter":
      return ["arms"];
    case "pairedArmsPlusCenter":
      return ["armsTopBottom", "armsLeftRight"];
  }
}

function modeHasCenter(mode: BrickPatternMode): boolean {
  return mode === "armsPlusCenter" || mode === "pairedArmsPlusCenter";
}

/** Compose the brick canvas into `ctx`. Not offline-testable -- exercises
 *  the CanvasRenderingContext2D directly. All the geometry it relies on
 *  (panelPixelRect / tileGrid / fitCenterRect) is unit-tested separately. */
export function drawBrickComposition(
  ctx: CanvasRenderingContext2D,
  canvasWpx: number,
  canvasHpx: number,
  mode: BrickPatternMode,
  images: BrickSlotImages,
  repeats: {
    uniform?: number;
    arms?: number;
    armsTopBottom?: number;
    armsLeftRight?: number;
  },
  contentModes: Partial<Record<BrickSlotKind, BrickSlotContentMode>>,
  centerBBox: { minX: number; minY: number; maxX: number; maxY: number } | null,
  backgroundHex: string,
): void {
  // 1. Background fill.
  ctx.save();
  ctx.fillStyle = backgroundHex;
  ctx.fillRect(0, 0, canvasWpx, canvasHpx);
  ctx.restore();

  // 2. Pattern slots.
  for (const slot of patternSlotsForMode(mode)) {
    const img = images[slot];
    if (!img) continue;
    const targetIds = slotPanels(slot);
    const targetRegion =
      slot === "uniform"
        ? { x: 0, y: 0, w: canvasWpx, h: canvasHpx }
        : unionPixelRect(targetIds, canvasWpx, canvasHpx);
    const repRaw = (repeats as Record<string, number | undefined>)[slot];
    const rep = Math.max(1, Math.floor(repRaw && repRaw > 0 ? repRaw : 3));
    const tileW = Math.max(1, Math.round(targetRegion.w / rep));
    const tileH = tileW; // keep pattern undistorted

    for (const id of targetIds) {
      const panelRect = panelPixelRect(panelById(id), canvasWpx, canvasHpx);
      ctx.save();
      ctx.beginPath();
      ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
      ctx.clip();
      // Uniform is one continuous all-over print across the whole net, so it
      // is never rotated. Arm patterns are rotated so they read upright once
      // the tab is folded down (see panelFoldRotation).
      const rot: 0 | 90 | 180 | 270 = slot === "uniform" ? 0 : panelFoldRotation(id);
      if (rot !== 0) {
        const cx = panelRect.x + panelRect.w / 2;
        const cy = panelRect.y + panelRect.h / 2;
        ctx.translate(cx, cy);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.translate(-cx, -cy);
      }
      const drawRegion = rot === 0 ? targetRegion : rotatedDrawRegion(panelRect, rot);

      if (contentModes[slot] === "single") {
        // One motif per panel, placed once and centred. Fitted into the
        // rotation-adjusted panel rect so it reads upright once folded.
        const fitRegion = rotatedDrawRegion(panelRect, rot);
        const fit = fitCenterRect(img.width, img.height, null, fitRegion);
        ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
        ctx.restore();
        continue;
      }

      const tiles = tileGrid(drawRegion, tileW, tileH);
      for (const t of tiles) {
        // Mirror via transform, not by swapping source rects.
        ctx.save();
        const sx = t.flipX ? -1 : 1;
        const sy = t.flipY ? -1 : 1;
        // Translate to the tile's would-be top-left, then scale about that
        // point; the drawImage destination adjusts to compensate for the
        // negative axis so the image still lands inside the tile bounds.
        ctx.translate(
          t.flipX ? t.x + t.w : t.x,
          t.flipY ? t.y + t.h : t.y,
        );
        ctx.scale(sx, sy);
        ctx.drawImage(img, 0, 0, t.w, t.h);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // 3. Centre motif.
  if (modeHasCenter(mode) && images.center) {
    const panelRect = panelPixelRect(panelById("top"), canvasWpx, canvasHpx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
    ctx.clip();
    const img = images.center;
    const fit = fitCenterRect(img.width, img.height, centerBBox, panelRect);
    ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
    ctx.restore();
  }

  // 4. Corners: never drawn. They remain backgroundHex and the canvas-shape
  //    mask removes them during finishing.
}
