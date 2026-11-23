import { useMemo, useState } from "react";
import { displayName, formatMetric, formatSpeed } from "../lib/format";
import { recommendByDifficulty } from "../lib/recommendations";
import { formatCost, TIERS, type PickView } from "../lib/engine";
import type { Filters } from "../lib/filters";
import type { Row } from "../lib/types";
import { FitBar, GlassPanel, InfoButton, PanelHeader, RouteChip, TierGlyph, routeName } from "./decision";
import { HowItWorks } from "./HowItWorks";

const FOCUS_LABEL = { price: "Lean budget", quality: "Balanced budget", speed: "Balanced budget, speed counts" } as const;

// The engine's pick per difficulty for the benchmark in view: an inset grouped
// list, one row per tier. A row opens the model's details.
export function Recommendations({ rows, filters, onSelect }: { rows: Row[]; filters: Filters; onSelect: (slug: string) => void }) {
  const [howOpen, setHowOpen] = useState(false);
  const results = useMemo(() => recommendByDifficulty(rows, filters.task, filters.costMode, filters.valueMode), [rows, filters.task, filters.costMode, filters.valueMode]);
  const unit = filters.costMode === "task" ? "per task" : "per 1M tokens";
  const cost = (p: PickView) => (p.free ? "Free" : formatCost(p.cost_per_task_usd));
  return <GlassPanel id="overview" label="Recommendations by difficulty" className="decision-difficulty">
    <PanelHeader kicker="A PLACE TO START" title="Recommendations" subtitle={<>{filters.task.label}<span className="dot-sep" aria-hidden="true">·</span>{FOCUS_LABEL[filters.valueMode]}</>}
      actions={<InfoButton onClick={() => setHowOpen(true)} label="How recommendations work" />} />
    {results.every((r) => !r.result)
      ? <p className="decision-empty">No scored and priced models match the filters. Try broadening your criteria.</p>
      : <ul className="inset-list">
        {results.map(({ difficulty, tier, result }) => {
          const pick = result?.pick;
          if (!result || !pick) return <li key={difficulty} className="list-row is-static"><TierGlyph tier={tier} /><div className="row-main"><span className="row-eyebrow">{difficulty}</span><span className="row-muted">No eligible model</span></div></li>;
          const pct = pick.score_pct_of_best ?? 0;
          return <li key={difficulty}>
            <button type="button" className="list-row" onClick={() => onSelect(pick.slug)} title={`${result.reason}.`}>
              <TierGlyph tier={tier} />
              <div className="row-main">
                <span className="row-eyebrow">{difficulty}<span className="dot-sep" aria-hidden="true">·</span>{TIERS[tier].label} tier, ≥ {Math.round(result.floor_share * 100)}% of best</span>
                <span className="row-title">{displayName(pick.name)}</span>
                <span className="row-sub"><RouteChip>{routeName(pick.provider_id, pick.model_id, pick.variant)}</RouteChip><span>{pick.creator}</span></span>
                {result.stronger && <span className="row-next">Next: {displayName(result.stronger.name)} · +{(result.stronger.score - pick.score).toFixed(1)} for {pick.cost_per_task_usd > 0 ? `${(result.stronger.cost_per_task_usd / pick.cost_per_task_usd).toFixed(1)}×` : "more"} cost</span>}
              </div>
              <div className="row-figures">
                <span className="figure"><strong>{formatMetric(pick.score, filters.task.scale)}</strong><small>{Math.round(pct)}% of best</small></span>
                <FitBar value={pct} label={`${Math.round(pct)}% of the best score`} />
                <span className="figure-line"><strong>{cost(pick)}</strong> {unit}</span>
                <span className="figure-line">{formatSpeed(pick.output_tokens_per_second)}</span>
              </div>
              <span className="chevron" aria-hidden="true">›</span>
            </button>
          </li>;
        })}
      </ul>}
    <p className="decision-footnote">Each row is the cheapest model that is good enough for its tier. Superseded releases are never picked.</p>
    <HowItWorks open={howOpen} onOpenChange={setHowOpen} />
  </GlassPanel>;
}
