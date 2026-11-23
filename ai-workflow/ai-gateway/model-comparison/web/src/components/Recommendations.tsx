import { useMemo } from "react";
import { displayName, formatMetric, formatNumber, formatSpeed, formatUsd } from "../lib/format";
import { recommendByDifficulty } from "../lib/recommendations";
import { formatValue, priceFor, scoreFor, valueFor } from "../lib/tasks";
import type { Filters } from "../lib/filters";
import type { Row } from "../lib/types";

export function Recommendations({ rows, filters, onSelect }: { rows: Row[]; filters: Filters; onSelect: (slug: string) => void }) {
  const results = useMemo(() => recommendByDifficulty(rows, filters.task, filters.costMode, filters.valueMode, filters.priceSensitivity), [rows, filters.task, filters.costMode, filters.valueMode, filters.priceSensitivity]);
  return <section id="overview" aria-label="Difficulty recommendations" className="recommendations">
    <header className="recommendations-heading"><div><p className="section-kicker">A PLACE TO START</p><h1>Recommendations by difficulty</h1><p>Relative score bands for {filters.task.label} · based on your current criteria</p></div>
      <details className="recommendation-method"><summary>How this works <span aria-hidden="true">ⓘ</span></summary><p>These are relative heuristics, not measured task difficulty or guarantees of success. Easy uses the 25th–50th percentile, medium the 50th–75th, and difficult the 75th and above. Models below the 25th percentile are not recommended. Speed focus excludes models without speed data. Free models rank ahead of paid models because no finite score-to-cost ratio exists.</p></details>
    </header>
    <div className="recommendation-grid">
      {results.length === 0 && <p className="text-sm text-muted">No scored and priced models match the filters. Try broadening your criteria.</p>}
      {results.map(({ difficulty, minimum, maximum, eligible, model, comparison, nextUpgrade }) => <article key={difficulty} className={`recommendation-card recommendation-${difficulty.toLowerCase()}`}>
        <div className="recommendation-band"><span className="band-indicator" aria-hidden="true" /><strong>{difficulty}</strong><span>Score {formatMetric(minimum, filters.task.scale)}{maximum !== null ? ` – < ${formatMetric(maximum, filters.task.scale)}` : "+"}</span></div>
        {model ? <>
          <button type="button" onClick={() => onSelect(model.slug)} className="recommendation-model">{displayName(model.name)} <span aria-hidden="true">↗</span></button>
          <p className="recommendation-creator">{model.creator} · {eligible} eligible variants</p>
          <div className="recommendation-stats"><span><small>Score</small><strong>{formatMetric(scoreFor(model, filters.task), filters.task.scale)}</strong></span><span><small>Cost</small><strong>{priceFor(model, filters.costMode) === 0 ? "$0 reported" : formatUsd(priceFor(model, filters.costMode))}</strong></span><span><small>Value</small><strong>{formatValue(valueFor(model, filters.task, filters.costMode, filters.valueMode, filters.priceSensitivity), filters.valueMode)}</strong></span></div>
          <details className="recommendation-detail"><summary>More context</summary><p>{filters.costMode === "task" ? "Cost per AA benchmark task" : "Blended cost per 1M tokens"} · {formatSpeed(model.performance.output_tokens_per_second)}.</p>{comparison && <p>vs. {displayName(comparison.cheaper.name)}: +{formatNumber(comparison.scoreGainPercent)}% score for +{formatNumber(comparison.costIncreasePercent)}% cost.</p>}{nextUpgrade && <p>Highest score in band: <button type="button" onClick={() => onSelect(nextUpgrade.model.slug)}>{displayName(nextUpgrade.model.name)}</button> · +{formatNumber(nextUpgrade.scoreGainPercent)}% score for +{formatNumber(nextUpgrade.costIncreasePercent)}% cost.</p>}</details>
        </> : <p className="recommendation-empty">No eligible model{filters.valueMode === "speed" ? " with measured speed" : ""}.</p>}
      </article>)}
    </div>
  </section>;
}
