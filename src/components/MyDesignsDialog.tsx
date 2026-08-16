import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2 } from "lucide-react";

export interface DesignSummary {
  id: string;
  name: string;
  thumbnail_url: string | null;
  updated_at: string;
}

export function MyDesignsDialog({
  open,
  onOpenChange,
  designs,
  loading,
  currentDesignId,
  currentDesignName,
  onSave,
  onSaveAsNew,
  onLoad,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  designs: DesignSummary[];
  loading: boolean;
  currentDesignId: string | null;
  currentDesignName: string;
  onSave: (name: string) => Promise<void>;
  onSaveAsNew: (name: string) => Promise<void>;
  onLoad: (id: string) => void;
  onDelete: (id: string) => Promise<{ error: string | null }>;
}) {
  const [name, setName] = useState(currentDesignName);
  const [saving, setSaving] = useState(false);
  const [savingNew, setSavingNew] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave(name.trim());
    } catch {
      /* error already surfaced by saveDesign */
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAsNew() {
    if (!name.trim()) return;
    setSavingNew(true);
    try {
      await onSaveAsNew(name.trim());
    } catch {
      /* error already surfaced by saveDesign */
    } finally {
      setSavingNew(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteError(null);
    setDeletingId(id);
    const { error } = await onDelete(id);
    setDeletingId(null);
    if (error) setDeleteError(error);
  }

  const busy = saving || savingNew;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>My Designs</DialogTitle>
          <DialogDescription>
            Save your current design, or load and manage designs you've saved before.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-4">
          <Label htmlFor="design-name" className="font-serif text-sm">
            {currentDesignId ? "Design name" : "Save current design as"}
          </Label>
          <Input
            id="design-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Whippet circle for Mum"
            maxLength={80}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={busy || !name.trim()}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : currentDesignId ? (
                "Save changes"
              ) : (
                "Save"
              )}
            </Button>
            {currentDesignId && (
              <Button
                type="button"
                variant="secondary"
                onClick={handleSaveAsNew}
                disabled={busy || !name.trim()}
              >
                {savingNew ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save as new"}
              </Button>
            )}
          </div>
          {currentDesignId && (
            <p className="text-[11px] italic text-muted-foreground">
              "Save changes" updates the design you currently have loaded.
              "Save as new" creates a separate copy and switches to it.
            </p>
          )}
        </div>


        {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Saved designs
          </p>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : designs.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-secondary/40 px-4 py-8 text-center text-xs italic text-muted-foreground">
              No saved designs yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {designs.map((d) => (
                <div
                  key={d.id}
                  className={`rounded-md border p-2 ${
                    d.id === currentDesignId
                      ? "border-primary bg-primary/10"
                      : "border-border bg-secondary/40"
                  }`}
                >
                  <button type="button" onClick={() => onLoad(d.id)} className="block w-full">
                    <div className="aspect-square w-full overflow-hidden rounded bg-secondary">
                      {d.thumbnail_url ? (
                        <img
                          src={d.thumbnail_url}
                          alt={d.name}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
