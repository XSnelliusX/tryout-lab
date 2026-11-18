import { useMemo } from "react";
import type { Filters } from "../lib/filters";
import { computeKpis } from "../lib/kpi";
import { displayName, formatMetric, formatUsd } from "../lib/format";
import { formatValue, priceFor, scoreFor, valueFor, valueUnit } from "../lib/tasks";
import type { Row } from "../lib/types";

interface Props {
  rows: Row[];
  total: number;
  excludedForTask: number;
  filters: Filters;
  onSelect: (slug: string) => void;
}

interface Card {
  label: string;
  title: string;
  primary: string;
  secondary: string;
  row: Row | null;
  accent: boolean;
}

// Four cards. Each one states its basis, so no number needs a footnote. The
// cheapest card only looks at models at or above the median score of the set.
export function KpiRow({ rows, total, excludedForTask, filters, onSelect }: Props) {
  const { task, costMode, valueMode } = filters;
  const k = useMemo(() => computeKpis(rows, task, costMode, valueMode, filters.priceSensitivity), [rows, task, costMode, valueMode, filters.priceSensitivity]);
  const unit = costMode === "blended" ? "per 1M tokens" : "per task";

  const cards: Card[] = [
    {
      label: "Best value",
      title: k.bestValue ? displayName(k.bestValue.name) : "–",
      primary: k.bestValue
        ? `${formatValue(valueFor(k.bestValue, task, costMode, valueMode, filters.priceSensitivity), valueMode)}${priceFor(k.bestValue, costMode) === 0 ? " · gateway reports $0" : ` ${valueUnit(costMode, valueMode)}`}`
        : valueMode === "speed" ? "No model has score, price and speed" : "No model has both a score and a price",
      secondary: k.bestValue ? `score ${formatMetric(scoreFor(k.bestValue, task), task.scale)} · ${formatUsd(priceFor(k.bestValue, costMode))} ${unit}` : "",
      row: k.bestValue,
      accent: true,
    },
    {
      label: "Highest score",
      title: k.topScore ? displayName(k.topScore.name) : "–",
      primary: k.topScore ? `score ${formatMetric(scoreFor(k.topScore, task), task.scale)}` : "–",
      secondary: k.topScore ? `${formatUsd(priceFor(k.topScore, costMode))} ${unit}` : "",
      row: k.topScore,
      accent: false,
    },
    {
      label: "Lowest cost above median",
      title: k.cheapestAboveMedian ? displayName(k.cheapestAboveMedian.name) : "–",
      primary: k.cheapestAboveMedian ? `${formatUsd(priceFor(k.cheapestAboveMedian, costMode))} ${unit}` : "–",
      secondary:
        k.cheapestAboveMedian && k.medianScore !== null
          ? `score ${formatMetric(scoreFor(k.cheapestAboveMedian, task), task.scale)} vs. median ${formatMetric(k.medianScore, task.scale)}`
          : "No priced model reaches the median score",
      row: k.cheapestAboveMedian,
      accent: false,
    },
    {
      label: "Models in view",
      title: `${rows.length} of ${total}`,
      primary: `${total - rows.length} hidden by filters or missing scores`,
      secondary: `${excludedForTask} lack a ${task.label.toLowerCase()} score`,
      row: null,
      accent: false,
    },
  ];

  return (
    <section aria-label="Key figures" className="insight-list">
      {cards.map((c) => (
        <CardView key={c.label} card={c} onSelect={onSelect} />
      ))}
    </section>
  );
}

function CardView({ card, onSelect }: { card: Card; onSelect: (slug: string) => void }) {
  const { row } = card;
  const Tag = row ? "button" : "div";
  return (
    <Tag
      type={row ? "button" : undefined}
      onClick={row ? () => onSelect(row.slug) : undefined}
      className={`flex min-w-0 flex-col gap-1 rounded-2xl border p-4 text-left shadow-sm transition ${
        card.accent ? "border-accent/40 bg-accent/5" : "border-line bg-surface"
      } ${row ? "hover:border-accent focus-visible:outline-2 focus-visible:outline-accent" : ""}`}
    >
      <span className="text-xs font-medium uppercase tracking-wider text-muted">{card.label}</span>
      <span className="break-words text-lg font-semibold tracking-tight" title={card.title}>
        {card.title}
      </span>
      <span className="text-sm font-medium">{card.primary}</span>
      {card.secondary && <span className="text-xs text-muted">{card.secondary}</span>}
    </Tag>
  );
}
