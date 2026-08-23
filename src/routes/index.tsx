import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { ImageCropFrame, type ImageCropFrameHandle, type NormRect } from "@/components/ImageCropFrame";
import { assessDetailFit, findBetterFit, type DetailFit } from "@/lib/detail-fit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { SwatchPicker } from "@/components/SwatchPicker";
import { NavMenu } from "@/components/NavMenu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, RotateCcw, Crop } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { StitchChart, buildBlankChart, type ChartData, type ChartPaletteEntry } from "@/components/StitchChart";
import { ThreadShoppingList } from "@/components/ThreadShoppingList";
import { makeLayer, rotateCells, type Layer, type Quarter } from "@/lib/layer-model";
import { applyLayersToChart } from "@/lib/chart-layer-compositor";
import { mergeManualEdit } from "@/lib/merge-manual-edit";
import { mergeManualEditAttributed } from "@/lib/merge-manual-edit-attributed";
import { applyLayerEdits } from "@/lib/merge-manual-edit-attributed";
import { textToLayer, monogramToLayer, previewGrid, measureTextOnCanvas } from "@/lib/glyph-layers";
import { HAND_FONTS, type HandFont } from "@/data/hand-charted-fonts";

import { borderToLayer } from "@/lib/border-layers";
import { detectInputType, type InputType, type DetectionResult } from "@/lib/input-type-detect";
import { HAND_BORDERS } from "@/data/hand-charted-borders";
import { tileHandBorder } from "@/lib/hand-charted-border-tiling";
import {
  CANVAS_SHAPES, BRICK_BLURB,
  canvasDimsInches, hasFixedDimensions, isSingleDimension,
  widthLabel, heightLabel, stockingGridWidthInches,
  BRICK_CANVAS_WIDTH_INCHES, BRICK_CANVAS_HEIGHT_INCHES,
  type CanvasShape,
} from "@/lib/canvasShapes";
import { STOCKING_ASPECT, STOCKING_SAFE_RECT, drawShapeOutline } from "@/lib/canvasShapeOutline";
import { shapeMask, applyShapeMask, NOT_STITCHABLE } from "@/lib/canvas-shape-mask";
import { buildBrickSlotPrompt, type BrickPatternMode, type BrickSlotKind, type BrickSlotContentMode } from "@/lib/brick-layout";
import { drawBrickComposition, type BrickSlotImages } from "@/lib/brick-compose";
import { chartToCodeGrid, codeGridToChart } from "@/lib/chart-layer-compositor";
import { useAuth } from "@/lib/auth-context";
import { AuthModal } from "@/components/AuthModal";
import { MyDesignsDialog, type DesignSummary } from "@/components/MyDesignsDialog";
import { MotifLibraryDialog } from "@/components/MotifLibraryDialog";
import { listMotifs, saveMotif, centeredOffset, type MotifRecord } from "@/lib/motif-library";
import { tileFillWholeCanvas, buildTileFillLayer } from "@/lib/tile-fill";
import type { Json } from "@/integrations/supabase/types";
import { makeProgressGrid, type ProgressGrid } from "@/lib/progress-tracking";
import { serializeProgress, deserializeProgress, reconcileProgress } from "@/lib/progress-persistence";
import { gridToSnapshot, snapshotToGrid } from "@/lib/progress-bridge";
import { listStash, type StashRow } from "@/lib/thread-stash-store";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Tessella Studio — Custom Needlepoint Canvas Designer" },
      {
        name: "description",
        content:
          "Design custom needlepoint and tapestry canvases with Tessella Studio — choose threads, images, lettering, monograms, borders and more.",
      },
      { property: "og:title", content: "Tessella Studio — Custom Needlepoint Canvas Designer" },
      {
        property: "og:description",
        content:
          "Design custom needlepoint and tapestry canvases with Tessella Studio.",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { design?: string } => ({
    design: typeof search.design === "string" ? search.design : undefined,
  }),
  component: Index,
});

// Canvas first: shape + mesh drive what the Image step can offer (the brick
// layout controls only make sense once "brick" is chosen), so choosing the
// canvas last meant those controls appeared above a decision not yet made.
// Thread Brand stays second rather than moving to the end: threadBrand starts
// null and `palette` is empty until it's set, which disables every thread
// colour picker (SwatchPicker disables itself on an empty palette) used by
// Text & Lettering, Monogram, and Border & Frame.
const designSteps = [
  { id: "canvas-spec", number: "01", title: "Canvas Specification" },
  { id: "thread-brand", number: "02", title: "Thread Brand" },
  { id: "image", number: "03", title: "Image" },
  { id: "text-lettering", number: "04", title: "Text & Lettering" },
  { id: "monogram", number: "05", title: "Monogram" },
  { id: "border-frame", number: "06", title: "Border & Frame" },
  { id: "image-tuning", number: "07", title: "Image Tuning" },
];

const STYLE_PRESETS = [
  {
    id: "motif",
    label: "Single Motif",
    placeholder: "e.g. a whippet sitting, a red rose, a martini glass, a pair of wellies",
    positive:
      "single subject, isolated, centred on a plain solid white background, no scenery, no setting, no other objects, clean simple edges, flat painterly style, bold colour, strong silhouette, designed for needlepoint charting",
    negative:
      "multiple subjects, busy background, scenery, landscape, gradients, photographic realism, fine detail, text, lettering, words, watermark",
  },
  {
    id: "scene",
    label: "Scene",
    placeholder: "e.g. a Cotswold village in rolling hills, a walled garden in bloom, a lion crest with laurel",
    positive:
      "flat painterly style, bold colour, strong silhouette, clean simple edges, simplified into clear bands and shapes, limited harmonious palette, designed for needlepoint charting",
    negative:
      "photographic realism, fine detail, atmospheric gradients, busy cluttered composition, text, lettering, words, watermark",
  },
] as const;

import {
  THREAD_PALETTES,
  type ThreadBrand,
  type ThreadColor,
} from "@/data/threadPalettes";


// Delaney's hand-charted alphabets are now wired in (src/data/hand-charted-fonts.ts).
// "default" remains the built-in 5x7 bitmap font -- kept first, and kept as the
// stored id, so designs saved before the hand-charted fonts existed still load.
const TEXT_FONTS: { id: string; label: string; css: string; hand: HandFont | null }[] = [
  { id: "default", label: "Default (built-in)", css: "Georgia, 'Times New Roman', serif", hand: null },
  ...HAND_FONTS.map((f) => ({ id: f.id, label: f.label, css: "Georgia, serif", hand: f })),
];

const MONOGRAM_STYLES: { id: string; label: string; note: string; font: string; hand: HandFont | null }[] = [
  { id: "m1", label: "Default (built-in)", note: "", font: "Georgia, serif", hand: null },
  ...HAND_FONTS.map((f) => ({ id: f.id, label: f.label, note: "", font: "Georgia, serif", hand: f })),
];

type MonogramStyleId = string;


const BORDER_STYLES = [
  { id: "none", label: "None", layers: 0 },
  { id: "simple", label: "Simple", layers: 1 },
  { id: "double", label: "Double", layers: 2 },
  { id: "poppy", label: "Poppy", layers: 2 },
  { id: "flowers", label: "Flowers", layers: 3 },
  { id: "ladder", label: "Ladder", layers: 3 },
  { id: "interlock", label: "Interlock", layers: 2 },
  { id: "spades", label: "Spades", layers: 2 },
  { id: "small-flowers", label: "Small Flowers", layers: 3 },
  { id: "scandi-double", label: "Scandi Double", layers: 2 },
  { id: "oak-and-acorn", label: "Oak and Acorn", layers: 2 },
  { id: "scalloped-tulips", label: "Scalloped Tulips", layers: 3 },
] as const;

type BorderStyleId = typeof BORDER_STYLES[number]["id"];

const DRAFT_KEY = "tessella_draft_v1";
const DRAFT_SAVED_DISPLAY_MS = 2000;

// Circle/oval fit — REPLACES the earlier fixed SHAPE_FIT_SCALE constant.
// That approach assumed every subject fills the full square the same way a
// cat roughly does; a tall martini glass with its base near the bottom edge
// proved that assumption wrong (it still clipped at 0.82). Rather than keep
// guessing a magic number per subject shape, this detects the ACTUAL extent
// of non-white content in the generated image and computes the exact scale
// + recentring needed to fit THAT subject inside the shape's safe zone --
// works the same way for a cat, a glass, a rose, or a pair of wellies,
// without per-shape tuning.

// Cache: image URL -> detected subject bbox. The live preview recomposes on
// every keystroke/slider move (150ms debounce); without this it would rescan
// pixels constantly. The bbox only depends on the raw image content, so it's
// computed once per distinct URL.
const subjectBBoxCache = new Map<string, { minX: number; minY: number; maxX: number; maxY: number } | null>();

/**
 * Detect the bounding box of non-background content in an image, by scanning
 * a downsampled copy for pixels that aren't near-white. Returns normalised
 * (0..1) coordinates relative to the image's own dimensions, or null if no
 * subject content was found (blank/near-blank image) -- callers treat null
 * as "no adjustment possible, leave as-is".
 */
async function detectSubjectBBox(
  imageUrl: string,
): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | null> {
  if (subjectBBoxCache.has(imageUrl)) return subjectBBoxCache.get(imageUrl)!;
  let result: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not load image for bbox detection"));
      img.src = imageUrl;
    });
    // Downsample for a fast scan -- exact subject edges aren't needed, just
    // the rough extent, and this keeps getImageData cheap regardless of the
    // source image's real resolution.
    const SCAN_SIZE = 200;
    const canvas = document.createElement("canvas");
    canvas.width = SCAN_SIZE;
    canvas.height = SCAN_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas not supported");
    ctx.drawImage(img, 0, 0, SCAN_SIZE, SCAN_SIZE);
    const { data } = ctx.getImageData(0, 0, SCAN_SIZE, SCAN_SIZE);

    // A pixel counts as background if it's near-pure white or transparent.
    // The Single Motif prompt explicitly requests a plain solid white
    // background, so this threshold is deliberately tight -- loose enough to
    // absorb mild compression noise, tight enough not to eat pale subject
    // edges (e.g. a white cat's ear outline).
    const WHITE_THRESHOLD = 245;
    let minX = SCAN_SIZE, minY = SCAN_SIZE, maxX = -1, maxY = -1;
    for (let y = 0; y < SCAN_SIZE; y++) {
      for (let x = 0; x < SCAN_SIZE; x++) {
        const i = (y * SCAN_SIZE + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2], alpha = data[i + 3];
        const isBackground = alpha < 10 || (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD);
        if (!isBackground) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= minX && maxY >= minY) {
      // Small outward padding so the fit doesn't crop right on the subject's
      // own anti-aliased edge pixels.
      const pad = SCAN_SIZE * 0.02;
      result = {
        minX: Math.max(0, minX - pad) / SCAN_SIZE,
        minY: Math.max(0, minY - pad) / SCAN_SIZE,
        maxX: Math.min(SCAN_SIZE, maxX + pad) / SCAN_SIZE,
        maxY: Math.min(SCAN_SIZE, maxY + pad) / SCAN_SIZE,
      };
    }
  } catch (e) {
    console.warn("Subject bbox detection failed", e);
    result = null;
  }
  subjectBBoxCache.set(imageUrl, result);
  return result;
}

// Fraction of the canvas, on EACH axis independently, occupied by the largest
// axis-aligned rectangle inscribed in an ellipse spanning the full canvas --
// the guaranteed-safe zone for circle/oval. From the ellipse equation
// (x/a)^2+(y/b)^2=1, the inscribed rectangle's half-extents are a/sqrt2,
// b/sqrt2 -- as a FRACTION of the full a,b it's 1/sqrt2 on each axis
// independently, true for a circle and any oval (the axes are handled
// separately, so aspect ratio doesn't matter here).
const ELLIPSE_SAFE_FRACTION = 1 / Math.SQRT2;

type ShapeSafeRect = { x0: number; y0: number; x1: number; y1: number };

const ELLIPSE_SAFE_RECT: ShapeSafeRect = {
  x0: 0.5 - ELLIPSE_SAFE_FRACTION / 2,
  x1: 0.5 + ELLIPSE_SAFE_FRACTION / 2,
  y0: 0.5 - ELLIPSE_SAFE_FRACTION / 2,
  y1: 0.5 + ELLIPSE_SAFE_FRACTION / 2,
};

/**
 * The guaranteed-safe zone (fractional canvas-space) a generated subject's
 * own bounding box must fit inside for a given canvas shape, or null if the
 * shape doesn't need bbox-fitting (rectangle; brick has no single inscribed
 * rect at all -- see master plan §10 item 1, still open).
 */
function shapeFitSafeRect(shape: CanvasShape): ShapeSafeRect | null {
  if (shape === "circle" || shape === "oval") return ELLIPSE_SAFE_RECT;
  if (shape === "stocking") return STOCKING_SAFE_RECT;
  return null;
}

/**
 * Given a draw rect (dx,dy,dw,dh, all normalised 0..1 canvas-space) and a
 * detected subject bbox (normalised within the IMAGE's own space), return the
 * adjusted rect so the subject's own extent fits inside the given shape's
 * safe zone, centred on THAT ZONE (not necessarily the canvas centre --
 * stocking's safe zone sits down the leg, off-centre). Never magnifies
 * (scale is clamped to <=1) -- a subject that already fits is left alone
 * rather than blown up. Returns the input unchanged if bbox or safeRect is
 * null, or the subject already fits.
 */
function applyBBoxFit(
  dx: number, dy: number, dw: number, dh: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null,
  safeRect: ShapeSafeRect | null,
): { dx: number; dy: number; dw: number; dh: number } {
  if (!bbox || !safeRect) return { dx, dy, dw, dh };
  const subjW = (bbox.maxX - bbox.minX) * dw;
  const subjH = (bbox.maxY - bbox.minY) * dh;
  if (subjW <= 0 || subjH <= 0) return { dx, dy, dw, dh };
  const safeW = safeRect.x1 - safeRect.x0;
  const safeH = safeRect.y1 - safeRect.y0;
  const scale = Math.min(1, safeW / subjW, safeH / subjH);
  if (scale >= 0.999) return { dx, dy, dw, dh };
  const newDw = dw * scale;
  const newDh = dh * scale;
  const bcx = (bbox.minX + bbox.maxX) / 2;
  const bcy = (bbox.minY + bbox.maxY) / 2;
  const safeCx = (safeRect.x0 + safeRect.x1) / 2;
  const safeCy = (safeRect.y0 + safeRect.y1) / 2;
  const newDx = safeCx - bcx * newDw;
  const newDy = safeCy - bcy * newDh;
  return { dx: newDx, dy: newDy, dw: newDw, dh: newDh };
}

function Index() {
  const [openStep, setOpenStep] = useState<string>("canvas-spec");

  // Thread Brand
  const [threadBrand, setThreadBrand] = useState<ThreadBrand | null>(null);
  const palette = threadBrand ? THREAD_PALETTES[threadBrand] : [];

  // Account / My Designs library
  const { user } = useAuth();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [myDesignsOpen, setMyDesignsOpen] = useState(false);
  const [myDesigns, setMyDesigns] = useState<DesignSummary[]>([]);
  const [myDesignsLoading, setMyDesignsLoading] = useState(false);
  // Thread stash, fetched once here (same convention as `designs`) and passed
  // down to ThreadShoppingList for "you already have a close match" hints.
  const [stash, setStash] = useState<StashRow[]>([]);

  const [motifLibraryOpen, setMotifLibraryOpen] = useState(false);
  const [motifsMine, setMotifsMine] = useState<MotifRecord[]>([]);
  const [motifsPreloaded, setMotifsPreloaded] = useState<MotifRecord[]>([]);
  const [motifsLoading, setMotifsLoading] = useState(false);
  const [motifsError, setMotifsError] = useState<string | null>(null);
  const [motifPickMode, setMotifPickMode] = useState(false);
  const [tileFillMotif, setTileFillMotif] = useState<MotifRecord | null>(null);
  const [currentDesignId, setCurrentDesignId] = useState<string | null>(null);
  const [currentDesignName, setCurrentDesignName] = useState<string>("");
  const [placingOrder, setPlacingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderPlaced, setOrderPlaced] = useState(false);
  const [progressGrid, setProgressGrid] = useState<ProgressGrid | null>(null);

  // Text & Lettering
  const [textValue, setTextValue] = useState<string>("");
  const [textFontId, setTextFontId] = useState<string>(TEXT_FONTS[0].id);
  const [textColor, setTextColor] = useState<string | null>(null);
  const textFont = TEXT_FONTS.find((f) => f.id === textFontId) ?? TEXT_FONTS[0];

  // Monogram
  const [initials, setInitials] = useState<string[]>(["", "", ""]);
  const [initialColors, setInitialColors] = useState<(string | null)[]>([null, null, null]);
  const [monogramCount, setMonogramCount] = useState<1 | 2 | 3>(3);
  const [monogramStyle, setMonogramStyle] = useState<MonogramStyleId>("m1");

  // Second thread colour for two-colour fonts (currently only Shadow Serif).
  // Null = render those cells in the main colour instead.
  const [textShadowColor, setTextShadowColor] = useState<string | null>(null);
  const [monogramShadowColor, setMonogramShadowColor] = useState<string | null>(null);

  // Quarter-turn rotation for lettering. Only 90-degree steps exist because
  // stitches are grid-aligned -- any other angle would have to resample the
  // charted cells and could not be stitched cleanly.
  const [textRotation, setTextRotation] = useState<Quarter>(0);
  const [textLetterSpacing, setTextLetterSpacing] = useState<number>(1);
  const [monogramRotation, setMonogramRotation] = useState<Quarter>(0);


  // Independent overlay positions (normalised 0..1, centre point on canvas).
  // Moving image MUST NOT alter these; moving these MUST NOT alter image.
  const [textPos, setTextPos] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.86 });
  const [textAlign, setTextAlign] = useState<"left" | "center" | "right">("center");
  const [textWrapEnabled, setTextWrapEnabled] = useState(false);
  const [textBoxWidthFrac, setTextBoxWidthFrac] = useState(0.6);
  const [monogramPos, setMonogramPos] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.14 });

  // A motif placed on the chart that KEEPS its identity -- it stays a live
  // layer (re-composited on every recompose, exactly like text/monogram)
  // rather than being baked into chartBase, so it can be re-selected, moved,
  // reordered, or removed later. Cells are stored verbatim (not just a
  // library id) so a placed motif survives the library row being deleted,
  // and so save/reload restores it without a second fetch.
  type PlacedMotif = {
    instanceId: string;
    name: string;
    cells: string[][];
    width: number;
    height: number;
    offset: { x: number; y: number };
    scale: number;
    // Quarter-turn only (stitches are grid-aligned; any other angle would
    // resample the cells and can't be stitched cleanly). Older saved designs
    // predate this field -- treat a missing rotation as 0 wherever it's read.
    rotation: Quarter;
  };
  const [placedMotifs, setPlacedMotifs] = useState<PlacedMotif[]>([]);



  // Border
  const [borderStyle, setBorderStyle] = useState<BorderStyleId>("none");
  const [borderColors, setBorderColors] = useState<Record<BorderStyleId, (string | null)[]>>({
    none: [],
    simple: [null],
    double: [null, null],
    poppy: [null, null],
    flowers: [null, null, null],
    ladder: [null, null, null],
    interlock: [null, null],
    spades: [null, null],
    "small-flowers": [null, null, null],
    "scandi-double": [null, null],
    "oak-and-acorn": [null, null],
    "scalloped-tulips": [null, null, null],
  });

  // Canvas Specification
  const [canvasShape, setCanvasShape] = useState<CanvasShape>("rectangle");
  const [meshCount, setMeshCount] = useState<number>(12);
  const [finishedWidth, setFinishedWidth] = useState<string>("");
  const [finishedHeight, setFinishedHeight] = useState<string>("");

  // The TRUE canvas dimensions, which differ from the raw inputs for some
  // shapes: a stocking's foot extends ~1.9x past the leg width the user
  // types, and a brick is a fixed 14x10. Declared here so every consumer
  // (aspect ratio, stitch grid, chart payload) uses the same numbers.
  const canvasDims = canvasDimsInches(
    canvasShape,
    parseFloat(finishedWidth) || 0,
    parseFloat(finishedHeight) || 0,
  );

  // Switching shape changes what the dimension fields MEAN, so reconcile them.
  function handleShapeChange(next: CanvasShape) {
    // Leaving brick: its locked 14/10 are not the user's numbers — discard
    // them BEFORE any seeding runs, or brick -> circle would silently seed a
    // 14in diameter the user never chose.
    const leavingBrick = canvasShape === "brick" && next !== "brick";
    const baseW = leavingBrick ? "" : finishedWidth;
    const baseH = leavingBrick ? "" : finishedHeight;

    if (next === "brick") {
      setFinishedWidth(String(BRICK_CANVAS_WIDTH_INCHES));
      setFinishedHeight(String(BRICK_CANVAS_HEIGHT_INCHES));
    } else if (next === "circle") {
      const seed = baseW || baseH || "";
      setFinishedWidth(seed);
      setFinishedHeight(seed);
    } else {
      setFinishedWidth(baseW);
      setFinishedHeight(baseH);
    }
    setCanvasShape(next);
  }

  // Image generation
  const [imageMode, setImageMode] = useState<"generate" | "upload" | "none">("generate");
  const [userText, setUserText] = useState("");
  const [styleId, setStyleId] = useState<string>(STYLE_PRESETS[0].id);
  // Brick composition: a mode plus independently-generated artwork slots.
  // Replaces the earlier single "scene wrap" prompt, which asked one
  // generation to lay out all five panels and did not comply in practice.
  const [brickPatternMode, setBrickPatternMode] = useState<BrickPatternMode>("uniform");
  const [brickSlots, setBrickSlots] = useState<Partial<Record<BrickSlotKind, { url: string; repeats: number; contentMode?: BrickSlotContentMode }>>>({});
  // Each brick slot is generated from its own prompt -- one shared prompt
  // can't describe a side pattern and a centre motif at the same time, and
  // having both a shared box and per-slot buttons made it ambiguous which
  // one any given Generate was using.
  const [brickSlotPrompts, setBrickSlotPrompts] = useState<Record<string, string>>({});
  const [brickSlotError, setBrickSlotError] = useState<Partial<Record<BrickSlotKind, string>>>({});
  const [brickSlotGenerating, setBrickSlotGenerating] = useState<BrickSlotKind | null>(null);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);
  // null = use whatever auto-detection decided; a value = user overrode it.
  const [inputTypeOverride, setInputTypeOverride] = useState<InputType | null>(null);
  const [detectedInputType, setDetectedInputType] = useState<DetectionResult | null>(null);
  const sourceImageInputRef = useRef<HTMLInputElement | null>(null);
  const cropFrameRef = useRef<ImageCropFrameHandle | null>(null);
  // Crop frame starts collapsed behind an explicit "Crop image" button --
  // drag handles alone read as resize/reposition, not "this is the crop
  // tool". A clear button makes the action discoverable.
  const [cropOpen, setCropOpen] = useState(false);
  // The image as first uploaded/generated. Cropping physically cuts the
  // image, so without this a second crop would cut the already-cropped
  // result and could never widen again. The crop tool always works from
  // this, never from the cropped output.
  const [uncroppedImageUrl, setUncroppedImageUrl] = useState<string | null>(null);

  // === Single source of truth for image placement ===
  // Normalised (0..1) rect of the image within the canvas frame.
  // null means "fit on first render" (the crop frame seeds it).
  const [imageRect, setImageRect] = useState<NormRect | null>(null);

  // Reset dialog
  const [showResetDialog, setShowResetDialog] = useState(false);

  // Portrait awareness
  const [isPortrait, setIsPortrait] = useState(false);
  const [orderAcknowledged, setOrderAcknowledged] = useState(false);

  async function detectFaceFromUrl(url: string): Promise<boolean> {
    try {
      // @ts-expect-error - FaceDetector is an experimental browser API
      const FD = typeof window !== "undefined" ? window.FaceDetector : undefined;
      if (!FD) return false;
      const detector = new FD({ fastMode: true, maxDetectedFaces: 3 });
      const img = await loadImage(url, true);
      const faces = await detector.detect(img);
      return Array.isArray(faces) && faces.length > 0;
    } catch {
      return false;
    }
  }

  // Renders the ACTUAL charted stitch data (colour-quantized cells) into a
  // small canvas, for use as a thumbnail -- distinct from buildComposite(),
  // which renders the pre-chart AI-generated source image and is meant for
  // the live design-in-progress preview, not a record of the finished
  // charted result. A design's thumbnail should show what will actually be
  // stitched/printed, not the raw generation input. Walks pixelsRLE directly
  // (chart.width/height runs of palette indices) rather than expanding to a
  // full pixel array first, since this only needs to visit each run once.
  // NOT_STITCHABLE cells (outside a non-rectangular canvas shape's outline)
  // are left transparent, matching how StitchChart's own canvas and the
  // Motif Library's MotifPreview both already treat that sentinel.
  function renderChartThumbnail(chart: ChartData, maxSize: number): HTMLCanvasElement {
    const { width, height, palette, pixelsRLE } = chart;
    const canvas = document.createElement("canvas");
    const scale = Math.max(1, Math.floor(maxSize / Math.max(width, height, 1)));
    canvas.width = Math.max(1, width * scale);
    canvas.height = Math.max(1, height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    ctx.imageSmoothingEnabled = false;
    let i = 0;
    for (const [palIdx, len] of pixelsRLE) {
      const entry = palette[palIdx];
      for (let n = 0; n < len; n++) {
        if (i >= width * height) break;
        const x = i % width;
        const y = Math.floor(i / width);
        if (entry && entry.id !== NOT_STITCHABLE) {
          ctx.fillStyle = entry.hex;
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
        i++;
      }
    }
    return canvas;
  }

  async function uploadCanvasToDesigns(canvas: HTMLCanvasElement): Promise<string> {
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not encode image"))),
        "image/png",
      ),
    );
    const path = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const { error: uploadErr } = await supabase.storage
      .from("designs")
      .upload(path, blob, { contentType: "image/png", upsert: false });
    if (uploadErr) throw uploadErr;
    const { data: signed, error: signErr } = await supabase.storage
      .from("designs")
      .createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signErr || !signed?.signedUrl) throw signErr ?? new Error("Could not sign URL");
    return signed.signedUrl;
  }

  async function loadImage(src: string, crossOrigin = false): Promise<HTMLImageElement> {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not load image"));
      img.src = src;
    });
    return img;
  }

  // Pure flatten: opaque white BEHIND the image, image on top as a 1:1 pixel
  // copy. No filter, no opacity, no blend mode — colour-identical to source.
  function flattenOnWhite(
    img: HTMLImageElement,
    maxSize: number | null,
  ): HTMLCanvasElement {
    const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1024;
    const scale = maxSize && longest > maxSize ? maxSize / longest : 1;
    const w = Math.max(1, Math.round((img.naturalWidth || 1024) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 1024) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    // 1) White goes DOWN FIRST, on the empty transparent canvas.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    // 2) Image drawn on TOP, never the other way round. No filter / opacity.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  // Tuning pass: white behind, then image on top with the CSS filter applied.
  // Only used when the user has actually moved a slider.
  function flattenWithFilter(
    img: HTMLImageElement,
    filter: string,
  ): HTMLCanvasElement {
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = filter;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  // ===== Composite design (image + border + monogram + text) =====

  async function svgToImage(svg: string): Promise<HTMLImageElement> {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      return await loadImage(url);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  type ComposeOpts = {
    baseImageUrl: string | null;
    /** Longest side of the output canvas, px. */
    size?: number;
    /** Canvas width / height — controls output aspect (no longer hard-square). */
    aspect: number;
    /** Normalised image placement within the canvas (single source of truth). */
    imageRect: NormRect | null;
    /** CSS filter applied when rasterising the image (brightness/saturation/contrast). */
    imageFilter?: string;
    /** If set, detect the subject's real extent and fit it into this safe zone. Pass shapeFitSafeRect(canvasShape). */
    shapeSafeRect?: ShapeSafeRect | null;
    text: string;
    textFontCss: string;
    textColor: string | null;
    textPos: { x: number; y: number };
    initials: string[];
    initialColors: (string | null)[];
    monogramCount: 1 | 2 | 3;
    monogramFontCss: string;
    monogramPos: { x: number; y: number };
    borderStyle: BorderStyleId;
    borderColors: (string | null)[];
    /** If true, skip border/text/monogram and render image-only on background. */
    imageOnly?: boolean;
    /** Canvas shape — brick has its own multi-slot composition path. */
    canvasShape?: CanvasShape;
    brickPatternMode?: BrickPatternMode;
    brickSlots?: Partial<Record<BrickSlotKind, { url: string; repeats: number; contentMode?: BrickSlotContentMode }>>;
  };


  async function composeDesignCanvas(opts: ComposeOpts): Promise<HTMLCanvasElement> {
    const longest = opts.size ?? 1024;
    const a = opts.aspect > 0 ? opts.aspect : 1;
    const W = a >= 1 ? longest : Math.round(longest * a);
    const H = a >= 1 ? Math.round(longest / a) : longest;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    // Background.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);

    // Brick branch: composes independently-generated panel/motif slots.
    // Runs INSTEAD of the single base-image draw. Falls through if no slots
    // are present yet, so an empty brick still renders (blank preview).
    const brickSlotEntries = opts.brickSlots
      ? (Object.entries(opts.brickSlots) as [BrickSlotKind, { url: string; repeats: number; contentMode?: BrickSlotContentMode }][])
        .filter(([, v]) => !!v?.url)
      : [];
    const useBrickBranch = opts.canvasShape === "brick" && brickSlotEntries.length > 0;

    if (useBrickBranch) {
      try {
        const imgEntries = await Promise.all(
          brickSlotEntries.map(async ([slot, v]) => [slot, await loadImage(v.url, true)] as const),
        );
        const images: BrickSlotImages = {};
        const repeatsBy: Record<string, number> = {};
        for (const [slot, img] of imgEntries) {
          images[slot] = img;
        }
        for (const [slot, v] of brickSlotEntries) repeatsBy[slot] = v.repeats;
        const mode = opts.brickPatternMode ?? "uniform";
        // Centre bbox: only relevant when a centre motif is present. The
        // slot prompt asks for a motif on a plain background, so detection
        // has content to trim.
        let centerBBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
        if ((mode === "armsPlusCenter" || mode === "pairedArmsPlusCenter") && opts.brickSlots?.center?.url) {
          centerBBox = await detectSubjectBBox(opts.brickSlots.center.url);
        }
        const contentModesBy: Partial<Record<BrickSlotKind, BrickSlotContentMode>> = {};
        for (const [k, v] of brickSlotEntries) contentModesBy[k] = v.contentMode ?? "pattern";
        drawBrickComposition(ctx, W, H, mode, images, repeatsBy, contentModesBy, centerBBox, "#FFFFFF");
      } catch (e) {
        console.warn("Could not draw brick composition", e);
      }
    } else
    // 1. Base image — drawn at the EXACT normalised rect, no re-fit.
    if (opts.baseImageUrl && opts.imageRect) {
      try {
        const img = await loadImage(opts.baseImageUrl, true);
        const r = opts.imageRect;
        if (opts.imageFilter) ctx.filter = opts.imageFilter;
        let dx = r.x, dy = r.y, dw = r.w, dh = r.h;
        if (opts.shapeSafeRect) {
          const bbox = await detectSubjectBBox(opts.baseImageUrl);
          ({ dx, dy, dw, dh } = applyBBoxFit(dx, dy, dw, dh, bbox, opts.shapeSafeRect));
        }
        ctx.drawImage(img, dx * W, dy * H, dw * W, dh * H);
        ctx.filter = "none";
      } catch (e) {
        console.warn("Could not draw base image", e);
      }
    } else if (opts.baseImageUrl) {
      // No rect supplied yet (e.g. brand-new image) — cover-fit fallback.
      try {
        const img = await loadImage(opts.baseImageUrl, true);
        const imgAR = img.naturalWidth / img.naturalHeight;
        let dwN = W, dhN = H;
        if (imgAR > a) { dhN = H; dwN = dhN * imgAR; }
        else { dwN = W; dhN = dwN / imgAR; }
        let dxN = (W - dwN) / 2, dyN = (H - dhN) / 2;
        if (opts.shapeSafeRect) {
          const bbox = await detectSubjectBBox(opts.baseImageUrl);
          const fitted = applyBBoxFit(dxN / W, dyN / H, dwN / W, dhN / H, bbox, opts.shapeSafeRect);
          dxN = fitted.dx * W; dyN = fitted.dy * H; dwN = fitted.dw * W; dhN = fitted.dh * H;
        }
        if (opts.imageFilter) ctx.filter = opts.imageFilter;
        ctx.drawImage(img, dxN, dyN, dwN, dhN);
        ctx.filter = "none";
      } catch (e) {
        console.warn("Could not draw base image", e);
      }
    }

    if (opts.imageOnly) return canvas;

    const refSize = Math.min(W, H);

    // Grid-cell math shared by the border, text and monogram layers below.
    const previewGridW = Math.max(1, Math.round(canvasDims.width * meshCount));
    const previewGridH = Math.max(1, Math.round(canvasDims.height * meshCount));
    const pxPerCellX = W / previewGridW;
    const pxPerCellY = H / previewGridH;
    const codeToHex = new Map(palette.map((p) => [p.code, p.hex]));
    const drawLayerCells = (layer: Layer | null) => {
      if (!layer) return;
      const { cells, offset, scale } = layer;
      for (let ry = 0; ry < cells.length; ry++) {
        const row = cells[ry];
        for (let rx = 0; rx < row.length; rx++) {
          const v = row[rx];
          if (v === LAYER_SENTINEL) continue;
          const hex = codeToHex.get(v) ?? "#3B4F35";
          const gx = offset.x + rx * scale;
          const gy = offset.y + ry * scale;
          ctx.fillStyle = hex;
          ctx.fillRect(gx * pxPerCellX, gy * pxPerCellY, scale * pxPerCellX, scale * pxPerCellY);
        }
      }
    };

    // 2. Border — anchored to canvas (independent of image/text/monogram).
    // Uses the SAME borderToLayer geometry the real chart engine's shape-aware
    // border logic is built on (src/lib/border-layers.ts), not a decorative
    // SVG approximation -- this is what makes "This is exactly what will be
    // sent to the chart" (the caption under this preview) actually true for
    // every canvas shape, not just rectangles.
    if (opts.borderStyle !== "none") {
      const fallbackBorderColor = "#3B4F35";
      const borderShapeMask = (opts.canvasShape ?? canvasShape) === "rectangle"
        ? undefined
        : shapeMask(opts.canvasShape ?? canvasShape, previewGridW, previewGridH, canvasDims.width, canvasDims.height);
      const borderLayer = borderToLayer(
        "preview-border",
        { style: opts.borderStyle, colors: opts.borderColors.map((c) => c ?? fallbackBorderColor) },
        previewGridW, previewGridH, palette, LAYER_SENTINEL,
        borderShapeMask,
      );
      drawLayerCells(borderLayer);
    }

    // 3 & 4. Text and monogram — rendered from the SAME glyph layout the
    // charter uses, so the preview shows exactly what will be stitched. The
    // old CSS-font path drew at an arbitrary pixel size that bore no
    // relation to the charted footprint, so a user could see "tiny text"
    // in the preview, chart it, and get half the letters clipped.

    if (palette.length && previewGridW > 0 && previewGridH > 0) {
      const monoLayer = monogramToLayer(
        "preview-mono",
        {
          initials: opts.initials,
          colors: opts.initialColors,
          count: opts.monogramCount,
          fontCss: opts.monogramFontCss,
          fontId: monogramStyle === "m1" ? null : monogramStyle,
          shadowColor: monogramShadowColor,
          rotation: monogramRotation,
        },
        previewGridW, previewGridH, palette, LAYER_SENTINEL, opts.monogramPos,
      );
      drawLayerCells(monoLayer);

      const textLayer = textToLayer(
        "preview-text",
        {
          text: opts.text,
          fontCss: opts.textFontCss,
          color: opts.textColor,
          align: textAlign,
          boxWidthCells: textWrapEnabled ? Math.round(textBoxWidthFrac * previewGridW) : undefined,
          fontId: textFontId === "default" ? null : textFontId,
          shadowColor: textShadowColor,
          rotation: textRotation,
          letterSpacing: textLetterSpacing,
        },
        previewGridW, previewGridH, palette, LAYER_SENTINEL, opts.textPos,
      );
      drawLayerCells(textLayer);
    }


    // Display-only finished-shape outline, matching the stitch chart. Drawn last so
    // it sits above image/border/text. Deliberately AFTER the `opts.imageOnly` early
    // return above, so the image sent to the chart engine never contains the line.
    drawShapeOutline(
      ctx,
      opts.canvasShape ?? canvasShape,
      0, 0, W, H,
      canvasDims.width,
      canvasDims.height,
    );

    return canvas;

  }

  const handleSourceImageUpload = async (file: File) => {
    setUploadError(null);
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      setUploadError("Please upload a JPEG or PNG image.");
      return;
    }
    setIsProcessingUpload(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.readAsDataURL(file);
      });
      const img = await loadImage(dataUrl);
      const canvas = flattenOnWhite(img, 1024);
      // Classify flat artwork vs photograph — see input-type-detect.ts.
      // A fresh upload always starts from fresh detection, not the last override.
      setDetectedInputType(detectInputType(canvas));
      setInputTypeOverride(null);
      // The same flattened PNG is what the preview shows AND what the chart
      // function receives — they cannot diverge.
      const signedUrl = await uploadCanvasToDesigns(canvas);
      setIsPortrait(false);
      setOrderAcknowledged(false);
      setImageRect(null); // re-fit for new image
      setCropOpen(false); // fresh image -- start collapsed behind the Crop button again
      setUncroppedImageUrl(signedUrl);
      setGeneratedImageUrl(signedUrl);
      // Try auto-detecting a face; if found, pre-tick the portrait flag.
      const hasFace = await detectFaceFromUrl(signedUrl);
      if (hasFace) setIsPortrait(true);
    } catch (err) {
      console.error(err);
      setUploadError("Sorry, we couldn't process that image. Try a different file.");
    } finally {
      setIsProcessingUpload(false);
    }
  };




  // Chart generation
  const [maxColours, setMaxColours] = useState<number>(24);
  const [maxColoursTouched, setMaxColoursTouched] = useState<boolean>(false);
  const [pendingColourChange, setPendingColourChange] = useState<{ before: number; after: number } | null>(null);
  const [shading, setShading] = useState<"none" | "light" | "medium" | "heavy">("medium");
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [isCharting, setIsCharting] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  // Image tuning
  const [brightness, setBrightness] = useState<number>(100);
  const [saturation, setSaturation] = useState<number>(100);
  const [contrast, setContrast] = useState<number>(100);
  const resetTuning = () => {
    setBrightness(100);
    setSaturation(100);
    setContrast(100);
  };

  const handleStartNewDesign = () => {
    setShowResetDialog(false);
    localStorage.removeItem(DRAFT_KEY);

    // Step / tab
    setOpenStep("canvas-spec");
    setActiveTab("canvas");

    // Thread
    setThreadBrand(null);

    // Text & Lettering
    setTextValue("");
    setTextFontId(TEXT_FONTS[0].id);
    setTextColor(null);
    setTextLetterSpacing(1);

    // Monogram
    setInitials(["", "", ""]);
    setInitialColors([null, null, null]);
    setMonogramCount(3);
    setMonogramStyle("m1");

    // Independent overlay positions
    setTextPos({ x: 0.5, y: 0.86 });
    setMonogramPos({ x: 0.5, y: 0.14 });


    // Border
    setBorderStyle("none");
    setBorderColors({
      none: [],
      simple: [null],
      double: [null, null],
      poppy: [null, null],
      flowers: [null, null, null],
      ladder: [null, null, null],
      interlock: [null, null],
      spades: [null, null],
      "small-flowers": [null, null, null],
      "scandi-double": [null, null],
      "oak-and-acorn": [null, null],
      "scalloped-tulips": [null, null, null],
      });

    // Canvas spec
    setCanvasShape("rectangle");
    setMeshCount(12);
    setFinishedWidth("");
    setFinishedHeight("");

    // Image generation
    setImageMode("generate");
    setUserText("");
    setStyleId(STYLE_PRESETS[0].id);
    setGeneratedImageUrl(null);
    setImageRect(null);
    setIsGenerating(false);
    setGenerateError(null);
    setUploadError(null);
    setIsProcessingUpload(false);
    setIsPortrait(false);
    setOrderAcknowledged(false);

    // Chart generation
    setMaxColours(24);
    setShading("medium");
    setChartData(null);
    setIsCharting(false);
    setChartError(null);
    chartBaseRef.current = null;
    lastCompositeRef.current = null;
    setCurrentDesignId(null);
    setCurrentDesignName("");
    setOrderPlaced(false);
    setOrderError(null);
    setProgressGrid(null);

    // Image tuning
    setBrightness(100);
    setSaturation(100);
    setContrast(100);

    // Preview
    setPreviewUrl(null);
    setIsBuildingPreview(false);

    // Clear file inputs
    if (sourceImageInputRef.current) sourceImageInputRef.current.value = "";
  };
  // Identity tuning must be a genuinely ABSENT filter, not a no-op string.
  // ctx.filter = "brightness(100%) ..." is numerically identity but still
  // routes drawImage through the filter pipeline, which resamples in linear
  // light. Averaging black ink with white paper in linear space yields ~188
  // instead of ~128, so thin anti-aliased dark strokes are lifted to pale
  // grey while large flat areas are unaffected. Measured on a real upload:
  // pixels darker than sum 250 fell from 17,384 to 644 between the browser
  // and the chart engine, and the pure-black bucket (8,100 px) vanished
  // entirely while every olive bucket survived intact. That is why black
  // linework never reached the chart.
  const tuningIsIdentity = brightness === 100 && saturation === 100 && contrast === 100;
  const tuningFilter = tuningIsIdentity
    ? ""
    : `brightness(${brightness}%) saturate(${saturation}%) contrast(${contrast}%)`;

  async function buildAdjustedImage(url: string): Promise<string> {
    // Sliders untouched → use the already-uploaded image AS-IS. No re-flatten,
    // no re-encode — guarantees the chart sees the exact pixels in the preview.
    if (brightness === 100 && saturation === 100 && contrast === 100) return url;
    try {
      const img = await loadImage(url, true);
      const canvas = flattenWithFilter(img, tuningFilter);
      return await uploadCanvasToDesigns(canvas);
    } catch (err) {
      console.error("Could not build adjusted image", err);
      return url;
    }
  }

  const [activeTab, setActiveTab] = useState<string>("canvas");
  const [draftSaved, setDraftSaved] = useState(false);

  // Next walks the accordion in designSteps order; only the final step
  // hands off to the chart. Deriving the target from the array means
  // reordering steps can't silently strand a Next button pointing at the
  // wrong place (which is exactly what happened when Canvas Specification
  // moved to first).
  function goToNextStep(currentId: string) {
    const i = designSteps.findIndex((s) => s.id === currentId);
    if (i < 0) return;
    if (i === designSteps.length - 1) {
      setActiveTab("chart");
      return;
    }
    setOpenStep(designSteps[i + 1].id);
  }

  // Deep link from the Account page: /?design=<id> loads that saved design.
  // Runs after the draft-restore effect below (declared later, so it has
  // already flushed by the time this fires) and clears the param so a reload
  // doesn't re-load over any edits.
  const navigate = useNavigate();
  const { design: designParam } = Route.useSearch();
  const designParamLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!designParam || !user) return;
    if (designParamLoadedRef.current === designParam) return;
    designParamLoadedRef.current = designParam;
    loadDesign(designParam).finally(() => {
      navigate({ to: "/", search: {}, replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designParam, user]);

  // Restore design draft from localStorage on mount (survives tab eviction /
  // Lovable preview reloads). Runs once; each setter is guarded so missing
  // keys in an older draft are silently skipped.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || typeof d !== "object") return;
      // Discard drafts older than 7 days (signed image URLs expire then).
      if (Date.now() - (d.savedAt ?? 0) > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      if (d.openStep !== undefined) setOpenStep(d.openStep);
      if (d.activeTab !== undefined) setActiveTab(d.activeTab);
      if (d.threadBrand !== undefined) setThreadBrand(d.threadBrand);
      if (d.textValue !== undefined) setTextValue(d.textValue);
      if (d.textFontId !== undefined) setTextFontId(d.textFontId);
      if (d.textColor !== undefined) setTextColor(d.textColor);
      if (d.initials !== undefined) setInitials(d.initials);
      if (d.initialColors !== undefined) setInitialColors(d.initialColors);
      if (d.monogramCount !== undefined) setMonogramCount(d.monogramCount);
      if (d.monogramStyle !== undefined) setMonogramStyle(d.monogramStyle);
      if (d.textShadowColor !== undefined) setTextShadowColor(d.textShadowColor);
      if (d.monogramShadowColor !== undefined) setMonogramShadowColor(d.monogramShadowColor);
      if (d.textRotation !== undefined) setTextRotation(d.textRotation as Quarter);
      if (d.textLetterSpacing !== undefined) setTextLetterSpacing(d.textLetterSpacing as number);
      if (d.monogramRotation !== undefined) setMonogramRotation(d.monogramRotation as Quarter);

      if (d.textPos !== undefined) setTextPos(d.textPos);
      if (d.textAlign !== undefined) setTextAlign(d.textAlign);
      if (d.textWrapEnabled !== undefined) setTextWrapEnabled(d.textWrapEnabled);
      if (d.textBoxWidthFrac !== undefined) setTextBoxWidthFrac(d.textBoxWidthFrac);
      if (d.monogramPos !== undefined) setMonogramPos(d.monogramPos);
      if (d.placedMotifs !== undefined) setPlacedMotifs(d.placedMotifs as PlacedMotif[]);
      if (d.borderStyle !== undefined) setBorderStyle(d.borderStyle);
      if (d.borderColors !== undefined) setBorderColors(d.borderColors);
      if (d.meshCount !== undefined) setMeshCount(d.meshCount);
      if (d.canvasShape !== undefined) setCanvasShape(d.canvasShape);
      if (d.finishedWidth !== undefined) setFinishedWidth(d.finishedWidth);
      if (d.finishedHeight !== undefined) setFinishedHeight(d.finishedHeight);
      if (d.imageMode !== undefined) setImageMode(d.imageMode);
      if (d.userText !== undefined) setUserText(d.userText);
      if (d.styleId !== undefined) setStyleId(d.styleId);
      if (d.brickPatternMode !== undefined) setBrickPatternMode(d.brickPatternMode as BrickPatternMode);
      else if (d.brickMode !== undefined) setBrickPatternMode("uniform"); // legacy "sceneWrap"/"allOver" both collapse to uniform
      if (d.brickSlots !== undefined) setBrickSlots(d.brickSlots as Partial<Record<BrickSlotKind, { url: string; repeats: number; contentMode?: BrickSlotContentMode }>>);
      if (d.brickSlotPrompts !== undefined) setBrickSlotPrompts(d.brickSlotPrompts as Record<string, string>);
      if (d.generatedImageUrl !== undefined) setGeneratedImageUrl(d.generatedImageUrl);
      if (d.imageRect !== undefined) setImageRect(d.imageRect);
      if (d.isPortrait !== undefined) setIsPortrait(d.isPortrait);
      if (d.orderAcknowledged !== undefined) setOrderAcknowledged(d.orderAcknowledged);
      if (d.maxColours !== undefined) { setMaxColours(d.maxColours); setMaxColoursTouched(true); }
      if (d.shading !== undefined) setShading(d.shading);
      if (d.brightness !== undefined) setBrightness(d.brightness);
      if (d.saturation !== undefined) setSaturation(d.saturation);
      if (d.contrast !== undefined) setContrast(d.contrast);
    } catch {
      // Corrupt data — ignore silently.
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave design draft to localStorage (debounced 400 ms).
  // chartData is intentionally excluded — it's always re-generated.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          savedAt: Date.now(),
          openStep, activeTab, threadBrand,
          textValue, textFontId, textColor, textShadowColor, textRotation, textLetterSpacing,
          initials, initialColors, monogramCount, monogramStyle, monogramShadowColor, monogramRotation,

          textPos, monogramPos, textAlign, textWrapEnabled, textBoxWidthFrac, placedMotifs,
          borderStyle, borderColors,
          canvasShape, meshCount, finishedWidth, finishedHeight,
          imageMode, userText, styleId, brickPatternMode, brickSlots, brickSlotPrompts,
          generatedImageUrl, imageRect,
          isPortrait, orderAcknowledged,
          maxColours, shading,
          brightness, saturation, contrast,
        }));
        setDraftSaved(true);
        setTimeout(() => setDraftSaved(false), DRAFT_SAVED_DISPLAY_MS);
      } catch {
        // Storage full or unavailable — fail silently.
      }
    }, 400);
    return () => clearTimeout(t);
  }, [
    openStep, activeTab, threadBrand,
    textValue, textFontId, textColor, textShadowColor, textRotation, textLetterSpacing,
    initials, initialColors, monogramCount, monogramStyle, monogramShadowColor, monogramRotation,

    textPos, monogramPos, textAlign, textWrapEnabled, textBoxWidthFrac, placedMotifs,
    borderStyle, borderColors,
    canvasShape, meshCount, finishedWidth, finishedHeight,
    imageMode, userText, styleId, brickPatternMode, brickSlots, brickSlotPrompts,
    generatedImageUrl, imageRect,
    isPortrait, orderAcknowledged,
    maxColours, shading,
    brightness, saturation, contrast,
  ]);
  const canvasStepComplete =
    canvasDims.width > 0 &&
    canvasDims.height > 0 &&
    !!meshCount;

  const canvasComplete =
    !!threadBrand &&
    canvasStepComplete;

  const selectedStyle =
    STYLE_PRESETS.find((s) => s.id === styleId) ?? STYLE_PRESETS[0];

  async function callEdgeFunction<T>(name: string, payload: unknown): Promise<T> {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    };
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`,
      { method: "POST", headers, body: JSON.stringify(payload) },
    );
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const j = await res.json();
        msg = j?.error || j?.message || msg;
      } catch {}
      throw new Error(msg);
    }
    return (await res.json()) as T;
  }

  const handleGenerate = async () => {
    setIsGenerating(true);
    setGenerateError(null);
    try {
      const positivePrompt = `${userText.trim()}, ${selectedStyle.positive}`;
      const negativePrompt = selectedStyle.negative;
      const data = await callEdgeFunction<{ imageUrl: string }>("generate", {
        positivePrompt,
        negativePrompt,
        width: 1024,
        height: 1024,
      });
      if (!data?.imageUrl) throw new Error("No image returned");
      setIsPortrait(false);
      setOrderAcknowledged(false);
      setImageRect(null); // re-fit for new image
      setCropOpen(false); // fresh image -- start collapsed behind the Crop button again
      setUncroppedImageUrl(data.imageUrl);
      setGeneratedImageUrl(data.imageUrl);
      const hasFace = await detectFaceFromUrl(data.imageUrl);
      if (hasFace) setIsPortrait(true);
    } catch (err) {
      console.error(err);
      setGenerateError(
        "Sorry, we couldn't generate your image. Please try again in a moment.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  async function handleGenerateBrickSlot(slot: BrickSlotKind) {
    const slotPrompt = (brickSlotPrompts[slot] ?? "").trim();
    if (!slotPrompt) {
      setBrickSlotError((cur) => ({ ...cur, [slot]: "Describe this piece first" }));
      return;
    }
    setBrickSlotError((cur) => ({ ...cur, [slot]: undefined }));
    setBrickSlotGenerating(slot);
    setGenerateError(null);
    try {
      // Pattern slots tile, so a square source is ideal. The centre motif
      // fills the centre panel, which is landscape (8.5 x 4.5in) -- 1536x1024
      // is the closest supported ratio, so the model composes to roughly the
      // right shape rather than having a square crop fitted into it.
      const isCenter = slot === "center";
      const data = await callEdgeFunction<{ imageUrl: string }>("generate", {
        positivePrompt: buildBrickSlotPrompt(slot, slotPrompt, meshCount, brickSlots[slot]?.contentMode ?? "pattern"),
        negativePrompt: selectedStyle.negative,
        width: isCenter ? 1536 : 1024,
        height: 1024,
      });
      if (!data?.imageUrl) throw new Error("No image returned");
      setBrickSlots((cur) => ({
        ...cur,
        [slot]: {
          url: data.imageUrl,
          repeats: cur[slot]?.repeats ?? 3,
          // Carry the user's Pattern/Single choice across regeneration —
          // dropping it silently reverted the composition to tiling.
          contentMode: cur[slot]?.contentMode ?? "pattern",
        },
      }));
    } catch (err) {
      console.error(err);
      setBrickSlotError((cur) => ({ ...cur, [slot]: "Couldn't generate this piece. Try again." }));
    } finally {
      setBrickSlotGenerating(null);
    }
  }


  // Build the composite design canvas using current state.
  const currentMonogramFont =
    MONOGRAM_STYLES.find((s) => s.id === monogramStyle)?.font ?? "serif";

  // Canvas aspect ratio = single source of truth for output shape.
  // Uses the TRUE dims (see canvasDims) so stocking/brick preview correctly.
  const canvasAspect = (canvasDims.width || 1) / (canvasDims.height || 1);

  // Image is pre-flattened with the user's tuning baked in at upload time; the
  // crop frame applies the filter live. For the unified pipeline we hand the
  // raw image + filter to composeDesignCanvas so preview and chart match.
  async function buildComposite(size = 1024, imageOnly = false): Promise<HTMLCanvasElement> {
    return composeDesignCanvas({
      baseImageUrl: imageMode === "none" ? null : generatedImageUrl,
      size,
      aspect: canvasAspect,
      imageRect,
      imageFilter: tuningFilter,
      shapeSafeRect: shapeFitSafeRect(canvasShape),

      text: textValue,
      textFontCss: textFont.css,
      textColor,
      textPos,
      initials,
      initialColors,
      monogramCount,
      monogramFontCss: currentMonogramFont,
      monogramPos,
      borderStyle,
      borderColors: borderColors[borderStyle],
      imageOnly,
      canvasShape,
      brickPatternMode,
      brickSlots,
    });
  }


  // Live preview data URL — recomputed whenever any design input changes,
  // including canvas size / mesh, image crop rect, and tuning.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isBuildingPreview, setIsBuildingPreview] = useState(false);
  const previewDepKey = JSON.stringify({
    generatedImageUrl,
    imageMode,
    imageRect,
    textValue,
    textFontId,
    textColor,
    textPos,
    initials,
    initialColors,
    monogramCount,
    monogramStyle,
    monogramPos,
    borderStyle,

    borderColors: borderColors[borderStyle],
    brightness,
    saturation,
    contrast,
    finishedWidth,
    finishedHeight,
    meshCount,
    canvasShape,
    brickPatternMode,
    brickSlots,
  });
  useEffect(() => {
    let cancelled = false;
    const hasContent =
      !!generatedImageUrl ||
      !!textValue.trim() ||
      initials.slice(0, monogramCount).some((v) => v) ||
      borderStyle !== "none" ||
      (canvasShape === "brick" && Object.values(brickSlots).some((v) => !!v?.url)) ||
      imageMode === "none";
    if (!hasContent) {
      setPreviewUrl(null);
      return;
    }
    setIsBuildingPreview(true);
    const t = setTimeout(async () => {
      try {
        const canvas = await buildComposite(512, false);
        if (!cancelled) setPreviewUrl(canvas.toDataURL("image/png"));
      } catch (e) {
        console.warn("Live preview failed", e);
      } finally {
        if (!cancelled) setIsBuildingPreview(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewDepKey]);

  // Pick the closest "ivory/cream" thread from the active brand palette.
  function pickIvoryThread(): typeof palette[number] | null {
    if (!palette.length) return null;
    const preferNames = ["ivory", "cream", "ecru", "off white", "antique white", "white"];
    for (const term of preferNames) {
      const m = palette.find(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.family ?? "").toLowerCase().includes(term),
      );
      if (m) return m;
    }
    // Fall back to nearest hex match to a target ivory.
    const target = { r: 0xf2, g: 0xe9, b: 0xd4 };
    const toRgb = (hex: string) => {
      const h = hex.replace("#", "");
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      };
    };
    let best = palette[0];
    let bestD = Infinity;
    for (const p of palette) {
      const c = toRgb(p.hex);
      const d =
        (c.r - target.r) ** 2 + (c.g - target.g) ** 2 + (c.b - target.b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // ===== My Designs library (save/load/delete) =====
  //
  // buildDesignSnapshot/applyDesignSnapshot deliberately mirror the SAME
  // field list as the existing localStorage draft autosave below (kept as a
  // separate, parallel set of functions rather than refactored to share code
  // with the already-working draft effects, to avoid risking a regression in
  // that working autosave path for the sake of a small amount of duplication).

  function buildDesignSnapshot() {
    return {
      openStep, activeTab, threadBrand,
      textValue, textFontId, textColor, textShadowColor, textRotation, textLetterSpacing,
      initials, initialColors, monogramCount, monogramStyle, monogramShadowColor, monogramRotation,

      textPos, monogramPos, textAlign, textWrapEnabled, textBoxWidthFrac, placedMotifs,
      borderStyle, borderColors,
      canvasShape, meshCount, finishedWidth, finishedHeight,
      imageMode, userText, styleId, brickPatternMode, brickSlots, brickSlotPrompts,
      generatedImageUrl, imageRect,
      isPortrait, orderAcknowledged,
      maxColours, shading,
      brightness, saturation, contrast,
    };
  }

  function applyDesignSnapshot(d: Record<string, unknown>) {
    if (d.openStep !== undefined) setOpenStep(d.openStep as string);
    if (d.activeTab !== undefined) setActiveTab(d.activeTab as string);
    if (d.threadBrand !== undefined) setThreadBrand(d.threadBrand as ThreadBrand | null);
    if (d.textValue !== undefined) setTextValue(d.textValue as string);
    if (d.textFontId !== undefined) setTextFontId(d.textFontId as string);
    if (d.textColor !== undefined) setTextColor(d.textColor as string | null);
    if (d.initials !== undefined) setInitials(d.initials as string[]);
    if (d.initialColors !== undefined) setInitialColors(d.initialColors as (string | null)[]);
    if (d.monogramCount !== undefined) setMonogramCount(d.monogramCount as 1 | 2 | 3);
    if (d.monogramStyle !== undefined) setMonogramStyle(d.monogramStyle as MonogramStyleId);
    if (d.textShadowColor !== undefined) setTextShadowColor(d.textShadowColor as string | null);
    if (d.monogramShadowColor !== undefined) setMonogramShadowColor(d.monogramShadowColor as string | null);
    if (d.textRotation !== undefined) setTextRotation(d.textRotation as Quarter);
    if (d.textLetterSpacing !== undefined) setTextLetterSpacing(d.textLetterSpacing as number);
    if (d.monogramRotation !== undefined) setMonogramRotation(d.monogramRotation as Quarter);

    if (d.textPos !== undefined) setTextPos(d.textPos as { x: number; y: number });
    if (d.textAlign !== undefined) setTextAlign(d.textAlign as "left" | "center" | "right");
    if (d.textWrapEnabled !== undefined) setTextWrapEnabled(d.textWrapEnabled as boolean);
    if (d.textBoxWidthFrac !== undefined) setTextBoxWidthFrac(d.textBoxWidthFrac as number);
    if (d.monogramPos !== undefined) setMonogramPos(d.monogramPos as { x: number; y: number });
    if (d.placedMotifs !== undefined) setPlacedMotifs(d.placedMotifs as PlacedMotif[]);
    if (d.borderStyle !== undefined) setBorderStyle(d.borderStyle as BorderStyleId);
    if (d.borderColors !== undefined) setBorderColors(d.borderColors as Record<BorderStyleId, (string | null)[]>);
    if (d.canvasShape !== undefined) setCanvasShape(d.canvasShape as CanvasShape);
    if (d.meshCount !== undefined) setMeshCount(d.meshCount as number);
    if (d.finishedWidth !== undefined) setFinishedWidth(d.finishedWidth as string);
    if (d.finishedHeight !== undefined) setFinishedHeight(d.finishedHeight as string);
    if (d.imageMode !== undefined) setImageMode(d.imageMode as "generate" | "upload" | "none");
    if (d.userText !== undefined) setUserText(d.userText as string);
    if (d.styleId !== undefined) setStyleId(d.styleId as string);
    if (d.brickPatternMode !== undefined) setBrickPatternMode(d.brickPatternMode as BrickPatternMode);
    else if (d.brickMode !== undefined) setBrickPatternMode("uniform"); // legacy "sceneWrap"/"allOver" both collapse to uniform
    if (d.brickSlots !== undefined) setBrickSlots(d.brickSlots as Partial<Record<BrickSlotKind, { url: string; repeats: number; contentMode?: BrickSlotContentMode }>>);
    if (d.brickSlotPrompts !== undefined) setBrickSlotPrompts(d.brickSlotPrompts as Record<string, string>);
    if (d.generatedImageUrl !== undefined) setGeneratedImageUrl(d.generatedImageUrl as string | null);
    if (d.imageRect !== undefined) setImageRect(d.imageRect as NormRect | null);
    if (d.isPortrait !== undefined) setIsPortrait(d.isPortrait as boolean);
    if (d.orderAcknowledged !== undefined) setOrderAcknowledged(d.orderAcknowledged as boolean);
    if (d.maxColours !== undefined) { setMaxColours(d.maxColours as number); setMaxColoursTouched(true); }
    if (d.shading !== undefined) setShading(d.shading as "none" | "light" | "medium" | "heavy");
    if (d.brightness !== undefined) setBrightness(d.brightness as number);
    if (d.saturation !== undefined) setSaturation(d.saturation as number);
    if (d.contrast !== undefined) setContrast(d.contrast as number);
  }

  async function refreshMyDesigns() {
    if (!user) { setMyDesigns([]); return; }
    setMyDesignsLoading(true);
    const { data } = await supabase
      .from("designs")
      .select("id, name, thumbnail_url, updated_at")
      .order("updated_at", { ascending: false });
    setMyDesigns((data as DesignSummary[]) ?? []);
    setMyDesignsLoading(false);
  }

  function handleOpenMyDesigns() {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    setMyDesignsOpen(true);
    refreshMyDesigns();
  }

  async function saveDesign(name: string, forceNew: boolean = false) {
    if (!user) return;
    let thumbnail_url: string | null = null;
    try {
      // Thumbnail reflects the actual charted stitch data, not the pre-chart
      // AI-generated source image -- see renderChartThumbnail's own comment.
      // Falls back to the old generated-image composite only in the
      // (shouldn't-happen-but-defensive) case chartData is somehow null when
      // a design is being saved.
      const thumbCanvas = chartData
        ? renderChartThumbnail(chartData, 256)
        : await buildComposite(256, false);
      thumbnail_url = await uploadCanvasToDesigns(thumbCanvas);
    } catch (e) {
      console.warn("Could not build design thumbnail", e);
    }
    const row = {
      user_id: user.id,
      name,
      chart_data: chartData as unknown as Json,
      design_meta: buildDesignSnapshot() as unknown as Json,
      thumbnail_url,
      stitch_progress: progressGrid ? serializeProgress(gridToSnapshot(progressGrid)) : null,
    };
    // forceNew=true is "Save as New" -- always take the INSERT path so the
    // user gets a fresh row, regardless of whether a design is currently
    // loaded. Plain Save (forceNew=false) updates the loaded design when
    // one is loaded, otherwise inserts.
    try {
      if (currentDesignId && !forceNew) {
        const { error } = await supabase
          .from("designs")
          .update(row)
          .eq("id", currentDesignId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("designs")
          .insert(row)
          .select("id")
          .single();
        if (error) throw error;
        if (data) setCurrentDesignId(data.id);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`Could not save design: ${msg}`);
      throw e;
    }
    setCurrentDesignName(name);
    refreshMyDesigns();
  }

  async function loadDesign(id: string) {
    const { data, error } = await supabase.from("designs").select("*").eq("id", id).single();
    if (error || !data) return;
    applyDesignSnapshot((data.design_meta as Record<string, unknown>) ?? {});
    const loadedChart = data.chart_data as unknown as ChartData | null;
    setChartData(loadedChart);
    chartBaseRef.current = loadedChart;
    lastCompositeRef.current = loadedChart;
    setCurrentDesignId(data.id);
    setCurrentDesignName(data.name);
    // Load + reconcile stitch progress against the loaded chart's actual
    // dimensions -- a resize between save and load can't be auto-mapped
    // (positional progress, see progress-persistence.ts), so that case falls
    // back to a fresh empty grid rather than trusting a mis-mapped count.
    if (loadedChart) {
      let nextProgress = makeProgressGrid(loadedChart.width, loadedChart.height);
      if (data.stitch_progress) {
        try {
          const loadedSnapshot = deserializeProgress(data.stitch_progress);
          const result = reconcileProgress(loadedSnapshot, {
            width: loadedChart.width,
            height: loadedChart.height,
          });
          if (result.ok && result.snapshot) nextProgress = snapshotToGrid(result.snapshot);
        } catch (e) {
          console.warn("Could not load stitch progress", e);
        }
      }
      setProgressGrid(nextProgress);
    } else {
      setProgressGrid(null);
    }
    setMyDesignsOpen(false);
    setActiveTab("canvas");
  }

  async function deleteDesignById(id: string): Promise<{ error: string | null }> {
    const { error } = await supabase.from("designs").delete().eq("id", id);
    if (error) {
      // ON DELETE RESTRICT on orders.design_id -- surface a clear message
      // rather than a raw Postgres error if this design has an order on it.
      const msg = error.message.includes("foreign key")
        ? "This design has an order on it, so it can't be deleted."
        : error.message;
      return { error: msg };
    }
    if (id === currentDesignId) {
      setCurrentDesignId(null);
      setCurrentDesignName("");
    }
    refreshMyDesigns();
    return { error: null };
  }

  // An order needs a design_id (the orders table requires one, not null) --
  // so ordering an unsaved design is refused with a clear message rather
  // than silently auto-saving it under a name the user didn't choose.
  // order_details is a snapshot of the finishing spec AT ORDER TIME (shape,
  // size, mesh, brand, portrait acknowledgement) -- deliberately NOT wired to
  // any payment step yet (none exists); this only records order intent/status.
  async function handlePlaceOrder() {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    if (!currentDesignId) {
      setOrderError('Please save your design first -- use "My Designs" or "Finish & Save Chart" on the Stitch Chart tab.');
      return;
    }
    setOrderError(null);
    setPlacingOrder(true);
    const { error } = await supabase.from("orders").insert({
      user_id: user.id,
      design_id: currentDesignId,
      order_details: {
        canvasShape,
        meshCount,
        finishedWidthInches: canvasDims.width,
        finishedHeightInches: canvasDims.height,
        threadBrand,
        isPortrait,
        orderAcknowledged,
      } as unknown as Json,
    });
    setPlacingOrder(false);
    if (error) {
      setOrderError(error.message);
      return;
    }
    setOrderPlaced(true);
  }

  // ===== Motif Library layers: non-destructive border/text/monogram =====
  //
  // Replaces the old destructive stampBorderOnChart/stampTextOnChart path.
  // chartBaseRef holds the pre-overlay base (blank ivory fill, or the raw
  // image chart from the edge function -- border still server-baked there,
  // unchanged). lastCompositeRef holds the exact composite StitchChart was
  // last shown/editing. Whenever a layer-affecting input changes (text
  // content/colour/position, monogram, border) AFTER a chart already exists,
  // mergeManualEdit first folds any manual paint/select edits the user made
  // into chartBaseRef, THEN the new layer positions are composited on top --
  // so repositioning text never discards a manual edit, and painting over a
  // letter permanently sticks even after the letter later moves elsewhere.
  //
  // Distinct sentinel from NOT_STITCHABLE on purpose (see canvas-shape-mask.ts):
  // this one means "this layer doesn't touch this cell", not "outside the
  // finished shape" -- the two concerns are unrelated and must never collide.
  const LAYER_SENTINEL = "__LAYER_TRANSPARENT__";
  const chartBaseRef = useRef<ChartData | null>(null);
  // The exact Layer[] that produced lastCompositeRef. Edit attribution must
  // run against THESE, not freshly-rebuilt layers -- a rebuild would already
  // reflect the new positions and would mis-attribute every moved cell.
  const lastLayersRef = useRef<Layer[] | null>(null);
  const maxColoursBeforeEditRef = useRef<number | null>(null);
  const lastCompositeRef = useRef<ChartData | null>(null);
  const chartDataRef = useRef<ChartData | null>(null);
  useEffect(() => {
    chartDataRef.current = chartData;
  }, [chartData]);

  // Thread stash for shopping-list substitution hints. Same shape of fetch as
  // refreshMyDesigns above (RLS scopes it to the signed-in user).
  useEffect(() => {
    if (!user) {
      setStash([]);
      return;
    }
    let cancelled = false;
    listStash().then(({ rows }) => {
      if (!cancelled) setStash(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);


  // Debounced stitch-progress autosave -- only once a design has actually
  // been saved (progress needs a design_id to attach to, same constraint as
  // orders). A longer debounce than the local draft's 400ms since this is a
  // real database write, not localStorage, and progress can update rapidly
  // during a drag in the Progress tool.
  useEffect(() => {
    if (!currentDesignId || !progressGrid) return;
    const t = setTimeout(async () => {
      const serialized = serializeProgress(gridToSnapshot(progressGrid));
      await supabase.from("designs").update({ stitch_progress: serialized }).eq("id", currentDesignId);
    }, 1500);
    return () => clearTimeout(t);
  }, [progressGrid, currentDesignId]);

  function buildOverlayLayers(
    gridW: number,
    gridH: number,
    includeBorder: boolean,
    motifsOverride?: PlacedMotif[],
  ): Layer[] {
    const layers: Layer[] = [];
    if (includeBorder) {
      const supportedBorderStyles = ["simple", "double", "poppy", "flowers", "ladder", "interlock", "spades", "small-flowers", "scandi-double", "oak-and-acorn", "scalloped-tulips"];
      if (supportedBorderStyles.includes(borderStyle)) {
        const fallbackBorderColor = "#3B4F35";
        // Non-rectangular canvases pass the real shape mask so borderToLayer
        // follows the shape instead of insetting a rectangle. Rectangle
        // passes undefined explicitly -- borderToLayer's internal
        // isUnrestricted() check treats that identically to "no mask", so
        // rectangle behaviour is provably unchanged.
        const borderShapeMask = canvasShape === "rectangle"
          ? undefined
          : shapeMask(canvasShape, gridW, gridH, canvasDims.width, canvasDims.height);
        const bl = borderToLayer(
          "border",
          { style: borderStyle, colors: borderColors[borderStyle].map((c) => c ?? fallbackBorderColor) },
          gridW, gridH, palette, LAYER_SENTINEL,
          borderShapeMask,
        );
        if (bl) layers.push(bl);
      }
    }
    // Placed motifs, bottom-to-top in array order. Above the border (§11.7:
    // a motif may render in front of the border; only background sits under
    // it), below text/monogram so lettering stays legible on top.
    const motifList = motifsOverride ?? placedMotifs;
    for (const pm of motifList) {
      // Rotation is lossless (rotateCells is pure reindexing). Offset stays
      // as stored -- unlike text there's no centring to redo, but note the
      // footprint width/height swap when the rotation is 90 or 270.
      const rotatedCells = rotateCells(pm.cells, pm.rotation ?? 0);
      layers.push(
        makeLayer({
          id: `placed-${pm.instanceId}`,
          kind: "motif",
          cells: rotatedCells,
          offset: pm.offset,
          scale: pm.scale,
        }),
      );
    }
    const tl = textToLayer(
      "text",
      {
        text: textValue,
        fontCss: textFont.css,
        color: textColor,
        align: textAlign,
        boxWidthCells: textWrapEnabled ? Math.round(textBoxWidthFrac * gridW) : undefined,
        fontId: textFontId === "default" ? null : textFontId,
        shadowColor: textShadowColor,
        rotation: textRotation,
        letterSpacing: textLetterSpacing,

      },
      gridW, gridH, palette, LAYER_SENTINEL, textPos,
    );
    if (tl) layers.push(tl);
    const ml = monogramToLayer(
      "mono",
      {
        initials, colors: initialColors, count: monogramCount, fontCss: currentMonogramFont,
        fontId: monogramStyle === "m1" ? null : monogramStyle,
        shadowColor: monogramShadowColor,
        rotation: monogramRotation,
      },

      gridW, gridH, palette, LAYER_SENTINEL, monogramPos,
    );
    if (ml) layers.push(ml);
    return layers;
  }

  // Composite the current layers onto `base` and apply the canvas-shape mask
  // -- the single path both the initial "Generate Chart" click and every
  // subsequent live reposition go through, so they can never disagree.
  // Phase B: ownership-aware fold of manual edits, replacing the bare
  // mergeManualEdit call every recompose site used to make. Each changed
  // cell is attributed to whichever layer owns it -- the same top-down
  // traversal hitTest uses for selection, so selection, rendering and
  // edit-attribution can never disagree.
  //   * owned by a placed motif   -> written into that motif's OWN cells, so
  //                                  the edit travels with it when it moves
  //   * owned by border/text/mono -> counted and dropped. Rebuilt from
  //                                  config every recompose so the edit
  //                                  cannot persist -- but must NOT fall
  //                                  back to the base, which is exactly what
  //                                  destroyed the border stitches.
  //   * owned by nothing          -> written into the base, as before
  function foldManualEdits(motifs: PlacedMotif[]): { base: ChartData; motifs: PlacedMotif[] } {
    const base = chartBaseRef.current!;
    const lastComposite = lastCompositeRef.current!;
    const edited = chartDataRef.current!;
    const layers = lastLayersRef.current;
    if (!layers) {
      // No captured layers (first recompose after load) -- fall back to the
      // original positional merge rather than guessing ownership.
      return { base: mergeManualEdit(base, lastComposite, edited), motifs };
    }
    const result = mergeManualEditAttributed(base, lastComposite, edited, layers, LAYER_SENTINEL);
    let nextMotifs = motifs;
    if (result.layerEdits.size > 0) {
      nextMotifs = motifs.map((pm) => {
        const edits = result.layerEdits.get(`placed-${pm.instanceId}`);
        if (!edits || edits.length === 0) return pm;
        // Layer cells are ROTATED; map each edit back to the motif's native
        // cell before writing.
        const deg = pm.rotation ?? 0;
        const nh = pm.height, nw = pm.width;
        const cells = pm.cells.map((row) => row.slice());
        for (const e of edits) {
          let nr: number, nc: number;
          if (deg === 0) { nr = e.row; nc = e.col; }
          else if (deg === 180) { nr = nh - 1 - e.row; nc = nw - 1 - e.col; }
          else if (deg === 90) { nr = nh - 1 - e.col; nc = e.row; }
          else { nr = e.col; nc = nw - 1 - e.row; }
          if (nr < 0 || nc < 0 || nr >= nh || nc >= nw) continue;
          cells[nr][nc] = e.code;
        }
        return { ...pm, cells };
      });
    }
    if (result.discardedOnRebuiltLayers > 0 || result.refusedOnScaledLayers > 0) {
      console.log("manual-edit attribution:", JSON.stringify({
        touched: result.touched,
        intoLayers: result.layerEdits.size,
        discardedOnRebuiltLayers: result.discardedOnRebuiltLayers,
        refusedOnScaledLayers: result.refusedOnScaledLayers,
      }));
    }
    return { base: result.base, motifs: nextMotifs };
  }

  function recomposeChart(
    base: ChartData,
    includeBorder: boolean,
    motifsOverride?: PlacedMotif[],
  ): ChartData {
    const layers = buildOverlayLayers(base.width, base.height, includeBorder, motifsOverride);
    lastLayersRef.current = layers;
    const composited = applyLayersToChart(base, layers, palette, LAYER_SENTINEL);
    return applyCanvasShapeMask(composited, canvasShape, canvasDims.width, canvasDims.height);
  }


  async function refreshMotifs() {
    if (!threadBrand) return;
    setMotifsLoading(true);
    setMotifsError(null);
    const { mine, preloaded, error } = await listMotifs(threadBrand);
    setMotifsMine(mine);
    setMotifsPreloaded(preloaded);
    if (error) setMotifsError(error);
    setMotifsLoading(false);
  }

  function handleOpenMotifLibrary() {
    setMotifPickMode(false);
    setMotifLibraryOpen(true);
    refreshMotifs();
  }

  function handleOpenMotifPicker() {
    setMotifPickMode(true);
    setMotifLibraryOpen(true);
    refreshMotifs();
  }

  function handleMotifPicked(motif: MotifRecord) {
    setTileFillMotif(motif);
    setMotifLibraryOpen(false);
    setMotifPickMode(false);
  }

  function handleAddMotifToChart(motif: MotifRecord) {
    if (!chartBaseRef.current || !lastCompositeRef.current || !chartDataRef.current) return;
    const includeBorder = true; // borders are stamped client-side in every mode (single authority)
    const folded = foldManualEdits(placedMotifs);
    const updatedBase = folded.base;
    // Place the motif as a live layer rather than baking it in -- keeps its
    // identity so it can be moved/reordered/removed later (§11.7). Centre it
    // by default using the same math insertMotifIntoChart used to.
    const offset = centeredOffset(motif, updatedBase.width, updatedBase.height, 1);
    const newMotif: PlacedMotif = {
      instanceId: `${motif.id}-${Date.now()}`,
      name: motif.name,
      cells: motif.cells,
      width: motif.width,
      height: motif.height,
      offset,
      scale: 1,
      rotation: 0,
    };
    const nextMotifs = [...folded.motifs, newMotif];
    setPlacedMotifs(nextMotifs);
    const next = recomposeChart(updatedBase, includeBorder, nextMotifs);
    chartBaseRef.current = updatedBase;
    lastCompositeRef.current = next;
    setChartData(next);
    setMotifLibraryOpen(false);
  }

  // All four of these mutate the live (unflattened) placed-motif list, which
  // means the visible/saved chart pixels must be re-baked from the SAME base
  // via recomposeChart -- otherwise chartData silently drifts out of sync
  // with placedMotifs. This is exactly the pattern handleAddMotifToChart and
  // flattenPlacedMotif already use; these four were missing it, which is why
  // a move/remove/reorder/rotate looked applied (the live drag-ghost in
  // StitchChart's Motifs-mode canvas render made it LOOK committed) but
  // reverted the instant the chart left Motifs mode, was saved, or reloaded
  // -- chartData, the thing actually persisted, was never updated.
  //
  // mergeManualEdit first folds any manual paint/select/etc. edits already
  // present in chartData into the base, so those aren't lost either -- same
  // reasoning as every other recompose call site in this file.
  function recomposePlacedMotifs(nextMotifs: PlacedMotif[]) {
    if (!chartBaseRef.current || !lastCompositeRef.current || !chartDataRef.current) {
      setPlacedMotifs(nextMotifs);
      return;
    }
    const includeBorder = true; // borders are stamped client-side in every mode (single authority)
    // Fold against the OLD list (placedMotifs) -- that's what actually
    // produced lastCompositeRef -- then carry any freshly-attributed cell
    // edits onto nextMotifs (the NEW positions/rotation/etc.) by instanceId,
    // since nextMotifs and folded.motifs each hold half of what's needed.
    const folded = foldManualEdits(placedMotifs);
    const updatedBase = folded.base;
    const editedById = new Map(folded.motifs.map((m) => [m.instanceId, m]));
    const merged = nextMotifs.map((m) => {
      const e = editedById.get(m.instanceId);
      return e ? { ...m, cells: e.cells } : m;
    });
    setPlacedMotifs(merged);
    const next = recomposeChart(updatedBase, includeBorder, merged);
    chartBaseRef.current = updatedBase;
    lastCompositeRef.current = next;
    setChartData(next);
  }

  function movePlacedMotif(instanceId: string, offset: { x: number; y: number }) {
    recomposePlacedMotifs(
      placedMotifs.map((m) => (m.instanceId === instanceId ? { ...m, offset } : m)),
    );
  }
  function removePlacedMotif(instanceId: string) {
    recomposePlacedMotifs(placedMotifs.filter((m) => m.instanceId !== instanceId));
  }
  // Z-order within the placed-motif band. Array order IS stack order (later
  // = on top), matching how buildOverlayLayers pushes them.
  function reorderPlacedMotif(instanceId: string, direction: "forward" | "backward") {
    const cur = placedMotifs;
    const i = cur.findIndex((m) => m.instanceId === instanceId);
    if (i < 0) return;
    const j = direction === "forward" ? i + 1 : i - 1;
    if (j < 0 || j >= cur.length) return;
    const next = cur.slice();
    [next[i], next[j]] = [next[j], next[i]];
    recomposePlacedMotifs(next);
  }
  // Quarter-turn rotation: 0 -> 90 -> 180 -> 270 -> 0. Old saves may lack
  // the field entirely; treat missing as 0.
  function rotatePlacedMotif(instanceId: string) {
    recomposePlacedMotifs(
      placedMotifs.map((m) => {
        if (m.instanceId !== instanceId) return m;
        const curRot = (m.rotation ?? 0) as Quarter;
        const next: Quarter = curRot === 0 ? 90 : curRot === 90 ? 180 : curRot === 180 ? 270 : 0;
        return { ...m, rotation: next };
      }),
    );
  }
  // Integer scale multiplier per placed motif -- same recompose-on-change
  // pattern as move/rotate. Clamped to a sane range; 1 is "as charted", higher
  // values are a simple integer upscale (each source cell becomes an NxN
  // block), matching how scale already works when flattening.
  function resizePlacedMotif(instanceId: string, scale: number) {
    const clamped = Math.max(1, Math.min(10, Math.round(scale)));
    recomposePlacedMotifs(
      placedMotifs.map((m) => (m.instanceId === instanceId ? { ...m, scale: clamped } : m)),
    );
  }

  // Flatten: bake this motif permanently into the base and drop its identity.
  // Deliberately explicit (Delaney's choice) rather than auto-flattening on
  // paint -- until flattened, a live motif always re-composites ON TOP of the
  // base, so painting "over" it would otherwise appear to do nothing.
  function flattenPlacedMotif(instanceId: string) {
    if (!chartBaseRef.current || !lastCompositeRef.current || !chartDataRef.current) return;
    const target = placedMotifs.find((m) => m.instanceId === instanceId);
    if (!target) return;
    const includeBorder = true; // borders are stamped client-side in every mode (single authority)
    const folded = foldManualEdits(placedMotifs);
    const updatedBase = folded.base;
    // Use the post-fold version of the target motif, so any edit attributed
    // to it a moment ago is included in what gets baked in, not lost.
    const foldedTarget = folded.motifs.find((m) => m.instanceId === instanceId) ?? target;
    const layer = makeLayer({
      id: `placed-${foldedTarget.instanceId}`,
      kind: "motif",
      cells: rotateCells(foldedTarget.cells, foldedTarget.rotation ?? 0),
      offset: foldedTarget.offset,
      scale: foldedTarget.scale,
    });
    const bakedBase = applyLayersToChart(updatedBase, [layer], palette, LAYER_SENTINEL);
    const remaining = folded.motifs.filter((m) => m.instanceId !== instanceId);
    setPlacedMotifs(remaining);
    // Recompose explicitly with the remaining motif list so the flattened one
    // isn't drawn twice from a stale closure this render.
    const next = recomposeChart(bakedBase, includeBorder, remaining);
    chartBaseRef.current = bakedBase;
    lastCompositeRef.current = next;
    setChartData(next);
  }


  function handleTileFillCanvas(motif: MotifRecord) {
    if (!chartBaseRef.current || !lastCompositeRef.current || !chartDataRef.current) return;
    if (!window.confirm(`Tile-fill the entire canvas with "${motif.name}"? This replaces everything currently on the chart.`)) return;
    const includeBorder = true; // borders are stamped client-side in every mode (single authority)
    const folded = foldManualEdits(placedMotifs);
    const updatedBase = folded.base;
    if (folded.motifs !== placedMotifs) setPlacedMotifs(folded.motifs);
    const layer = tileFillWholeCanvas(`tile-${motif.id}`, motif, updatedBase.width, updatedBase.height, LAYER_SENTINEL);
    const bakedBase = applyLayersToChart(updatedBase, [layer], palette, LAYER_SENTINEL);
    const next = recomposeChart(bakedBase, includeBorder);
    chartBaseRef.current = bakedBase;
    lastCompositeRef.current = next;
    setChartData(next);
    setMotifLibraryOpen(false);
  }

  function handleTileFillApply(region: number[], scale: number) {
    if (!tileFillMotif) return;
    if (!chartBaseRef.current || !lastCompositeRef.current || !chartDataRef.current) return;
    if (region.length === 0) return;
    const includeBorder = true; // borders are stamped client-side in every mode (single authority)
    const folded = foldManualEdits(placedMotifs);
    const updatedBase = folded.base;
    if (folded.motifs !== placedMotifs) setPlacedMotifs(folded.motifs);
    const layer = buildTileFillLayer(
      `tile-region-${tileFillMotif.id}-${Date.now()}`,
      tileFillMotif,
      updatedBase.width,
      updatedBase.height,
      new Set(region),
      LAYER_SENTINEL,
      undefined,
      scale,
    );
    const bakedBase = applyLayersToChart(updatedBase, [layer], palette, LAYER_SENTINEL);
    const next = recomposeChart(bakedBase, includeBorder);
    chartBaseRef.current = bakedBase;
    lastCompositeRef.current = next;
    setChartData(next);
  }

  // Save the current Select/Lasso selection to the user's personal Motif
  // Library. StitchChart owns extraction (which cells, in what shape); this
  // function owns everything StitchChart doesn't have: auth, brand context,
  // naming, and the actual Supabase write via saveMotif() (motif-library.ts).
  // Deliberately a plain window.prompt/window.alert flow, not a new dialog
  // component -- consistent with the existing window.confirm used for Tile
  // Fill's "replace the whole canvas" guard just above, and a proper naming
  // UI can replace this later without changing the underlying save path.
  async function handleSaveAsMotif(cells: (ChartPaletteEntry | null)[], w: number, h: number) {
    if (!user) {
      window.alert("Sign in to save motifs to your library.");
      return;
    }
    if (!threadBrand) {
      window.alert("Choose a thread brand first so the motif is saved in the right library.");
      return;
    }
    const name = window.prompt("Name this motif:");
    if (!name || !name.trim()) return;
    const { error } = await saveMotif(name.trim(), threadBrand, w, h, cells, LAYER_SENTINEL, user.id);
    if (error) {
      window.alert(`Couldn't save motif: ${error}`);
      return;
    }
    window.alert(`Saved "${name.trim()}" to your Motif Library.`);
  }

  // Live reposition: fires whenever a layer-affecting input changes AFTER a
  // chart already exists (chartBaseRef is only set once "Generate Chart" has
  // run at least once -- before that, the raster preview already handles the
  // live-updating experience, and this effect stays a no-op).
  useEffect(() => {
    if (!chartBaseRef.current || !lastCompositeRef.current || !chartDataRef.current) return;
    const includeBorder = true; // borders are stamped client-side in every mode (single authority)
    const folded = foldManualEdits(placedMotifs);
    const updatedBase = folded.base;
    if (folded.motifs !== placedMotifs) setPlacedMotifs(folded.motifs);
    const next = recomposeChart(updatedBase, includeBorder);
    chartBaseRef.current = updatedBase;
    lastCompositeRef.current = next;
    setChartData(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    textValue, textColor, textShadowColor, textRotation, textLetterSpacing, textPos, textAlign, textWrapEnabled, textBoxWidthFrac,
    initials, initialColors, monogramCount, monogramShadowColor, monogramRotation, monogramPos,
    borderStyle, borderColors[borderStyle], placedMotifs,
  ]);

  // Apply the non-rectangular canvas mask to a finished chart: writes
  // NOT_STITCHABLE into every cell outside the finished shape. No-op for
  // "rectangle" (shapeMask returns an all-true mask, so applyShapeMask writes
  // nothing) -- existing rectangle-canvas behaviour is completely unaffected.
  function applyCanvasShapeMask(
    chartToMask: ChartData,
    shape: CanvasShape,
    widthInches: number,
    heightInches: number,
  ): ChartData {
    if (shape === "rectangle") return chartToMask;
    const mask = shapeMask(shape, chartToMask.width, chartToMask.height, widthInches, heightInches);
    const grid = chartToCodeGrid(chartToMask);
    applyShapeMask(grid, mask);
    const entryByCode = new Map(chartToMask.palette.map((p) => [p.id, p]));
    if (!entryByCode.has(NOT_STITCHABLE)) {
      entryByCode.set(NOT_STITCHABLE, {
        id: NOT_STITCHABLE,
        name: "Not Stitchable",
        family: "Not Stitchable",
        hex: "#FFFFFF",
      });
    }
    return codeGridToChart(grid, (code) => entryByCode.get(code));
  }

  // Detail-fit gate. Runs once per click: if the artwork carries more detail
  // than the chosen stitch count can resolve, offer the choice before
  // spending a generation rather than after. Bypassed by detailAck (set when
  // the user chooses "chart it anyway"), and never blocks -- it is advice.
  const [detailWarning, setDetailWarning] = useState<
    { fit: DetailFit; currentStitches: number; suggestion: { mesh: number; inches: number; stitches: number } | null } | null
  >(null);
  const [detailAck, setDetailAck] = useState(false);

  const handleGenerateChart = async () => {
    if (!threadBrand) return;
    const w = Math.round(canvasDims.width * meshCount);
    const h = Math.round(canvasDims.height * meshCount);
    if (!detailAck && generatedImageUrl && w > 0 && h > 0) {
      const probe = new Image();
      probe.crossOrigin = "anonymous";
      const ready = await new Promise<boolean>((res) => {
        probe.onload = () => res(true);
        probe.onerror = () => res(false);
        probe.src = generatedImageUrl;
      });
      if (ready) {
        const fit = assessDetailFit(probe, w, h);
        if (fit?.warn) {
          const aspect = (canvasDims.width || 1) / (canvasDims.height || 1);
          const better = findBetterFit(probe, aspect, [108, 126, 144, 162, 180, 216, 252]);
          let suggestion: { mesh: number; inches: number; stitches: number } | null = null;
          if (better) {
            // Prefer the smallest physical canvas that reaches the needed
            // stitch count on an available mesh, so the advice is the least
            // disruptive change rather than simply "make it huge".
            const options: { mesh: number; inches: number; stitches: number }[] = [];
            for (const m of [12, 13, 14, 18]) {
              const inches = Math.ceil((better / m) * 2) / 2;
              options.push({ mesh: m, inches, stitches: Math.round(inches * m) });
            }
            options.sort((a, b) => a.inches - b.inches || b.mesh - a.mesh);
            suggestion = options[0];
          }
          setDetailWarning({ fit, currentStitches: w, suggestion });
          return;
        }
      }
    }
    if (!(w > 0) || !(h > 0)) {
      setChartError("Set a finished width, height, and mesh count first.");
      return;
    }

    // Brick artwork lives in brickSlots, not generatedImageUrl — don't fall
    // into the blank-canvas branch when real brick panels exist.
    const hasBrickArt = canvasShape === "brick" && Object.values(brickSlots).some((v) => !!v?.url);

    // Blank-canvas mode: build the chart entirely in the app, no edge call.
    if ((imageMode === "none" || !generatedImageUrl) && !hasBrickArt) {
      const ivory = pickIvoryThread();
      if (!ivory) {
        setChartError("Choose a thread brand first so we can pick an ivory shade.");
        return;
      }
      setIsCharting(true);
      setChartError(null);
      setChartData(null);
      try {
        const blank = buildBlankChart(w, h, ivory);
        const finalChart = recomposeChart(blank, true);
        chartBaseRef.current = blank;
        lastCompositeRef.current = finalChart;
        setChartData(finalChart);
        setProgressGrid(makeProgressGrid(finalChart.width, finalChart.height));
      } catch (err) {
        console.error(err);
        setChartError("Sorry, we couldn't build your blank chart. Please try again.");
      } finally {
        setIsCharting(false);
      }
      return;
    }


    setIsCharting(true);
    setChartError(null);
    setChartData(null);
    try {
      const fallbackBorderColor = "#3B4F35";
      // Build the EXACT image (cropped, tuned, at canvas aspect) the live
      // preview is showing — image only, no border/text/monogram (those are
      // stamped client-side after the chart returns). This is the single
      // source of truth: the same `imageRect` drives preview and chart.
      let chartImageUrl = generatedImageUrl;
      try {
        const composed = await buildComposite(1024, true);
        chartImageUrl = await uploadCanvasToDesigns(composed);
      } catch (e) {
        console.warn("Falling back to raw image URL for chart", e);
      }
      // Brick charts have no generatedImageUrl to fall back on — bail out
      // rather than sending a null imageUrl to the edge function (it 400s).
      if (!chartImageUrl) {
        setChartError("Sorry, we couldn't build your brick composition. Please try again.");
        return;
      }
      // Uploads are classified rather than assumed — see input-type-detect.ts.
      // AI-generated images are always flat art by construction.
      const inputType: InputType =
        imageMode === "upload"
          ? (inputTypeOverride ?? detectedInputType?.inputType ?? "generated")
          : "generated";
      const chartPayload: Record<string, unknown> = {
        imageUrl: chartImageUrl,
        brand: threadBrand,
        mesh: meshCount,
        // TRUE canvas dims (stocking foot extent / fixed brick), plus the shape
        finishedWidthInches: canvasDims.width,
        finishedHeightInches: canvasDims.height,
        shape: canvasShape,
        shading,
        mode: styleId === "motif"
          ? "motif"
          : imageMode === "upload"
            ? "upload"
            : "scene",
        border: null, // border is stamped client-side after the chart returns (single authority; server stamp retired)
        inputType,
      };
      if (maxColoursTouched) chartPayload.maxColours = maxColours;
      const data = await callEdgeFunction<ChartData>("chart", chartPayload);
      const finalChart = recomposeChart(data, true);
      chartBaseRef.current = data;
      lastCompositeRef.current = finalChart;
      setChartData(finalChart);
      setProgressGrid(makeProgressGrid(finalChart.width, finalChart.height));
      // Reflect the ACTUAL colour count the chart settled on, not just what
      // was requested -- excludes the NOT_STITCHABLE mask sentinel, same as
      // the Colour Key already does. Marking it "touched" keeps the next
      // regenerate consistent with what's displayed.
      const realColourCount = finalChart.palette.filter((p) => p.id !== NOT_STITCHABLE).length;
      setMaxColours(realColourCount);
      setMaxColoursTouched(true);
    } catch (err) {
      console.error(err);
      setChartError(
        "Sorry, we couldn't generate your chart. Please try again in a moment.",
      );
    } finally {
      setIsCharting(false);
    }
  };

  const widthNum = parseFloat(finishedWidth) || 0;
  const heightNum = parseFloat(finishedHeight) || 0;
  const stitchGridWidth = Math.round(canvasDims.width * meshCount);
  const stitchGridHeight = Math.round(canvasDims.height * meshCount);
  const totalStitches = stitchGridWidth * stitchGridHeight;

  const needsBrandNotice = (
    <div className="rounded-md border border-dashed border-border bg-secondary/40 px-5 py-8 text-center text-sm italic text-muted-foreground">
      Choose a thread brand in Step 01 to unlock the palette for this section.
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <OrnamentFrame>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <div>
            <h1 className="text-4xl tracking-tight font-black" style={{ color: IVORY, fontFamily: "'IM Fell DW Pica SC', serif" }}>
              lanaria Studio
            </h1>
            <p className="mt-1 text-sm italic" style={{ color: IVORY, opacity: 0.85, fontFamily: "'IM Fell DW Pica SC', serif" }}>
              Design. Print. Create.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <NavMenu />
          </div>


        </div>
      </OrnamentFrame>


      <main className="mx-auto max-w-6xl px-6 py-10">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="mx-auto mb-10 grid w-full max-w-2xl grid-cols-3 bg-secondary/60 p-1">
            <TabsTrigger value="canvas" className="font-serif text-base">Canvas Design</TabsTrigger>
            <TabsTrigger value="chart" disabled={!canvasComplete} className="font-serif text-base">Stitch Chart</TabsTrigger>
            <TabsTrigger value="order" disabled={!chartData} className="font-serif text-base">Order</TabsTrigger>
          </TabsList>

          <TabsContent value="canvas" className="mt-0">
            <SectionHeading
              eyebrow="Step by step"
              title="Design your canvas"
              description="​"
            />
            <div className="mx-auto mt-4 flex max-w-3xl flex-wrap justify-end gap-x-2 gap-y-2">

              {draftSaved && (
                <span className="text-xs text-muted-foreground animate-fade-in mr-2 self-center">
                  Draft saved ✓
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenMyDesigns}
                className="border-primary/40 text-primary hover:bg-primary/10"
              >
                My Designs
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenMotifLibrary}
                className="border-primary/40 text-primary hover:bg-primary/10"
              >
                Browse Motif Library
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowResetDialog(true)}
                className="border-primary/40 text-primary hover:bg-primary/10"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Start New Design
              </Button>
            </div>

            {/* Sticky live design preview — visible throughout the design steps */}
            <div className="mx-auto mt-6 max-w-3xl sticky top-2 z-20">
              <div className="rounded-md border border-border bg-card/95 backdrop-blur p-3 shadow-sm">
                <div className="flex items-center gap-3">
                  <div
                    className="overflow-hidden rounded border border-border bg-secondary/40 shrink-0"
                    style={{
                      width: 88,
                      aspectRatio: `${canvasAspect}`,
                    }}
                  >
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt="Live design preview"
                        className="block h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[10px] italic text-muted-foreground text-center px-1">
                        {isBuildingPreview ? "…" : "Preview"}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      Live design preview
                    </p>
                    <p className="text-xs italic text-muted-foreground truncate">
                      Updates as you edit. This is exactly what becomes the chart.
                    </p>
                  </div>
                </div>
              </div>
            </div>


            <div className="mx-auto mt-8 max-w-3xl rounded-lg border border-border bg-card p-2 shadow-sm">
              <Accordion
                type="single"
                collapsible
                value={openStep}
                onValueChange={(v) => setOpenStep(v)}
                className="w-full"
              >
                {designSteps.map((step) => (
                  <AccordionItem
                    key={step.id}
                    value={step.id}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <AccordionTrigger className="px-4 py-5 text-base hover:no-underline">
                      <span className="flex items-baseline gap-4">
                        <span className="text-xs tracking-[0.2em] text-muted-foreground">
                          {step.number}
                        </span>
                        <span className="font-serif text-lg">{step.title}</span>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pb-6">
                      {step.id === "thread-brand" && (
                        <div className="space-y-4">
                          <p className="text-sm text-muted-foreground">
                            Select the thread brand you would like to use for your canvas.
                          </p>
                          <div className="grid grid-cols-2 gap-4">
                            <button
                              type="button"
                              onClick={() => setThreadBrand("appletons")}
                              className={`rounded-lg border px-5 py-6 text-left transition-colors ${
                                threadBrand === "appletons"
                                  ? "border-primary bg-primary/10"
                                  : "border-border bg-secondary/40 hover:bg-secondary/60"
                              }`}
                            >
                              <span className="block font-serif text-base font-semibold">
                                Appletons Wool
                              </span>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                Traditional British wool, rich colour range.
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setThreadBrand("dmc")}
                              className={`rounded-lg border px-5 py-6 text-left transition-colors ${
                                threadBrand === "dmc"
                                  ? "border-primary bg-primary/10"
                                  : "border-border bg-secondary/40 hover:bg-secondary/60"
                              }`}
                            >
                              <span className="block font-serif text-base font-semibold">
                                DMC Perle Cotton
                              </span>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                Lustrous twisted cotton, wide colour range. 
                              </span>
                            </button>
                          </div>
                          {threadBrand && (() => {
                            const families: Array<{ family: string; colors: ThreadColor[] }> = [];
                            const idx = new Map<string, number>();
                            for (const c of palette) {
                              const key = c.family ?? c.name;
                              let i = idx.get(key);
                              if (i === undefined) {
                                i = families.length;
                                idx.set(key, i);
                                families.push({ family: key, colors: [] });
                              }
                              families[i].colors.push(c);
                            }
                            return (
                              <div className="space-y-3">
                                <p className="text-sm italic text-muted-foreground">
                                  Selected: {threadBrand === "appletons" ? "Appletons Wool" : "DMC Perle Cotton"} ({families.length} families · {palette.length} colours)
                                </p>
                                <div
                                  className="rounded-md border p-3"
                                  style={{ background: "#F8F4EC", borderColor: "#8B6914", maxHeight: "420px", overflowY: "auto" }}
                                >
                                  {families.map(({ family, colors }) => (
                                    <div key={family} style={{ marginBottom: "10px" }}>
                                      <div
                                        style={{
                                          fontSize: "10px",
                                          letterSpacing: "1px",
                                          textTransform: "uppercase",
                                          color: "#8A7A60",
                                          marginBottom: "5px",
                                        }}
                                      >
                                        {family}
                                      </div>
                                      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                                        {colors.map((c) => (
                                          <span
                                            key={c.code}
                                            title={`${c.name} · ${c.code}`}
                                            style={{
                                              width: "26px",
                                              height: "26px",
                                              borderRadius: "3px",
                                              background: c.hex,
                                              border: "1px solid rgba(0,0,0,0.15)",
                                              display: "inline-block",
                                            }}
                                          />
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}

                          <div className="flex justify-end pt-2">
                            <Button onClick={() => goToNextStep("thread-brand")} disabled={!threadBrand}>
                              Next
                            </Button>
                          </div>
                        </div>
                      )}

                      {step.id === "text-lettering" && (
                        threadBrand ? (
                          <div className="space-y-5">
                            <div className="space-y-2">
                              <Label htmlFor="text-input" className="font-serif text-base">
                                Text
                              </Label>
                              <Input
                                id="text-input"
                                value={textValue}
                                onChange={(e) => setTextValue(e.target.value)}
                                placeholder="e.g. Home Sweet Home"
                                maxLength={60}
                                className="bg-secondary/40"
                              />
                            </div>

                            <div className="space-y-2">
                              <Label className="font-serif text-base">Font</Label>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {TEXT_FONTS.map((f) => (
                                  <button
                                    key={f.id}
                                    type="button"
                                    onClick={() => setTextFontId(f.id)}
                                    className={`rounded-md border px-4 py-3 text-left transition-colors ${
                                      textFontId === f.id
                                        ? "border-primary bg-primary/10"
                                        : "border-border bg-secondary/40 hover:bg-secondary/60"
                                    }`}
                                  >
                                    <span className="block text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                      {f.label}
                                    </span>
                                    <span className="mt-1 block overflow-hidden">
                                      <GlyphPreview
                                        fontId={f.id === "default" ? null : f.id}
                                        sample={(textValue || "Abc 123").slice(0, 8)}
                                        hex={textColor || "#3B4F35"}
                                        shadowHex={textShadowColor}
                                        maxPx={200}
                                        letterSpacing={textLetterSpacing}
                                      />
                                    </span>


                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="space-y-2">
                              <Label className="font-serif text-base">Letter spacing</Label>
                              <div className="flex items-center gap-3">
                                <input
                                  type="range"
                                  min={0}
                                  max={4}
                                  step={1}
                                  value={textLetterSpacing}
                                  onChange={(e) => setTextLetterSpacing(Number(e.target.value) || 0)}
                                  className="w-40"
                                />
                                <span className="w-6 text-center text-xs font-medium tabular-nums">
                                  {textLetterSpacing}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  Gap between letters within a word, in stitches. Word spacing is unaffected.
                                </span>
                              </div>
                            </div>


                            <ColorPicker
                              label="Thread Colour"
                              palette={palette}
                              selectedHex={textColor}
                              onSelect={setTextColor}
                            />

                            {TEXT_FONTS.find((f) => f.id === textFontId)?.hand?.colours === 2 && (
                              <div className="space-y-2">
                                <ColorPicker
                                  label="Shadow Colour"
                                  palette={palette}
                                  selectedHex={textShadowColor}
                                  onSelect={setTextShadowColor}
                                />
                                <p className="text-[11px] italic text-muted-foreground">
                                  This font is charted in two colours. Leave unset to stitch the whole
                                  letter in the main colour.
                                </p>
                              </div>
                            )}

                            {textValue && textColor && (() => {
                              const gw = Math.max(1, Math.round(canvasDims.width * meshCount));
                              const gh = Math.max(1, Math.round(canvasDims.height * meshCount));
                              const footprint = measureTextOnCanvas(
                                {
                                  text: textValue,
                                  fontCss: textFont.css,
                                  color: textColor,
                                  align: textAlign,
                                  boxWidthCells: textWrapEnabled ? Math.round(textBoxWidthFrac * gw) : undefined,
                                  fontId: textFontId === "default" ? null : textFontId,
                                  shadowColor: textShadowColor,
                                  rotation: textRotation,
                                  letterSpacing: textLetterSpacing,
                                },
                                gw, gh,
                              );
                              const overflow = !!footprint && footprint.w > gw;
                              return (
                                <>
                                  {footprint && (
                                    <p
                                      className={`text-[11px] ${
                                        overflow ? "text-destructive font-medium" : "italic text-muted-foreground"
                                      }`}
                                    >
                                      Will chart at {footprint.w} × {footprint.h} stitches on a {gw} × {gh} canvas
                                      {footprint.lines > 1 ? ` (${footprint.lines} lines)` : ""}.
                                      {overflow && " Too wide — it will wrap. Try a smaller font or shorter text."}
                                    </p>
                                  )}
                                  <div className="rounded-md border border-border bg-secondary/40 p-6 text-center">
                                    <GlyphPreview
                                      fontId={textFontId === "default" ? null : textFontId}
                                      sample={textValue}
                                      hex={textColor}
                                      shadowHex={textShadowColor}
                                      maxPx={280}
                                      rotation={textRotation}
                                      letterSpacing={textLetterSpacing}
                                    />
                                  </div>
                                </>
                              );
                            })()}


                            <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-4">
                              <div className="flex items-center justify-between">
                                <Label className="font-serif text-sm">Text position on canvas</Label>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setTextPos({ x: 0.5, y: 0.86 })}
                                >
                                  Reset
                                </Button>
                              </div>
                              <p className="text-[11px] italic text-muted-foreground">
                                Moves only the text. The image and monogram stay put.
                              </p>
                              <div className="flex items-center gap-3">
                                <span className="w-10 text-xs text-muted-foreground">Left↔Right</span>
                                <Slider min={5} max={95} step={1} value={[Math.round(textPos.x * 100)]} onValueChange={(v) => setTextPos((p) => ({ ...p, x: v[0] / 100 }))} className="flex-1" />
                                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(textPos.x * 100)}%</span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="w-10 text-xs text-muted-foreground">Top↕Bottom</span>
                                <Slider min={5} max={95} step={1} value={[Math.round(textPos.y * 100)]} onValueChange={(v) => setTextPos((p) => ({ ...p, y: v[0] / 100 }))} className="flex-1" />
                                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(textPos.y * 100)}%</span>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <Label className="font-serif text-sm">Rotation</Label>
                              <div className="flex gap-2">
                                {([0, 90, 180, 270] as const).map((deg) => (
                                  <button
                                    key={deg}
                                    type="button"
                                    onClick={() => setTextRotation(deg)}
                                    className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                                      textRotation === deg
                                        ? "border-primary bg-primary/10 text-foreground"
                                        : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                                    }`}
                                  >
                                    {deg}°
                                  </button>
                                ))}
                              </div>
                              <p className="text-[11px] italic text-muted-foreground">
                                Quarter turns only — stitches sit on a grid, so any other angle
                                would have to redraw the letters and couldn't be stitched cleanly.
                              </p>
                            </div>

                            <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-4">
                              <Label className="font-serif text-sm">Text alignment</Label>
                              <div className="flex gap-2">
                                {(["left", "center", "right"] as const).map((a) => (
                                  <button
                                    key={a}
                                    type="button"
                                    onClick={() => setTextAlign(a)}
                                    className={`flex-1 rounded-md border px-3 py-2 text-sm capitalize transition-colors ${
                                      textAlign === a
                                        ? "border-primary bg-primary/10 text-foreground"
                                        : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                                    }`}
                                  >
                                    {a}
                                  </button>
                                ))}
                              </div>
                              <div className="flex items-center justify-between pt-1">
                                <Label htmlFor="text-wrap-toggle" className="font-serif text-sm">
                                  Wrap text in a box
                                </Label>
                                <Checkbox
                                  id="text-wrap-toggle"
                                  checked={textWrapEnabled}
                                  onCheckedChange={(c) => setTextWrapEnabled(!!c)}
                                />
                              </div>
                              {textWrapEnabled && (
                                <>
                                  <p className="text-[11px] italic text-muted-foreground">
                                    Words wrap onto new lines once they don't fit this width — narrow the box to stack words vertically.
                                  </p>
                                  <div className="flex items-center gap-3">
                                    <span className="w-10 text-xs text-muted-foreground">Width</span>
                                    <Slider min={10} max={95} step={1} value={[Math.round(textBoxWidthFrac * 100)]} onValueChange={(v) => setTextBoxWidthFrac(v[0] / 100)} className="flex-1" />
                                    <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(textBoxWidthFrac * 100)}%</span>
                                  </div>
                                </>
                              )}
                            </div>


                            <div className="flex justify-end pt-2">
                              <Button onClick={() => goToNextStep("text-lettering")}>
                                Next
                              </Button>
                            </div>
                          </div>
                        ) : needsBrandNotice
                      )}

                      {step.id === "monogram" && (
                        threadBrand ? (
                          <div className="space-y-5">
                            <div className="space-y-2">
                              <Label className="font-serif text-base">Monogram Style</Label>
                              <p className="text-xs italic text-muted-foreground">
                                Choose an era. Final artwork will use uploaded reference monograms — these previews show the chosen lettering treatment as a stand-in.
                              </p>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {MONOGRAM_STYLES.map((s) => {
                                  const isSelected = monogramStyle === s.id;

                                  return (
                                    <button
                                      key={s.id}
                                      type="button"
                                      onClick={() => setMonogramStyle(s.id)}
                                      className={`flex flex-col items-center gap-1 rounded-md border px-2 py-3 transition-colors ${
                                        isSelected
                                          ? "border-primary bg-primary/10"
                                          : "border-border bg-secondary/40 hover:bg-secondary/60"
                                      }`}
                                    >
                                      <span className="block overflow-hidden">
                                        <GlyphPreview
                                          fontId={s.id === "m1" ? null : s.id}
                                          sample={
                                            (initials.slice(0, monogramCount).join("") || "ABC")
                                          }
                                          hex={initialColors[0] ?? "#3B4F35"}
                                          shadowHex={monogramShadowColor}
                                          maxPx={120}
                                        />
                                      </span>
                                      <span className="font-serif text-xs">{s.label}</span>

                                    </button>
                                  );
                                })}
                              </div>
                              <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                                Upload monogram reference images in chat to replace these placeholders.
                              </p>
                            </div>

                            <div className="space-y-2">
                              <Label className="font-serif text-base">Number of initials</Label>
                              <div className="flex gap-3">
                                {[1, 2, 3].map((n) => (
                                  <button
                                    key={n}
                                    type="button"
                                    onClick={() => setMonogramCount(n as 1 | 2 | 3)}
                                    className={`flex-1 rounded-md border px-4 py-2 font-serif transition-colors ${
                                      monogramCount === n
                                        ? "border-primary bg-primary/10"
                                        : "border-border bg-secondary/40 hover:bg-secondary/60"
                                    }`}
                                  >
                                    {n}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${monogramCount}, minmax(0, 1fr))` }}>
                              {Array.from({ length: monogramCount }).map((_, i) => (
                                <div key={i} className="space-y-3 rounded-md border border-border bg-secondary/30 p-4">
                                  <Label className="font-serif text-sm">Initial {i + 1}</Label>
                                  <Input
                                    value={initials[i] ?? ""}
                                    maxLength={1}
                                    onChange={(e) => {
                                      const next = [...initials];
                                      next[i] = e.target.value.toUpperCase().slice(0, 1);
                                      setInitials(next);
                                    }}
                                    placeholder="A"
                                    className="bg-card text-center font-serif text-2xl uppercase"
                                  />
                                  <ColorPicker
                                    label="Colour"
                                    palette={palette}
                                    selectedHex={initialColors[i]}
                                    onSelect={(hex) => {
                                      const next = [...initialColors];
                                      next[i] = hex;
                                      setInitialColors(next);
                                    }}
                                    compact
                                  />
                                </div>
                              ))}
                            </div>

                            {MONOGRAM_STYLES.find((s) => s.id === monogramStyle)?.hand?.colours === 2 && (
                              <div className="space-y-2">
                                <ColorPicker
                                  label="Shadow Colour"
                                  palette={palette}
                                  selectedHex={monogramShadowColor}
                                  onSelect={setMonogramShadowColor}
                                />
                                <p className="text-[11px] italic text-muted-foreground">
                                  This font is charted in two colours. Leave unset to stitch the whole
                                  letter in the main colour.
                                </p>
                              </div>
                            )}

                            <div className="space-y-2">
                              <Label className="font-serif text-sm">Rotation</Label>
                              <div className="flex gap-2">
                                {([0, 90, 180, 270] as const).map((deg) => (
                                  <button
                                    key={deg}
                                    type="button"
                                    onClick={() => setMonogramRotation(deg)}
                                    className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                                      monogramRotation === deg
                                        ? "border-primary bg-primary/10 text-foreground"
                                        : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                                    }`}
                                  >
                                    {deg}°
                                  </button>
                                ))}
                              </div>
                              <p className="text-[11px] italic text-muted-foreground">
                                Quarter turns only — stitches sit on a grid, so any other angle
                                would have to redraw the letters and couldn't be stitched cleanly.
                              </p>
                            </div>

                            {initials.slice(0, monogramCount).some((v) => v) && (
                              <div className="rounded-md border border-border bg-secondary/40 p-6 text-center">
                                <GlyphPreview
                                  fontId={monogramStyle === "m1" ? null : monogramStyle}
                                  sample={initials.slice(0, monogramCount).map((v) => v || "·").join("")}
                                  hex={initialColors[0] ?? "#3B4F35"}
                                  shadowHex={monogramShadowColor}
                                  maxPx={280}
                                  rotation={monogramRotation}
                                />
                                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  {MONOGRAM_STYLES.find((s) => s.id === monogramStyle)?.label}
                                </p>
                              </div>
                            )}


                            <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-4">
                              <div className="flex items-center justify-between">
                                <Label className="font-serif text-sm">Monogram position on canvas</Label>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setMonogramPos({ x: 0.5, y: 0.14 })}
                                >
                                  Reset
                                </Button>
                              </div>
                              <p className="text-[11px] italic text-muted-foreground">
                                Moves only the monogram. The image and text stay put.
                              </p>
                              <div className="flex items-center gap-3">
                                <span className="w-10 text-xs text-muted-foreground">Left↔Right</span>
                                <Slider min={5} max={95} step={1} value={[Math.round(monogramPos.x * 100)]} onValueChange={(v) => setMonogramPos((p) => ({ ...p, x: v[0] / 100 }))} className="flex-1" />
                                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(monogramPos.x * 100)}%</span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="w-10 text-xs text-muted-foreground">Top↕Bottom</span>
                                <Slider min={5} max={95} step={1} value={[Math.round(monogramPos.y * 100)]} onValueChange={(v) => setMonogramPos((p) => ({ ...p, y: v[0] / 100 }))} className="flex-1" />
                                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(monogramPos.y * 100)}%</span>
                              </div>
                            </div>

                            <div className="flex justify-end pt-2">
                              <Button onClick={() => goToNextStep("monogram")}>
                                Next
                              </Button>
                            </div>
                          </div>

                        ) : needsBrandNotice
                      )}

                      {step.id === "border-frame" && (
                        threadBrand ? (
                          <div className="space-y-5">
                            <div className="space-y-2">
                              <Label className="font-serif text-base">Border Style</Label>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {BORDER_STYLES.map((b) => (
                                  <button
                                    key={b.id}
                                    type="button"
                                    onClick={() => setBorderStyle(b.id)}
                                    className={`rounded-md border px-3 py-3 font-serif text-sm transition-colors ${
                                      borderStyle === b.id
                                        ? "border-primary bg-primary/10"
                                        : "border-border bg-secondary/40 hover:bg-secondary/60"
                                    }`}
                                  >
                                    {b.label}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {borderStyle !== "none" && (
                              <div className="space-y-4 rounded-md border border-border bg-secondary/30 p-4">

                                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Border colours
                                </p>
                                {borderColors[borderStyle].map((hex, i) => (
                                  <ColorPicker
                                    key={i}
                                    label={`Layer ${i + 1}`}
                                    palette={palette}
                                    selectedHex={hex}
                                    onSelect={(value) => {
                                      const next = { ...borderColors };
                                      const layers = [...next[borderStyle]];
                                      layers[i] = value;
                                      next[borderStyle] = layers;
                                      setBorderColors(next);
                                    }}
                                    compact
                                  />
                                ))}
                              </div>
                            )}

                            {borderStyle !== "none" && (
                              <div className="rounded-md border border-border bg-secondary/40 p-6 text-center">
                                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                  Preview
                                </p>
                                <BorderPreview
                                  styleId={borderStyle}
                                  colors={borderColors[borderStyle]}
                                />
                                <p className="mt-4 text-sm italic text-muted-foreground">
                                  {BORDER_STYLES.find((b) => b.id === borderStyle)?.label} border
                                </p>
                              </div>
                            )}

                            <div className="flex justify-end pt-2">
                              <Button onClick={() => goToNextStep("border-frame")}>
                                Next
                              </Button>
                            </div>
                          </div>
                        ) : needsBrandNotice
                      )}

                      {step.id === "canvas-spec" && (
                        <div className="space-y-6">
                          <div className="space-y-3">
                            <Label className="font-serif text-base">Canvas Shape</Label>
                            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                              {CANVAS_SHAPES.map((s) => (
                                <button
                                  key={s.value}
                                  type="button"
                                  onClick={() => handleShapeChange(s.value)}
                                  className={`rounded-md border px-3 py-3 text-center font-serif text-sm transition-colors ${
                                    canvasShape === s.value
                                      ? "border-primary bg-primary/10 text-foreground"
                                      : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                                  }`}
                                >
                                  {s.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-3">
                            <Label className="font-serif text-base">Mesh Count (holes per inch)</Label>
                            <div className="flex gap-3">
                              {[12, 13, 14, 18].map((count) => (
                                <button
                                  key={count}
                                  type="button"
                                  onClick={() => setMeshCount(count)}
                                  className={`flex-1 rounded-md border px-4 py-3 text-center font-serif text-sm transition-colors ${
                                    meshCount === count
                                      ? "border-primary bg-primary/10 text-foreground"
                                      : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                                  }`}
                                >
                                  {count}
                                </button>
                              ))}
                            </div>
                          </div>

                          {hasFixedDimensions(canvasShape) ? (
                            <div className="rounded-md border border-border bg-secondary/40 p-4">
                              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                Canvas size
                              </p>
                              <p className="mt-2 font-serif text-sm">
                                Fixed at {BRICK_CANVAS_WIDTH_INCHES}in × {BRICK_CANVAS_HEIGHT_INCHES}in.
                              </p>
                              <p className="mt-2 text-[11px] italic leading-relaxed text-muted-foreground">
                                {BRICK_BLURB}
                              </p>
                            </div>
                          ) : isSingleDimension(canvasShape) ? (
                            <div className="space-y-2">
                              <Label htmlFor="width" className="font-serif text-base">
                                {widthLabel(canvasShape)}
                              </Label>
                              <Input
                                id="width"
                                type="number"
                                min={0}
                                step={0.1}
                                value={finishedWidth}
                                onChange={(e) => {
                                  setFinishedWidth(e.target.value);
                                  setFinishedHeight(e.target.value);
                                }}
                                placeholder="e.g. 8"
                                className="bg-secondary/40"
                              />
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <Label htmlFor="width" className="font-serif text-base">
                                  {widthLabel(canvasShape)}
                                </Label>
                                <Input
                                  id="width"
                                  type="number"
                                  min={0}
                                  step={0.1}
                                  value={finishedWidth}
                                  onChange={(e) => setFinishedWidth(e.target.value)}
                                  placeholder="e.g. 8"
                                  className="bg-secondary/40"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="height" className="font-serif text-base">
                                  {heightLabel(canvasShape)}
                                </Label>
                                <Input
                                  id="height"
                                  type="number"
                                  min={0}
                                  step={0.1}
                                  value={finishedHeight}
                                  onChange={(e) => setFinishedHeight(e.target.value)}
                                  placeholder="e.g. 10"
                                  className="bg-secondary/40"
                                />
                              </div>
                            </div>
                          )}

                          {canvasShape === "stocking" && heightNum > 0 && (
                            <p className="text-[11px] italic text-muted-foreground">
                              The finished stocking is about {(heightNum * STOCKING_ASPECT).toFixed(1)}in wide at its widest point, scaled from the traced silhouette.
                            </p>
                          )}

                          {(widthNum > 0 && heightNum > 0) && (
                            <div className="rounded-md border border-border bg-secondary/40 p-4">
                              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                                Calculations
                              </p>
                              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                                <div>
                                  <span className="text-muted-foreground">Stitch grid:</span>{" "}
                                  <span className="font-semibold">
                                    {stitchGridWidth.toLocaleString()} × {stitchGridHeight.toLocaleString()} stitches
                                  </span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Total stitches:</span>{" "}
                                  <span className="font-semibold">
                                    {totalStitches.toLocaleString()}
                                  </span>
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="flex justify-end pt-2">
                            <Button
                              onClick={() => goToNextStep("canvas-spec")}
                              disabled={!canvasStepComplete}
                            >
                              Next
                            </Button>
                          </div>
                        </div>
                      )}

                      {step.id === "image" && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            {([
                              { value: "generate", label: "Generate with AI", note: "Use a style + prompt to create one." },
                              { value: "upload", label: "Upload my own image", note: "Pick a photo from your phone or computer." },
                              { value: "none", label: "Blank canvas", note: "Skip the image — start with a plain ivory canvas you can add borders or lettering to." },
                            ] as const).map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => setImageMode(opt.value)}
                                className={`rounded-md border px-3 py-3 text-left transition-colors ${
                                  imageMode === opt.value
                                    ? "border-primary bg-primary/10 text-foreground"
                                    : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                                }`}
                              >
                                <p className="font-serif text-sm font-medium">{opt.label}</p>
                                <p className="mt-1 text-[11px] leading-snug opacity-80">{opt.note}</p>
                              </button>
                            ))}
                          </div>

                          {imageMode === "generate" && (
                            <>
                              {canvasShape === "brick" && (() => {
                                const modeOptions = [
                                  { id: "uniform" as const, label: "Uniform all-over", note: "One pattern across the whole brick, no separate top." },
                                  { id: "armsPlusCenter" as const, label: "Pattern + centre motif", note: "Same pattern on all four sides, with its own motif on the top face." },
                                  { id: "pairedArmsPlusCenter" as const, label: "Paired sides + centre motif", note: "Top/bottom sides share one pattern, left/right share another, plus a top motif." },
                                ];
                                const slotsByMode: Record<BrickPatternMode, { key: BrickSlotKind; label: string; isPattern: boolean }[]> = {
                                  uniform: [{ key: "uniform", label: "Uniform pattern", isPattern: true }],
                                  armsPlusCenter: [
                                    { key: "arms", label: "Side pattern", isPattern: true },
                                    { key: "center", label: "Centre motif", isPattern: false },
                                  ],
                                  pairedArmsPlusCenter: [
                                    { key: "armsTopBottom", label: "Top/bottom pattern", isPattern: true },
                                    { key: "armsLeftRight", label: "Left/right pattern", isPattern: true },
                                    { key: "center", label: "Centre motif", isPattern: false },
                                  ],
                                };
                                const activeSlots = slotsByMode[brickPatternMode];
                                return (
                                  <div className="space-y-3">
                                    <div className="space-y-2">
                                      <Label>Brick layout</Label>
                                      <div className="grid grid-cols-1 gap-2">
                                        {modeOptions.map((opt) => (
                                          <button
                                            key={opt.id}
                                            type="button"
                                            onClick={() => setBrickPatternMode(opt.id)}
                                            className={`rounded-md border px-3 py-2 text-left transition ${
                                              brickPatternMode === opt.id
                                                ? "border-primary bg-primary/10"
                                                : "border-border bg-secondary/30 hover:bg-secondary/60"
                                            }`}
                                          >
                                            <p className="font-serif text-sm font-medium">{opt.label}</p>
                                            <p className="mt-1 text-[11px] leading-snug opacity-80">{opt.note}</p>
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                    <div className="space-y-2">
                                      <p className="text-[11px] leading-snug text-muted-foreground">
                                        Each piece is generated separately, so regenerating one doesn't affect the others.
                                      </p>
                                      {activeSlots.map((s) => {
                                        const cur = brickSlots[s.key];
                                        const busy = brickSlotGenerating === s.key;
                                        const anyBusy = brickSlotGenerating !== null;
                                        const slotPrompt = brickSlotPrompts[s.key] ?? "";
                                        const slotErr = brickSlotError[s.key];
                                        const placeholder = s.isPattern
                                          ? "e.g. small repeating waves"
                                          : "e.g. a single sailboat";
                                        return (
                                          <div key={s.key} className="rounded-md border border-border bg-secondary/30 p-3 space-y-2">
                                            <p className="font-serif text-sm font-medium">{s.label}</p>
                                            <Textarea
                                              value={slotPrompt}
                                              onChange={(e) =>
                                                setBrickSlotPrompts((prev) => ({ ...prev, [s.key]: e.target.value }))
                                              }
                                              placeholder={placeholder}
                                              rows={2}
                                              className="text-sm"
                                            />
                                            {s.isPattern && (
                                              <div className="grid grid-cols-2 gap-2">
                                                {([
                                                  { key: "pattern" as const, label: "Pattern (repeating)", note: "Tiles across the panel." },
                                                  { key: "single" as const, label: "Single motif", note: "One motif, placed once on each side." },
                                                ]).map((opt) => {
                                                  const active = (cur?.contentMode ?? "pattern") === opt.key;
                                                  return (
                                                    <button
                                                      key={opt.key}
                                                      type="button"
                                                      onClick={() =>
                                                        setBrickSlots((prev) => ({
                                                          ...prev,
                                                          [s.key]: {
                                                            url: prev[s.key]?.url ?? "",
                                                            repeats: prev[s.key]?.repeats ?? 3,
                                                            contentMode: opt.key,
                                                          },
                                                        }))
                                                      }
                                                      className={`rounded-md border px-3 py-3 text-left text-xs transition ${active ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-secondary/50"}`}
                                                    >
                                                      <div className="font-medium">{opt.label}</div>
                                                      <div className="text-[10px] text-muted-foreground">{opt.note}</div>
                                                    </button>
                                                  );
                                                })}
                                              </div>
                                            )}
                                            <div className="flex items-center justify-end">
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={anyBusy || !slotPrompt.trim()}
                                                onClick={() => handleGenerateBrickSlot(s.key)}
                                              >
                                                {busy ? (
                                                  <><Loader2 className="mr-2 h-3 w-3 animate-spin" />Generating…</>
                                                ) : cur?.url ? "Regenerate" : "Generate"}
                                              </Button>
                                            </div>
                                            {slotErr && (
                                              <p className="text-xs text-destructive">{slotErr}</p>
                                            )}
                                            {cur?.url && (
                                              <div className="space-y-3">
                                                <div className="flex items-start gap-3">
                                                  <img
                                                    src={cur.url}
                                                    alt={s.label}
                                                    className="h-16 w-16 rounded border border-border object-cover"
                                                  />
                                                  {s.isPattern && (cur.contentMode ?? "pattern") === "pattern" && (
                                                    <div className="flex-1 space-y-1">
                                                      <div className="flex items-center justify-between">
                                                        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Repeat</Label>
                                                        <span className="text-xs tabular-nums">{cur.repeats}×</span>
                                                      </div>
                                                      <input
                                                        type="range"
                                                        min={1}
                                                        max={8}
                                                        step={1}
                                                        value={cur.repeats}
                                                        onChange={(e) => {
                                                          const n = parseInt(e.target.value, 10);
                                                          setBrickSlots((prev) => ({
                                                            ...prev,
                                                            [s.key]: { url: prev[s.key]!.url, repeats: n, contentMode: prev[s.key]!.contentMode },
                                                          }));
                                                        }}
                                                        className="w-full"
                                                      />
                                                    </div>
                                                  )}
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })()}
                              <div className="space-y-2">
                                <Label htmlFor="design-style">Design style</Label>
                                <Select value={styleId} onValueChange={setStyleId}>
                                  <SelectTrigger id="design-style">
                                    <SelectValue placeholder="Choose a style" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {STYLE_PRESETS.map((s) => (
                                      <SelectItem key={s.id} value={s.id}>
                                        {s.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              {canvasShape !== "brick" && (
                                <>
                                  <div className="space-y-2">
                                    <Label htmlFor="user-text">Describe your design</Label>
                                    <Textarea
                                      id="user-text"
                                      value={userText}
                                      onChange={(e) => setUserText(e.target.value)}
                                      placeholder={selectedStyle.placeholder}
                                      rows={3}
                                    />
                                  </div>
                                  <Button onClick={handleGenerate} disabled={isGenerating || !userText.trim()}>
                                    {isGenerating ? (
                                      <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Generating…
                                      </>
                                    ) : (
                                      "Generate"
                                    )}
                                  </Button>
                                  {userText.trim() && (
                                    <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
                                      <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Prompt preview</p>
                                      <div className="space-y-1 text-xs">
                                        <p>
                                          <span className="font-semibold text-muted-foreground">Positive:</span>{" "}
                                          <span className="italic">{`${userText.trim()}, ${selectedStyle.positive}`}</span>
                                        </p>
                                        <p>
                                          <span className="font-semibold text-muted-foreground">Negative:</span>{" "}
                                          <span className="italic">{selectedStyle.negative}</span>
                                        </p>
                                      </div>
                                    </div>
                                  )}
                                </>
                              )}
                              {generateError && (
                                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                                  {generateError}
                                </div>
                              )}
                              {isGenerating && !generatedImageUrl && (
                                <div className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-border bg-secondary/40">
                                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                                </div>
                              )}
                            </>
                          )}

                          {imageMode === "upload" && (
                            <div className="space-y-3">
                              <input
                                ref={sourceImageInputRef}
                                type="file"
                                accept="image/jpeg,image/png"
                                className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) handleSourceImageUpload(f);
                                  e.target.value = "";
                                }}
                              />
                              <Button
                                onClick={() => sourceImageInputRef.current?.click()}
                                disabled={isProcessingUpload}
                                variant="outline"
                              >
                                {isProcessingUpload ? (
                                  <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Processing…
                                  </>
                                ) : (
                                  "Choose image (JPEG or PNG)"
                                )}
                              </Button>
                              <p className="text-xs italic text-muted-foreground">
                                Large phone photos are automatically resized to about 1024px on the longest side.
                              </p>
                              {uploadError && (
                                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                                  {uploadError}
                                </div>
                              )}
                              {generatedImageUrl && (() => {
                                const effective: InputType =
                                  inputTypeOverride ?? detectedInputType?.inputType ?? "generated";
                                const opts = [
                                  { value: "generated" as InputType, label: "Flat artwork" },
                                  { value: "photo" as InputType, label: "Photograph" },
                                ];
                                return (
                                  <div className="space-y-2">
                                    <div className="grid grid-cols-2 gap-3">
                                      {opts.map((opt) => (
                                        <button
                                          key={opt.value}
                                          type="button"
                                          onClick={() => setInputTypeOverride(opt.value)}
                                          className={`rounded-md border px-3 py-2 text-left transition-colors ${
                                            effective === opt.value
                                              ? "border-primary bg-primary/10 text-foreground"
                                              : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                                          }`}
                                        >
                                          <p className="font-serif text-sm font-medium">{opt.label}</p>
                                        </button>
                                      ))}
                                    </div>
                                    {detectedInputType && (
                                      <p className="text-xs italic text-muted-foreground">
                                        {detectedInputType.inputType === "generated"
                                          ? "Detected: flat artwork — cleaner edges, fewer colours."
                                          : "Detected: photograph — more colours, softer shading."}
                                        {detectedInputType.confidence < 0.35
                                          ? " — this one was a close call, switch it if the chart looks wrong."
                                          : ""}
                                      </p>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          )}




                          {generatedImageUrl && !cropOpen && (
                            <div className="space-y-2">
                              <div
                                className="relative mx-auto overflow-hidden rounded-md border-2 border-border bg-secondary/40"
                                style={{ aspectRatio: `${canvasAspect}`, maxWidth: 480 }}
                              >
                                {/* Positioned from imageRect exactly as ImageCropFrame does, so
                                    this preview and the crop frame always agree. object-cover
                                    ignored the crop entirely and showed a centred cover-fit of
                                    the whole image, which is why the two disagreed. */}
                                {imageRect ? (
                                  <img
                                    src={generatedImageUrl}
                                    alt="Current crop"
                                    draggable={false}
                                    className="absolute"
                                    style={{
                                      left: `${imageRect.x * 100}%`,
                                      top: `${imageRect.y * 100}%`,
                                      width: `${imageRect.w * 100}%`,
                                      height: `${imageRect.h * 100}%`,
                                      filter: tuningFilter || "none",
                                    }}
                                  />
                                ) : (
                                  <img
                                    src={generatedImageUrl}
                                    alt="Current crop"
                                    className="h-full w-full object-contain"
                                    style={{ filter: tuningFilter || "none" }}
                                  />
                                )}
                              </div>
                              <div className="flex justify-center">
                                <Button type="button" variant="outline" onClick={() => setCropOpen(true)}>
                                  <Crop className="mr-2 h-4 w-4" />
                                  Crop image
                                </Button>
                              </div>
                            </div>
                          )}

                          {generatedImageUrl && cropOpen && (
                            <div className="space-y-2">
                              <ImageCropFrame
                                ref={cropFrameRef}
                                imageUrl={uncroppedImageUrl ?? generatedImageUrl}
                                aspect={canvasAspect}
                                filter={tuningFilter || "none"}
                                rect={imageRect}
                                onRectChange={setImageRect}
                                finishedWidthInches={canvasDims.width}
                                finishedHeightInches={canvasDims.height}
                              />
                              <div className="flex justify-center">
                                <Button
                                  type="button"
                                  onClick={() => {
                                    // Physically cut the image to the chosen region. Everything
                                    // downstream then works on an already-cropped image, so no
                                    // un-cropped remnant can appear at the canvas edges.
                                    const canvas = cropFrameRef.current?.exportCanvas();
                                    if (canvas) {
                                      canvas.toBlob((blob) => {
                                        if (blob) setGeneratedImageUrl(URL.createObjectURL(blob));
                                      }, "image/png");
                                    }
                                    setImageRect(cropFrameRef.current?.getResetRect() ?? null);
                                    setCropOpen(false);
                                  }}
                                >
                                  Done cropping
                                </Button>
                              </div>
                            </div>
                          )}


                          {generatedImageUrl && (
                            <div className="space-y-3">
                              <label className="flex items-start gap-3 rounded-md border border-border bg-secondary/40 px-4 py-3">
                                <Checkbox
                                  checked={isPortrait}
                                  onCheckedChange={(v) => {
                                    setIsPortrait(v === true);
                                    if (v !== true) setOrderAcknowledged(false);
                                  }}
                                  className="mt-0.5"
                                />
                                <span className="text-sm">
                                  This is a portrait of a person
                                </span>
                              </label>

                              {isPortrait && (
                                <div
                                  className="rounded-md border px-5 py-4 text-sm"
                                  style={{
                                    background: "#F8F4EC",
                                    borderColor: "#8B6914",
                                    color: "#4A3508",
                                  }}
                                >
                                  <p className="mb-2 font-serif text-base font-semibold">
                                    Tips for portraits of people
                                  </p>
                                  <p className="leading-relaxed">
                                    Portraits of people are the most challenging subject to stitch well, because skin is made of many subtle tones. They can look beautiful, but to capture a face accurately you'll usually need: a larger canvas, an 18-count (fine) mesh, and a higher number of thread shades (often 40–60) so the skin tones come through. For the best result, use a clear, well-lit photo, crop in close on the face, and consider using 'Remove background' so the stitches focus on the person. Photos with a single clear subject — and pets, flowers and landscapes — tend to chart more easily than group or full-scene photos.
                                  </p>
                                </div>
                              )}
                            </div>
                          )}

                          <div className="flex justify-end pt-2">
                            <Button onClick={() => goToNextStep("image")}>
                              Next
                            </Button>
                          </div>
                        </div>
                      )}

                      {step.id === "image-tuning" && (
                        <div className="space-y-5 rounded-md border border-border bg-card/60 p-5">
                          {!generatedImageUrl ? (
                            <p className="text-center text-sm italic text-muted-foreground">
                              Generate or upload an image in Step 02 first.
                            </p>
                          ) : (
                            <div className="grid gap-5 sm:grid-cols-[160px_1fr] sm:items-start">
                              {/* Shows the CROPPED result, not the original upload -- the
                                  tuning sliders must be judged against exactly what will be
                                  charted. Positioned from imageRect the same way
                                  ImageCropFrame and the collapsed crop preview do, so all
                                  three always agree. */}
                              <div
                                className="relative overflow-hidden rounded-md border border-border bg-secondary/40"
                                style={{ aspectRatio: `${canvasAspect}` }}
                              >
                                {imageRect ? (
                                  <img
                                    src={generatedImageUrl}
                                    alt="Tuning preview"
                                    draggable={false}
                                    className="absolute max-w-none"
                                    style={{
                                      left: `${imageRect.x * 100}%`,
                                      top: `${imageRect.y * 100}%`,
                                      width: `${imageRect.w * 100}%`,
                                      height: `${imageRect.h * 100}%`,
                                      filter: tuningFilter || "none",
                                    }}
                                  />
                                ) : (
                                  <img
                                    src={generatedImageUrl}
                                    alt="Tuning preview"
                                    className="absolute inset-0 h-full w-full object-contain"
                                    style={{ filter: tuningFilter || "none" }}
                                  />
                                )}
                              </div>
                              <div className="space-y-4">
                                {([
                                  { label: "Brightness", value: brightness, set: setBrightness },
                                  { label: "Saturation", value: saturation, set: setSaturation },
                                  { label: "Contrast", value: contrast, set: setContrast },
                                ] as const).map((s) => (
                                  <div key={s.label} className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                      <Label className="font-serif text-sm">{s.label}</Label>
                                      <span className="text-xs tabular-nums text-muted-foreground">{s.value}%</span>
                                    </div>
                                    <Slider
                                      min={50}
                                      max={150}
                                      step={1}
                                      value={[s.value]}
                                      onValueChange={(v) => s.set(v[0])}
                                    />
                                  </div>
                                ))}
                                <Button variant="outline" size="sm" onClick={resetTuning}>
                                  Reset
                                </Button>
                              </div>
                            </div>
                          )}
                          <p className="text-xs italic text-muted-foreground">
                            Adjust the image before charting. Brighter or more saturated images change which thread colours are matched. Regenerate the chart to see the effect.
                          </p>

                          <div className="flex justify-end pt-2">
                            <Button onClick={() => goToNextStep("image-tuning")}>
                              Go to Stitch Chart
                            </Button>
                          </div>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </TabsContent>

          <TabsContent value="chart" className="mt-0">
            <SectionHeading
              eyebrow="Preview"
              title="Stitch Chart"
              description="A printable, gridded stitch chart of your finished design will appear here."
            />
            <div className="mx-auto mt-4 flex max-w-3xl flex-wrap justify-end gap-x-2 gap-y-2">
              {draftSaved && (
                <span className="text-xs text-muted-foreground animate-fade-in mr-2 self-center">
                  Draft saved ✓
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenMyDesigns}
                className="border-primary/40 text-primary hover:bg-primary/10"
              >
                My Designs
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowResetDialog(true)}
                className="border-primary/40 text-primary hover:bg-primary/10"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Start New Design
              </Button>
            </div>


            <div className="mx-auto mt-8 max-w-3xl space-y-6 rounded-md border border-border bg-card/60 p-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-serif text-sm">Number of Colours</Label>
                  <Input
                    type="number"
                    min={2}
                    max={120}
                    value={maxColours}
                    onFocus={() => {
                      maxColoursBeforeEditRef.current =
                        typeof maxColours === "number" ? maxColours : null;
                    }}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setMaxColoursTouched(true);
                      if (raw === "") {
                        setMaxColours("" as unknown as number);
                        return;
                      }
                      const n = parseInt(raw);
                      if (!Number.isNaN(n)) setMaxColours(Math.min(120, n));
                    }}
                    onBlur={(e) => {
                      const n = parseInt(e.target.value);
                      const clamped = Number.isNaN(n) || n < 2 ? 2 : Math.min(120, n);
                      const before = maxColoursBeforeEditRef.current;
                      if (chartData && before !== null && clamped !== before) {
                        setPendingColourChange({ before, after: clamped });
                        return;
                      }
                      setMaxColours(clamped);
                      setMaxColoursTouched(true);
                      maxColoursBeforeEditRef.current = null;
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="font-serif text-sm">Shading</Label>
                  {styleId === "motif" ? (
                    <p className="rounded-md border border-border bg-secondary/40 px-3 py-3 text-sm italic text-muted-foreground">
                      Single Motif is always charted flat, for a clean stitched look.
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        { value: "none", label: "No Shading", note: "Solid blocks of colour. Bold and simple." },
                        { value: "light", label: "Light Shading", note: "Gentle tonal variation. Beginner friendly." },
                        { value: "medium", label: "Medium Shading", note: "Moderate, detailed shading." },
                        { value: "heavy", label: "Heavy Shading", note: "Fine gradients. Intricate, advanced work." },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setShading(opt.value as "none" | "light" | "medium" | "heavy")}
                          className={`rounded-md border px-3 py-3 text-left transition-colors ${
                            shading === opt.value
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/60"
                          }`}
                        >
                          <p className="font-serif text-sm font-medium">{opt.label}</p>
                          <p className="mt-1 text-[11px] leading-snug opacity-80">{opt.note}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="text-xs italic text-muted-foreground">
                Brand: {threadBrand ?? "— choose in Step 01"} · Mesh: {meshCount} ·{" "}
                {canvasShape !== "rectangle" ? `${canvasShape} · ` : ""}
                {canvasDims.width > 0 ? canvasDims.width.toFixed(1) : "?"}" × {canvasDims.height > 0 ? canvasDims.height.toFixed(1) : "?"}"
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Design preview
                </p>
                <div className="overflow-hidden rounded-md border border-border bg-secondary/40">
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Live design preview"
                      className="block h-auto w-full"
                    />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center text-xs italic text-muted-foreground">
                      {isBuildingPreview
                        ? "Building preview…"
                        : "Add an image, text, monogram or border to see a preview."}
                    </div>
                  )}
                </div>
                <p className="text-[11px] italic text-muted-foreground">
                  This is exactly what will be sent to the chart.
                </p>
              </div>

              <Button
                onClick={handleGenerateChart}
                disabled={
                  isCharting ||
                  !threadBrand ||
                  !(canvasDims.width > 0) ||
                  !(canvasDims.height > 0) ||
                  !(
                    imageMode === "none" ||
                    !!generatedImageUrl ||
                    !!textValue.trim() ||
                    initials.slice(0, monogramCount).some((v) => v) ||
                    borderStyle !== "none"
                  )
                }
                className="w-full"
              >
                {isCharting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating chart…
                  </>
                ) : (
                  "Generate Chart"
                )}
              </Button>

              {chartError && (
                <p className="text-center text-sm text-destructive">{chartError}</p>
              )}

              <Dialog open={!!pendingColourChange} onOpenChange={(o) => {
                if (!o) {
                  if (pendingColourChange) setMaxColours(pendingColourChange.before);
                  setPendingColourChange(null);
                  maxColoursBeforeEditRef.current = null;
                }
              }}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle className="font-serif">Update number of colours?</DialogTitle>
                    <DialogDescription>
                      Changing the number of colours means regenerating the chart, which will lose
                      any manual edits you've made (paint, moves, fills, etc.) since it was last
                      generated. If you want more colour variety, it's best to decide that before
                      making manual changes.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-2 pt-2">
                    <Button
                      onClick={() => {
                        if (pendingColourChange) {
                          setMaxColours(pendingColourChange.after);
                          setMaxColoursTouched(true);
                        }
                        setPendingColourChange(null);
                        maxColoursBeforeEditRef.current = null;
                      }}
                    >
                      Update now
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (pendingColourChange) setMaxColours(pendingColourChange.before);
                        setPendingColourChange(null);
                        maxColoursBeforeEditRef.current = null;
                      }}
                    >
                      Keep current colours
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>

              <Dialog open={!!detailWarning} onOpenChange={(o) => { if (!o) setDetailWarning(null); }}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle className="font-serif">
                      This canvas may not capture all the detail
                    </DialogTitle>
                    <DialogDescription asChild>
                      <div className="space-y-3 pt-2 text-left">
                        <p>
                          At {meshCount} mesh on {canvasDims.width}&quot; × {canvasDims.height}&quot;, your
                          design is {detailWarning?.currentStitches} stitches across.{" "}
                          {detailWarning?.fit.reason === "fine-linework"
                            ? "About " + Math.round((detailWarning?.fit.subStitch ?? 0) * 100) +
                              "% of the linework in this image is finer than a single stitch, so it can't be stitched at this size — thin strokes will break up or disappear."
                            : "This image has fine photographic shading, so many stitches would have to blend several colours into one. That tends to come out as speckling rather than clean areas of colour."}
                        </p>
                        {detailWarning?.suggestion ? (
                          <p>
                            Around {detailWarning.suggestion.stitches} stitches across would hold the
                            detail. Detail depends on the stitch count, not the mesh on its own — so
                            you can get there with a finer mesh, a larger canvas, or both.
                          </p>
                        ) : (
                          <p>
                            No canvas size we offer fully resolves this particular image — it's the
                            artwork rather than the canvas that sets the limit here. A simpler or
                            bolder image will always chart more cleanly.
                          </p>
                        )}
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-2 pt-2">
                    {detailWarning?.suggestion && (
                      <Button
                        onClick={() => {
                          const s = detailWarning.suggestion!;
                          setMeshCount(s.mesh);
                          setFinishedWidth(String(s.inches));
                          setFinishedHeight(String(s.inches));
                          setDetailWarning(null);
                        }}
                      >
                        Use {detailWarning.suggestion.mesh} mesh at {detailWarning.suggestion.inches}
                        &quot; × {detailWarning.suggestion.inches}&quot;
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setDetailWarning(null);
                        setDetailAck(true);
                        setTimeout(() => { void handleGenerateChart(); }, 0);
                      }}
                    >
                      Chart it anyway
                    </Button>
                    <Button variant="ghost" onClick={() => setDetailWarning(null)}>
                      Go back and adjust
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            <div className="mx-auto mt-10 max-w-5xl">
              {isCharting && (
                <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-border">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              )}
              {chartData && !isCharting && (
                <StitchChart
                  chart={chartData}
                  palette={palette}
                  onChange={setChartData}
                  canvasShape={canvasShape}
                  canvasWidthInches={canvasDims.width}
                  canvasHeightInches={canvasDims.height}
                  progress={progressGrid ?? undefined}
                  onProgressChange={setProgressGrid}
                  tileFillMotifName={tileFillMotif?.name ?? null}
                  onTileFillPickMotif={handleOpenMotifPicker}
                  onTileFillApply={handleTileFillApply}
                  onSaveAsMotif={handleSaveAsMotif}
                  placedMotifs={placedMotifs.map((m) => {
                    const rot = (m.rotation ?? 0) as Quarter;
                    const swap = rot === 90 || rot === 270;
                    return {
                      id: m.instanceId,
                      name: m.name,
                      cells: rotateCells(m.cells, rot),
                      // Swap w/h for quarter turns so hit-testing and the
                      // drag preview agree with the drawn footprint.
                      width: swap ? m.height : m.width,
                      height: swap ? m.width : m.height,
                      offset: m.offset,
                      scale: m.scale,
                    };
                  })}
                  motifSentinel={LAYER_SENTINEL}
                  onMotifMove={movePlacedMotif}
                  onMotifRemove={removePlacedMotif}
                  onMotifReorder={reorderPlacedMotif}
                  onMotifFlatten={flattenPlacedMotif}
                  onMotifRotate={rotatePlacedMotif}
                  onMotifResize={resizePlacedMotif}

                  onAddMotifFromLibrary={handleOpenMotifLibrary}
                />

              )}
              {chartData && (
                <div className="mx-auto mt-6 max-w-5xl">
                  <ThreadShoppingList
                    chart={chartData}
                    meshCount={meshCount}
                    threadBrand={threadBrand}
                    stash={stash}

                  />
                </div>
              )}
              {!chartData && !isCharting && (
                <PlaceholderPanel label="Stitch chart preview" />
              )}
            </div>

            <div className="mx-auto mt-8 flex max-w-5xl items-center justify-between">
              <Button
                variant="outline"
                onClick={handleOpenMyDesigns}
                disabled={!chartData}
                className="border-primary/40 text-primary hover:bg-primary/10"
              >
                Finish &amp; Save Chart
              </Button>
              <Button
                onClick={() => setActiveTab("order")}
                disabled={!chartData}
              >
                Next
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="order" className="mt-0">
            <SectionHeading
              eyebrow="Checkout"
              title="Order your canvas"
              description="Review your design, choose finishing options, and place your order."
            />
            <div className="mx-auto mt-8 max-w-3xl space-y-6 rounded-lg border border-border bg-card p-6 shadow-sm">
              <div className="rounded-md border border-border bg-secondary/40 p-6">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Order summary
                </p>
                <div className="mt-3 space-y-1 text-sm">
                  <p>
                    <span className="text-muted-foreground">Design:</span>{" "}
                    <span className="font-medium">{currentDesignName || "Unsaved design"}</span>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Thread brand:</span>{" "}
                    {threadBrand === "appletons" ? "Appletons Wool" : threadBrand === "dmc" ? "DMC Perle Cotton" : "—"}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Shape:</span> {canvasShape}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Size:</span>{" "}
                    {canvasDims.width > 0 ? canvasDims.width.toFixed(1) : "?"}" × {canvasDims.height > 0 ? canvasDims.height.toFixed(1) : "?"}"
                  </p>
                  <p>
                    <span className="text-muted-foreground">Mesh:</span> {meshCount}
                  </p>
                </div>
                {!currentDesignId && (
                  <p className="mt-3 text-xs italic text-amber-700">
                    Save this design (use "My Designs" or "Finish & Save Chart" on the Stitch Chart tab) before placing an order.
                  </p>
                )}
              </div>

              {isPortrait && (
                <label className="flex items-start gap-3 rounded-md border border-border bg-secondary/40 px-4 py-3">
                  <Checkbox
                    checked={orderAcknowledged}
                    onCheckedChange={(v) => setOrderAcknowledged(v === true)}
                    className="mt-0.5"
                  />
                  <span className="text-sm leading-relaxed">
                    I understand that portraits of people are detailed and challenging to stitch, and that the finished chart is a hand-craftable interpretation rather than a photographic likeness.
                  </span>
                </label>
              )}

              {orderPlaced ? (
                <div className="rounded-md border border-primary/40 bg-primary/10 px-4 py-3 text-sm">
                  Order placed -- status: pending. We'll be in touch about next steps (online checkout
                  isn't wired up yet, so nothing has been charged).
                </div>
              ) : (
                <>
                  {orderError && <p className="text-sm text-destructive">{orderError}</p>}
                  <div className="flex justify-end">
                    <Button
                      onClick={handlePlaceOrder}
                      disabled={placingOrder || (isPortrait && !orderAcknowledged)}
                    >
                      {placingOrder ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Placing order…
                        </>
                      ) : (
                        "Place order"
                      )}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>

      <OrnamentFrame>
        <div className="py-8 text-center text-xs uppercase tracking-[0.25em]" style={{ color: IVORY, fontFamily: "'IM Fell DW Pica SC', serif" }}>
          LANARIA STUDIO · DESIGN. PRINT. CREATE.
        </div>
      </OrnamentFrame>

      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a new design?</DialogTitle>
            <DialogDescription>
              This will clear your current design — make sure you’ve saved or ordered it first if you want to keep it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleStartNewDesign}>
              Start New Design
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AuthModal open={authModalOpen} onOpenChange={setAuthModalOpen} />
      <MyDesignsDialog
        open={myDesignsOpen}
        onOpenChange={setMyDesignsOpen}
        designs={myDesigns}
        loading={myDesignsLoading}
        currentDesignId={currentDesignId}
        currentDesignName={currentDesignName}
        onSave={(name) => saveDesign(name, false)}
        onSaveAsNew={(name) => saveDesign(name, true)}
        onLoad={loadDesign}
        onDelete={deleteDesignById}
      />
      <MotifLibraryDialog
        open={motifLibraryOpen}
        onOpenChange={setMotifLibraryOpen}
        mine={motifsMine}
        preloaded={motifsPreloaded}
        loading={motifsLoading}
        error={motifsError}
        signedIn={!!user}
        onSignInClick={() => { setMotifLibraryOpen(false); setAuthModalOpen(true); }}
        onAddToChart={handleAddMotifToChart}
        onTileFillCanvas={handleTileFillCanvas}
        sentinel={LAYER_SENTINEL}
        palette={palette}
        disabledReason={!chartData ? "Generate a chart first." : null}
        pickMode={motifPickMode}
        onPick={handleMotifPicked}
      />
    </div>
  );
}

/** Renders a sample string using the ACTUAL charted glyphs, so the picker
 *  shows what will really be stitched rather than a CSS lookalike. */
function GlyphPreview({
  fontId,
  sample,
  hex,
  shadowHex,
  maxPx = 240,
  rotation = 0,
  letterSpacing,
}: {
  fontId: string | null;
  sample: string;
  hex: string;
  shadowHex?: string | null;
  maxPx?: number;
  rotation?: Quarter;
  letterSpacing?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const grid = previewGrid(fontId, sample, rotation, letterSpacing);
    const h = grid.length;
    const w = grid[0]?.length ?? 1;
    if (!h || !w) return;
    const cell = Math.max(1, Math.min(4, Math.floor(maxPx / w)));
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * cell * dpr;
    cv.height = h * cell * dpr;
    cv.style.width = `${w * cell}px`;
    cv.style.height = `${h * cell}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w * cell, h * cell);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const v = grid[r][c];
        if (v === "0") continue;
        ctx.fillStyle = v === "2" ? (shadowHex || hex) : hex;
        ctx.fillRect(c * cell, r * cell, cell, cell);
      }
    }
  }, [fontId, sample, hex, shadowHex, maxPx, rotation, letterSpacing]);
  return <canvas ref={canvasRef} style={{ imageRendering: "pixelated" }} />;
}

function ColorPicker({

  label,
  palette,
  selectedHex,
  onSelect,
  compact = false,
}: {
  label: string;
  palette: ThreadColor[];
  selectedHex: string | null;
  onSelect: (hex: string) => void;
  compact?: boolean;
}) {
  const value = palette.find((c) => c.hex === selectedHex) ?? null;
  const disabled = palette.length === 0;

  return (
    <div className={compact ? "flex items-center gap-3" : "space-y-2"}>
      <Label className="font-serif text-sm">{label}</Label>
      <SwatchPicker
        value={value}
        onChange={(c) => onSelect(c.hex)}
        palette={palette}
        disabled={disabled}
        compact={compact}
      />
    </div>
  );
}



function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
        {eyebrow}
      </p>
      <h2 className="mt-3 font-serif text-3xl">{title}</h2>
      <p className="mt-3 text-sm italic text-muted-foreground">{description}</p>
    </div>
  );
}

function PlaceholderPanel({ label }: { label: string }) {
  return (
    <div className="mx-auto mt-8 max-w-3xl rounded-lg border border-dashed border-border bg-card/60 px-6 py-20 text-center">
      <p className="font-serif text-lg text-foreground">{label}</p>
      <p className="mt-2 text-sm italic text-muted-foreground">
        Coming soon.
      </p>
    </div>
  );
}

function BorderPreview({ styleId, colors }: { styleId: BorderStyleId; colors: (string | null)[] }) {
  const fallback = "#3B4F35";
  const c1 = colors[0] ?? fallback;
  const c2 = colors[1] ?? c1;
  const c3 = colors[2] ?? c2;


  // All borders are drawn INSIDE the canvas rect (20,20)-(180,120).
  // Use an inset frame at (24,24)-(176,116).
  const IX1 = 24, IY1 = 24, IX2 = 176, IY2 = 116;
  const IW = IX2 - IX1, IH = IY2 - IY1;


  // Floral: corner + mid-edge flowers, all inside the canvas
  const Flower = ({ cx, cy, color }: { cx: number; cy: number; color: string }) => (
    <g fill={color}>
      <circle cx={cx} cy={cy - 3.5} r="2" />
      <circle cx={cx + 3.5} cy={cy} r="2" />
      <circle cx={cx} cy={cy + 3.5} r="2" />
      <circle cx={cx - 3.5} cy={cy} r="2" />
      <circle cx={cx} cy={cy} r="1.4" fill={c2} />
    </g>
  );

  return (
    <svg viewBox="0 0 200 140" className="mx-auto mt-3 h-40 w-full max-w-xs">
      <rect x="20" y="20" width="160" height="100" fill="#FAF6EA" stroke="#E5DCC7" strokeWidth="0.5" />

      {styleId === "simple" && (
        <rect x={IX1} y={IY1} width={IW} height={IH} fill="none" stroke={c1} strokeWidth="2" />
      )}

      {styleId === "double" && (
        <>
          <rect x={IX1} y={IY1} width={IW} height={IH} fill="none" stroke={c1} strokeWidth="1.6" />
          <rect x={IX1 + 4} y={IY1 + 4} width={IW - 8} height={IH - 8} fill="none" stroke={c2} strokeWidth="1.2" />
        </>
      )}

      {(() => {
        const hb = HAND_BORDERS.find((b) => b.id === styleId);
        if (!hb) return null;
        const grid = tileHandBorder(hb, 40);
        const n = grid.length;
        const cell = IW / n;
        const roleColors = [c1, c2, c3];
        const rects: ReactElement[] = [];
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            const role = grid[r][c];
            if (!role) continue;
            rects.push(
              <rect
                key={`${r}-${c}`}
                x={IX1 + c * cell}
                y={IY1 + r * cell}
                width={cell + 0.5}
                height={cell + 0.5}
                fill={roleColors[role - 1] ?? c1}
              />,
            );
          }
        }
        return <>{rects}</>;
      })()}

    </svg>
  );
}

const MOSS = "#3d5a2a";
const IVORY = "#f2e9d4";
const GROUT = "#2a3a1a";

// Small ivory + mossy-green mosaic tile pattern for text fill.
const MOSAIC_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'>\
<rect width='10' height='10' fill='${GROUT}'/>\
<rect x='0.5' y='0.5' width='4' height='4' fill='${MOSS}'/>\
<rect x='5.5' y='0.5' width='4' height='4' fill='${IVORY}'/>\
<rect x='0.5' y='5.5' width='4' height='4' fill='${IVORY}'/>\
<rect x='5.5' y='5.5' width='4' height='4' fill='${MOSS}'/>\
</svg>`;
export const MOSAIC_BG = `url("data:image/svg+xml;utf8,${encodeURIComponent(MOSAIC_SVG)}")`;

const BORDER_THICKNESS = 28; // px
const BORDER_BG = "#f2e9d4";
const BORDER_TILE_WIDTH = 56;

const BORDER_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='${BORDER_TILE_WIDTH}' height='${BORDER_THICKNESS}' viewBox='0 0 ${BORDER_TILE_WIDTH} ${BORDER_THICKNESS}'>\
<rect width='${BORDER_TILE_WIDTH}' height='${BORDER_THICKNESS}' fill='${GROUT}'/>\
<path d='M0 0h8l-1 8H0zM8 0h8l1 8H7zM17 0h9l-1 8h-8zM25 0h9l1 8H25zM35 0h8l-1 8h-8zM43 0h8l1 8H42zM52 0h4v8h-4z' fill='${IVORY}'/>\
<path d='M0 9h9l1 9H0zM10 9h8l-1 9H9zM18 9h9l1 9H17zM28 9h8l-1 9h-7zM36 9h9l1 9H35zM46 9h8l-1 9h-7zM54 9h2v9h-3z' fill='${MOSS}'/>\
<path d='M0 19h7l1 9H0zM8 19h9l-1 9H8zM17 19h8l1 9H16zM26 19h9l-1 9h-8zM35 19h8l1 9H34zM44 19h9l-1 9h-8zM53 19h3v9h-4z' fill='${IVORY}'/>\
<path d='M2 1h5l-1 6H1zM20 1h5l-1 6h-5zM37 1h5l-1 6h-5zM4 10h5l1 6H3zM22 10h5v6h-6zM39 10h5l1 6h-6zM11 20h5l-1 6h-5zM29 20h5l-1 6h-5zM47 20h5l-1 6h-5z' fill='#4f7138' opacity='.92'/>\
<path d='M10 1h5l1 6h-6zM28 1h5l1 6h-6zM46 1h5l1 6h-6zM13 10h4l-1 6h-5zM31 10h4l-1 6h-5zM49 10h4l-1 6h-5zM1 20h5l1 6H1zM19 20h5l1 6h-6zM37 20h5l1 6h-6z' fill='#efe3c8' opacity='.95'/>\
<path d='M0 8h56M0 18h56M8 0l-1 28M17 0v28M26 0v28M35 0v28M44 0v28M53 0v28' stroke='#263716' stroke-width='1.05' stroke-linecap='square' opacity='.72'/>\
</svg>`;
const BORDER_URL = `url("data:image/svg+xml;utf8,${encodeURIComponent(BORDER_SVG)}")`;
const VERTICAL_BORDER_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='${BORDER_THICKNESS}' height='${BORDER_TILE_WIDTH}' viewBox='0 0 ${BORDER_THICKNESS} ${BORDER_TILE_WIDTH}'>\
<rect width='${BORDER_THICKNESS}' height='${BORDER_TILE_WIDTH}' fill='${GROUT}'/>\
<g transform='translate(0 ${BORDER_TILE_WIDTH}) rotate(-90)'>${BORDER_SVG.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g>\
</svg>`;
const VERTICAL_BORDER_URL = `url("data:image/svg+xml;utf8,${encodeURIComponent(VERTICAL_BORDER_SVG)}")`;

const T = BORDER_THICKNESS;

function HorizontalBorder({ position }: { position: "top" | "bottom" }) {
  const flip = position === "bottom";
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        [position]: 0,
        height: T,
        backgroundColor: BORDER_BG,
        backgroundImage: BORDER_URL,
        backgroundRepeat: "repeat-x",
        backgroundSize: `${BORDER_TILE_WIDTH}px ${T}px`,
        backgroundPosition: "left center",
        transform: flip ? "scaleY(-1)" : undefined,
        zIndex: 2,
      }}
    />
  );
}

function VerticalBorder({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: T,
        bottom: T,
        [side]: 0,
        width: T,
        backgroundColor: BORDER_BG,
        backgroundImage: VERTICAL_BORDER_URL,
        backgroundRepeat: "repeat-y",
        backgroundSize: `${T}px ${BORDER_TILE_WIDTH}px`,
        backgroundPosition: "center top",
        zIndex: 1,
      }}
    />
  );
}

function OrnamentFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        padding: T,
        borderRadius: T + 12,
        backgroundColor: GROUT,
      }}
    >
      <div className="relative z-10 overflow-hidden" style={{ borderRadius: 4, backgroundColor: MOSS, color: IVORY }}>
        {children}
      </div>

      <HorizontalBorder position="top" />
      <HorizontalBorder position="bottom" />
      <VerticalBorder side="left" />
      <VerticalBorder side="right" />
    </div>
  );
}


