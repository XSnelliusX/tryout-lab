import { useMemo } from "react";
import { displayName, formatMetric } from "../lib/format";
import { DIFFICULTY_TIERS, presetFor, recommendByDifficulty, type RolePlan, type TierRecommendation } from "../lib/recommendations";
import { TIERS, floorFor, formatCost, type CurvePoint, type SetupSummary } from "../lib/engine";
import { changeFor, type ApplyResult } from "../lib/applyRoles";
import type { Filters } from "../lib/filters";
import type { Row } from "../lib/types";
import { Delta, FitBar, GlassPanel, InfoButton, PanelHeader, RouteChip, TierGlyph, routeName } from "./decision";
import { RoleCard, speedLine } from "./RoleModels";
import { ApplyButton } from "./ApplyButton";
import { PRESETS } from "./ControlBar";

interface Props {
  rows: Row[];
  plan: RolePlan | null;
  filters: Filters;
  lastApplied: ApplyResult | null;
  onSensitivity: (k: number) => void;
  onSelect: (slug: string) => void;
  onOpenRole: (role: string) => void;
  onHow: () => void;
  onApplied: (result: ApplyResult) => void;
}

// One decision panel: what the whole Herdr setup costs and scores at the price
// of quality chosen in the criteria rail (the curve shows every other choice,
// and Apply writes the picks into the Herdr config), then one section per
// difficulty tier: the pick for the benchmark in view and a card per role.
export function DecisionPanel({ rows, plan, filters, lastApplied, onSensitivity, onSelect, onOpenRole, onHow, onApplied }: Props) {
  const speed = filters.valueMode === "speed";
  const tiers = useMemo(() => recommendByDifficulty(rows, filters.task, filters.sensitivity, speed), [rows, filters.task, filters.sensitivity, speed]);
  const roles = plan?.roles.roles ?? [];
  const preset = presetFor(filters.sensitivity);
  const changes = roles.flatMap((r) => {
    const pick = r.picks.custom?.pick;
    return pick && pick.id !== r.current.id ? [changeFor(r.role, pick.id)] : [];
  });

  return <GlassPanel id="overview" label="Recommendations" className="decision-unified">
    <PanelHeader kicker="RECOMMENDATIONS" title="What to use, and what it costs"
      subtitle={<>Tier picks for {filters.task.label}<span className="dot-sep" aria-hidden="true">·</span>{plan ? "Herdr roles scored on what each needs" : "no Herdr config found"}</>}
      actions={<InfoButton onClick={onHow} label="How recommendations work" />} />

    <div className="tradeoff-band">
      <div className="tradeoff-summary">
        <div className="tradeoff-setting">
          <small>Price of quality</small>
          <strong>{preset ? PRESETS.find((p) => p.key === preset)!.label : "Custom"}</strong>
          <span>A cost doubling must buy {filters.sensitivity.toFixed(1)} points on standard work. Change it in the criteria or on the curve.</span>
        </div>
        {plan && <SetupStats summary={plan.roles.summary} />}
        {plan && <div className="tradeoff-apply">
          {changes.length
            ? <><span>{changes.length} of {roles.length} roles would change.</span><ApplyButton changes={changes} label={`Apply all ${changes.length} to Herdr`} onApplied={onApplied} /></>
            : <span className="keep">Herdr already uses every pick.</span>}
          {lastApplied && <small className="apply-done">Wrote {lastApplied.applied.length} {lastApplied.applied.length === 1 ? "role" : "roles"}; backup at <code>{lastApplied.backup.replace(/^\/(?:Users|home)\/[^/]+/, "~")}</code></small>}
        </div>}
      </div>
      {plan && plan.curve.length > 1 && <SetupCurve curve={plan.curve} summary={plan.roles.summary} onPick={onSensitivity} />}
    </div>

    {DIFFICULTY_TIERS.map(({ difficulty, tier }) => {
      const result = tiers.find((t) => t.tier === tier)?.result ?? null;
      const inTier = roles.filter((r) => r.tier === tier);
      return <section key={tier} className={`tier-section tier-${tier}`} aria-label={`${TIERS[tier].label} tier`}>
        <header className="tier-head">
          <TierGlyph tier={tier} />
          <div><h3>{TIERS[tier].label}<span> · {difficulty.toLowerCase()} work</span></h3><p>{TIERS[tier].description}</p></div>
          <div className="tier-rules"><span>≥ {Math.round(floorFor(tier, filters.sensitivity) * 100)}% of best</span><span>{(filters.sensitivity * TIERS[tier].priceScale).toFixed(1)} pts per cost ×2</span></div>
        </header>
        <div className="card-grid">
          <TaskCard result={result} task={filters.task} onSelect={onSelect} />
          {inTier.map((r) => <RoleCard key={r.role} r={r} pickKey="custom" onOpen={() => onOpenRole(r.role)} onApplied={onApplied} />)}
        </div>
      </section>;
    })}
    <p className="decision-footnote">{plan
      ? <>Roles use {plan.roles.providers.join(", ")}{plan.roles.exclude.length ? `, excluding ${plan.roles.exclude.join(", ")}` : ""}. Apply writes only model and variant to the Herdr config and keeps a backup, like <code>cc-models recommend --apply</code>.</>
      : <>Install herdr-commander (<code>ai-workflow/install.sh</code>) to see a model per role here.</>} Superseded releases are never picked.</p>
  </GlassPanel>;
}

// The tier's pick for the benchmark in view: any task of this difficulty.
function TaskCard({ result, task, onSelect }: { result: TierRecommendation["result"]; task: Filters["task"]; onSelect: (slug: string) => void }) {
  const pick = result?.pick;
  if (!result || !pick) return <article className="role-card is-task"><p className="row-muted">No model for {task.shortLabel} matches the criteria.</p></article>;
  const pct = pick.score_pct_of_best ?? 0;
  const next = result.stronger;
  return <article className="role-card is-task">
    <button type="button" className="role-card-head" onClick={() => onSelect(pick.slug)} title={`${result.reason}.`}>
      <span className="task-glyph" aria-hidden="true">◎</span>
      <span className="row-main"><span className="row-title">Any task</span><span className="row-muted">{task.shortLabel} score</span></span>
      <span className="chevron" aria-hidden="true">›</span>
    </button>
    <div className="role-card-pick">
      <strong>{displayName(pick.name)}</strong>
      <RouteChip>{routeName(pick.provider_id, pick.model_id, pick.variant)}</RouteChip>
      <span className="row-from">{pick.creator}</span>
    </div>
    <dl className="role-card-stats">
      <div><dt>Score</dt><dd><strong>{formatMetric(pick.score, task.scale)}</strong><small>{Math.round(pct)}% of best</small></dd><FitBar value={pct} label={`${Math.round(pct)}% of the best score`} /></div>
      <div><dt>Per task</dt><dd><strong>{pick.free ? "Free" : formatCost(pick.cost_per_task_usd)}</strong></dd></div>
      <div><dt>Speed</dt><dd className="is-speed">{speedLine(pick) || "–"}</dd></div>
    </dl>
    {next && <p className="role-card-next">Next step up: {displayName(next.name)}, +{(next.score - pick.score).toFixed(1)} for {pick.cost_per_task_usd > 0 ? `${(next.cost_per_task_usd / pick.cost_per_task_usd).toFixed(1)}×` : "more"} the cost</p>}
  </article>;
}

function SetupStats({ summary }: { summary: Record<string, SetupSummary | null> }) {
  const now = summary.current, next = summary.custom;
  const ratio = now && next && now.cost_usd > 0 ? next.cost_usd / now.cost_usd : null;
  return <div className="setup-stats">
    <div className="setup-stat"><small>Average role fit</small><strong>{next ? Math.round(next.fit) : "–"}</strong>{now && next && <span><Delta value={next.fit - now.fit} digits={0} /> vs now {Math.round(now.fit)}</span>}</div>
    <div className="setup-stat"><small>One task per role</small><strong>{next ? formatCost(next.cost_usd) : "–"}</strong>{now && next && <span><Delta value={next.cost_usd - now.cost_usd} unit="$" invert digits={2} />{ratio ? ` (${ratio.toFixed(1)}×)` : ""} vs now {formatCost(now.cost_usd)}</span>}</div>
  </div>;
}

// The setup's cost (log scale) against its average fit for every sensitivity:
// each point is a setup the slider can reach; click one to choose it. Drawn at a
// fixed size: stretched wider, the few points would read as a misleading trend.
function SetupCurve({ curve, summary, onPick }: { curve: CurvePoint[]; summary: Record<string, SetupSummary | null>; onPick: (k: number) => void }) {
  const W = 300, H = 150, L = 28, R = 12, T = 14, B = 26;
  const now = summary.current, sel = summary.custom;
  const pts = [...curve, ...(now ? [now] : [])];
  const lc = (c: number) => Math.log(Math.max(c, 0.01));
  const [c0, c1] = [Math.min(...pts.map((p) => lc(p.cost_usd))), Math.max(...pts.map((p) => lc(p.cost_usd)))];
  const [f0, f1] = [Math.floor(Math.min(...pts.map((p) => p.fit)) - 3), Math.ceil(Math.max(...pts.map((p) => p.fit)) + 2)];
  const x = (c: number) => L + ((lc(c) - c0) / (c1 - c0 || 1)) * (W - L - R);
  const y = (f: number) => T + (1 - (f - f0) / (f1 - f0 || 1)) * (H - T - B);
  const sorted = [...curve].sort((a, b) => a.cost_usd - b.cost_usd);
  const isSel = (p: CurvePoint) => sel && p.cost_usd === sel.cost_usd && p.fit === sel.fit;
  return <figure className="setup-figure">
    <svg className="setup-chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Setups by cost and average fit; choose one">
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} className="axis" />
      <line x1={L} y1={T} x2={L} y2={H - B} className="axis" />
      <text x={L - 5} y={T + 4} className="tick" textAnchor="end">{f1}</text>
      <text x={L - 5} y={H - B} className="tick" textAnchor="end">{f0}</text>
      <text x={L} y={H - 9} className="tick">{formatCost(Math.exp(c0))}</text>
      <text x={W - R} y={H - 9} className="tick" textAnchor="end">{formatCost(Math.exp(c1))}</text>
      <text x={(L + W - R) / 2} y={H - 9} className="tick" textAnchor="middle">one task per role (log)</text>
      <text x={L + 3} y={T - 4} className="tick">avg fit</text>
      <polyline points={sorted.map((p) => `${x(p.cost_usd)},${y(p.fit)}`).join(" ")} className="curve" />
      {now && <g className="pt is-now"><circle cx={x(now.cost_usd)} cy={y(now.fit)} r={4.5} /><text x={x(now.cost_usd) + 8} y={y(now.fit) + 3}>Now</text></g>}
      {sorted.map((p) => <g key={p.sensitivity} className={`pt is-option${isSel(p) ? " is-active" : ""}`} role="button" tabIndex={0}
        aria-label={`${formatCost(p.cost_usd)} per round, fit ${Math.round(p.fit)}`} onClick={() => onPick(p.sensitivity)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(p.sensitivity); } }}>
        <title>{`${formatCost(p.cost_usd)} · fit ${Math.round(p.fit)}`}</title>
        <circle cx={x(p.cost_usd)} cy={y(p.fit)} r={isSel(p) ? 6 : 4} />
      </g>)}
    </svg>
    <figcaption>Each point is a setup the slider reaches; choose one.</figcaption>
  </figure>;
}
