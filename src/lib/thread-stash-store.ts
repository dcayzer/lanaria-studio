// Data layer for the user's thread stash (thread_stash table).
//
// Deliberately thin: mirrors the way `designs` are fetched in src/routes/index.tsx
// (a plain Supabase query scoped by RLS to the signed-in user), and converts DB
// rows into the pure StashEntry shape thread-inventory.ts / thread-swap-bridge.ts
// already expect, so neither of those modules learns about Supabase.

import { supabase } from "@/integrations/supabase/client";
import type { StashEntry, ThreadUnit } from "@/lib/thread-inventory";

export const THREAD_UNITS: ThreadUnit[] = ["skein", "card", "hank", "spool"];

export interface StashRow extends StashEntry {
  id: string;
  unit: ThreadUnit;
}

function toUnit(u: string): ThreadUnit {
  return (THREAD_UNITS as string[]).includes(u) ? (u as ThreadUnit) : "skein";
}

export async function listStash(): Promise<{ rows: StashRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("thread_stash")
    .select("*")
    .order("brand", { ascending: true })
    .order("code", { ascending: true });
  if (error) return { rows: [], error: error.message };
  const rows: StashRow[] = (data ?? []).map((r) => ({
    id: r.id,
    brand: r.brand,
    code: r.code,
    name: r.name ?? undefined,
    quantity: Number(r.quantity),
    unit: toUnit(r.unit),
    location: r.location ?? undefined,
    updatedAt: r.updated_at,
  }));
  return { rows, error: null };
}

export async function addStashLine(
  userId: string,
  line: { brand: string; code: string; name?: string; quantity: number; unit: ThreadUnit; location?: string },
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("thread_stash").insert({
    user_id: userId,
    brand: line.brand,
    code: line.code,
    name: line.name ?? null,
    quantity: line.quantity,
    unit: line.unit,
    location: line.location?.trim() ? line.location.trim() : null,
  });
  return { error: error?.message ?? null };
}

export async function updateStashLine(
  id: string,
  patch: { quantity?: number; unit?: ThreadUnit; location?: string | null },
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("thread_stash")
    .update({
      ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
      ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
      ...(patch.location !== undefined
        ? { location: patch.location && patch.location.trim() ? patch.location.trim() : null }
        : {}),
    })
    .eq("id", id);
  return { error: error?.message ?? null };
}

export async function deleteStashLine(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("thread_stash").delete().eq("id", id);
  return { error: error?.message ?? null };
}
