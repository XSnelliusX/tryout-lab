import { Button } from "open-glass-ui";
import type { ColorBy } from "./ValueScatter";
import type { Filters } from "../lib/filters";
import { PRICE_MAX, SLIDER_STEPS, priceFromSlider, sliderFromPrice } from "../lib/filters";
import { formatUsd } from "../lib/format";
import type { Task } from "../lib/tasks";
import type { ProviderOption } from "../lib/types";

interface Props {
  filters: Filters;
  setFilters: (f: Filters) => void;
  creators: string[];
  gatewayProviders: ProviderOption[];
  taskOptions: Task[];
  colorBy: ColorBy;
  setColorBy: (color: ColorBy) => void;
  onReset: () => void;
}

export function ControlBar({ filters, setFilters, creators, gatewayProviders, taskOptions, colorBy, setColorBy, onReset }: Props) {
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const capped = filters.maxPrice >= PRICE_MAX;
  const groups = [...new Set(taskOptions.map((t) => t.group))];
  const quick = ["intelligence", "general", "scicode", "coding", "automation_bench", "agentic", "engineering"]
    .map((id) => taskOptions.find((t) => t.id === id))
    .filter((t): t is Task => Boolean(t))
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
    .slice(0, 4);

  return (
    <section
      aria-label="Filters"
      className="control-panel flex min-w-0 flex-col gap-4"
    >
      <div className="control-heading"><div><span className="section-kicker">YOUR COMPARISON</span><h2>Criteria</h2><p>Shape the view around your needs.</p></div><Button variant="quiet" size="small" onClick={onReset} className="reset-button">Reset</Button></div>
      <div className="control-main">
      <div className="benchmark-field flex flex-col gap-2">
        <span id="task-label" className="text-xs font-medium uppercase tracking-wider text-muted">
          Benchmark
        </span>
        <div className="benchmark-picker">
          <select
            aria-labelledby="task-label"
            value={filters.task.id}
            onChange={(e) => {
              const next = taskOptions.find((t) => t.id === e.target.value);
              if (next) set({ task: next });
            }}
            className="min-w-[280px] max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {taskOptions.filter((t) => t.group === group).map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="quick-tasks" role="group" aria-label="Popular benchmarks">{quick.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={filters.task.id === t.id}
              aria-label={t.shortLabel}
              title={t.description}
              onClick={() => set({ task: t })}
              className={`rounded-full border px-3 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-accent ${
                filters.task.id === t.id
                  ? "border-accent bg-accent text-white"
                  : "border-line text-ink hover:border-accent"
              }`}
            >
              {t.shortLabel}
            </button>
          ))}</div>
        </div>
        <p className="text-xs text-muted">
          {filters.task.description}{filters.task.kind !== "benchmark" ? " AA index points." : ""}
        </p>
      </div>

      <Field label="Optimize for">
        <Segmented name="Value calculation" value={filters.valueMode} options={[
          { value: "price", label: "Price focused" },
          { value: "quality", label: "Quality focused" },
          { value: "speed", label: "Quality + speed" },
        ]} onChange={(v) => set({ valueMode: v })} />
      </Field>
      <label className="search-field">
        <span>Find a model</span>
        <input type="search" aria-label="Search models" placeholder="Search name, alias, gateway ID, release…" value={filters.modelQuery}
          onChange={(e) => set({ modelQuery: e.target.value })} />
      </label>
      </div>
      <details className="advanced-filters">
      <summary><span>More filters &amp; settings</span><span className="disclosure-icon" aria-hidden="true">+</span></summary>
      <div className="advanced-content">
      <p className="advanced-intro">Fine-tune the models and costs in your comparison.</p>
      {filters.valueMode !== "price" && <div className="advanced-block">
        <label htmlFor="price-sensitivity" className="text-xs font-medium text-muted">Price sensitivity: {filters.priceSensitivity.toFixed(2)}</label>
        <input id="price-sensitivity" type="range" min="0.05" max="1" step="0.05" value={filters.priceSensitivity}
          onChange={(e) => set({ priceSensitivity: Number(e.target.value) })} className="w-full accent-accent" />
        <p className="text-xs text-muted">At {filters.priceSensitivity.toFixed(2)}, a 10% price increase needs about {(100 * (Math.pow(1.1, filters.priceSensitivity) - 1)).toFixed(1)}% more score to break even{filters.valueMode === "speed" ? " at equal speed" : ""}. Higher sensitivity favors lower prices.</p>
      </div>}

      <div className="advanced-block advanced-fields">
        <Field label="Cost basis">
          <Segmented
            name="Cost basis"
            value={filters.costMode}
            options={[
              { value: "blended", label: "Blended 3:1 price" },
              { value: "task", label: "Cost per task" },
            ]}
            onChange={(v) => set({ costMode: v })}
          />
        </Field>

        <Field label={`Max cost: ${capped ? "no limit" : `${formatUsd(filters.maxPrice)} ${filters.costMode === "task" ? "/ task" : "/ 1M tokens"}`}`}>
          <input
            type="range"
            min={0}
            max={SLIDER_STEPS}
            step={1}
            value={sliderFromPrice(filters.maxPrice)}
            onChange={(e) => {
              const p = priceFromSlider(Number(e.target.value));
              set({ maxPrice: p >= PRICE_MAX * 0.999 ? PRICE_MAX : p });
            }}
            aria-label="Maximum cost, logarithmic"
            className="w-full accent-accent"
          />
        </Field>

        <Field label={`Min score: ${filters.minScore}`}>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={filters.minScore}
            onChange={(e) => set({ minScore: Number(e.target.value) })}
            aria-label="Minimum score"
            className="w-full accent-accent"
          />
        </Field>

        <Field label="Variants & reasoning">
          <div className="variant-selects">
            <select
              aria-label="Effort variants"
              value={filters.effort}
              onChange={(e) => set({ effort: e.target.value as Filters["effort"] })}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
            >
              <option value="all">All variants</option>
              <option value="base">Primary variant only</option>
              <option value="effort">Non-primary variants</option>
            </select>
            <select
              aria-label="Reasoning mode"
              value={filters.reasoning}
              onChange={(e) => set({ reasoning: e.target.value as Filters["reasoning"] })}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
            >
              <option value="all">Any mode</option>
              <option value="reasoning">Reasoning</option>
              <option value="non-reasoning">Non-reasoning</option>
            </select>
          </div>
        </Field>
      </div>

      <div className="advanced-block advanced-fields">
        <CreatorFilter creators={creators} selected={filters.creators} onChange={(creators) => set({ creators })} />
        <Field label="Gateway provider">
          <select
            aria-label="Gateway provider"
            value={filters.gatewayProvider}
            onChange={(e) => set({ gatewayProvider: e.target.value })}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
          >
            <option value="">All providers</option>
            {gatewayProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Scatter color">
          <Segmented name="Color by" value={colorBy} options={[{ value: "creator", label: "Creator" }, { value: "effort", label: "Effort" }]} onChange={setColorBy} />
        </Field>
        <label className="filter-check">
          <input type="checkbox" checked={filters.includeFree} onChange={(e) => set({ includeFree: e.target.checked })} className="accent-accent" />
          Include gateway $0 models
        </label>
        <label className="filter-check">
          <input type="checkbox" checked={filters.includeDeprecated} onChange={(e) => set({ includeDeprecated: e.target.checked })} className="accent-accent" />
          Include deprecated releases
        </label>
      </div>
      <details className="advanced-method"><summary>Understanding value and cost</summary><p>
        {filters.valueMode === "price" ? "Price focused: score ÷ cost." : filters.valueMode === "quality" ? "Quality focused: score ÷ cost raised to the selected price sensitivity." : "Quality + speed: the same relative value index with an additional speed factor. Models without measured speed are not ranked."} Higher is better. Free models rank separately; no percentage cost increase from zero is defined.
      </p>
      <p>
        {filters.costMode === "blended" ? "Blended price is (3 × input + output) ÷ 4 per 1M tokens. " : "Cost per task estimates one AA Intelligence Index task at gateway prices, using AA's benchmark token usage; it falls back to AA host or model pricing when a gateway price is unavailable. "}
        Effective prices prefer the gateway, then the AA provider host, then AA's model list price. Gateway $0 models {filters.includeFree ? "are included" : "are hidden"}; unavailable prices are excluded. These are decision heuristics, not benchmark scores.
      </p>
      <details className="text-xs text-muted"><summary className="cursor-pointer underline">How the utility score is calculated</summary>
        <p className="mt-1">For positive prices: price focus = score / cost; quality focus = score / cost^s, where s is price sensitivity. Speed focus = score × (tokens/s ÷ 100)^0.2 / cost^s. Free models have no finite cost ratio and are ranked before paid models; equal free models are ordered by score. Percentage gains are relative changes in benchmark scores, not changes in real-world success rates. The exponents are preferences, not measured facts; value indices cannot be compared across tasks or cost bases.</p>
      </details>
      </details>
      </div>
      </details>
    </section>
  );
}

function CreatorFilter({ creators, selected, onChange }: { creators: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  return <details className="creator-filter">
    <summary>Creators <span>{selected.length ? `${selected.length} selected` : "All"}</span></summary>
    <div className="creator-filter-options">
      <button type="button" onClick={() => onChange([])} className="mb-1 px-2 py-1 text-xs text-muted underline">Clear selection</button>
      <div className="max-h-56 overflow-y-auto">{creators.map((c) => <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-canvas">
        <input type="checkbox" checked={selected.includes(c)} onChange={() => onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c])} className="accent-accent" />{c}
      </label>)}</div>
    </div>
  </details>;
}

function Field({ label, children, inline = false }: { label: string; children: React.ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? "flex items-center gap-2" : "flex flex-col gap-1.5"}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={name} className="segmented inline-flex flex-wrap rounded-lg border border-line p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 transition ${value === o.value ? "bg-accent text-white" : "text-ink hover:bg-canvas"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
