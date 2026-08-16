import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import type { MotifRecord } from "@/lib/motif-library";
import type { ThreadColor } from "@/data/threadPalettes";

function MotifPreview({
  motif,
  sentinel,
  hexByCode,
}: {
  motif: MotifRecord;
  sentinel: string;
  hexByCode: Map<string, string>;
}) {
  const dataUrl = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = motif.width;
    canvas.height = motif.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    const img = ctx.createImageData(motif.width, motif.height);
    for (let y = 0; y < motif.height; y++) {
      for (let x = 0; x < motif.width; x++) {
        const code = motif.cells[y]?.[x];
        const i = (y * motif.width + x) * 4;
        if (!code || code === sentinel) {
          img.data[i + 3] = 0; // transparent
          continue;
        }
        const hex = hexByCode.get(code) ?? "#CCCCCC";
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }, [motif, sentinel, hexByCode]);

  return (
    <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-secondary [background-image:linear-gradient(45deg,#0000000d_25%,transparent_25%),linear-gradient(-45deg,#0000000d_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#0000000d_75%),linear-gradient(-45deg,transparent_75%,#0000000d_75%)] [background-size:8px_8px]">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={motif.name}
          className="h-full w-full object-contain"
          style={{ imageRendering: "pixelated" }}
        />
      ) : (
        <div className="text-[10px] italic text-muted-foreground">No preview</div>
      )}
    </div>
  );
}

function MotifGrid({
  motifs,
  sentinel,
  palette,
  onAddToChart,
  onTileFillCanvas,
  emptyMessage,
  pickMode,
  onPick,
}: {
  motifs: MotifRecord[];
  sentinel: string;
  palette: ThreadColor[];
  onAddToChart: (motif: MotifRecord) => void;
  onTileFillCanvas: (motif: MotifRecord) => void;
  emptyMessage: string;
  pickMode?: boolean;
  onPick?: (motif: MotifRecord) => void;
}) {
  const hexByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of palette) m.set(t.code, t.hex);
    return m;
  }, [palette]);

  if (motifs.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-secondary/40 px-4 py-6 text-center text-xs italic text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
      {motifs.map((m) => (
        <div key={m.id} className="rounded-md border border-border bg-secondary/40 p-2">
          <MotifPreview motif={m} sentinel={sentinel} hexByCode={hexByCode} />
          <p className="mt-1 truncate text-xs font-medium">{m.name}</p>
          {pickMode ? (
            <Button
              type="button"
              size="sm"
              onClick={() => onPick?.(m)}
              className="mt-1 h-7 w-full text-xs"
            >
              Use this motif
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => onAddToChart(m)}
                className="mt-1 h-7 w-full text-xs"
              >
                Add to chart
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onTileFillCanvas(m)}
                className="mt-1 h-7 w-full text-xs"
              >
                Tile fill canvas
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function MotifLibraryDialog({
  open,
  onOpenChange,
  mine,
  preloaded,
  loading,
  error,
  signedIn,
  onSignInClick,
  onAddToChart,
  onTileFillCanvas,
  sentinel,
  palette,
  disabledReason,
  pickMode,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mine: MotifRecord[];
  preloaded: MotifRecord[];
  loading: boolean;
  error: string | null;
  signedIn: boolean;
  onSignInClick: () => void;
  onAddToChart: (motif: MotifRecord) => void;
  onTileFillCanvas: (motif: MotifRecord) => void;
  sentinel: string;
  palette: ThreadColor[];
  /** Non-null disables adding (e.g. no chart generated yet) and explains why. */
  disabledReason: string | null;
  pickMode?: boolean;
  onPick?: (motif: MotifRecord) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{pickMode ? "Choose a motif to tile-fill with" : "Motif Library"}</DialogTitle>
          <DialogDescription>
            {pickMode
              ? "Pick a motif to repeat at its native scale across the selected area."
              : "Add a preloaded or your own saved motif onto the chart you're currently working on."}
          </DialogDescription>
        </DialogHeader>

        {disabledReason && (
          <p className="rounded-md border border-dashed border-border bg-secondary/40 px-4 py-3 text-center text-xs italic text-muted-foreground">
            {disabledReason}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                My Motifs
              </p>
              {signedIn ? (
                <MotifGrid
                  motifs={mine}
                  sentinel={sentinel}
                  palette={palette}
                  onAddToChart={onAddToChart}
                  onTileFillCanvas={onTileFillCanvas}
                  emptyMessage="No motifs of your own saved yet."
                  pickMode={pickMode}
                  onPick={onPick}
                />
              ) : (
                <div className="rounded-md border border-dashed border-border bg-secondary/40 px-4 py-6 text-center text-xs italic text-muted-foreground">
                  <p>Sign in to see and save your own motifs.</p>
                  <Button type="button" variant="outline" size="sm" onClick={onSignInClick} className="mt-2">
                    Sign in
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Preloaded
              </p>
              <MotifGrid
                motifs={preloaded}
                sentinel={sentinel}
                palette={palette}
                onAddToChart={onAddToChart}
                onTileFillCanvas={onTileFillCanvas}
                emptyMessage="Preloaded motifs coming soon."
                pickMode={pickMode}
                onPick={onPick}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
