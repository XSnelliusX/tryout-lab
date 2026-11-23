import { useState } from "react";
import { Dialog, SegmentedControl } from "open-glass-ui";
import { displayName, formatSpeed } from "../lib/format";
import { CRITERIA, formatCost, type CurrentModel, type PickView, type Profile, type RecommendationsDocument, type RoleRecommendation, type SetupSummary } from "../lib/engine";
import { Delta, FitBar, GlassPanel, InfoButton, NEED_COLORS, NeedsBar, PanelHeader, RoleGlyph, RouteChip, routeName, routeNameFromId } from "./decision";
import { HowItWorks } from "./HowItWorks";

const PROFILES: { value: Profile; label: string }[] = [
  { value: "lean", label: "Lean" }, { value: "balanced", label: "Balanced" }, { value: "max", label: "Max" },
];

// Herdr Command Center roles: each role scored on what it needs (fit 0-100),
// the profile's pick next to the model in use, and what the whole setup costs
// for one task per role against its average fit.
export function RoleModels({ doc, onSelect }: { doc: RecommendationsDocument | null; onSelect: (slug: string) => void }) {
  const [profile, setProfile] = useState<Profile>("balanced");
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const roles = doc?.roles;
  const header = (subtitle?: string) => <PanelHeader kicker="HERDR COMMAND CENTER" title="Models per role" subtitle={subtitle}
    actions={<>{roles?.available && <SegmentedControl aria-label="Budget profile" className="panel-segments" items={PROFILES} value={profile} onValueChange={setProfile} />}<InfoButton onClick={() => setHowOpen(true)} label="How recommendations work" /></>} />;

  if (!roles?.available) {
    return <GlassPanel id="roles" label="Herdr role recommendations" className="decision-roles">
      {header()}
      <p className="decision-empty">No Herdr config found. Install herdr-commander (<code>ai-workflow/install.sh</code>) to see a model per role here and in <code>cc-models recommend</code>.</p>
      <HowItWorks open={howOpen} onOpenChange={setHowOpen} />
    </GlassPanel>;
  }
  const selected = roles.roles.find((r) => r.role === openRole) ?? null;
  return <GlassPanel id="roles" label="Herdr role recommendations" className="decision-roles">
    {header("Each role scored on what it needs, at your gateway's prices")}
    <SetupCard summary={roles.summary} profile={profile} />
    <ul className="inset-list role-list">
      {roles.roles.map((r) => <RoleRow key={r.role} r={r} profile={profile} onOpen={() => setOpenRole(r.role)} />)}
    </ul>
    <p className="decision-footnote">From {roles.providers.join(", ")}{roles.exclude.length ? `, excluding ${roles.exclude.join(", ")}` : ""}. Apply a pick with <code>cc-models recommend --profile {profile} --apply --role &lt;role&gt;</code>; it asks first.</p>
    {selected && <RoleSheet r={selected} profile={profile} open onOpenChange={(o) => { if (!o) setOpenRole(null); }} onSelect={(slug) => { setOpenRole(null); onSelect(slug); }} />}
    <HowItWorks open={howOpen} onOpenChange={setHowOpen} />
  </GlassPanel>;
}

function SetupCard({ summary, profile }: { summary: Record<string, SetupSummary | null>; profile: Profile }) {
  const now = summary.current, next = summary[profile];
  const ratio = now && next && now.cost_usd > 0 ? next.cost_usd / now.cost_usd : null;
  return <div className="setup-card">
    <div className="setup-stats">
      <div className="setup-stat"><small>Average fit</small><strong>{next ? Math.round(next.fit) : "–"}</strong>{now && next && <span><Delta value={next.fit - now.fit} digits={0} /> vs now {Math.round(now.fit)}</span>}</div>
      <div className="setup-stat"><small>One task per role</small><strong>{next ? formatCost(next.cost_usd) : "–"}</strong>{now && next && <span><Delta value={next.cost_usd - now.cost_usd} unit="$" invert digits={2} /> {ratio ? `(${ratio.toFixed(1)}×)` : ""} vs now {formatCost(now.cost_usd)}</span>}</div>
    </div>
    <SetupChart summary={summary} profile={profile} />
  </div>;
}

// Cost (log scale) against average fit for the current setup and the three profiles.
function SetupChart({ summary, profile }: { summary: Record<string, SetupSummary | null>; profile: Profile }) {
  const keys = ["current", "lean", "balanced", "max"].filter((k) => summary[k]);
  if (keys.length < 2) return null;
  const W = 270, H = 132, L = 26, R = 14, T = 16, B = 26;
  const costs = keys.map((k) => Math.log(Math.max(summary[k]!.cost_usd, 0.01)));
  const fits = keys.map((k) => summary[k]!.fit);
  const [c0, c1] = [Math.min(...costs), Math.max(...costs)];
  const [f0, f1] = [Math.floor(Math.min(...fits) - 4), Math.ceil(Math.max(...fits) + 3)];
  const x = (c: number) => L + ((Math.log(Math.max(c, 0.01)) - c0) / (c1 - c0 || 1)) * (W - L - R);
  const y = (f: number) => T + (1 - (f - f0) / (f1 - f0 || 1)) * (H - T - B);
  const curve = ["lean", "balanced", "max"].filter((k) => summary[k]).map((k) => `${x(summary[k]!.cost_usd)},${y(summary[k]!.fit)}`).join(" ");
  const names: Record<string, string> = { current: "Now", lean: "Lean", balanced: "Balanced", max: "Max" };
  return <svg className="setup-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cost per round against average fit: ${keys.map((k) => `${names[k]} ${formatCost(summary[k]!.cost_usd)}, fit ${Math.round(summary[k]!.fit)}`).join("; ")}`}>
    <line x1={L} y1={H - B} x2={W - R} y2={H - B} className="axis" />
    <line x1={L} y1={T} x2={L} y2={H - B} className="axis" />
    <text x={L - 5} y={T + 4} className="tick" textAnchor="end">{f1}</text>
    <text x={L - 5} y={H - B} className="tick" textAnchor="end">{f0}</text>
    <text x={L} y={H - 9} className="tick">{formatCost(Math.exp(c0))}</text>
    <text x={W - R} y={H - 9} className="tick" textAnchor="end">{formatCost(Math.exp(c1))}</text>
    <text x={(L + W - R) / 2} y={H - 9} className="tick" textAnchor="middle">one task per role, log scale</text>
    <text x={L + 3} y={T - 5} className="tick">avg fit</text>
    <polyline points={curve} className="curve" />
    {placeLabels(keys.map((k) => ({ k, cx: x(summary[k]!.cost_usd), cy: y(summary[k]!.fit), text: names[k] })), W - R).map(({ k, cx, cy, lx, ly, anchor, text }) => {
      const active = k === profile, isNow = k === "current";
      return <g key={k} className={`pt${active ? " is-active" : ""}${isNow ? " is-now" : ""}`}>
        <circle cx={cx} cy={cy} r={active ? 6 : 4.5} />
        <text x={lx} y={ly} textAnchor={anchor}>{text}</text>
      </g>;
    })}
  </svg>;
}

// Label beside each point, flipping side and nudging down when two labels would touch.
function placeLabels(points: { k: string; cx: number; cy: number; text: string }[], right: number) {
  const placed: { k: string; cx: number; cy: number; lx: number; ly: number; anchor: "start" | "end"; text: string; box: [number, number, number, number] }[] = [];
  const width = (t: string) => t.length * 5.2 + 4;
  for (const p of [...points].sort((a, b) => a.cx - b.cx)) {
    const options: { lx: number; ly: number; anchor: "start" | "end" }[] = [
      { lx: p.cx + 9, ly: p.cy + 3, anchor: "start" }, { lx: p.cx - 9, ly: p.cy + 3, anchor: "end" },
      { lx: p.cx + 9, ly: p.cy + 14, anchor: "start" }, { lx: p.cx - 9, ly: p.cy - 8, anchor: "end" },
    ];
    const fits = options.map((o) => {
      const w = width(p.text);
      const box: [number, number, number, number] = o.anchor === "start" ? [o.lx, o.ly - 8, o.lx + w, o.ly + 2] : [o.lx - w, o.ly - 8, o.lx, o.ly + 2];
      const clash = box[2] > right + 4 || box[0] < 0 || placed.some((q) => !(box[2] < q.box[0] || box[0] > q.box[2] || box[3] < q.box[1] || box[1] > q.box[3]));
      return { o, box, clash };
    });
    const choice = fits.find((f) => !f.clash) ?? fits[0];
    placed.push({ ...p, ...choice.o, box: choice.box });
  }
  return placed;
}

function shortCurrent(c: CurrentModel): string {
  if (c.placeholder) return "not set";
  return routeNameFromId(c.id);
}

function RoleRow({ r, profile, onOpen }: { r: RoleRecommendation; profile: Profile; onOpen: () => void }) {
  const result = r.picks[profile];
  const pick = result?.pick ?? null;
  const c = r.current;
  const same = pick && pick.id === c.id;
  const fitDelta = pick && c.score !== null ? pick.score - c.score : null;
  return <li>
    <button type="button" className="list-row role-row" onClick={onOpen}>
      <span className="role-head"><RoleGlyph role={r.role} />
        <span className="row-main">
          <span className="row-title">{r.role}</span>
          <span className="role-purpose"><span className="row-muted">{r.label}</span><NeedsBar needs={r.needs} /></span>
        </span>
      </span>
      <span className="role-model">
        {!pick ? <span className="row-muted">No eligible model</span> : <>
          <span className="row-title is-small" title={routeName(pick.provider_id, pick.model_id, pick.variant)}>{displayName(pick.name)}</span>
          {same ? <span className="keep"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>Keeps current</span>
            : <span className="row-from" title={shortCurrent(c)}>from {c.name ? displayName(c.name) : shortCurrent(c)}{c.deprecated ? " · superseded" : ""}</span>}
        </>}
      </span>
      <span className="role-fit">
        <span className="figure"><strong>{pick ? Math.round(pick.score) : "–"}</strong>{!same && <Delta value={fitDelta} digits={0} />}</span>
        <FitBar value={pick?.score ?? null} marker={same ? null : c.score} label={`Fit ${pick ? Math.round(pick.score) : "unknown"} of 100`} />
        <span className="figure-line"><strong>{pick ? formatCost(pick.cost_per_task_usd) : "–"}</strong> per task</span>
      </span>
      <span className="chevron" aria-hidden="true">›</span>
    </button>
  </li>;
}

function RoleSheet({ r, profile, open, onOpenChange, onSelect }: { r: RoleRecommendation; profile: Profile; open: boolean; onOpenChange: (open: boolean) => void; onSelect: (slug: string) => void }) {
  const result = r.picks[profile];
  const pick = result?.pick ?? null;
  const c = r.current;
  const same = pick && pick.id === c.id;
  const columns: { key: string; title: string; model: CurrentModel | PickView | null }[] = same || !pick
    ? [{ key: "pick", title: same ? "Now and recommended" : "Now", model: same ? pick : c }]
    : [{ key: "now", title: "Now", model: c }, { key: "pick", title: `${PROFILES.find((p) => p.value === profile)?.label} pick`, model: pick }];
  return <Dialog title={r.role} description={`${r.label} · ${r.tier} tier`} open={open} onOpenChange={onOpenChange}>
    <div className="sheet role-sheet">
      <div className={`sheet-columns cols-${columns.length}`}>
        {columns.map((col) => <div key={col.key} className="sheet-model">
          <small>{col.title}</small>
          <strong>{col.model && "name" in col.model && col.model.name ? displayName(col.model.name) : col.model ? routeNameFromId(col.model.id) : "–"}</strong>
          {col.model && <RouteChip>{routeNameFromId(col.model.id)}</RouteChip>}
        </div>)}
      </div>
      <section>
        <div className="sheet-section-head"><h3>What {r.role} needs</h3>
          {columns.length > 1 && <span className="sheet-legend"><i className="is-now" />Now<i />{columns[1].title}</span>}</div>
        <ul className="need-list">
          {r.needs.map((n) => <li key={n.key}>
            <span className="need-name"><span className="dot" style={{ background: NEED_COLORS[n.key] }} aria-hidden="true" />{n.label}<small>{n.weight}%</small></span>
            <span className="need-bars">
              {columns.map((col) => {
                const v = col.model?.breakdown?.[n.key] ?? null;
                return <span key={col.key} className="need-bar-line"><FitBar value={v} color={col.key === "now" ? "var(--color-muted)" : NEED_COLORS[n.key]} label={`${col.title}: ${CRITERIA[n.key]?.label ?? n.label} ${v === null ? "not measured" : Math.round(v)}`} /><span>{v === null ? "–" : Math.round(v)}</span></span>;
              })}
            </span>
          </li>)}
        </ul>
      </section>
      <section>
        <table className="sheet-table compare">
          <thead><tr><th scope="col" />{columns.map((col) => <th key={col.key} scope="col">{col.title}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Fit</th>{columns.map((col) => <td key={col.key}><strong>{col.model?.score === null || col.model?.score === undefined ? "–" : Math.round(col.model.score)}</strong></td>)}</tr>
            <tr><th scope="row">Cost per task</th>{columns.map((col) => <td key={col.key}>{formatCost(col.model?.cost_per_task_usd ?? null)}</td>)}</tr>
            <tr><th scope="row">Time to an answer</th>{columns.map((col) => <td key={col.key}>{col.model?.response_seconds === null || col.model?.response_seconds === undefined ? "–" : `${col.model.response_seconds.toFixed(1)} s`}</td>)}</tr>
            <tr><th scope="row">Output speed</th>{columns.map((col) => <td key={col.key}>{formatSpeed(col.model?.output_tokens_per_second ?? null)}</td>)}</tr>
          </tbody>
        </table>
      </section>
      {result && <section><h3>Why</h3><p>{capitalize(result.reason)}.</p></section>}
      <section className="sheet-actions">
        {pick && <button type="button" className="sheet-button" onClick={() => onSelect(pick.slug)}>Model details</button>}
        {!same && pick && <code className="sheet-command">cc-models recommend --profile {profile} --apply --role {r.role}</code>}
      </section>
    </div>
  </Dialog>;
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
