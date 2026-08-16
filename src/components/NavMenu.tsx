import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { AuthModal } from "@/components/AuthModal";

type NavMenuProps = {
  color?: string;
  triggerBg?: string;
};

const PAGES = [
  { to: "/", label: "Home" },
  { to: "/about", label: "About Us" },
  { to: "/faqs", label: "FAQs" },
] as const;

export function NavMenu({ color = "#f2e9d4", triggerBg = "transparent" }: NavMenuProps) {
  const [open, setOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const { user, signOut } = useAuth();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      const r = btnRef.current!.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
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
      if (btnRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    if (open) document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 14px",
          borderRadius: "4px",
          border: `1px solid ${color}`,
          background: triggerBg,
          color,
          fontFamily: "'IM Fell DW Pica SC', serif",
          fontSize: "14px",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        Menu
        <span aria-hidden style={{ fontSize: "10px" }}>▾</span>
      </button>

      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={popRef}
          role="menu"
          style={{
            position: "fixed",
            top: pos.top,
            right: pos.right,
            minWidth: "160px",
            background: "#F8F4EC",
            border: "1px solid #8B6914",
            borderRadius: "6px",
            boxShadow: "0 12px 30px rgba(44,24,16,0.25)",
            overflow: "hidden",
            zIndex: 1000,
          }}
        >
          {PAGES.map((p) => (
            <Link
              key={p.to}
              to={p.to}
              role="menuitem"
              onClick={() => setOpen(false)}
              activeOptions={{ exact: true }}
              activeProps={{
                style: { background: "#EFE3C8", fontWeight: 600 },
              }}
              style={{
                display: "block",
                padding: "10px 14px",
                color: "#2C1810",
                fontFamily: "'IM Fell DW Pica SC', serif",
                fontSize: "14px",
                textDecoration: "none",
              }}
            >
              {p.label}
            </Link>
          ))}
          <div style={{ borderTop: "1px solid #E5DCC7", margin: "4px 0" }} />
          {user ? (
            <>
              <Link
                to="/account"
                role="menuitem"
                onClick={() => setOpen(false)}
                activeOptions={{ exact: true }}
                activeProps={{ style: { background: "#EFE3C8", fontWeight: 600 } }}
                style={{
                  display: "block",
                  padding: "10px 14px",
                  color: "#2C1810",
                  fontFamily: "'IM Fell DW Pica SC', serif",
                  fontSize: "14px",
                  textDecoration: "none",
                }}
              >
                My Account
              </Link>
              <div
                style={{
                  padding: "8px 14px",
                  color: "#8A7A60",
                  fontFamily: "'IM Fell DW Pica SC', serif",
                  fontSize: "12px",
                  wordBreak: "break-all",
                }}
              >
                {user.email}
              </div>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  signOut();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 14px",
                  color: "#2C1810",
                  fontFamily: "'IM Fell DW Pica SC', serif",
                  fontSize: "14px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setAuthModalOpen(true);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 14px",
                color: "#2C1810",
                fontFamily: "'IM Fell DW Pica SC', serif",
                fontSize: "14px",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              Sign in
            </button>
          )}
        </div>,
        document.body,
      )}
      <AuthModal open={authModalOpen} onOpenChange={setAuthModalOpen} />
    </>
  );
}
