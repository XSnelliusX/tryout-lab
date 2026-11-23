import { useEffect, useRef } from "react";
import type { Filters } from "../lib/filters";
import { displayName, formatContext, formatMetric, formatNumber, formatSeconds, formatSpeed, formatUsd } from "../lib/format";
import { formatValue, priceFor, scoreFor, valueFor, valueUnit, type Task } from "../lib/tasks";
import type { Metric, Row } from "../lib/types";

interface Props {
  row: Row | null;
  filters: Filters;
  tasks: Task[];
  metrics: Metric[];
  onClose: () => void;
}

// Full detail for one model: a third workspace column on wide screens (the main
// content narrows, nothing is covered), a floating panel on narrow ones. It
// stays open while the page is used, so another row simply replaces it; Escape
// or × closes it.
export function DetailDrawer({ row, filters, tasks, metrics, onClose }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const isOpen = row !== null;
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previousFocus?.isConnected && (!document.activeElement || document.activeElement === document.body || panel?.contains(document.activeElement))) previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [row?.slug]);

  if (!row) return null;

  const metricList: Metric[] = metrics.length > 0
    ? metrics
    : tasks.map((t) => ({ id: t.id, label: t.label, short_label: t.shortLabel, group: t.group, kind: t.kind, scale: t.scale, description: t.description, radar: t.radar, default: t.default }));
  const scoreGroups = groupMetrics(metricList)
    .map(([group, list]) => [group, list.filter((m) => row.scores[m.id] !== null && row.scores[m.id] !== undefined)] as [string, Metric[]])
    .filter(([, list]) => list.length > 0);
  const priceSource = row.pricing.price_source ?? "gateway";
  const taskCostSource = row.pricing.cost_per_task_source ?? "none";

  return (
    <aside
      key={row.slug}
      ref={panelRef}
      role="region"
      aria-label={`Details for ${displayName(row.name)}`}
      tabIndex={-1}
      className="detail-drawer side-panel"
    >
      <div className="drawer-header">
        <div className="drawer-heading-line"><span className="section-kicker">MODEL DETAILS</span><button type="button" onClick={onClose} className="drawer-close" aria-label="Close model details">×</button></div>
        <div className="min-w-0">
          <p className="drawer-creator">{row.creator}</p>
          <h2>{displayName(row.name)}</h2>
          <p className="drawer-release">
            {row.release_name ? `${row.release_name} · ` : ""}
            {row.release_date ? `Released ${row.release_date}` : "Release date not published"}
          </p>
          <div className="drawer-badges">
            {row.release_deprecated && <Badge tone="warn">deprecated release</Badge>}
            {row.is_primary && <Badge>primary variant</Badge>}
            {row.effort && <Badge>{row.effort} effort</Badge>}
            {row.non_reasoning && <Badge>non-reasoning</Badge>}
            {row.is_open_weights && <Badge>open weights</Badge>}
          </div>
        </div>
      </div>
      <div className="drawer-body">
      <div className="drawer-summary">
        <div><span>{filters.task.shortLabel} score</span><strong>{formatMetric(scoreFor(row, filters.task), filters.task.scale)}</strong></div>
        <div><span>{filters.costMode === "task" ? "Cost / task" : "Cost / 1M"}</span><strong>{formatUsd(priceFor(row, filters.costMode))}</strong></div>
        <div><span>Output speed</span><strong>{formatSpeed(row.performance.output_tokens_per_second)}</strong></div>
      </div>

      <Section title="Value" summary={`${filters.task.label} · ${formatValue(valueFor(row, filters.task, filters.costMode, filters.valueMode, filters.priceSensitivity), filters.valueMode)}`}>
        <Stat label={`${filters.task.label} value`} value={`${formatValue(valueFor(row, filters.task, filters.costMode, filters.valueMode, filters.priceSensitivity), filters.valueMode)}${priceFor(row, filters.costMode) === 0 ? " · gateway reports $0" : ` ${valueUnit(filters.costMode, filters.valueMode)}`}`} />
        <Stat label={`${filters.task.label} score`} value={formatMetric(scoreFor(row, filters.task), filters.task.scale)} />
        <Stat label="Gateway blended price (3:1)" value={`${formatUsd(row.pricing.blended_3_to_1_per_1m)} / 1M`} />
        <Stat label="Gateway cost per task (est.)" value={formatUsd(row.pricing.gateway_cost_per_task_usd ?? row.intelligence_index_cost_per_task_usd)} />
        <Stat label="AA cost per task" value={formatUsd(row.pricing.aa_cost_per_task_usd ?? row.intelligence_index_cost_per_task_usd)} />
        <Note>
          Effective price source: <strong>{priceSourceLabel(priceSource)}</strong>. Task cost source: <strong>{taskCostLabel(taskCostSource)}</strong>.
          {row.pricing.gateway_price_model ? ` Gateway price from ${row.pricing.gateway_price_model}.` : ""}
        </Note>
      </Section>

      <Section title="Pricing" summary="Gateway and AA prices">
        <Stat label="Gateway input / 1M" value={formatUsd(row.pricing.gateway_input_per_1m)} />
        <Stat label="Gateway output / 1M" value={formatUsd(row.pricing.gateway_output_per_1m)} />
        {row.pricing.provider_host && (
          <>
            <Stat label={`${row.pricing.provider_host} input / 1M`} value={formatUsd(row.pricing.provider_input_per_1m ?? null)} />
            <Stat label={`${row.pricing.provider_host} output / 1M`} value={formatUsd(row.pricing.provider_output_per_1m ?? null)} />
          </>
        )}
        <Stat label="AA input / 1M" value={formatUsd(row.pricing.aa_input_per_1m)} />
        <Stat label="AA output / 1M" value={formatUsd(row.pricing.aa_output_per_1m)} />
        {row.pricing.gateway_price_differs_from_aa && (
          <Note tone="warn">Gateway and AA token prices differ. Value uses the effective price shown above.</Note>
        )}
        {row.pricing.free_at_gateway && (
          <Note>The gateway reports $0 for both input and output. Verify this price before relying on it.</Note>
        )}
        <p className="text-xs text-muted">Gateway IDs: {row.gateway_ids.join(", ") || "–"}</p>
        {(row.gateway_provider_names?.length ?? 0) > 0 && <p className="text-xs text-muted">Gateway providers: {row.gateway_provider_names!.join(", ")}</p>}
      </Section>

      <Section title="Match & provenance" summary={`${row.gateway_ids.length} gateway deployments · ${(row.warnings ?? []).length} warnings`}>
        <Stat label="AA release" value={row.release_name || row.release_slug || "–"} />
        <Stat label="AA variant" value={displayName(row.name)} />
        <Stat label="Variant slug" value={row.slug} />
        {row.match && (
          <>
            <Stat label="Match source" value={row.match.source || "–"} />
            <Stat label="Matched query" value={row.match.query || "–"} />
            <Stat label="Match score" value={formatNumber(row.match.score, 1)} />
            <Stat label="Matched on" value={`${row.match.matched_on || "–"}${row.match.mode ? ` · ${row.match.mode}` : ""}`} />
            {row.match.effort_hint && <Stat label="Requested effort" value={row.match.effort_hint} />}
          </>
        )}
        {(row.aliases?.length ?? 0) > 0 && <Stat label="Aliases" value={row.aliases!.join(", ")} />}
        {(row.upstream_models?.length ?? 0) > 0 && <Stat label="Upstream IDs" value={row.upstream_models!.join(", ")} />}
        {(row.warnings?.length ?? 0) > 0 && (
          <div className="rounded-lg bg-frontier/15 px-3 py-2 text-xs text-ink">
            <p className="font-medium">Warnings</p>
            <ul className="mt-1 list-inside list-disc">{row.warnings!.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
      </Section>

      <Section title="Context & capabilities" summary={`${formatContext(row.gateway_context_window_tokens ?? row.context_window_tokens)} context`}>
        <Stat label="Context window (gateway)" value={formatContext(row.gateway_context_window_tokens ?? row.context_window_tokens)} />
        <Stat label="Context window (model)" value={formatContext(row.context_window_tokens)} />
        <Stat label="Max output tokens" value={row.gateway_max_output_tokens ? formatContext(row.gateway_max_output_tokens) : "–"} />
        <Stat label="Input modalities" value={row.modalities?.input.join(", ") || "–"} />
        <Stat label="Output modalities" value={row.modalities?.output.join(", ") || "–"} />
        <Stat label="Open weights" value={row.is_open_weights === null || row.is_open_weights === undefined ? "–" : row.is_open_weights ? "Yes" : "No"} />
        {row.license_name && <Stat label="License" value={row.license_name} />}
        <Stat label="AA host rows" value={String(row.hosts?.length ?? 0)} />
      </Section>

      <Section title="Performance" summary={`${formatSpeed(row.performance.output_tokens_per_second)} output`}>
        <Stat label="Output speed" value={formatSpeed(row.performance.output_tokens_per_second)} />
        <Stat label="Time to first token" value={formatSeconds(row.performance.time_to_first_token_seconds)} />
        <Stat label="Time to first answer token" value={formatSeconds(row.performance.time_to_first_answer_token_seconds)} />
        <Stat label="End-to-end (500 answer tokens)" value={formatSeconds(row.performance.end_to_end_seconds)} />
        <Note>Source: {row.performance_source === "gateway_host" ? "the matched AA provider host" : "AA model-level medians"}.</Note>
      </Section>

      <Section title="Scores" summary={`${scoreGroups.reduce((count, [, list]) => count + list.length, 0)} published scores`}>
        {scoreGroups.length === 0 && <p className="text-sm text-muted">No benchmark scores published for this variant.</p>}
        {scoreGroups.map(([group, list]) => (
          <div key={group} className="mb-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">{group}</p>
            <div className="flex flex-col gap-1">
              {list.map((m) => {
                const value = row.scores[m.id] ?? null;
                if (value === null) return null;
                const raw = row.raw_scores?.[m.id];
                return <Stat key={m.id} label={m.label} value={formatScore(value, raw, m.scale)} />;
              })}
            </div>
          </div>
        ))}
      </Section>

      {(row.hosts?.length ?? 0) > 0 && (
        <Section title="Provider availability" summary={`${row.hosts!.length} AA host rows`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[380px] text-xs">
              <thead className="text-left uppercase tracking-wider text-muted">
                <tr>
                  <th className="py-1 font-medium">Host</th>
                  <th className="py-1 text-right font-medium">In / Out</th>
                  <th className="py-1 text-right font-medium">Per task</th>
                  <th className="py-1 text-right font-medium">Context</th>
                  <th className="py-1 text-right font-medium">Speed</th>
                </tr>
              </thead>
              <tbody>
                {row.hosts!.map((h, i) => (
                  <tr key={`${h.host_slug}-${h.label}-${i}`} className="border-t border-line/60">
                    <td className="py-1.5 pr-2">{h.host}</td>
                    <td className="py-1.5 text-right">{formatUsd(h.input_per_1m)} / {formatUsd(h.output_per_1m)}</td>
                    <td className="py-1.5 text-right">{formatUsd(h.cost_per_task_usd)}</td>
                    <td className="py-1.5 text-right">{formatContext(h.context_window_tokens)}</td>
                    <td className="py-1.5 text-right">{formatSpeed(h.output_tokens_per_second)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <p className="mt-6 text-xs text-muted">
        Data: Artificial Analysis. Scores are AA indices or raw benchmarks normalized to 0–100; they are not success probabilities.
        {row.release_deprecated ? " This AA release is deprecated; retained scores may be historical." : ""}
      </p>
      </div>
    </aside>
  );
}

function groupMetrics(metrics: Metric[]): [string, Metric[]][] {
  const groups = new Map<string, Metric[]>();
  for (const m of metrics) {
    const list = groups.get(m.group) ?? [];
    list.push(m);
    groups.set(m.group, list);
  }
  return [...groups.entries()];
}

function formatScore(value: number, raw: number | null | undefined, scale: "index" | "percent"): string {
  if (scale === "percent" && raw !== null && raw !== undefined && Number.isFinite(raw)) {
    return `${formatMetric(value, scale)} (raw ${formatNumber(raw, 3)})`;
  }
  return formatMetric(value, scale);
}

function priceSourceLabel(source: string): string {
  switch (source) {
    case "gateway": return "gateway /model/info";
    case "aa_host": return "AA provider host list price";
    case "aa_model": return "AA model list price";
    default: return "not available";
  }
}

function taskCostLabel(source: string): string {
  switch (source) {
    case "gateway_estimate": return "AA token usage × gateway price";
    case "aa_host": return "AA host cost per task";
    case "aa_model": return "AA model cost per task";
    default: return "not published";
  }
}

function Section({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  return (
    <details className="drawer-section">
      <summary><span><strong>{title}</strong><small>{summary}</small></span><span className="drawer-chevron" aria-hidden="true">⌄</span></summary>
      <div className="drawer-section-content">{children}</div>
    </details>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <p className={`rounded-lg px-3 py-2 text-xs ${tone === "warn" ? "bg-frontier/15 text-ink" : "bg-canvas text-muted"}`}>{children}</p>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone === "warn" ? "bg-frontier/20 text-ink" : "bg-canvas text-muted"}`}>
      {children}
    </span>
  );
}
