import { useMemo } from "react";
import { displayName, formatMetric, formatNumber, formatSpeed, formatUsd } from "../lib/format";
import { recommendByDifficulty } from "../lib/recommendations";
import { label, TIERS, type PickView } from "../lib/engine";
import type { Filters } from "../lib/filters";
import type { Row } from "../lib/types";

const FOCUS_LABEL = { price: "lean budget", quality: "balanced budget", speed: "balanced budget, speed counts" } as const;

export function Recommendations({ rows, filters, onSelect }: { rows: Row[]; filters: Filters; onSelect: (slug: string) => void }) {
  const results = useMemo(() => recommendByDifficulty(rows, filters.task, filters.costMode, filters.valueMode), [rows, filters.task, filters.costMode, filters.valueMode]);
  const unit = filters.costMode === "task" ? "per task" : "per 1M tokens";
  const cost = (p: PickView) => (p.free ? "$0 (free)" : formatUsd(p.cost_per_task_usd));
  return <section id="overview" aria-label="Difficulty recommendations" className="recommendations">
    <header className="recommendations-heading"><div><p className="section-kicker">A PLACE TO START</p><h1>Recommendations by difficulty</h1><p>{filters.task.label} · {FOCUS_LABEL[filters.valueMode]} · the same engine as Herdr&apos;s cc-models and the prompt rewriter</p></div>
      <details className="recommendation-method"><summary>How this works <span aria-hidden="true">ⓘ</span></summary><p>Each card is the cheapest model that is good enough for its tier. A pick must reach a share of the best score in view (easy {pct(TIERS.light)}, medium {pct(TIERS.standard)}, difficult {pct(TIERS.hard)}), and among those every doubling of cost must buy enough extra score: {perDoubling(TIERS.light)} points of the best score for easy work, {perDoubling(TIERS.standard)} for medium, {perDoubling(TIERS.hard)} for difficult (lean, balanced and max budgets). Price focus uses the lean budget, quality focus the balanced one, and speed focus also rewards tokens per second. Each route of a model (provider and effort) is a separate candidate at its own cost. Superseded releases are never recommended, and a $0 model counts as $0.005 so it has to be good enough too. These are benchmark heuristics, not guarantees.</p></details>
    </header>
    <div className="recommendation-grid">
      {results.every((r) => !r.result) && <p className="text-sm text-muted">No scored and priced models match the filters. Try broadening your criteria.</p>}
      {results.map(({ difficulty, tier, result }) => {
        const pick = result?.pick;
        return <article key={difficulty} className={`recommendation-card recommendation-${difficulty.toLowerCase()}`}>
          <div className="recommendation-band"><span className="band-indicator" aria-hidden="true" /><strong>{difficulty}</strong><span>{TIERS[tier].label} tier · ≥ {Math.round((result?.floor_share ?? 0) * 100)}% of best</span></div>
          {result && pick ? <>
            <button type="button" onClick={() => onSelect(pick.slug)} className="recommendation-model">{displayName(pick.name)} <span aria-hidden="true">↗</span></button>
            <p className="recommendation-creator">{pick.creator} · <code>{label(pick)}</code> · {result.eligible} of {result.pool} routes qualify</p>
            <div className="recommendation-stats"><span><small>Score</small><strong>{formatMetric(pick.score, filters.task.scale)} <small>({formatNumber(pick.score_pct_of_best ?? 0)}%)</small></strong></span><span><small>Cost {unit}</small><strong>{cost(pick)}</strong></span><span><small>Speed</small><strong>{formatSpeed(pick.output_tokens_per_second)}</strong></span></div>
            <details className="recommendation-detail"><summary>Why this one</summary>
              <p>{result.reason}.</p>
              {result.stronger && <p>Next step up: <button type="button" onClick={() => onSelect(result.stronger!.slug)}>{displayName(result.stronger.name)}</button> ({label(result.stronger)}) · {formatMetric(result.stronger.score, filters.task.scale)} for {cost(result.stronger)}.</p>}
              {result.cheaper && <p>Strongest cheaper option: <button type="button" onClick={() => onSelect(result.cheaper!.slug)}>{displayName(result.cheaper.name)}</button> · {formatMetric(result.cheaper.score, filters.task.scale)} for {cost(result.cheaper)}.</p>}
              {result.best.id !== pick.id && <p>Best available: <button type="button" onClick={() => onSelect(result.best.slug)}>{displayName(result.best.name)}</button> · {formatMetric(result.best.score, filters.task.scale)} for {cost(result.best)}.</p>}
            </details>
          </> : <p className="recommendation-empty">No eligible model.</p>}
        </article>;
      })}
    </div>
  </section>;
}

function pct(t: { floor: { balanced: number } }) {
  return `${Math.round(t.floor.balanced * 100)}%`;
}

function perDoubling(t: { perDoubling: { lean: number; balanced: number; max: number } }) {
  return `${t.perDoubling.lean}/${t.perDoubling.balanced}/${t.perDoubling.max}`;
}
