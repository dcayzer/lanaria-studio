import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";

export interface ImageCropFrameHandle {
  /** Kept for backwards compatibility; not used in the unified flow. */
  exportCanvas: (maxSize?: number) => HTMLCanvasElement | null;
  /** Placement rect for the freshly-exported (already-cropped) image: places
   *  it exactly as ImageCropFrame would place a brand-new image at the
   *  crop's own aspect, honouring the current "Size on canvas" fill. Call
   *  this alongside exportCanvas and use the result to REPLACE the old
   *  rect — never keep the pre-crop rect once the image has been cut. */
  getResetRect: () => NormRect | null;
}

/**
 * Normalised rect: position of the IMAGE within the canvas frame, 0..1 in
 * canvas units. Consumed unchanged by the server crop, the saved-design
 * format and every preview.
 *
 * IMPORTANT: rect.w / rect.h is NOT the crop shape -- it is whatever placement
 * makes the cropped region sit undistorted inside the canvas. The previous
 * model derived it as the plain inverse of the crop box, which is only correct
 * when the crop happens to share the canvas's aspect ratio; with a free-form
 * crop it encoded a stretched image, which is why the crop frame and the
 * previews disagreed.
 */
export type NormRect = { x: number; y: number; w: number; h: number };

interface Props {
  imageUrl: string;
  /** canvas width / height */
  aspect: number;
  filter?: string;
  background?: string;
  rect: NormRect | null;
  onRectChange: (next: NormRect) => void;
  /** Finished piece size, used to label the rulers. */
  finishedWidthInches?: number;
  finishedHeightInches?: number;
}

type Corner = "nw" | "ne" | "sw" | "se";
type Edge = "n" | "s" | "e" | "w";
type Mode = Corner | Edge | "move";

interface Box { x: number; y: number; w: number; h: number }

const MIN_BOX_PX = 32;
const RULER = 26;

export const ImageCropFrame = forwardRef<ImageCropFrameHandle, Props>(function ImageCropFrame(
  {
    imageUrl,
    aspect,
    filter,
    background = "#FFFFFF",
    rect,
    onRectChange,
    finishedWidthInches,
    finishedHeightInches,
  },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [unit, setUnit] = useState<"in" | "cm">("in");
  /** How much of the canvas the cropped region fills, 0.2..1. */
  const [fill, setFill] = useState(1);
  /**
   * The crop box is LOCAL state, not derived from rect. The contain-fit
   * mapping below is deliberately not invertible (a rect cannot tell you
   * whether the bars around a motif came from the crop shape or the size
   * control), so the box is the source of truth here and rect is the output.
   */
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const decodedRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => {
      if (cancelled) return;
      decodedRef.current = im;
      setNatural({ w: im.naturalWidth, h: im.naturalHeight });
    };
    im.src = imageUrl;
    setBox(null);
    setFill(1);
    return () => { cancelled = true; };
  }, [imageUrl]);

  /** Where the whole image sits inside the stage, contain-fit. */
  const imgBox = useMemo<Box | null>(() => {
    if (!natural || !stage.w || !stage.h) return null;
    const availW = stage.w - RULER - 12;
    const availH = stage.h - RULER - 12;
    if (availW <= 0 || availH <= 0) return null;
    const s = Math.min(availW / natural.w, availH / natural.h);
    const w = natural.w * s;
    const h = natural.h * s;
    return { x: RULER + (availW - w) / 2, y: RULER + (availH - h) / 2, w, h };
  }, [natural, stage]);

  /**
   * Convert a crop box into the image placement rect.
   *
   * The cropped region is fitted (contain) into the canvas at its true
   * proportions and centred, so it is never stretched however the box is
   * shaped. `fill` shrinks it further, leaving canvas background around it.
   */
  const emit = (b: Box, fillFrac: number) => {
    if (!imgBox || imgBox.w === 0 || imgBox.h === 0) return;
    const fx = (b.x - imgBox.x) / imgBox.w;
    const fy = (b.y - imgBox.y) / imgBox.h;
    const fw = b.w / imgBox.w;
    const fh = b.h / imgBox.h;
    if (fw <= 0 || fh <= 0) return;
    // A = image aspect expressed in canvas units, so W/H = A keeps the image
    // undistorted once the canvas's own aspect is accounted for.
    const A = (imgBox.w / imgBox.h) / aspect;
    const W = Math.min(1 / fw, A / fh) * fillFrac;
    const H = W / A;
    onRectChange({
      x: (1 - fw * W) / 2 - fx * W,
      y: (1 - fh * H) / 2 - fy * H,
      w: W,
      h: H,
    });
  };

  const fullBox = useMemo<Box | null>(
    () => (imgBox ? { x: imgBox.x, y: imgBox.y, w: imgBox.w, h: imgBox.h } : null),
    [imgBox],
  );

  useEffect(() => {
    if (!box && fullBox) { setBox(fullBox); emit(fullBox, fill); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, fullBox]);

  const clampToImage = (b: Box): Box => {
    if (!imgBox) return b;
    let { x, y, w, h } = b;
    if (w > imgBox.w) w = imgBox.w;
    if (h > imgBox.h) h = imgBox.h;
    if (x < imgBox.x) x = imgBox.x;
    if (y < imgBox.y) y = imgBox.y;
    if (x + w > imgBox.x + imgBox.w) x = imgBox.x + imgBox.w - w;
    if (y + h > imgBox.y + imgBox.h) y = imgBox.y + imgBox.h - h;
    return { x, y, w, h };
  };

  const drag = useRef<{ mode: Mode; start: Box; sx: number; sy: number; pid: number } | null>(null);

  const onDown = (mode: Mode) => (e: React.PointerEvent) => {
    if (!box) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, start: { ...box }, sx: e.clientX, sy: e.clientY, pid: e.pointerId };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId || !imgBox) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    const s = d.start;
    let next: Box;
    if (d.mode === "move") {
      next = { ...s, x: s.x + dx, y: s.y + dy };
    } else {
      // Free-form: each handle moves only the edges it touches. Corners move
      // two, edge handles move one -- which is what allows cropping the width
      // while keeping the full height.
      let { x, y, w, h } = s;
      const m = d.mode;
      if (m === "e" || m === "ne" || m === "se") w = s.w + dx;
      if (m === "w" || m === "nw" || m === "sw") { w = s.w - dx; x = s.x + dx; }
      if (m === "s" || m === "se" || m === "sw") h = s.h + dy;
      if (m === "n" || m === "ne" || m === "nw") { h = s.h - dy; y = s.y + dy; }
      if (w < MIN_BOX_PX) { if (m === "w" || m === "nw" || m === "sw") x = s.x + s.w - MIN_BOX_PX; w = MIN_BOX_PX; }
      if (h < MIN_BOX_PX) { if (m === "n" || m === "ne" || m === "nw") y = s.y + s.h - MIN_BOX_PX; h = MIN_BOX_PX; }
      next = { x, y, w, h };
    }
    const c = clampToImage(next);
    setBox(c);
    emit(c, fill);
  };

  const onUp = (e: React.PointerEvent) => {
    if (drag.current?.pid === e.pointerId) drag.current = null;
  };

  const handleFit = () => { if (fullBox) { setBox(fullBox); emit(fullBox, fill); } };
  const changeFill = (v: number) => { setFill(v); if (box) emit(box, v); };

  /**
   * Ruler ticks along the crop box. These report the size the CROPPED REGION
   * will actually be stitched at, which is the canvas size scaled by how much
   * of the canvas it fills -- so shrinking with the size control shrinks these
   * numbers too.
   */
  const ticks = useMemo(() => {
    const wIn = finishedWidthInches ?? 0;
    const hIn = finishedHeightInches ?? 0;
    if (!wIn || !hIn || !box || !imgBox) return null;
    const fw = box.w / imgBox.w;
    const fh = box.h / imgBox.h;
    const A = (imgBox.w / imgBox.h) / aspect;
    const W = Math.min(1 / fw, A / fh) * fill;
    const H = W / A;
    const totW = wIn * fw * W;
    const totH = hIn * fh * H;
    const totalW = unit === "in" ? totW : totW * 2.54;
    const totalH = unit === "in" ? totH : totH * 2.54;
    const build = (total: number, lengthPx: number) => {
      const count = Math.floor(total);
      if (count < 1 || !isFinite(count)) return [];
      const labelEvery = count <= 12 ? 1 : count <= 30 ? 2 : 5;
      const out: { pos: number; label: string | null }[] = [];
      for (let i = 0; i <= count; i++) {
        out.push({ pos: (i / total) * lengthPx, label: i % labelEvery === 0 ? String(i) : null });
      }
      return out;
    };
    return { x: build(totalW, box.w), y: build(totalH, box.h), totalW, totalH };
  }, [finishedWidthInches, finishedHeightInches, unit, box, imgBox, aspect, fill]);

  // Physically cut the crop region out of the image at full natural
  // resolution. Until now the crop was only ever a placement hint, which is
  // why un-cropped parts of the image kept showing at the canvas edges.
  useImperativeHandle(ref, () => ({
    exportCanvas: () => {
      if (!box || !imgBox || !natural) return null;
      const fx = (box.x - imgBox.x) / imgBox.w;
      const fy = (box.y - imgBox.y) / imgBox.h;
      const fw = box.w / imgBox.w;
      const fh = box.h / imgBox.h;
      const sx = Math.max(0, Math.round(fx * natural.w));
      const sy = Math.max(0, Math.round(fy * natural.h));
      const sw = Math.max(1, Math.min(natural.w - sx, Math.round(fw * natural.w)));
      const sh = Math.max(1, Math.min(natural.h - sy, Math.round(fh * natural.h)));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const im = decodedRef.current;
      if (!im) return null;
      try {
        ctx.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
      } catch {
        return null;
      }
      return canvas;
    },
    getResetRect: () => {
      if (!box || !imgBox) return null;
      const A = (box.w / box.h) / aspect;
      const W = Math.min(1, A) * fill;
      const H = W / A;
      return { x: (1 - W) / 2, y: (1 - H) / 2, w: W, h: H };
    },
  }), [box, imgBox, natural, imageUrl, fill]);

  return (
    <div className="space-y-3">
      <div
        ref={stageRef}
        className="relative mx-auto w-full touch-none select-none overflow-hidden rounded-md border border-border"
        style={{ height: 380, maxWidth: 520, background }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {imgBox && (
          <img
            src={imageUrl}
            alt="Choose the area to chart"
            draggable={false}
            className="absolute"
            style={{ left: imgBox.x, top: imgBox.y, width: imgBox.w, height: imgBox.h, filter }}
          />
        )}

        {imgBox && box && (
          <>
            <div className="pointer-events-none absolute inset-0 bg-background/70" />
            <div
              className="absolute overflow-hidden"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            >
              <img
                src={imageUrl}
                alt=""
                draggable={false}
                className="absolute max-w-none"
                style={{
                  left: imgBox.x - box.x,
                  top: imgBox.y - box.y,
                  width: imgBox.w,
                  height: imgBox.h,
                  filter,
                }}
              />
            </div>

            <div
              className="absolute border-2 border-primary"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h, cursor: "move" }}
              onPointerDown={onDown("move")}
            >
              {ticks?.x.map((t, i) => (
                <div key={"x" + i} className="pointer-events-none absolute" style={{ left: t.pos, top: -RULER }}>
                  <div className="h-2 w-px bg-foreground/60" style={{ marginTop: RULER - 8 }} />
                  {t.label !== null && (
                    <span className="absolute -translate-x-1/2 text-[9px] tabular-nums text-foreground/70" style={{ top: 0 }}>
                      {t.label}
                    </span>
                  )}
                </div>
              ))}
              {ticks?.y.map((t, i) => (
                <div key={"y" + i} className="pointer-events-none absolute" style={{ top: t.pos, left: -RULER }}>
                  <div className="h-px w-2 bg-foreground/60" style={{ marginLeft: RULER - 8 }} />
                  {t.label !== null && (
                    <span className="absolute -translate-y-1/2 text-[9px] tabular-nums text-foreground/70" style={{ left: 0 }}>
                      {t.label}
                    </span>
                  )}
                </div>
              ))}

              {(["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
                <div
                  key={c}
                  className="absolute h-5 w-5 rounded-sm border-2 border-primary bg-background"
                  style={{
                    left: c === "nw" || c === "sw" ? -10 : undefined,
                    right: c === "ne" || c === "se" ? -10 : undefined,
                    top: c === "nw" || c === "ne" ? -10 : undefined,
                    bottom: c === "sw" || c === "se" ? -10 : undefined,
                    cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize",
                    touchAction: "none",
                  }}
                  onPointerDown={onDown(c)}
                />
              ))}
              {(["n", "s", "e", "w"] as Edge[]).map((m) => {
                const vertical = m === "n" || m === "s";
                return (
                  <div
                    key={m}
                    className="absolute rounded-sm border-2 border-primary bg-background"
                    style={{
                      width: vertical ? 28 : 10,
                      height: vertical ? 10 : 28,
                      left: m === "w" ? -5 : vertical ? "50%" : undefined,
                      right: m === "e" ? -5 : undefined,
                      top: m === "n" ? -5 : vertical ? undefined : "50%",
                      bottom: m === "s" ? -5 : undefined,
                      transform: vertical ? "translateX(-50%)" : "translateY(-50%)",
                      cursor: vertical ? "ns-resize" : "ew-resize",
                      touchAction: "none",
                    }}
                    onPointerDown={onDown(m)}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="whitespace-nowrap text-xs text-muted-foreground">Size on canvas</span>
        <input
          type="range"
          min={20}
          max={100}
          value={Math.round(fill * 100)}
          onChange={(e) => changeFill(Number(e.target.value) / 100)}
          className="h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-secondary accent-primary"
        />
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
          {Math.round(fill * 100)}%
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleFit}>
          Whole image
        </Button>
        <div className="flex overflow-hidden rounded border border-border">
          {(["in", "cm"] as const).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setUnit(u)}
              className={
                "px-3 py-1 text-xs " +
                (unit === u ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")
              }
            >
              {u === "in" ? "inches" : "cm"}
            </button>
          ))}
        </div>
        {ticks && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            Stitched: {ticks.totalW.toFixed(1)} × {ticks.totalH.toFixed(1)} {unit}
          </span>
        )}
      </div>

      <p className="text-center text-xs italic text-muted-foreground">
        Drag inside the box to move it, a corner to reshape it, or a side handle to crop
        one edge. "Size on canvas" sets how much of the canvas it fills.
      </p>
    </div>
  );
});
