import type { Row } from "./types";
import { priceFor, scoreFor, valueFor, type CostMode, type Task, type ValueMode } from "./tasks";

// The cost slider is logarithmic: $0.001 to $200 per 1M tokens (or per task).
// It has 1000 steps so small prices stay precise.
// The cost slider is logarithmic: $0.001 to $200 per 1M tokens (or per task).
// It has 1000 steps so small prices stay precise.
export const PRICE_MIN = 0.001;
export const PRICE_MAX = 200;
export const SLIDER_STEPS = 1000;

export function priceFromSlider(t: number): number {
  if (t >= SLIDER_STEPS) return PRICE_MAX;
  return PRICE_MIN * Math.pow(PRICE_MAX / PRICE_MIN, t / SLIDER_STEPS);
}

export function sliderFromPrice(p: number): number {
  if (p >= PRICE_MAX) return SLIDER_STEPS;
  return Math.max(0, Math.round((SLIDER_STEPS * Math.log(p / PRICE_MIN)) / Math.log(PRICE_MAX / PRICE_MIN)));
}

export interface Filters {
  task: Task;
  costMode: CostMode;
  valueMode: ValueMode;
  priceSensitivity: number;
  minScore: number;
  maxPrice: number;
  creators: string[];
  modelQuery: string;
  includeFree: boolean;
  includeDeprecated: boolean;
  gatewayProvider: string;
  effort: "all" | "base" | "effort";
  reasoning: "all" | "reasoning" | "non-reasoning";
}

// Applies the control bar to the snapshot rows. Rows with no task score are
// excluded here, so the charts, KPIs and table always agree.
export function applyFilters(rows: Row[], f: Filters): Row[] {
  return rows.filter((r) => {
    const score = scoreFor(r, f.task);
    if (score === null || score < f.minScore) return false;

    const cost = priceFor(r, f.costMode);
    if (cost === null || !Number.isFinite(cost) || cost < 0) return false;
    if (cost === 0 && !f.includeFree) return false;
    if (f.maxPrice < PRICE_MAX && cost > f.maxPrice) return false;

    if (!f.includeDeprecated && r.release_deprecated) return false;
    if (f.creators.length > 0 && !f.creators.includes(r.creator)) return false;
    if (f.gatewayProvider && !(r.gateway_providers ?? []).includes(f.gatewayProvider)) return false;
    const query = f.modelQuery.trim().toLocaleLowerCase();
    if (query) {
      const haystack = [
        r.name,
        r.slug,
        r.release_slug ?? "",
        r.release_name ?? "",
        r.creator,
        ...(r.gateway_ids ?? []),
        ...(r.aliases ?? []),
        ...(r.upstream_models ?? []),
        ...(r.gateway_providers ?? []),
        ...(r.gateway_provider_names ?? []),
      ];
      if (!haystack.some((s) => s.toLocaleLowerCase().includes(query))) return false;
    }
    if (f.effort === "base") {
      if (r.is_primary === false) return false;
      if (r.is_primary === undefined && r.effort) return false;
    }
    if (f.effort === "effort") {
      if (r.is_primary === true) return false;
      if (r.is_primary === undefined && !r.effort) return false;
    }
    if (f.reasoning === "reasoning" && r.non_reasoning) return false;
    if (f.reasoning === "non-reasoning" && !r.non_reasoning) return false;
    return true;
  });
}

// Ranks rows by value for the active task, best first. Rows without a value
// ratio sort last, ordered by score.
export function rankByValue(rows: Row[], f: Filters): Row[] {
  return [...rows].sort((a, b) => {
    const va = valueFor(a, f.task, f.costMode, f.valueMode, f.priceSensitivity);
    const vb = valueFor(b, f.task, f.costMode, f.valueMode, f.priceSensitivity);
    if (va === null && vb === null) return (scoreFor(b, f.task) ?? 0) - (scoreFor(a, f.task) ?? 0);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va === vb) return (scoreFor(b, f.task) ?? 0) - (scoreFor(a, f.task) ?? 0);
    return vb > va ? 1 : -1;
  });
}
