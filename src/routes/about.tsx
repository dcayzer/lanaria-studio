import { createFileRoute } from "@tanstack/react-router";
import { NavMenu } from "@/components/NavMenu";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About Us — Tessella Studio" },
      {
        name: "description",
        content:
          "Learn about Tessella Studio — the team behind the custom needlepoint and tapestry canvas designer.",
      },
      { property: "og:title", content: "About Us — Tessella Studio" },
      {
        property: "og:description",
        content:
          "Learn about Tessella Studio — the team behind the custom needlepoint and tapestry canvas designer.",
      },
    ],
  }),
  component: AboutPage,
});

function AboutPage() {
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
        <h2 className="font-serif text-4xl">About Us</h2>
        <p className="mt-6 text-base leading-relaxed text-muted-foreground whitespace-pre-line">
          Tessella Studio is a custom needlepoint and tapestry canvas designer. Traditional needlepoint is a luxury and can have long lead times due to the handpainted nature of the craft.

          We help stitchers turn ideas, photographs, lettering and monograms into beautiful custom printed canvases ready for you in a fraction of the time. 
        </p>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Every canvas is built around your choices: thread brand, palette,
          border style and finished size — so the finished piece is unmistakably
          yours. The only limit is your creativity.
        </p>
      </main>
    </div>
  );
}
