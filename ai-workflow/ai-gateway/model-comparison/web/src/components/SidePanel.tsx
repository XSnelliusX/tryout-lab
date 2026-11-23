import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  /** Small caps line above the title, e.g. "HERDR ROLE". */
  kicker: string;
  title: ReactNode;
  subtitle?: ReactNode;
  label: string;
  onClose: () => void;
  /** Changing it scrolls the panel back to the top (a new subject). */
  subject?: string;
  children: ReactNode;
}

// The right-hand panel of the workspace (model details, a Herdr role, how
// recommendations work). On wide screens it is a third layout column, so the
// main content narrows instead of being covered; on narrow screens it floats.
// Escape or × closes it; focus moves in on open and back on close.
export function SidePanel({ kicker, title, subtitle, label, onClose, subject, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = ref.current;
    panel?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body || panel?.contains(document.activeElement))) previous.focus({ preventScroll: true });
    };
  }, [onClose]);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [subject]);

  return <aside ref={ref} role="region" aria-label={label} tabIndex={-1} className="detail-drawer side-panel">
    <div className="drawer-header">
      <div className="drawer-heading-line"><span className="section-kicker">{kicker}</span><button type="button" onClick={onClose} className="drawer-close" aria-label={`Close ${label.toLowerCase()}`}>×</button></div>
      <div className="min-w-0">
        <h2 className="side-title">{title}</h2>
        {subtitle ? <p className="drawer-release">{subtitle}</p> : null}
      </div>
    </div>
    <div className="drawer-body">{children}</div>
  </aside>;
}
