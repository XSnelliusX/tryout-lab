import { useMemo } from "react";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { Filters } from "../lib/filters";
import { formatMetric, formatUsd, displayName } from "../lib/format";
import { formatValue, priceFor, scoreFor, valueFor, valueUnit } from "../lib/tasks";
import type { Row } from "../lib/types";
import { useChartTheme, type ChartTheme } from "../lib/theme";
import { useChart } from "../lib/useChart";
import { creatorColor } from "../lib/creatorColors";

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  rows: Row[];
  filters: Filters;
  selected: string | null;
  onSelect: (slug: string) => void;
}

const TOP_N = 15;

// Horizontal bars show the best finite paid-model values for the active task.
export function TopValueBars({ rows, filters, selected, onSelect }: Props) {
  const theme = useChartTheme();
  const option = useMemo(() => buildOption(rows, filters, selected, theme), [rows, filters, selected, theme]);
  const ref = useChart(option, onSelect);
  const free = rows.filter((r) => priceFor(r, filters.costMode) === 0 && valueFor(r, filters.task, filters.costMode, filters.valueMode, filters.priceSensitivity) !== null);

  return (
    <section aria-label="Top models by value" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <header>
          <h2 className="text-base font-semibold">Leading paid models by value</h2>
        <p className="text-sm text-muted">
          {filters.task.label}, {valueUnit(filters.costMode, filters.valueMode)}{free.length ? " · paid models only" : ""}
        </p>
      </header>
      {free.length > 0 && <details className="free-models"><summary>{free.length} $0 variants excluded from bars</summary><p>Free variants are ranked at $0.005 in the table; the bars show paid models only. Verify gateway pricing before relying on it.</p><div>{free.map((r) => <button key={r.slug} type="button" onClick={() => onSelect(r.slug)}>{displayName(r.name)}</button>)}</div></details>}
      <div ref={ref} role="img" aria-label={`Top ${TOP_N} paid models by value. Exact values are available in the model table.`} className="value-chart tradeoff-chart w-full" />
      <p className="text-xs text-muted">Select a bar for details. The model table provides the same values and is keyboard accessible.</p>
    </section>
  );
}

export function buildOption(rows: Row[], filters: Filters, selected: string | null, theme: ChartTheme): EChartsCoreOption {
  const { task, costMode, valueMode } = filters;
  const ranked = rows
    .map((r) => ({ r, v: valueFor(r, task, costMode, valueMode, filters.priceSensitivity) }))
    .filter((x): x is { r: Row; v: number } => x.v !== null && Number.isFinite(x.v) && priceFor(x.r, costMode) !== 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, TOP_N)
    .reverse();

  const data = ranked.map(({ r, v }) => ({
    value: v,
    slug: r.slug,
    name: displayName(r.name),
    score: scoreFor(r, task),
    cost: priceFor(r, costMode),
    itemStyle: { color: r.slug === selected ? theme.ink : creatorColor(r.creator, theme), borderRadius: [0, 6, 6, 0] },
  }));

  return {
    animationDuration: 0,
    grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (p: { data: { name: string; score: number | null; cost: number | null; value: number } }) =>
        [
          `<strong>${escapeHtml(p.data.name)}</strong>`,
          `Score: ${formatMetric(p.data.score, task.scale)}`,
          `Cost: ${formatUsd(p.data.cost)} ${costMode === "task" ? "per AA benchmark task" : "per 1M tokens"}`,
          `Value: ${formatValue(p.data.value, valueMode)} ${valueUnit(costMode, valueMode)}`,
        ].join("<br/>"),
    },
    xAxis: {
      type: "value",
      axisLabel: { color: theme.muted },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.line, type: "dashed" } },
    },
    yAxis: {
      type: "category",
      data: ranked.map(({ r }) => displayName(r.name)),
      axisLabel: { color: theme.ink, width: 165, overflow: "truncate" },
      axisTick: { show: false },
      axisLine: { show: false },
    },
    series: [
      {
        type: "bar",
        data,
        barMaxWidth: 18,
        label: {
          show: true,
          position: "right",
          color: theme.muted,
          formatter: (p: { value: number }) => formatValue(p.value, valueMode),
        },
      },
    ],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
