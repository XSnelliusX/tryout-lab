import { useMemo } from "react";
import * as echarts from "echarts/core";
import { ScatterChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { Filters } from "../lib/filters";
import { paretoFrontier } from "../lib/pareto";
import { costAxisPosition, costAxisValue, medianPositive, scoreExtent } from "../lib/chartScales";
import { formatValue, priceFor, scoreFor, valueFor, valueUnit } from "../lib/tasks";
import type { Row } from "../lib/types";
import { formatMetric, formatUsd, displayName } from "../lib/format";
import { useChartTheme, type ChartTheme } from "../lib/theme";
import { useChart } from "../lib/useChart";
import { colorIndex, groupColor } from "../lib/creatorColors";
import { CreatorLegend, chartLegendRows } from "./CreatorLegend";

echarts.use([ScatterChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export type ColorBy = "creator" | "effort";

interface Props {
  rows: Row[];
  legendRows: Row[];
  filters: Filters;
  colorBy: ColorBy;
  selected: string | null;
  pinned: string[];
  hiddenCreators: string[];
  highlightCreator: string | null;
  onHighlightCreator: (creator: string | null) => void;
  onToggleCreator: (creator: string) => void;
  onSelect: (slug: string) => void;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Score on a linear axis, cost on a log axis. Frontier points are drawn larger
// and joined by a step line, so the best trade-offs stand out.
export function ValueScatter({ rows, legendRows, filters, colorBy, selected, pinned, hiddenCreators, highlightCreator, onHighlightCreator, onToggleCreator, onSelect }: Props) {
  const theme = useChartTheme();
  const { option, frontierIds, plotted } = useMemo(
    () => buildOption(rows, filters, colorBy, selected, pinned, theme, highlightCreator),
    [rows, filters, colorBy, selected, pinned, theme, highlightCreator],
  );
  const ref = useChart(option, onSelect);

  return (
    <section aria-label="Cost versus score" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Where capability meets cost</h2>
          <p className="text-sm text-muted">
            {filters.task.label} score against {filters.costMode === "blended" ? "blended price" : "cost per task"}.
            The dashed frontier marks models where no other model scores higher at the same or lower cost.
          </p>
        </div>
        <p className="text-xs text-muted">
          {plotted} plotted · {frontierIds.length} on frontier
        </p>
      </header>
      <div ref={ref} role="img" aria-label={`Scatter chart of ${filters.task.label} score against cost. ${plotted} models plotted, ${frontierIds.length} on the frontier. Exact values are available in the model table.`} className="tradeoff-chart w-full" />
      <CreatorLegend rows={chartLegendRows(legendRows, filters, "cost")} hidden={hiddenCreators} highlighted={highlightCreator} theme={theme} colorBy={colorBy} onToggle={onToggleCreator} onHighlight={onHighlightCreator} />
      {colorBy === "effort" && <EffortLegend rows={rows} theme={theme} />}
      <p className="text-xs text-muted">
        Select a point for details. Colors are brand-inspired, with shapes as an additional cue. Cost uses a compressed scale with a true $0; the score axis is zoomed to the visible data. Unpriced or unscored models are excluded. The model table provides a keyboard-accessible alternative.
      </p>
      {frontierIds.length > 0 && <details className="frontier-list"><summary><span><strong>Efficient frontier</strong><small>{frontierIds.length} models · best score at their cost</small></span><span className="frontier-chevron" aria-hidden="true">⌄</span></summary><div>{frontierIds.map((slug) => {
        const row = rows.find((r) => r.slug === slug);
        return row ? <button type="button" key={slug} onClick={() => onSelect(slug)}>{displayName(row.name)} <span>· {formatMetric(scoreFor(row, filters.task), filters.task.scale)} · {formatUsd(priceFor(row, filters.costMode))}</span></button> : null;
      })}</div></details>}
    </section>
  );
}

export function EffortLegend({ rows, theme }: { rows: Row[]; theme: ChartTheme }) {
  const efforts = [...new Set(rows.map(effortLabel))].sort(groupSort("effort"));
  return <div className="effort-legend" aria-label="Effort color key"><strong>Effort colors</strong>{efforts.map((effort) => <span key={effort}><i style={{ backgroundColor: groupColor(effort, false, theme) }} />{effort}</span>)}</div>;
}

interface Plottable {
  row: Row;
  cost: number;
  score: number;
}

export function buildOption(
  rows: Row[],
  filters: Filters,
  colorBy: ColorBy,
  selected: string | null,
  pinned: string[],
  theme: ChartTheme,
  highlightCreator: string | null = null,
): { option: EChartsCoreOption; frontierIds: string[]; plotted: number } {
  const { task, costMode } = filters;

  const points: Plottable[] = [];
  for (const r of rows) {
    const cost = priceFor(r, costMode);
    const score = scoreFor(r, task);
    if (cost === null || cost < 0 || score === null) continue;
    points.push({ row: r, cost, score });
  }
  const maxCostPosition = points.length ? Math.max(...points.map((point) => point.cost)) : 0;

  const allFrontier = paretoFrontier(rows.flatMap((r) => {
    const cost = priceFor(r, costMode), score = scoreFor(r, task);
    return cost !== null && score !== null && cost >= 0 ? [{ id: r.slug, cost, score }] : [];
  }));
  const frontier = allFrontier;
  const frontierIds = allFrontier.map((p) => p.id);
  const frontierSet = new Set(frontierIds);
  const pinnedSet = new Set(pinned);
  const costReference = medianPositive(points.map((p) => p.cost), costMode === "task" ? 0.25 : 1);
  const [scoreMin, scoreMax] = scoreExtent(points.map((p) => p.score));

  const groupOf = (r: Row) => (colorBy === "creator" ? r.creator : effortLabel(r));
  const groups = [...new Set(points.map((p) => groupOf(p.row)))].sort(groupSort(colorBy));
  const colorOf = (g: string) => groupColor(g, colorBy === "creator", theme);

  const symbols = ["circle", "rect", "triangle", "diamond", "roundRect", "pin"];
  const series = groups.map((g) => ({
    name: g || "Unknown creator",
    type: "scatter" as const,
    symbol: symbols[colorIndex(g, colorBy === "creator") % symbols.length],
    color: colorOf(g),
    symbolSize: (d: number[]) => d[2],
    itemStyle: { color: colorOf(g), borderColor: theme.surface, borderWidth: 1.5, opacity: 1 },
    symbolKeepAspect: true,
    emphasis: { focus: "series" as const, scale: 1.5 },
    data: points
      .filter((p) => groupOf(p.row) === g)
      .map((p) => ({
        value: [costAxisPosition(p.cost, costReference), p.score, pinnedSet.has(p.row.slug) ? 18 : frontierSet.has(p.row.slug) ? 15 : 11],
        cost: p.cost,
        slug: p.row.slug,
        name: displayName(p.row.name),
        creator: p.row.creator,
        effort: effortLabel(p.row),
        metric: valueFor(p.row, task, costMode, filters.valueMode, filters.priceSensitivity),
        onFrontier: frontierSet.has(p.row.slug),
        isPinned: pinnedSet.has(p.row.slug),
        itemStyle: { opacity: highlightCreator && p.row.creator !== highlightCreator ? 0.18 : 1, ...(p.row.slug === selected ? { borderColor: theme.ink, borderWidth: 3 } : {}) },
      })),
  }));

  const frontierSeries = {
    name: "Pareto frontier",
    type: "line" as const,
    symbol: "none",
    step: "end" as const,
    lineStyle: { color: theme.muted, opacity: 0.8, width: 1.5, type: "dashed" as const },
    silent: true,
    z: 0,
    data: frontier.length ? [...frontier.map((p) => [costAxisPosition(p.cost, costReference), p.score]), [costAxisPosition(maxCostPosition, costReference) * 1.08 || 1, frontier[frontier.length - 1].score]] : [],
  };

  const option: EChartsCoreOption = {
    animationDuration: 0,
    color: groups.map(colorOf),
    grid: { left: 72, right: 24, top: 20, bottom: 55 },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (p: { data: { name: string; creator: string; effort: string; cost: number; value: [number, number, number]; onFrontier: boolean; metric: number | null } }) => {
        const cost = p.data.cost, score = p.data.value[1];
        return [
          `<strong>${escapeHtml(p.data.name)}</strong>`,
          escapeHtml(p.data.creator),
          `Score: ${formatMetric(score, task.scale)}`,
          `Cost: ${formatUsd(cost)} ${costMode === "task" ? "per AA benchmark task" : "per 1M tokens"}`,
          `Value: ${formatValue(p.data.metric, filters.valueMode)}${p.data.metric === Infinity ? " · no finite ratio" : ` ${valueUnit(costMode, filters.valueMode)}`}`,
          p.data.onFrontier ? "On the Pareto frontier" : "",
        ]
          .filter(Boolean)
          .join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: points.length ? costAxisPosition(maxCostPosition, costReference) * 1.08 || 1 : 1,
      name: costMode === "blended" ? "Blended price per 1M tokens (compressed)" : "Cost per task, USD (compressed)",
      nameLocation: "middle",
      nameGap: 30,
      nameTextStyle: { color: theme.muted },
      axisLabel: { color: theme.muted, formatter: (v: number) => formatUsd(costAxisValue(v, costReference)) },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.line, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      name: `${task.label} score`,
      nameLocation: "middle",
      nameGap: 48,
      nameTextStyle: { color: theme.muted },
      min: scoreMin,
      max: scoreMax,
      scale: true,
      axisLabel: { color: theme.muted },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.line, type: "dashed" } },
    },
    series: [...series, frontierSeries],
  };

  return { option, frontierIds, plotted: points.length };
}

export function effortLabel(r: Row): string {
  if (r.effort) return r.effort;
  return r.non_reasoning ? "non-reasoning" : "default";
}

function groupSort(colorBy: ColorBy) {
  return (a: string, b: string) => {
    if (colorBy === "effort") {
      const ia = EFFORT_ORDER.indexOf(a);
      const ib = EFFORT_ORDER.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    }
    return a.localeCompare(b);
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
