import { Fragment, useEffect, useMemo, useState } from "react";
import type { Filters } from "../lib/filters";
import { groupByBase } from "../lib/groups";
import { effortName } from "../lib/effort";
import { displayName, formatContext, formatMetric, formatSeconds, formatSpeed, formatUsd } from "../lib/format";
import { formatValue, priceFor, scoreFor, valueFor } from "../lib/tasks";
import type { Row } from "../lib/types";

export const MAX_PINNED = 3;

interface Props {
  rows: Row[];
  filters: Filters;
  selected: string | null;
  pinned: string[];
  onSelect: (slug: string) => void;
  onTogglePin: (slug: string) => void;
  query: string;
  onQuery: (query: string) => void;
}

type SortKey = "value" | "score" | "cost" | "context" | "speed" | "ttft" | "e2e" | "name";

const PAGE_SIZE = 50;

// Sortable ranking table. Numbers are right-aligned with tabular figures and
// unmeasured values show as a dash. Up to three rows can be pinned to compare.
export function RankingTable({ rows, filters, selected, pinned, onSelect, onTogglePin, query, onQuery }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [desc, setDesc] = useState(true);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [grouped, setGrouped] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showMoreColumns, setShowMoreColumns] = useState(false);
  const { task, costMode, valueMode } = filters;

  const sorted = useMemo(() => {
    const keyOf: Record<SortKey, (r: Row) => number | string | null> = {
      value: (r) => valueFor(r, task, costMode, valueMode, filters.priceSensitivity),
      score: (r) => scoreFor(r, task),
      cost: (r) => priceFor(r, costMode),
      context: (r) => r.gateway_context_window_tokens ?? r.context_window_tokens ?? null,
      speed: (r) => r.performance.output_tokens_per_second,
      ttft: (r) => r.performance.time_to_first_token_seconds,
      e2e: (r) => r.performance.end_to_end_seconds,
      name: (r) => displayName(r.name),
    };
    const get = keyOf[sortKey];
    return [...rows].sort((a, b) => compareNullsLast(get(a), get(b), desc));
  }, [rows, task, costMode, valueMode, filters.priceSensitivity, sortKey, desc]);

  // Grouping applies to the default value ordering only. Sorting by another column
  // compares rows across models, so nesting would hide that order.
  const useGroups = grouped && sortKey === "value" && desc;
  const groups = useMemo(() => (useGroups ? groupByBase(rows, task, costMode, valueMode, filters.priceSensitivity) : []), [useGroups, rows, task, costMode, valueMode, filters.priceSensitivity]);
  const visibleGroups = useMemo(() => groups.slice(0, limit), [groups, limit]);
  const visible = useGroups ? [] : sorted.slice(0, limit);
  // Grouped view counts models, not rows. Effort levels are reported beside the count.
  const shownCount = useGroups ? visibleGroups.length : visible.length;
  const totalCount = useGroups ? groups.length : sorted.length;
  const variantCount = useGroups ? groups.reduce((n, g) => n + g.variants.length, 0) : 0;
  const maxV = useMemo(() => maxValue(useGroups ? rows : visible, filters), [useGroups, rows, visible, filters]);
  const pinnedSet = new Set(pinned);
  const pinFull = pinned.length >= MAX_PINNED;

  useEffect(() => setLimit(PAGE_SIZE), [filters, sortKey, desc, grouped]);

  const toggleGroup = (key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderRow = (
    r: Row,
    rank: number | null,
    opts: { indent: boolean; variantCount: number; open: boolean; onToggle: () => void },
  ) => {
    const v = valueFor(r, task, costMode, valueMode, filters.priceSensitivity);
    const isSelected = r.slug === selected;
    const isPinned = pinnedSet.has(r.slug);
    const disablePin = !isPinned && pinFull;
    const label = displayName(r.name);
    return (
      <tr
        key={r.slug}
        onClick={() => onSelect(r.slug)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(r.slug);
          }
        }}
        tabIndex={0}
        aria-selected={isSelected}
        className={`cursor-pointer border-b border-line/60 transition last:border-0 hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none ${
          opts.indent ? "bg-canvas/50 text-[0.92em]" : ""
        } ${isSelected ? "bg-accent/5" : ""}`}
      >
        <td className="px-2 py-2">
          <button
            type="button"
            aria-pressed={isPinned}
            aria-label={`${isPinned ? "Unpin" : "Pin"} ${label}`}
            disabled={disablePin}
            title={disablePin ? `You can pin up to ${MAX_PINNED} models` : isPinned ? "Unpin" : "Pin to compare"}
            onClick={(e) => {
              e.stopPropagation();
              togglePin(r.slug);
            }}
            className={`h-6 w-6 rounded-md border text-xs transition disabled:opacity-40 ${
              isPinned ? "border-accent bg-accent text-white" : "border-line text-muted hover:border-accent"
            }`}
          >
            {isPinned ? "✓" : "+"}
          </button>
        </td>
        <td className="px-3 py-2 text-right text-muted">{rank ?? ""}</td>
        <td className="model-cell px-3 py-2">
          <div className={`model-cell-inner ${opts.indent ? "is-variant" : ""}`}>
            <div className="model-identity">
              <span className="model-name" title={label}>{opts.indent ? r.effort ? r.non_reasoning ? "Non-reasoning" : `${effortName(r.effort)} effort` : label : label}</span>
              {!opts.indent && <span className="model-metadata">
                {r.release_deprecated && <span className="model-status deprecated">Deprecated</span>}
                {(r.warnings?.length ?? 0) > 0 && <span className="model-status warning" title={(r.warnings ?? []).join("; ")}>⚠ {r.warnings?.length} {r.warnings?.length === 1 ? "warning" : "warnings"}</span>}
                {r.gateway_ids.length > 1 && <span className="model-status">{r.gateway_ids.length} deployments</span>}
              </span>}
            </div>
            {opts.variantCount > 0 && (
              <button
                type="button"
                aria-expanded={opts.open}
                aria-label={`${opts.open ? "Collapse" : "Expand"} ${label} variants`}
                onClick={(e) => {
                  e.stopPropagation();
                  opts.onToggle();
                }}
                className="variant-toggle"
              >
                {opts.variantCount} {opts.variantCount === 1 ? "variant" : "variants"} <span aria-hidden="true">{opts.open ? "⌃" : "⌄"}</span>
              </button>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-muted">{r.creator}</td>
        {showMoreColumns && <td className="px-3 py-2 text-right">{formatContext(r.gateway_context_window_tokens ?? r.context_window_tokens)}</td>}
        <td className="px-3 py-2 text-right">{formatMetric(scoreFor(r, task), task.scale)}</td>
        <td className="px-3 py-2 text-right">
          <ValueBar value={v} max={maxV} mode={valueMode} />
        </td>
        <td className="px-3 py-2 text-right">
          {priceFor(r, costMode) === 0 ? <span className="text-muted">free</span> : formatUsd(priceFor(r, costMode))}
        </td>
        {showMoreColumns && <td className="px-3 py-2 text-right text-muted">
          {formatUsd(r.pricing.gateway_input_per_1m)} / {formatUsd(r.pricing.gateway_output_per_1m)}
        </td>}
        <td className="px-3 py-2 text-right">{formatSpeed(r.performance.output_tokens_per_second)}</td>
        {showMoreColumns && <td className="px-3 py-2 text-right">{formatSeconds(r.performance.time_to_first_token_seconds)}</td>}
        {showMoreColumns && <td className="px-3 py-2 text-right">{formatSeconds(r.performance.end_to_end_seconds)}</td>}
      </tr>
    );
  };

  const togglePin = (slug: string) => onTogglePin(slug);

  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => {
    const active = sortKey === key;
    return (
      <th scope="col" aria-sort={active ? (desc ? "descending" : "ascending") : "none"} className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
        <button
          type="button"
          onClick={() => {
            if (active) setDesc(!desc);
            else {
              setSortKey(key);
              setDesc(key !== "name" && key !== "ttft" && key !== "e2e");
            }
          }}
          className="inline-flex min-h-8 items-center gap-1 rounded hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          {label}
          <span aria-hidden className="text-[10px]">{active ? (desc ? "▼" : "▲") : ""}</span>
        </button>
      </th>
    );
  };

  return (
    <section id="ranking" aria-label="Model ranking" className="ranking-section flex scroll-mt-24 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="section-kicker">YOUR MODEL UNIVERSE</p><h2 className="text-base font-semibold">Explore models</h2>
          <p className="text-sm text-muted">
            {useGroups ? "Groups are ordered by their best variant; values shown belong to each row." : "Flat sorting compares individual variants."} Select a row for details, or pin up to {MAX_PINNED} to compare.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input type="search" className="table-search" aria-label="Search models" placeholder="Find a model…" value={query} onChange={(e) => onQuery(e.target.value)} />
          <button type="button" className="columns-button" aria-pressed={showMoreColumns} onClick={() => setShowMoreColumns(!showMoreColumns)}>{showMoreColumns ? "Fewer columns" : "More columns"}</button>
          <div role="group" aria-label="Table view" className="segmented table-view-toggle inline-flex rounded-lg border border-line p-0.5 text-xs">
            {[
              { v: true, label: "Grouped" },
              { v: false, label: "Flat" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={grouped === o.v}
                onClick={() => { setGrouped(o.v); if (o.v) { setSortKey("value"); setDesc(true); } }}
                className={`rounded-md px-2.5 py-1 transition ${grouped === o.v ? "bg-accent text-white" : "text-ink hover:bg-canvas"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">
            Showing {shownCount} of {totalCount} {useGroups ? "models" : "rows"}
            {useGroups && variantCount > 0 ? ` · ${variantCount} additional variants` : ""}
          </p>
        </div>
      </header>
      <div className="overflow-x-auto" role="region" aria-label="Scrollable model ranking" tabIndex={0}>
        <table className={`w-full text-sm ${showMoreColumns ? "min-w-[1080px]" : "min-w-[760px]"}`}>
          <thead className="border-b border-line text-xs uppercase tracking-wider text-muted">
            <tr>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                <span className="sr-only">Pin</span>
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">#</th>
              {header("name", "Model", "left")}
              <th scope="col" className="px-3 py-2 text-left font-medium">Creator</th>
              {showMoreColumns && header("context", "Context")}
              {header("score", "Score")}
              {header("value", valueMode === "price" ? "Score / cost" : "Value index")}
              {header("cost", costMode === "blended" ? "Blended $/1M" : "Per task")}
              {showMoreColumns && <th scope="col" className="px-3 py-2 text-right font-medium">In / Out $/1M</th>}
              {header("speed", "Speed")}
              {showMoreColumns && header("ttft", "TTFT")}
              {showMoreColumns && header("e2e", "End-to-end")}
            </tr>
          </thead>
          <tbody>
            {useGroups
              ? visibleGroups.map((g, gi) => {
                  const open = expanded.has(g.key);
                  const hasVariants = g.variants.length > 0;
                  return (
                    <Fragment key={g.key}>
                      {renderRow(g.base, gi + 1, { indent: false, variantCount: hasVariants ? g.variants.length : 0, open, onToggle: () => toggleGroup(g.key) })}
                      {open && g.variants.map((v) => renderRow(v, null, { indent: true, variantCount: 0, open: false, onToggle: () => {} }))}
                    </Fragment>
                  );
                })
              : visible.map((r, i) => renderRow(r, i + 1, { indent: false, variantCount: 0, open: false, onToggle: () => {} }))}
          </tbody>
        </table>
      </div>
      {totalCount === 0 && <div className="empty-results"><strong>No models match these criteria.</strong><p>Try another benchmark, broaden your filters, or reset your selection.</p></div>}
      {(useGroups ? groups.length : sorted.length) > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE_SIZE)}
          className="self-center rounded-lg border border-line px-4 py-1.5 text-sm text-ink hover:border-accent"
        >
          Show {Math.min(PAGE_SIZE, (useGroups ? groups.length : sorted.length) - limit)} more
        </button>
      )}
    </section>
  );
}

function ValueBar({ value, max, mode }: { value: number | null; max: number; mode: Filters["valueMode"] }) {
  if (value === null) return <span className="text-muted">–</span>;
  if (!Number.isFinite(value)) return <span className="font-medium text-accent">Free · ∞</span>;
  const pct = max > 0 ? Math.max(4, (value / max) * 100) : 0;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden className="h-2 w-20 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-14 text-right">{formatValue(value, mode)}</span>
    </span>
  );
}

function maxValue(rows: Row[], filters: Filters): number {
  let max = 0;
  for (const r of rows) {
    const v = valueFor(r, filters.task, filters.costMode, filters.valueMode, filters.priceSensitivity);
    if (v !== null && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

// compareNullsLast orders values in the chosen direction while keeping
// unmeasured rows at the bottom either way.
function compareNullsLast(a: number | string | null, b: number | string | null, desc: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const dir = desc ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return dir * a.localeCompare(b);
  if (a === b) return 0;
  return dir * ((a as number) > (b as number) ? 1 : -1);
}
