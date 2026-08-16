import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data, error } = await supabase.storage
    .from("designs")
    .createSignedUrl("uploads/1782043654880-6s28yq.png", 60 * 60 * 24 * 7);
  return new Response(JSON.stringify({ data, error }), {
    headers: { "content-type": "application/json" },
  });
});
