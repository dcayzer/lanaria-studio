// Generate an image from prompts using the Lovable AI Gateway.
// Returns { imageUrl } as a data URL the client can render directly.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { positivePrompt, negativePrompt, width = 1024, height = 1024 } =
      await req.json();

    if (!positivePrompt || typeof positivePrompt !== "string") {
      return new Response(
        JSON.stringify({ error: "positivePrompt is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "LOVABLE_API_KEY is not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const prompt = [
      "Create one finished image for a needlepoint canvas design.",
      "The image must be a FLAT vector-style illustration: solid, opaque, uniform colour fills with crisp clean edges between every region. Think: simple flat icon.",
      "CRITICAL — every region must be ONE single flat colour with zero variation. No gradients. No colour blending within a region. No soft edges or feathering between regions.",
      "CRITICAL — Flat colour fills only — no gradients, no anti-aliasing between colour regions, no soft edges. Every region must have a single solid colour with a hard edge.",
      "CRITICAL — All details must be rendered with clean, hard-edged fills. No hairline elements — any detail that is intended to be visible must occupy a solid filled region, not a single pixel line.",
      "CRITICAL — no transparency, no translucency, no glass effects. Even naturally transparent objects (glass, water, ice) must be rendered with a solid opaque flat fill colour, as if painted with one coat of flat paint.",
      "CRITICAL — no reflections, no specular highlights, no gloss, no shine, no light bouncing off surfaces. No drop shadows. No ambient occlusion. Surfaces are completely matte and flat.",
      "CRITICAL — salt rim beads and lime pith lines must be rendered in a very light cream or off-white colour (e.g. #F0EFE8 or similar) NOT pure white (#FFFFFF). They must be visually distinct from the white canvas background so the chart engine can detect them as design features.",
      "CRITICAL — if the subject is bilaterally symmetric (a house, face, vase, bottle, animal seen front-on, vehicle seen from front or side), it must be rendered with PERFECT LEFT-RIGHT SYMMETRY. Windows, doors, steps, columns, and decorative elements must be centred and evenly spaced. Exception: a house should have only ONE chimney, positioned off-centre to one side of the roof — do NOT mirror the chimney.",
      "CRITICAL — for houses: window frames must have perfectly even surrounds — the cream/white border around each window must be exactly the same width on all four sides (left, right, top, bottom). The window and its frame must be centred within the wall region. The cream surround must be a single stitch wide at the canvas resolution.",
      "CRITICAL — all repeated internal elements within a single shape (window panes within a window frame, bricks within a wall, petals within a flower) must be IDENTICAL in size and evenly divided by their dividing lines. A window with 4 panes must have 4 equal panes separated by lines that cross exactly at the centre of the window.",
      "CRITICAL — for houses and buildings: windows must be simple rectangular shapes with at most one horizontal and one vertical glazing bar dividing them into 4 panes. Do NOT add shutters, louvres, window grilles, decorative grilles, venetian blinds, awnings, or any repeated fine linear detail alongside windows. Do NOT use circular, arched, oval, or porthole windows. Stairs and steps must be perfectly horizontal and centred symmetrically under the door.",
      "Do NOT render the image as if it were already stitched or embroidered — no thread texture, no stitch marks, no fabric grain, no noise or dithering.",
      "Use a small, bold palette of 5–8 well-separated colours. Colours should be saturated and distinct, not pale or washed out.",
      "This image will be analyzed pixel-by-pixel to extract colour regions for a stitch chart — flat uniform fills are essential; any gradient or texture baked into the image will produce a broken chart.",
      "Return image data only; do not ask questions and do not respond with text.",
      `Subject: ${positivePrompt}.`,
      negativePrompt ? `Avoid: ${negativePrompt}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const aiRes = await fetch(
      "https://ai.gateway.lovable.dev/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-image-2",
          prompt,
          size: `${width}x${height}`,
          quality: "low",
          n: 1,
        }),
      },
    );

    if (!aiRes.ok) {
      const text = await aiRes.text();
      console.error("AI gateway error", aiRes.status, text);
      return new Response(
        JSON.stringify({ error: "Image generation failed" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const data = await aiRes.json();
    const b64Json: string | undefined = data?.data?.[0]?.b64_json;
    const imageUrl: string | undefined = b64Json
      ? `data:image/png;base64,${b64Json}`
      : data?.data?.[0]?.url;

    if (!imageUrl) {
      console.error("No image in response", JSON.stringify(data).slice(0, 500));
      return new Response(
        JSON.stringify({ error: "No image returned" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Capture the Gateway's usage block instead of discarding it -- this is
    // currently the only source of real per-generation cost data, since
    // Lovable resells the model and the credit cost isn't the upstream
    // provider's public rate card. Logged with a distinctive, grep-able
    // prefix and also returned in the response so the caller has the option
    // to persist it -- deliberately NOT writing it into a new database table
    // yet: this is the first real look at the shape of this field for this
    // specific endpoint, and designing a schema before seeing real data
    // would repeat a mistake already learned from elsewhere in this project.
    const usage = data?.usage ?? null;
    if (usage) {
      console.log("generate usage:", JSON.stringify(usage));
    } else {
      console.log("generate usage: none returned by gateway for this call");
    }

    return new Response(JSON.stringify({ imageUrl, width, height, usage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("generate error", err);
    return new Response(
      JSON.stringify({ error: "Unexpected error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
