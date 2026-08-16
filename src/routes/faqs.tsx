import { createFileRoute } from "@tanstack/react-router";
import { NavMenu } from "@/components/NavMenu";

export const Route = createFileRoute("/faqs")({
  head: () => ({
    meta: [
      { title: "FAQs — Tessella Studio" },
      {
        name: "description",
        content:
          "Answers to common questions about Tessella Studio canvases, thread brands, sizing and ordering.",
      },
      { property: "og:title", content: "FAQs — Tessella Studio" },
      {
        property: "og:description",
        content:
          "Answers to common questions about Tessella Studio canvases, thread brands, sizing and ordering.",
      },
    ],
  }),
  component: FaqsPage,
});

const FAQS = [
  {
    q: "Which thread brands do you support?",
    a: "Currently Appletons Tapestry Wool and DMC Perle Cotton (Size 5). Each palette is grouped by colour family inside the designer.",
  },
  {
    q: "How do I choose the canvas size?",
    a: "Set your finished width and height in Step 07 (Canvas Specification). We calculate the stitch grid for you based on your chosen mesh count.",
  },
  {
    q: "Can I upload my own border?",
    a: "Yes. In Step 05 choose Custom Upload to add an SVG that will be re-coloured to match your chosen border colour.",
  },
  {
    q: "What happens after I place my order?",
    a: "We print your design onto your chosen canvas, double-check the colour mapping against your selected palette and ship it ready to stitch. We will also email you a downloadable stitch map on the day of dispatch to accompany the physical copy of it that will come with your canvas. ",
  },
];

function FaqsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-[#3d5a2a] text-[#f2e9d4]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <h1
            className="text-3xl tracking-tight font-black"
            style={{ fontFamily: "'IM Fell DW Pica SC', serif" }}
          >
            T e s s e l l a &nbsp; S t u d i o
          </h1>
          <NavMenu />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h2 className="font-serif text-4xl">FAQs</h2>
        <dl className="mt-8 space-y-6">
          {FAQS.map((item) => (
            <div key={item.q} className="rounded-md border border-border bg-card p-5">
              <dt className="font-serif text-lg">{item.q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {item.a}
              </dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  );
}
