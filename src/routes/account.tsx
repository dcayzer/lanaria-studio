import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, Trash2 } from "lucide-react";
import { NavMenu } from "@/components/NavMenu";
import { AuthModal } from "@/components/AuthModal";
import { StitchChart, type ChartData } from "@/components/StitchChart";
import { SwatchPicker } from "@/components/SwatchPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { THREAD_PALETTES, type ThreadBrand, type ThreadColor } from "@/data/threadPalettes";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { gridToSnapshot, snapshotToGrid } from "@/lib/progress-bridge";
import {
  deserializeProgress,
  reconcileProgress,
  serializeProgress,
} from "@/lib/progress-persistence";
import { makeProgressGrid, type ProgressGrid } from "@/lib/progress-tracking";
import { NOT_STITCHABLE } from "@/lib/canvas-shape-mask";
import type { ThreadUnit } from "@/lib/thread-inventory";
import {
  deleteMotif,
  listMyMotifs,
  renameMotif,
  type MotifRecord,
} from "@/lib/motif-library";
import {
  addStashLine,
  deleteStashLine,
  listStash,
  updateStashLine,
  THREAD_UNITS,
  type StashRow,
} from "@/lib/thread-stash-store";

export const Route = createFileRoute("/account")({
  head: () => ({
    meta: [
      { title: "My Account — lanaria Studio" },
      {
        name: "description",
        content:
          "Your lanaria Studio account: saved needlepoint designs, stitch progress and your thread stash.",
      },
      { property: "og:title", content: "My Account — lanaria Studio" },
      {
        property: "og:description",
        content:
          "Manage your saved needlepoint designs, track stitch progress and keep your thread stash up to date.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AccountPage,
});

interface DesignRow {
  id: string;
  name: string;
  thumbnail_url: string | null;
  updated_at: string;
}

const BRANDS: { id: ThreadBrand; label: string }[] = [
  { id: "appletons", label: "Appletons Tapestry Wool" },
  { id: "dmc", label: "DMC Perle Cotton (Size 5)" },
];

const selectClass =
  "h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground";

function AccountPage() {
  const { user, loading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-[#3d5a2a] text-[#f2e9d4]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <h1
            className="text-3xl font-black tracking-tight"
            style={{ fontFamily: "'IM Fell DW Pica SC', serif" }}
          >
            lanaria Studio
          </h1>
          <NavMenu />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <h2 className="font-serif text-4xl">My Account</h2>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !user ? (
          <div className="mt-8 rounded-md border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground">
              Sign in to see your saved designs, stitch progress and thread stash.
            </p>
            <Button className="mt-4" onClick={() => setAuthOpen(true)}>
              Sign in
            </Button>
          </div>
        ) : (
          <Tabs defaultValue="designs" className="mt-8">
            <TabsList className="flex-wrap">
              <TabsTrigger value="designs">Saved Designs</TabsTrigger>
              <TabsTrigger value="motifs">My Motifs</TabsTrigger>
              <TabsTrigger value="stash">Thread Stash</TabsTrigger>
              <TabsTrigger value="orders">Orders</TabsTrigger>
              <TabsTrigger value="progress">Progress</TabsTrigger>
              <TabsTrigger value="account">Account</TabsTrigger>
            </TabsList>
            <TabsContent value="designs" className="mt-6">
              <SavedDesignsSection />
            </TabsContent>
            <TabsContent value="motifs" className="mt-6">
              <MyMotifsSection />
            </TabsContent>
            <TabsContent value="stash" className="mt-6">
              <ThreadStashSection userId={user.id} />
            </TabsContent>
            <TabsContent value="orders" className="mt-6">
              <OrdersSection />
            </TabsContent>
            <TabsContent value="progress" className="mt-6">
              <ProgressSection />
            </TabsContent>
            <TabsContent value="account" className="mt-6">
              <AccountInfoSection />
            </TabsContent>
          </Tabs>
        )}
      </main>

      <AuthModal open={authOpen} onOpenChange={setAuthOpen} />
    </div>
  );
}

// ── shared designs fetch ─────────────────────────────────────────────────────
// Same query shape as refreshMyDesigns in src/routes/index.tsx (RLS scopes it
// to the signed-in user).
function useDesigns() {
  const [designs, setDesigns] = useState<DesignRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("designs")
      .select("id, name, thumbnail_url, updated_at")
      .order("updated_at", { ascending: false });
    setDesigns((data as DesignRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { designs, loading, refresh, setDesigns };
}

// ── 1. Saved Designs ─────────────────────────────────────────────────────────
function SavedDesignsSection() {
  const navigate = useNavigate();
  const { designs, loading, refresh } = useDesigns();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setError(null);
    setDeletingId(id);
    const { error: err } = await supabase.from("designs").delete().eq("id", id);
    setDeletingId(null);
    if (err) {
      setError(
        err.message.includes("foreign key")
          ? "This design has an order on it, so it can't be deleted."
          : err.message,
      );
      return;
    }
    refresh();
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Open a design to keep working on it, or delete ones you no longer need.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : designs.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
          You haven't saved any designs yet.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {designs.map((d) => (
            <div key={d.id} className="rounded-md border border-border bg-secondary/40 p-2">
              <button
                type="button"
                onClick={() => navigate({ to: "/", search: { design: d.id } })}
                className="block w-full"
              >
                <div className="aspect-square w-full overflow-hidden rounded bg-secondary">
                  {d.thumbnail_url ? (
                    <img
                      src={d.thumbnail_url}
                      alt={d.name}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] italic text-muted-foreground">
                      No preview
                    </div>
                  )}
                </div>
                <p className="mt-1 truncate text-xs font-medium">{d.name}</p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {new Date(d.updated_at).toLocaleDateString()}
                </p>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(d.id)}
                disabled={deletingId === d.id}
                className="mt-1 h-7 w-full text-xs text-destructive hover:text-destructive"
              >
                {deletingId === d.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <Trash2 className="mr-1 h-3 w-3" />
                    Delete
                  </>
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 2. Thread Stash ──────────────────────────────────────────────────────────
function ThreadStashSection({ userId }: { userId: string }) {
  const [rows, setRows] = useState<StashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [brand, setBrand] = useState<ThreadBrand>("appletons");
  const [colour, setColour] = useState<ThreadColor | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<ThreadUnit>("skein");
  const [location, setLocation] = useState("");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { rows: r, error: err } = await listStash();
    setRows(r);
    setError(err);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setColour(null);
  }, [brand]);

  async function handleAdd() {
    if (!colour) return;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0) return;
    setAdding(true);
    const { error: err } = await addStashLine(userId, {
      brand,
      code: colour.code,
      name: colour.name,
      quantity: qty,
      unit,
      location,
    });
    setAdding(false);
    if (err) {
      setError(err);
      return;
    }
    setColour(null);
    setQuantity("1");
    setLocation("");
    refresh();
  }

  async function patch(id: string, p: Parameters<typeof updateStashLine>[1]) {
    const { error: err } = await updateStashLine(id, p);
    if (err) setError(err);
  }

  async function handleDelete(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    const { error: err } = await deleteStashLine(id);
    if (err) {
      setError(err);
      refresh();
    }
  }

  // Grouped by brand, then sorted by thread family so shades sit together —
  // the way a stitcher scans a physical thread box.
  const grouped = useMemo(() => {
    const byBrand = new Map<string, StashRow[]>();
    for (const r of rows) {
      const key = r.brand.trim().toLowerCase();
      if (!byBrand.has(key)) byBrand.set(key, []);
      byBrand.get(key)!.push(r);
    }
    for (const [key, list] of byBrand) {
      const palette = THREAD_PALETTES[key as ThreadBrand] ?? [];
      const familyOf = (code: string) =>
        palette.find((p) => p.code.toLowerCase() === code.trim().toLowerCase())?.family ?? "";
      list.sort(
        (a, b) =>
          familyOf(a.code).localeCompare(familyOf(b.code)) || a.code.localeCompare(b.code),
      );
    }
    return Array.from(byBrand.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  function hexOf(row: StashRow): string {
    const palette = THREAD_PALETTES[row.brand.trim().toLowerCase() as ThreadBrand] ?? [];
    return (
      palette.find((p) => p.code.toLowerCase() === row.code.trim().toLowerCase())?.hex ?? "#cccccc"
    );
  }

  return (
    <section className="space-y-6">
      <p className="text-sm text-muted-foreground">
        What you already own. The Thread Shopping List uses this to tell you when you
        already have a colour — or something close enough to substitute.
      </p>

      <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-4">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Add a thread
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1">
            <Label className="text-xs">Brand</Label>
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value as ThreadBrand)}
              className={`${selectClass} w-full`}
            >
              {BRANDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col items-start gap-1">
            <span className="text-xs font-medium leading-none">Colour</span>
            <SwatchPicker
              value={colour}
              onChange={setColour}
              palette={THREAD_PALETTES[brand]}
              triggerLabel="Find a colour"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="stash-qty">
              Quantity
            </Label>
            <Input
              id="stash-qty"
              type="number"
              min="0"
              step="0.5"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Unit</Label>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as ThreadUnit)}
              className={`${selectClass} w-full capitalize`}
            >
              {THREAD_UNITS.map((u) => (
                <option key={u} value={u} className="capitalize">
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="stash-loc">
              Where it lives (optional)
            </Label>
            <Input
              id="stash-loc"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Second drawer"
              maxLength={120}
            />
          </div>
        </div>
        <Button onClick={handleAdd} disabled={adding || !colour}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add to stash"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">Your stash is empty so far.</p>
      ) : (
        <div className="space-y-6">
          {grouped.map(([brandKey, list]) => (
            <div key={brandKey} className="space-y-2">
              <h3 className="font-serif text-lg capitalize">
                {BRANDS.find((b) => b.id === brandKey)?.label ?? brandKey}{" "}
                <span className="text-xs text-muted-foreground">({list.length})</span>
              </h3>
              <ul className="divide-y divide-border rounded-md border border-border bg-card">
                {list.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                    <span
                      className="inline-block h-5 w-5 shrink-0 rounded border border-border"
                      style={{ backgroundColor: hexOf(r) }}
                    />
                    <div className="min-w-[140px] flex-1">
                      <div className="font-medium">
                        {r.name ?? r.code}{" "}
                        <span className="text-xs text-muted-foreground">({r.code})</span>
                      </div>
                    </div>
                    <Input
                      type="number"
                      min="0"
                      step="0.5"
                      aria-label="Quantity"
                      value={String(r.quantity)}
                      onChange={(e) => {
                        const q = Number(e.target.value);
                        setRows((prev) =>
                          prev.map((x) => (x.id === r.id ? { ...x, quantity: q } : x)),
                        );
                      }}
                      onBlur={() => patch(r.id, { quantity: r.quantity })}
                      className="h-9 w-20"
                    />
                    <select
                      aria-label="Unit"
                      value={r.unit}
                      onChange={(e) => {
                        const u = e.target.value as ThreadUnit;
                        setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, unit: u } : x)));
                        patch(r.id, { unit: u });
                      }}
                      className={`${selectClass} capitalize`}
                    >
                      {THREAD_UNITS.map((u) => (
                        <option key={u} value={u} className="capitalize">
                          {u}
                        </option>
                      ))}
                    </select>
                    <Input
                      aria-label="Location"
                      value={r.location ?? ""}
                      placeholder="Where it lives"
                      onChange={(e) => {
                        const v = e.target.value;
                        setRows((prev) =>
                          prev.map((x) => (x.id === r.id ? { ...x, location: v } : x)),
                        );
                      }}
                      onBlur={() => patch(r.id, { location: r.location ?? null })}
                      className="h-9 w-40"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(r.id)}
                      className="h-8 text-xs text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 3. Progress ──────────────────────────────────────────────────────────────
// Reuses the chart's own progress-marking UI (StitchChart in progressOnly
// presentation) against a chosen SAVED design's chart_data + stitch_progress,
// with the same reconcile-on-load rule as loadDesign in index.tsx and a
// debounced write back to designs.stitch_progress.
function ProgressSection() {
  const { designs, loading } = useDesigns();
  const [selectedId, setSelectedId] = useState<string>("");
  const [chart, setChart] = useState<ChartData | null>(null);
  const [progress, setProgress] = useState<ProgressGrid | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setChart(null);
      setProgress(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setNote(null);
    (async () => {
      const { data, error } = await supabase
        .from("designs")
        .select("chart_data, stitch_progress")
        .eq("id", selectedId)
        .single();
      if (cancelled) return;
      setBusy(false);
      if (error || !data) {
        setNote("Could not load that design.");
        return;
      }
      const loadedChart = data.chart_data as unknown as ChartData | null;
      setChart(loadedChart);
      if (!loadedChart) {
        setProgress(null);
        setNote("This design doesn't have a stitch chart yet, so there's nothing to track.");
        return;
      }
      let grid = makeProgressGrid(loadedChart.width, loadedChart.height);
      if (data.stitch_progress) {
        try {
          const result = reconcileProgress(deserializeProgress(data.stitch_progress), {
            width: loadedChart.width,
            height: loadedChart.height,
          });
          if (result.ok && result.snapshot) grid = snapshotToGrid(result.snapshot);
          else setNote("Saved progress didn't match this chart's size, so it's starting fresh.");
        } catch {
          setNote("Saved progress couldn't be read, so it's starting fresh.");
        }
      }
      setProgress(grid);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Debounced write-back, same 1500ms cadence as the chart page's autosave.
  useEffect(() => {
    if (!selectedId || !progress) return;
    const t = setTimeout(async () => {
      await supabase
        .from("designs")
        .update({ stitch_progress: serializeProgress(gridToSnapshot(progress)) })
        .eq("id", selectedId);
    }, 1500);
    return () => clearTimeout(t);
  }, [progress, selectedId]);

  // Stitchable total comes from the chart's own usage (masked NOT_STITCHABLE
  // cells are never paintable, so they must not count towards the total).
  const stats = useMemo(() => {
    if (!progress || !chart) return null;
    const nsIdx = chart.palette.findIndex((p) => p.id === NOT_STITCHABLE);
    const usage = chart.usage;
    const masked =
      nsIdx < 0
        ? 0
        : Array.isArray(usage)
          ? (usage[nsIdx] ?? 0)
          : (usage?.[String(nsIdx)] ?? 0);
    const total = Math.max(0, chart.width * chart.height - masked);
    let done = 0;
    for (const row of progress) for (const cell of row) if (cell) done++;
    const percent = total === 0 ? 0 : Math.round((done / total) * 1000) / 10;
    return { completed: done, totalStitchable: total, percent };
  }, [progress, chart]);

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Pick a saved design and tap or drag on the chart to mark stitches complete. Progress
        saves automatically.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Design</Label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className={`${selectClass} min-w-[240px]`}
            disabled={loading}
          >
            <option value="">Choose a design…</option>
            {designs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        {stats && (
          <p className="text-sm">
            <span className="font-medium">
              {stats.completed} / {stats.totalStitchable} st
            </span>{" "}
            <span className="text-muted-foreground">({stats.percent}%)</span>
          </p>
        )}
      </div>

      {note && <p className="text-sm text-muted-foreground">{note}</p>}

      {busy ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : chart && progress ? (
        <StitchChart
          chart={chart}
          progress={progress}
          onProgressChange={setProgress}
          progressOnly
        />
      ) : (
        !selectedId && (
          <p className="text-sm italic text-muted-foreground">
            No design chosen yet.
          </p>
        )
      )}
    </section>
  );
}

// ── 4. My Motifs ─────────────────────────────────────────────────────────────
// Same layer-transparency sentinel used by the charting page when compositing
// motifs (src/routes/index.tsx) -- transparent cells render as checkerboard.
const MOTIF_SENTINEL = "__LAYER_TRANSPARENT__";

function MotifThumb({ motif }: { motif: MotifRecord }) {
  const dataUrl = useMemo(() => {
    const hexByCode = new Map<string, string>();
    for (const t of THREAD_PALETTES[motif.brand] ?? []) hexByCode.set(t.code, t.hex);
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
        if (!code || code === MOTIF_SENTINEL) {
          img.data[i + 3] = 0;
          continue;
        }
        const hex = hexByCode.get(code) ?? "#CCCCCC";
        img.data[i] = parseInt(hex.slice(1, 3), 16);
        img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
        img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }, [motif]);

  return (
    <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-secondary [background-image:linear-gradient(45deg,#0000000d_25%,transparent_25%),linear-gradient(-45deg,#0000000d_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#0000000d_75%),linear-gradient(-45deg,transparent_75%,#0000000d_75%)] [background-size:8px_8px]">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={motif.name}
          className="h-full w-full object-contain"
          style={{ imageRendering: "pixelated" }}
          loading="lazy"
        />
      ) : (
        <div className="text-[10px] italic text-muted-foreground">No preview</div>
      )}
    </div>
  );
}

function MyMotifsSection() {
  const [motifs, setMotifs] = useState<MotifRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const { motifs: m, error: err } = await listMyMotifs();
    setMotifs(m);
    setError(err);
    setLoading(false);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete "${name}" from your motif library? This can't be undone.`)) return;
    const { error: err } = await deleteMotif(id);
    if (err) {
      setError(err);
      return;
    }
    refresh();
  }

  async function handleRenameSave(id: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    const { error: err } = await renameMotif(id, trimmed);
    setRenamingId(null);
    if (err) {
      setError(err);
      return;
    }
    refresh();
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Motifs you've saved from any chart, across every thread brand.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : motifs.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
          No personal motifs saved yet — use "Save as Motif" while charting to build your library.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {motifs.map((m) => (
            <div key={m.id} className="rounded-md border border-border bg-secondary/40 p-2">
              <MotifThumb motif={m} />
              {renamingId === m.id ? (
                <div className="mt-1 flex gap-1">
                  <Input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="h-7 text-xs"
                    autoFocus
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleRenameSave(m.id)}
                    className="h-7 px-2 text-xs"
                  >
                    Save
                  </Button>
                </div>
              ) : (
                <p className="mt-1 truncate text-xs font-medium">{m.name}</p>
              )}
              <p className="text-[10px] text-muted-foreground">
                {m.brand} · {m.width}x{m.height}
              </p>
              <div className="mt-1 flex gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRenamingId(m.id);
                    setRenameValue(m.name);
                  }}
                  className="h-7 flex-1 text-xs"
                >
                  Rename
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(m.id, m.name)}
                  className="h-7 flex-1 text-xs text-destructive hover:text-destructive"
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 5. Orders ────────────────────────────────────────────────────────────────
interface OrderRow {
  id: string;
  design_id: string;
  status: string;
  order_details: Record<string, unknown> | null;
  created_at: string;
}

function OrdersSection() {
  const { designs } = useDesigns();
  const designById = useMemo(() => new Map(designs.map((d) => [d.id, d])), [designs]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("orders")
      .select("id, design_id, status, order_details, created_at")
      .order("created_at", { ascending: false });
    if (err) setError(err.message);
    setOrders((data as unknown as OrderRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCancel(id: string) {
    setCancellingId(id);
    const { error: err } = await supabase
      .from("orders")
      .update({ status: "cancelled" })
      .eq("id", id);
    setCancellingId(null);
    if (err) {
      setError(err.message);
      return;
    }
    refresh();
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every design you've placed an order for, most recent first.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : orders.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">No orders yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {orders.map((o) => {
            const design = designById.get(o.design_id);
            const details = o.order_details ?? {};
            return (
              <li key={o.id} className="flex flex-wrap items-center gap-4 p-3">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded bg-secondary">
                  {design?.thumbnail_url ? (
                    <img
                      src={design.thumbnail_url}
                      alt={design.name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[9px] italic text-muted-foreground">
                      No preview
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{design?.name ?? "Deleted design"}</div>
                  <div className="text-xs text-muted-foreground">
                    {typeof details.finishedWidthInches === "number" &&
                    typeof details.finishedHeightInches === "number"
                      ? `${details.finishedWidthInches}" x ${details.finishedHeightInches}" · `
                      : ""}
                    {typeof details.meshCount === "number" ? `${details.meshCount} mesh · ` : ""}
                    {typeof details.threadBrand === "string" ? details.threadBrand : ""}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Ordered {new Date(o.created_at).toLocaleDateString()}
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                    o.status === "cancelled"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {o.status}
                </span>
                {o.status === "pending" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCancel(o.id)}
                    disabled={cancellingId === o.id}
                    className="text-destructive hover:text-destructive"
                  >
                    {cancellingId === o.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Cancel"
                    )}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── 6. Account info ──────────────────────────────────────────────────────────
function AccountInfoSection() {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaved, setPwSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .single();
      if (!err && data) setDisplayName(data.display_name ?? "");
      setLoading(false);
    })();
  }, [user]);

  async function handleSaveName() {
    if (!user) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const { error: err } = await supabase
      .from("profiles")
      .update({ display_name: displayName.trim() })
      .eq("id", user.id);
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSaved(true);
  }

  async function handleChangePassword() {
    if (newPassword.length < 8) {
      setPwError("Password must be at least 8 characters.");
      return;
    }
    setPwSaving(true);
    setPwError(null);
    setPwSaved(false);
    const { error: err } = await supabase.auth.updateUser({ password: newPassword });
    setPwSaving(false);
    if (err) {
      setPwError(err.message);
      return;
    }
    setNewPassword("");
    setPwSaved(true);
  }

  return (
    <section className="max-w-md space-y-8">
      <div className="space-y-3">
        <h3 className="font-serif text-lg">Your details</h3>
        <div className="space-y-1">
          <Label className="text-xs">Email</Label>
          <p className="text-sm text-muted-foreground">{user?.email}</p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="display-name">
            Display name
          </Label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSaved(false);
            }}
            disabled={loading}
            maxLength={80}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="button" onClick={handleSaveName} disabled={saving || loading}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </Button>
        {saved && <span className="ml-2 text-xs text-muted-foreground">Saved ✓</span>}
      </div>

      <div className="space-y-3 border-t border-border pt-6">
        <h3 className="font-serif text-lg">Change password</h3>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="new-password">
            New password
          </Label>
          <Input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setPwSaved(false);
            }}
            minLength={8}
            placeholder="At least 8 characters"
          />
        </div>
        {pwError && <p className="text-sm text-destructive">{pwError}</p>}
        <Button type="button" onClick={handleChangePassword} disabled={pwSaving || !newPassword}>
          {pwSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update password"}
        </Button>
        {pwSaved && (
          <span className="ml-2 text-xs text-muted-foreground">Password updated ✓</span>
        )}
      </div>
    </section>
  );
}
