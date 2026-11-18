import { useMemo } from "react";
import { displayName, formatContext, formatMetric, formatNumber, formatSpeed, formatUsd } from "../lib/format";
import { TASKS, priceFor, scoreFor, tasksFromMetrics, type CostMode, type Task } from "../lib/tasks";
import type { Metric, Row } from "../lib/types";

const PIN_COLORS = ["#316bd6", "#a05b9d", "#148477"];

interface Props {
  pinned: Row[];
  allRows: Row[];
  metrics: Metric[];
  costMode: CostMode;
  task: Task;
  onUnpin: (slug: string) => void;
  onClear: () => void;
}

export function ComparePanel({ pinned, metrics, costMode, task, onUnpin, onClear }: Props) {
  const comparisonTasks = useMemo(() => {
    const fromSnapshot = tasksFromMetrics(metrics).filter((t) => t.radar);
    return fromSnapshot.length ? fromSnapshot : TASKS.filter((t) => t.radar);
  }, [metrics]);

  return (
    <section aria-label="Compare models" className="comparison-panel">
      <header className="comparison-heading">
        <div><p className="section-kicker">SIDE BY SIDE</p><h2>Compare your shortlist</h2><p>Pin up to three models in the table to examine them together.</p></div>
        {pinned.length > 0 && <button type="button" onClick={onClear} className="columns-button">Clear shortlist</button>}
      </header>
      {pinned.length === 0 ? (
        <div className="compare-empty"><span className="compare-empty-icon" aria-hidden="true">＋</span><div><strong>Your shortlist starts here</strong><p>Use the + button beside a model to add it to your comparison.</p><a href="#ranking" className="compare-link">Browse models ↑</a></div></div>
      ) : (
        <>
          <div className="shortlist" aria-label="Pinned models">
            {pinned.map((row, i) => <div className="shortlist-item" key={row.slug}>
              <span className="shortlist-dot" style={{ backgroundColor: PIN_COLORS[i] }} aria-hidden="true" />
              <div><strong>{displayName(row.name)}</strong><span>{row.creator} · {formatMetric(scoreFor(row, task), task.scale)} {task.shortLabel}</span></div>
              <button type="button" onClick={() => onUnpin(row.slug)} aria-label={`Remove ${displayName(row.name)} from comparison`}>×</button>
            </div>)}
          </div>
          <div className="compare-grid">
            <div className="comparison-metrics">
              <h3>Capability profile</h3><p>Compare models within each index. Scores from different indices are not directly comparable.</p>
              {comparisonTasks.map((t) => <div className="metric-row" key={t.id}>
                <span className="metric-name">{t.shortLabel}</span>
                <div className="metric-bars">
                  {pinned.map((r, i) => {
                    const score = scoreFor(r, t);
                    return <div className="metric-bar-row" key={r.slug} aria-label={`${displayName(r.name)}, ${t.label}: ${score === null ? "not measured" : formatMetric(score, t.scale)}`}>
                      <div className="metric-track"><span style={{ width: `${Math.max(0, Math.min(100, score ?? 0))}%`, backgroundColor: PIN_COLORS[i] }} /></div>
                      <span>{score === null ? "–" : formatMetric(score, t.scale)}<span className="sr-only"> · {displayName(r.name)}</span></span>
                    </div>;
                  })}
                </div>
              </div>)}
            </div>
            <div className="comparison-details"><h3>At a glance</h3><div className="overflow-x-auto"><table>
              <thead><tr><th>Model</th><th>Cost</th><th>Context</th><th>Speed</th></tr></thead>
              <tbody>{pinned.map((r) => <tr key={r.slug}><th scope="row">{displayName(r.name)}</th><td>{formatUsd(priceFor(r, costMode))}</td><td>{formatContext(r.gateway_context_window_tokens ?? r.context_window_tokens)}</td><td>{formatSpeed(r.performance.output_tokens_per_second)}</td></tr>)}</tbody>
            </table></div><p>Cost {costMode === "blended" ? "per 1M tokens (3:1 blended)" : "per AA benchmark task"}. Missing values are shown as a dash.</p>
              {pinned.length > 1 && <div className="comparison-deltas"><strong>Compared with {displayName(pinned[0].name)}</strong>{pinned.slice(1).map((r) => {
                const baseScore = scoreFor(pinned[0], task), baseCost = priceFor(pinned[0], costMode);
                const score = scoreFor(r, task), cost = priceFor(r, costMode);
                if (baseScore === null || baseScore <= 0 || baseCost === null || baseCost <= 0 || score === null || cost === null) return <p key={r.slug}>{displayName(r.name)}: percentage comparison unavailable (missing data or zero baseline).</p>;
                const fmt = (v: number) => `${v >= 0 ? "+" : ""}${formatNumber(v)}%`;
                return <p key={r.slug}>{displayName(r.name)}: {fmt((score / baseScore - 1) * 100)} score · {fmt((cost / baseCost - 1) * 100)} cost</p>;
              })}</div>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
