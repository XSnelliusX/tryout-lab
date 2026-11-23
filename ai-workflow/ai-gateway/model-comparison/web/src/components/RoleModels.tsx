import { displayName, formatSpeed } from "../lib/format";
import { CRITERIA, formatCost, type CurrentModel, type PickView, type Profile, type RoleRecommendation } from "../lib/engine";
import { Delta, FitBar, NEED_COLORS, NeedsBar, RoleGlyph, RouteChip, routeName, routeNameFromId } from "./decision";
import { SidePanel } from "./SidePanel";
import { ApplyButton } from "./ApplyButton";
import { changeFor, type ApplyResult } from "../lib/applyRoles";

// A Herdr Command Center role in the recommendations panel: a card with the role
// scored on what it needs (fit 0-100) and the pick next to the model in use, and
// the need-by-need comparison in the side panel. pickKey selects the set of
// picks ("custom": the cost sensitivity of the criteria).
type PickKey = Profile | "custom";

/** Output speed and latency on one line: "64 tok/s · first token 3.1 s". */
export function speedLine(m: { output_tokens_per_second?: number | null; time_to_first_answer_token_seconds?: number | null } | null): string {
  if (!m) return "";
  const parts = [m.output_tokens_per_second ? formatSpeed(m.output_tokens_per_second) : null,
    m.time_to_first_answer_token_seconds !== null && m.time_to_first_answer_token_seconds !== undefined ? `first token ${m.time_to_first_answer_token_seconds.toFixed(1)} s` : null];
  return parts.filter(Boolean).join(" · ");
}

function shortCurrent(c: CurrentModel): string {
  if (c.placeholder) return "not set";
  return routeNameFromId(c.id);
}

/** What changes from the model in use to the pick: fit, cost per task and the speed figures. */
function changeOf(r: RoleRecommendation, pick: PickView | null) {
  const c = r.current;
  const same = Boolean(pick && pick.id === c.id);
  return {
    same,
    fit: pick && c.score !== null ? pick.score - c.score : null,
    cost: pick && c.cost_per_task_usd !== null ? pick.cost_per_task_usd - c.cost_per_task_usd : null,
  };
}

// One role as a card: what it is for, the pick and what it replaces, fit, cost
// and speed with their change against today, and Apply (writes the Herdr config).
export function RoleCard({ r, pickKey, onOpen, onApplied }: { r: RoleRecommendation; pickKey: PickKey; onOpen: () => void; onApplied: (result: ApplyResult) => void }) {
  const pick = r.picks[pickKey]?.pick ?? null;
  const c = r.current;
  const { same, fit, cost } = changeOf(r, pick);
  return <article className={`role-card${same ? " is-kept" : ""}`}>
    <button type="button" className="role-card-head" onClick={onOpen} aria-label={`${r.role}: details`}>
      <RoleGlyph role={r.role} />
      <span className="row-main">
        <span className="row-title">{r.role}</span>
        <span className="role-purpose"><span className="row-muted">{r.label}</span><NeedsBar needs={r.needs} /></span>
      </span>
      <span className="chevron" aria-hidden="true">›</span>
    </button>
    {!pick ? <p className="row-muted">No model matches the criteria.</p> : <>
      <div className="role-card-pick">
        <strong title={routeName(pick.provider_id, pick.model_id, pick.variant)}>{displayName(pick.name)}</strong>
        <RouteChip>{routeName(pick.provider_id, pick.model_id, pick.variant)}</RouteChip>
        {same
          ? <span className="keep"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>In use</span>
          : <span className="row-from" title={shortCurrent(c)}>replaces {c.name ? displayName(c.name) : shortCurrent(c)}{c.deprecated ? " · superseded" : ""}</span>}
      </div>
      <dl className="role-card-stats">
        <div><dt>Fit</dt><dd><strong>{Math.round(pick.score)}</strong>{!same && <Delta value={fit} digits={0} />}</dd>
          <FitBar value={pick.score} marker={same ? null : c.score} label={`Fit ${Math.round(pick.score)} of 100`} /></div>
        <div><dt>Per task</dt><dd><strong>{formatCost(pick.cost_per_task_usd)}</strong>{!same && <Delta value={cost} unit="$" invert digits={2} />}</dd></div>
        <div><dt>Speed</dt><dd className="is-speed">{speedLine(pick) || "–"}</dd></div>
      </dl>
      {!same && <div className="role-card-actions"><ApplyButton changes={[changeFor(r.role, pick.id)]} label="Apply" onApplied={onApplied} /></div>}
    </>}
  </article>;
}

export function RolePanel({ r, pickKey, pickTitle, preset, onClose, onSelect, onApplied }: { r: RoleRecommendation; pickKey: PickKey; pickTitle: string; preset: Profile | null; onClose: () => void; onSelect: (slug: string) => void; onApplied: (result: ApplyResult) => void }) {
  const result = r.picks[pickKey];
  const pick = result?.pick ?? null;
  const c = r.current;
  const same = pick && pick.id === c.id;
  const columns: { key: string; title: string; model: CurrentModel | PickView | null }[] = same || !pick
    ? [{ key: "pick", title: same ? "Now and recommended" : "Now", model: same ? pick : c }]
    : [{ key: "now", title: "Now", model: c }, { key: "pick", title: pickTitle, model: pick }];
  return <SidePanel kicker="HERDR ROLE" title={r.role} subtitle={`${r.label} · ${r.tier} tier`} label={`Role ${r.role}`} subject={r.role} onClose={onClose}>
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
            <tr><th scope="row">First answer token</th>{columns.map((col) => <td key={col.key}>{seconds(col.model?.time_to_first_answer_token_seconds)}{part(col.model?.speed_parts?.latency)}</td>)}</tr>
            <tr><th scope="row">Output speed</th>{columns.map((col) => <td key={col.key}>{formatSpeed(col.model?.output_tokens_per_second ?? null)}{part(col.model?.speed_parts?.throughput)}</td>)}</tr>
            <tr><th scope="row">500-token answer</th>{columns.map((col) => <td key={col.key}>{seconds(col.model?.response_seconds)}</td>)}</tr>
          </tbody>
        </table>
      </section>
      {result && <section><h3>Why</h3><p>{capitalize(result.reason)}.</p></section>}
      <section className="sheet-actions">
        {pick && <button type="button" className="sheet-button" onClick={() => onSelect(pick.slug)}>Model details</button>}
        {!same && pick && <ApplyButton changes={[changeFor(r.role, pick.id)]} label={`Apply to ${r.role}`} onApplied={onApplied} />}
        {!same && pick && preset && <code className="sheet-command">cc-models recommend --profile {preset} --apply --role {r.role}</code>}
      </section>
    </div>
  </SidePanel>;
}

function seconds(v: number | null | undefined) {
  return v === null || v === undefined ? "–" : `${v.toFixed(1)} s`;
}

/** The speed criterion's part score (0-100) next to the raw figure. */
function part(v: number | null | undefined) {
  return v === null || v === undefined ? null : <small className="part-score"> · {Math.round(v)}/100</small>;
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
