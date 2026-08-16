import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ThreadColor } from "@/data/threadPalettes";

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "10px 14px",
  border: "1px solid #D4C4A0",
  borderRadius: "4px",
  background: "#F5F0E8",
  fontFamily: "'Palatino Linotype',Georgia,serif",
  fontSize: "14px",
  color: "#2C1810",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

export type SwatchPickerProps = {
  value: ThreadColor | null;
  onChange: (color: ThreadColor) => void;
  palette: ThreadColor[];
  disabled?: boolean;
  compact?: boolean;
  /** Optional replacement for the default "Choose…" placeholder text. */
  triggerLabel?: string;
};

/**
 * Single reusable colour picker used everywhere a thread colour is chosen.
 * Groups palette by family (preserving first-seen order) with search.
 */
export function SwatchPicker({ value, onChange, palette, disabled, compact, triggerLabel }: SwatchPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const vh = window.innerHeight;
      const spaceBelow = vh - r.bottom - 8;
      const spaceAbove = r.top - 8;
      const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      const maxH = Math.min(420, Math.max(180, openUp ? spaceAbove : spaceBelow));
      const width = 320;
      let left = r.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      if (left < 8) left = 8;
      const top = openUp ? Math.max(8, r.top - maxH - 6) : r.bottom + 6;
      setPos({ top, left, maxHeight: maxH });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    if (open) document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);


  const ql = q.trim().toLowerCase();
  const filtered = palette.filter(
    (c) =>
      !ql ||
      c.name.toLowerCase().includes(ql) ||
      c.code.toLowerCase().includes(ql) ||
      c.family.toLowerCase().includes(ql),
  );

  // Preserve first-seen family order.
  const families: Array<{ family: string; colors: ThreadColor[] }> = [];
  const famIndex = new Map<string, number>();
  for (const c of filtered) {
    let idx = famIndex.get(c.family);
    if (idx === undefined) {
      idx = families.length;
      famIndex.set(c.family, idx);
      families.push({ family: c.family, colors: [] });
    }
    families[idx].colors.push(c);
  }

  const sw = compact ? 26 : 30;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "5px 8px",
          border: "1px solid #D4C4A0",
          borderRadius: "4px",
          background: disabled ? "#E5DECF" : "#F5F0E8",
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span
          style={{
            width: sw,
            height: sw,
            borderRadius: "3px",
            border: "1px solid rgba(0,0,0,0.18)",
            background: value ? value.hex : "#FFFFFF",
            flexShrink: 0,
          }}
        />
        {!compact && (
          <span
            style={{
              fontSize: "12px",
              color: "#2C1810",
              maxWidth: "140px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {value ? value.name : disabled ? "Pick brand first" : (triggerLabel ?? "Choose…")}
          </span>
        )}
        {!compact && <span style={{ fontSize: "10px", color: "#8A7A60" }}>▾</span>}
      </button>

      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={popRef}
          style={{
            position: "fixed",
            zIndex: 1000,
            top: pos.top,
            left: pos.left,
            width: "320px",
            maxHeight: pos.maxHeight,
            overflowY: "auto",
            background: "#F8F4EC",
            border: "1px solid #8B6914",
            borderRadius: "8px",
            boxShadow: "0 12px 30px rgba(44,24,16,0.25)",
            padding: "12px",
          }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or number…"
            style={{ ...inputStyle, marginBottom: "10px", padding: "8px 10px", fontSize: "13px" }}
          />
          {families.length === 0 && (
            <div style={{ fontSize: "12px", color: "#8A7A60", padding: "8px" }}>No matches.</div>
          )}
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
                {colors.map((c) => {
                  const sel = !!value && value.code === c.code;
                  return (
                    <button
                      key={c.code}
                      type="button"
                      title={`${c.name} · ${c.code}`}
                      onClick={() => {
                        onChange(c);
                        setOpen(false);
                      }}
                      style={{
                        width: "26px",
                        height: "26px",
                        borderRadius: "3px",
                        cursor: "pointer",
                        background: c.hex,
                        border: sel ? "2px solid #2C1810" : "1px solid rgba(0,0,0,0.15)",
                        boxShadow: sel ? "0 0 0 2px #C9A84C" : "none",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}

    </div>
  );
}
