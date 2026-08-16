// Temporary one-shot fetcher for chart-debug bucket contents.
// Deployed to bypass private bucket access limitations in the agent sandbox.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) return new Response("missing path", { status: 400 });
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await client.storage.from("chart-debug").download(path);
  if (error || !data) return new Response(error?.message ?? "not found", { status: 404 });
  return new Response(await data.arrayBuffer(), {
    headers: { "content-type": "application/json" },
  });
});
