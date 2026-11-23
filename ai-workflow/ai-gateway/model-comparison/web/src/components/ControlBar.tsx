import { Button } from "open-glass-ui";
import type { Filters } from "../lib/filters";
import { PRICE_MAX, SLIDER_STEPS, priceFromSlider, sliderFromPrice } from "../lib/filters";
import { formatUsd } from "../lib/format";
import { SENSITIVITY, SENSITIVITY_RANGE, TIERS } from "../lib/engine";
import { presetFor } from "../lib/recommendations";
import type { Task } from "../lib/tasks";
import type { ProviderOption } from "../lib/types";

export const PRESETS: { key: "max" | "balanced" | "lean"; label: string }[] = [
  { key: "max", label: "Max quality" }, { key: "balanced", label: "Balanced" }, { key: "lean", label: "Lean" },
];
const STEPS = 100;
const [K_LO, K_HI] = SENSITIVITY_RANGE;
const toSlider = (k: number) => Math.round((STEPS * Math.log(k / K_LO)) / Math.log(K_HI / K_LO));
const fromSlider = (t: number) => Number((K_LO * Math.pow(K_HI / K_LO, t / STEPS)).toFixed(2));

interface Props {
  filters: Filters;
  setFilters: (f: Filters) => void;
  /** Sets the cost sensitivity (and the value index exponent that follows it). */
  onSensitivity: (k: number) => void;
  gatewayProviders: ProviderOption[];
  taskOptions: Task[];
  onReset: () => void;
}

// The criteria rail: only what changes a decision. Each criterion applies to
// the recommendations, the Herdr roles, the charts and the ranking alike. The
// rail stays in view while the page scrolls, so the price of quality can be
// changed next to any chart or table.
export function ControlBar({ filters, setFilters, onSensitivity, gatewayProviders, taskOptions, onReset }: Props) {
  const preset = presetFor(filters.sensitivity);
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const capped = filters.maxPrice >= PRICE_MAX;
  const groups = [...new Set(taskOptions.map((t) => t.group))];
  const quick = ["intelligence", "general", "workload:coding", "scicode", "coding", "workload:agentic", "automation_bench", "agentic"]
    .map((id) => taskOptions.find((t) => t.id === id))
    .filter((t): t is Task => Boolean(t))
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
    .slice(0, 4);

  return (
    <section aria-label="Criteria" className="control-panel flex min-w-0 flex-col gap-4">
      <div className="control-heading"><div><span className="section-kicker">YOUR COMPARISON</span><h2>Criteria</h2><p>Every pick, role and chart follows these.</p></div><Button variant="quiet" size="small" onClick={onReset} className="reset-button">Reset</Button></div>
      <div className="control-main">
        <div className="benchmark-field flex flex-col gap-2">
          <span id="task-label" className="criteria-label">Benchmark</span>
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
                  filters.task.id === t.id ? "border-accent bg-accent text-white" : "border-line text-ink hover:border-accent"
                }`}
              >
                {t.shortLabel}
              </button>
            ))}</div>
          </div>
          <p className="criteria-hint">{filters.task.description}</p>
        </div>

        <div className="criteria-field price-of-quality">
          <span id="sensitivity-label" className="criteria-label">Price of quality<span>{preset ? PRESETS.find((p) => p.key === preset)!.label : `${filters.sensitivity.toFixed(1)} pts`}</span></span>
          <div className="preset-switch" role="group" aria-label="Price of quality presets">
            {PRESETS.map((p) => <button key={p.key} type="button" aria-pressed={preset === p.key} onClick={() => onSensitivity(SENSITIVITY[p.key])}>{p.label}</button>)}
          </div>
          <input type="range" min={0} max={STEPS} step={1} value={toSlider(filters.sensitivity)} aria-labelledby="sensitivity-label"
            aria-valuetext={`${filters.sensitivity} points per cost doubling`} onChange={(e) => onSensitivity(fromSlider(Number(e.target.value)))} className="w-full accent-accent" />
          <div className="tradeoff-scale" aria-hidden="true"><span>Quality first</span><span>Cost first</span></div>
          <p className="criteria-hint">Paying twice as much must buy <strong>{filters.sensitivity.toFixed(1)} points</strong> (% of the best) on standard work; light work asks {(filters.sensitivity * TIERS.light.priceScale).toFixed(1)}, hard work {(filters.sensitivity * TIERS.hard.priceScale).toFixed(1)}.</p>
        </div>

        <div className="criteria-field">
          <label htmlFor="max-cost" className="criteria-label">Max cost per task<span>{capped ? "No limit" : formatUsd(filters.maxPrice)}</span></label>
          <input
            id="max-cost"
            type="range"
            min={0}
            max={SLIDER_STEPS}
            step={1}
            value={sliderFromPrice(filters.maxPrice)}
            onChange={(e) => {
              const p = priceFromSlider(Number(e.target.value));
              set({ maxPrice: p >= PRICE_MAX * 0.999 ? PRICE_MAX : p });
            }}
            aria-valuetext={capped ? "No limit" : `${formatUsd(filters.maxPrice)} per task`}
            className="w-full accent-accent"
          />
          <p className="criteria-hint">No pick, for a tier or a role, may cost more per task.</p>
        </div>

        <div className="criteria-field">
          <label htmlFor="gateway-provider" className="criteria-label">Gateway provider</label>
          <select
            id="gateway-provider"
            value={filters.gatewayProvider}
            onChange={(e) => set({ gatewayProvider: e.target.value })}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
          >
            <option value="">All providers</option>
            {gatewayProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <p className="criteria-hint">{filters.gatewayProvider ? "Roles too are picked from this provider only." : "Roles keep to the providers in your Herdr policy."}</p>
        </div>

        <label className="speed-switch">
          <input type="checkbox" role="switch" checked={filters.valueMode === "speed"} onChange={(e) => set({ valueMode: e.target.checked ? "speed" : "quality" })} />
          <span className="switch-track" aria-hidden="true"><span /></span>
          <span className="speed-text"><strong>Speed counts</strong><small>Prefer a short wait for the first token and more tokens per second.</small></span>
        </label>
      </div>
    </section>
  );
}
