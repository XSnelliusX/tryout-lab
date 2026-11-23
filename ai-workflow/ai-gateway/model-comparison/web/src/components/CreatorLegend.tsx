import { useMemo } from "react";
import { displayName } from "../lib/format";
import type { Row } from "../lib/types";
import type { ChartTheme } from "../lib/theme";
import { creatorColor } from "../lib/creatorColors";
import { priceFor, scoreFor } from "../lib/tasks";
import type { Filters } from "../lib/filters";

interface Props {
  rows: Row[];
  hidden: string[];
  highlighted: string | null;
  theme: ChartTheme;
  colorBy?: "creator" | "effort";
  onToggle: (creator: string) => void;
  onHighlight: (creator: string | null) => void;
}

export function chartLegendRows(rows: Row[], filters: Filters, view: "cost" | "speed"): Row[] {
  return rows.filter((row) => {
    const score = scoreFor(row, filters.task);
    if (score === null) return false;
    if (view === "speed") return row.performance.output_tokens_per_second !== null && Number.isFinite(row.performance.output_tokens_per_second) && row.performance.output_tokens_per_second > 0;
    const cost = priceFor(row, filters.costMode);
    return cost !== null && Number.isFinite(cost) && cost >= 0;
  });
}

export function CreatorLegend({ rows, hidden, highlighted, theme, colorBy = "creator", onToggle, onHighlight }: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const group = map.get(row.creator) ?? [];
      group.push(row);
      map.set(row.creator, group);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  if (!groups.length) return null;
  return <div className="creator-legend" aria-label="Filter chart by creator">
    <div className="legend-heading"><strong>Creators</strong><span>Hover or focus to highlight · click to hide</span></div>
    <div className="creator-list">{groups.map(([creator, models]) => {
      const isHidden = hidden.includes(creator);
      return <div className="creator-legend-item" key={creator} onMouseEnter={() => onHighlight(creator)} onMouseLeave={() => onHighlight(null)}>
        <button type="button" className="creator-toggle" aria-pressed={!isHidden} aria-label={`${isHidden ? "Show" : "Hide"} ${creator} on charts`} onFocus={() => onHighlight(creator)} onBlur={() => onHighlight(null)} onClick={() => onToggle(creator)}>
          <span className="creator-swatch" style={{ background: colorBy === "creator" ? creatorColor(creator, theme) : "var(--color-muted)" }} aria-hidden="true" />{creator}<span className="creator-count">{models.length}</span>
        </button>
        {highlighted === creator && <div className="creator-popover" aria-hidden="true"><strong>{creator} · {models.length} variants</strong><ul>{models.slice(0, 6).map((row) => <li key={row.slug}>{displayName(row.name)}</li>)}</ul>{models.length > 6 && <small>+ {models.length - 6} more variants</small>}</div>}
      </div>;
    })}</div>
    {hidden.length > 0 && <p className="legend-note">Hidden creators affect charts only, not the ranking or recommendations.</p>}
  </div>;
}
