import type { ReactNode } from "react";

// Shared pieces of the two decision panels (Recommendations, Models per role):
// a glass panel with an Apple-style header, route chips, fit bars, the needs bar
// and SF Symbols-like glyphs. Styles live in index.css under "Decision panels".

export const NEED_COLORS: Record<string, string> = {
  coding: "var(--need-coding)",
  tool_use: "var(--need-tools)",
  reasoning: "var(--need-reasoning)",
  long_context: "var(--need-context)",
  knowledge_work: "var(--need-knowledge)",
  accuracy: "var(--need-accuracy)",
  speed: "var(--need-speed)",
};

/** A gateway route as people read it: the model id without the provider suffix, plus #effort. */
export function routeName(providerId: string, modelId: string, variant: string | null): string {
  const tail = providerId.split("-").pop() ?? "";
  let name = modelId;
  if (tail && name.endsWith(`-${tail}`) && name.length > tail.length + 1) name = name.slice(0, -(tail.length + 1));
  return variant ? `${name}#${variant}` : name;
}

/** "acc-openai/gpt-6.1-terra-openai#low" -> routeName parts. */
export function routeNameFromId(id: string): string {
  const [model, variant] = id.split("#");
  const slash = model.indexOf("/");
  return slash < 0 ? id : routeName(model.slice(0, slash), model.slice(slash + 1), variant ?? null);
}

export function GlassPanel({ id, label, className = "", children }: { id?: string; label: string; className?: string; children: ReactNode }) {
  return <section id={id} aria-label={label} className={`decision-panel ${className}`}>{children}</section>;
}

export function PanelHeader({ kicker, title, subtitle, actions }: { kicker: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return <header className="decision-header">
    <div className="decision-heading"><p className="section-kicker">{kicker}</p><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
    {actions ? <div className="decision-actions">{actions}</div> : null}
  </header>;
}

export function InfoButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button type="button" className="info-button" onClick={onClick} aria-label={label} title={label}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10 9v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><circle cx="10" cy="6.2" r="1.05" fill="currentColor" /></svg>
  </button>;
}

export function RouteChip({ children, title }: { children: ReactNode; title?: string }) {
  return <code className="route-chip" title={title}>{children}</code>;
}

/** 0-100 bar; `marker` draws a tick where the current model sits. */
export function FitBar({ value, marker, color = "var(--color-accent)", label }: { value: number | null; marker?: number | null; color?: string; label: string }) {
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  return <span className="fit-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
    <span style={{ width: `${v}%`, background: color }} />
    {marker !== null && marker !== undefined && <i style={{ left: `${Math.max(0, Math.min(100, marker))}%` }} aria-hidden="true" />}
  </span>;
}

/** The role's needs as one stacked bar, in need colors. */
export function NeedsBar({ needs }: { needs: { key: string; label: string; weight: number }[] }) {
  const total = needs.reduce((a, n) => a + n.weight, 0) || 1;
  const text = needs.map((n) => `${n.label} ${Math.round((100 * n.weight) / total)}%`).join(" · ");
  return <span className="needs-bar" title={text} aria-label={`Needs: ${text}`} role="img">
    {needs.map((n) => <span key={n.key} style={{ flexGrow: n.weight, background: NEED_COLORS[n.key] ?? "var(--color-muted)" }} />)}
  </span>;
}

export function Delta({ value, unit = "", invert = false, digits = 1 }: { value: number | null; unit?: string; invert?: boolean; digits?: number }) {
  if (value === null || !Number.isFinite(value) || Math.abs(value) < 10 ** -digits / 2) return null;
  const good = invert ? value < 0 : value > 0;
  const sign = value > 0 ? "+" : "−";
  return <span className={`delta ${good ? "is-good" : "is-bad"}`}>{sign}{unit === "$" ? "$" : ""}{Math.abs(value).toFixed(digits)}{unit && unit !== "$" ? unit : ""}</span>;
}

const ROLE_COLORS: Record<string, string> = {
  commander: "#5b6cf0", explore: "#11a2b5", writer: "#c2459b", reviewer: "#2f9e57", "verifier-fast": "#2f9e57",
  "verifier-deep": "#2f9e57", implementer: "#2f6fd6", "implementer-pro": "#2f6fd6", architect: "#c98a1b", escalation: "#d9463b",
};

// SF Symbols-like glyphs, 24 units, drawn in white on the role's color.
const ICONS: Record<string, ReactNode> = {
  compass: <><circle cx="12" cy="12" r="8.5" /><path d="m14.8 9.2-1.9 4.1-3.7 1.5 1.9-4.1z" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></>,
  pencil: <><path d="M5 19l1-4.2L15.6 5.2a1.9 1.9 0 0 1 2.7 0l.5.5a1.9 1.9 0 0 1 0 2.7L9.2 18z" /><path d="M13.8 7l3.2 3.2" /></>,
  check: <><path d="M12 3.5 5.5 6v5.3c0 4 2.7 7.3 6.5 9.2 3.8-1.9 6.5-5.2 6.5-9.2V6z" /><path d="m9 12 2.2 2.2L15.3 10" /></>,
  code: <><path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" /></>,
  map: <><path d="M4 6.5 9 4.5l6 2 5-2v13l-5 2-6-2-5 2z" /><path d="M9 4.5v13M15 6.5v13" /></>,
  bolt: <><path d="M13 3 5.5 13.5h5.5L10 21l8.5-11h-5.6z" fill="currentColor" stroke="none" /></>,
  sparkle: <><path d="M12 4c.7 4.2 2.8 6.3 7 7-4.2.7-6.3 2.8-7 7-.7-4.2-2.8-6.3-7-7 4.2-.7 6.3-2.8 7-7z" fill="currentColor" stroke="none" /></>,
};
const ROLE_ICON: Record<string, string> = {
  commander: "compass", explore: "search", writer: "pencil", reviewer: "check", "verifier-fast": "check", "verifier-deep": "check",
  implementer: "code", "implementer-pro": "code", architect: "map", escalation: "bolt",
};

export function RoleGlyph({ role }: { role: string }) {
  const color = ROLE_COLORS[role] ?? "#7a8699";
  return <span className="role-glyph" style={{ background: `linear-gradient(160deg, color-mix(in srgb, ${color} 78%, white), ${color})` }} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICONS[ROLE_ICON[role] ?? "sparkle"]}</svg>
  </span>;
}

const TIER_STYLE: Record<string, { color: string; bars: number }> = {
  light: { color: "#1f9e8f", bars: 1 }, standard: { color: "#d08a2b", bars: 2 }, hard: { color: "#9a5fc7", bars: 3 }, frontier: { color: "#d9463b", bars: 4 },
};

/** Difficulty as signal bars (one to four), on the tier's color. */
export function TierGlyph({ tier }: { tier: string }) {
  const t = TIER_STYLE[tier] ?? TIER_STYLE.standard;
  return <span className="role-glyph" style={{ background: `linear-gradient(160deg, color-mix(in srgb, ${t.color} 75%, white), ${t.color})` }} aria-hidden="true">
    <svg viewBox="0 0 24 24">{[0, 1, 2].map((i) => <rect key={i} x={5 + i * 5.2} y={15 - i * 4} width="3.6" height={4 + i * 4} rx="1.2" fill="currentColor" opacity={i < Math.min(3, t.bars) ? 1 : 0.35} />)}</svg>
  </span>;
}
