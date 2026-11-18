import { useMemo } from "react";
import * as echarts from "echarts/core";
import { ScatterChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { Filters } from "../lib/filters";
import { formatMetric, formatSpeed, formatUsd, displayName } from "../lib/format";
import { priceFor, scoreFor } from "../lib/tasks";
import { costAxisPosition, costAxisValue, medianPositive, scoreExtent } from "../lib/chartScales";
import type { Row } from "../lib/types";
import { useChartTheme, type ChartTheme } from "../lib/theme";
import { useChart } from "../lib/useChart";
import { creatorColor } from "../lib/creatorColors";
import { groupColor } from "../lib/creatorColors";
import { CreatorLegend, chartLegendRows } from "./CreatorLegend";
import { effortLabel, EffortLegend, type ColorBy } from "./ValueScatter";

echarts.use([ScatterChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  rows: Row[];
  legendRows: Row[];
  filters: Filters;
  colorBy: ColorBy;
  selected: string | null;
  hiddenCreators: string[];
  highlightCreator: string | null;
  onHighlightCreator: (creator: string | null) => void;
  onToggleCreator: (creator: string) => void;
  onSelect: (slug: string) => void;
}

// Score against output speed, for latency-sensitive work. Points with no speed
// measurement are left out, never drawn at zero.
export function SpeedScatter({ rows, legendRows, filters, colorBy, selected, hiddenCreators, highlightCreator, onHighlightCreator, onToggleCreator, onSelect }: Props) {
  const theme = useChartTheme();
  const option = useMemo(() => buildOption(rows, filters, selected, theme, highlightCreator, colorBy), [rows, filters, selected, theme, highlightCreator, colorBy]);
  const ref = useChart(option, onSelect);

  return (
    <section aria-label="Score against speed" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <header>
        <h2 className="text-base font-semibold">Capability at speed</h2>
        <p className="text-sm text-muted">
          Median output speed vs. {filters.task.label} score. Axes are zoomed to visible data; speed uses a compressed scale. AA measures across providers, not specifically the gateway.
        </p>
      </header>
      <div ref={ref} role="img" aria-label="Scatter chart of score against output speed. Exact values are available in the model table." className="tradeoff-chart w-full" />
      <CreatorLegend rows={chartLegendRows(legendRows, filters, "speed")} hidden={hiddenCreators} highlighted={highlightCreator} theme={theme} colorBy={colorBy} onToggle={onToggleCreator} onHighlight={onHighlightCreator} />
      {colorBy === "effort" && <EffortLegend rows={rows} theme={theme} />}
      <p className="text-xs text-muted">Diamond: gateway reports $0 · circle: priced or price unavailable · dashed line: speed/score frontier. Select a point for details. Models without speed are omitted; the model table offers a keyboard-accessible alternative.</p>
    </section>
  );
}

export function buildOption(rows: Row[], filters: Filters, selected: string | null, theme: ChartTheme, highlightCreator: string | null = null, colorBy: ColorBy = "creator"): EChartsCoreOption {
  const { task } = filters;
  const points = rows
    .map((r) => ({ r, score: scoreFor(r, task), speed: r.performance.output_tokens_per_second }))
    .filter((x): x is { r: Row; score: number; speed: number } => x.score !== null && x.speed !== null && x.speed > 0)
    .map(({ r, score, speed }) => ({
      value: [speed, score],
      slug: r.slug,
      name: displayName(r.name),
      creator: r.creator,
      cost: priceFor(r, filters.costMode),
      free: priceFor(r, filters.costMode) === 0,
      symbol: priceFor(r, filters.costMode) === 0 ? "diamond" : "circle",
      itemStyle: { color: colorBy === "creator" ? creatorColor(r.creator, theme) : groupColor(effortLabel(r), false, theme), opacity: highlightCreator && r.creator !== highlightCreator ? 0.18 : 1, borderColor: r.slug === selected ? theme.ink : theme.surface, borderWidth: r.slug === selected ? 3 : 1.5 },
    }));

  // Maximise both speed and score; traverse from the fastest point leftwards.
  let best = -Infinity;
  const frontier = [...points].sort((a, b) => b.value[0] - a.value[0] || b.value[1] - a.value[1])
    .filter((p) => { if (p.value[1] <= best) return false; best = p.value[1]; return true; })
    .reverse();
  const speedReference = medianPositive(points.map((p) => p.value[0]), 100);
  const [scoreMin, scoreMax] = scoreExtent(points.map((p) => p.value[1]));
  const transformedPoints = points.map((p) => ({ ...p, speed: p.value[0], value: [costAxisPosition(p.value[0], speedReference), p.value[1]] }));

  return {
    animationDuration: 0,
    grid: { left: 56, right: 24, top: 16, bottom: 44 },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (p: { data: { name: string; creator: string; cost: number | null; free: boolean; speed: number; value: [number, number] } }) =>
        [
          `<strong>${escapeHtml(p.data.name)}</strong>`,
          escapeHtml(p.data.creator),
          `Speed: ${formatSpeed(p.data.speed)}`,
          `Score: ${formatMetric(p.data.value[1], task.scale)}`,
          p.data.free ? "Gateway: $0" : `Cost: ${formatUsd(p.data.cost, 4)} ${filters.costMode === "task" ? "per AA benchmark task" : "per 1M tokens"}`,
        ].join("<br/>"),
    },
    xAxis: {
      type: "value",
      scale: true,
      min: points.length ? costAxisPosition(Math.max(0, Math.min(...points.map((p) => p.value[0])) * 0.8), speedReference) : 0,
      max: points.length ? costAxisPosition(Math.max(...points.map((p) => p.value[0])) * 1.1, speedReference) : 1,
      name: "Output speed (tokens/s, compressed)",
      nameLocation: "middle",
      nameGap: 28,
      nameTextStyle: { color: theme.muted },
      axisLabel: { color: theme.muted, formatter: (v: number) => `${Math.round(costAxisValue(v, speedReference))}` },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.line, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: scoreMin,
      max: scoreMax,
      scale: true,
      name: `${task.label} score`,
      nameLocation: "middle",
      nameGap: 40,
      nameTextStyle: { color: theme.muted },
      axisLabel: { color: theme.muted },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.line, type: "dashed" } },
    },
    series: [
      { type: "scatter", data: transformedPoints, symbolSize: 11 },
      { type: "line", data: frontier.length ? [[costAxisPosition(Math.max(0, Math.min(...points.map((p) => p.value[0])) * 0.8), speedReference), frontier[0].value[1]], ...frontier.map((p) => [costAxisPosition(p.value[0], speedReference), p.value[1]])] : [], symbol: "none", step: "start", silent: true, tooltip: { show: false }, lineStyle: { color: theme.muted, opacity: 0.8, type: "dashed", width: 1.5 } },
    ],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
