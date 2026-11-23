import type { Metric, Row } from "./types";
import { MIN_COST, WORKLOADS } from "./engine";

// A task is one metric the dashboard can rank by. The real application builds
// this list from snapshot.metrics; TASKS is the static fallback for tests and
// older snapshots.
export interface Task {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  score: string;
  group: string;
  kind: "index" | "capability" | "benchmark";
  scale: "index" | "percent";
  radar: boolean;
  default: boolean;
}

export const TASKS: Task[] = [
  { id: "general", label: "General reasoning", shortLabel: "General", description: "Overall intelligence across the AA Intelligence Index.", score: "intelligence", group: "Core index", kind: "index", scale: "index", radar: true, default: true },
  { id: "coding", label: "Coding · SciCode", shortLabel: "Coding", description: "Scientific coding benchmark, normalized to 0–100.", score: "scicode", group: "Coding", kind: "benchmark", scale: "percent", radar: false, default: false },
  { id: "agentic", label: "Agentic · AutomationBench", shortLabel: "Agentic", description: "Multi-step tool-use benchmark, normalized to 0–100.", score: "automation_bench", group: "Agentic", kind: "benchmark", scale: "percent", radar: false, default: false },
  { id: "engineering", label: "Engineering", shortLabel: "Engineering", description: "AA engineering capability index.", score: "engineering", group: "Capabilities", kind: "capability", scale: "index", radar: true, default: false },
  { id: "strategy", label: "Strategy & Ops", shortLabel: "Strategy", description: "AA strategy and operations capability index.", score: "strategy_and_ops", group: "Capabilities", kind: "capability", scale: "index", radar: true, default: false },
  { id: "finance", label: "Finance & accounting", shortLabel: "Finance", description: "AA finance and accounting capability index.", score: "finance_and_accounting", group: "Capabilities", kind: "capability", scale: "index", radar: true, default: false },
  { id: "economics", label: "Economics", shortLabel: "Economics", description: "AA economics capability index.", score: "economics", group: "Capabilities", kind: "capability", scale: "index", radar: true, default: false },
  { id: "legal", label: "Legal", shortLabel: "Legal", description: "AA legal capability index.", score: "legal", group: "Capabilities", kind: "capability", scale: "index", radar: true, default: false },
  { id: "healthcare", label: "Healthcare & medical", shortLabel: "Healthcare", description: "AA healthcare and medical capability index.", score: "healthcare_and_medical", group: "Capabilities", kind: "capability", scale: "index", radar: true, default: false },
];

export const WORKLOAD_PREFIX = "workload:";

// The recommendation workloads (weighted benchmark blends) as selectable tasks.
// useSnapshot puts their values into row.scores["workload:<name>"].
export function workloadTasks(): Task[] {
  return Object.entries(WORKLOADS).map(([name, spec]) => ({
    id: `${WORKLOAD_PREFIX}${name}`,
    label: `${spec.label} (workload)`,
    shortLabel: spec.label,
    description: `${spec.description} The score the recommendations, Herdr's cc-models and the prompt rewriter use.`,
    score: `${WORKLOAD_PREFIX}${name}`,
    group: "Workloads (used by recommendations)",
    kind: "index" as const,
    scale: "index" as const,
    radar: false,
    default: false,
  }));
}

export function tasksFromMetrics(metrics: Metric[] | undefined): Task[] {
  if (!metrics || metrics.length === 0) return TASKS;
  const tasks = metrics.map((m) => ({
    id: m.id,
    label: m.label,
    shortLabel: m.short_label,
    description: m.description,
    score: m.id,
    group: m.group,
    kind: m.kind,
    scale: m.scale,
    radar: m.radar,
    default: m.default,
  }));
  // Right after the core index, so the blends sit next to the score they extend.
  const core = tasks.filter((t) => t.group === tasks[0].group);
  return [...core, ...workloadTasks(), ...tasks.slice(core.length)];
}

export function defaultTask(tasks: Task[]): Task {
  return tasks.find((t) => t.default) ?? tasks[0] ?? TASKS[0];
}

export function taskById(id: string): Task {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
}

export type CostMode = "blended" | "task";
export type ValueMode = "price" | "quality" | "speed";

// Scored returns the task score for a row, or null when AA did not measure it.
// Older snapshots may still use the retired coding/agentic composite keys.
export function scoreFor(row: Row, task: Task): number | null {
  const value = row.scores[task.score];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (task.id === "coding") {
    const legacy = row.scores.coding;
    return typeof legacy === "number" && Number.isFinite(legacy) ? legacy : null;
  }
  if (task.id === "agentic") {
    const legacy = row.scores.agentic;
    return typeof legacy === "number" && Number.isFinite(legacy) ? legacy : null;
  }
  return null;
}

// PriceFor returns the effective cost used for the value ratio. It prefers the
// gateway's own price, then the AA provider host price, then AA's model price.
export function priceFor(row: Row, mode: CostMode): number | null {
  const input = row.pricing.effective_input_per_1m ?? row.pricing.gateway_input_per_1m;
  const output = row.pricing.effective_output_per_1m ?? row.pricing.gateway_output_per_1m;
  if (input === null || output === null || input === undefined || output === undefined || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  if (input === 0 && output === 0) return 0;
  if (mode === "blended") {
    if (row.pricing.blended_3_to_1_per_1m !== null && row.pricing.blended_3_to_1_per_1m !== undefined) return row.pricing.blended_3_to_1_per_1m;
    return (3 * input + output) / 4;
  }
  const taskCost = row.pricing.gateway_cost_per_task_usd ?? row.intelligence_index_cost_per_task_usd;
  return taskCost ?? null;
}

// For paid models, compare percentage differences: multiplying scores by s and
// costs by c multiplies the index by s/c^weight. The selected price weight is a
// transparent judgment about premiums, not an AA benchmark or success rate.
// The same cost unit must be used for all models in a comparison.
// 0.0866 is the balanced cost sensitivity (6 points per doubling), see exponentFor.
export const DEFAULT_PRICE_SENSITIVITY = 6 / (100 * Math.LN2);

// A gateway price of $0 counts as MIN_COST (the engine's floor, $0.005): a free
// model is very cheap, not infinitely good, so a weak free model cannot top the
// ranking just because it costs nothing. The cost column still shows $0.
export function valueFor(row: Row, task: Task, mode: CostMode, preference: ValueMode = "price", priceSensitivity = DEFAULT_PRICE_SENSITIVITY): number | null {
  const score = scoreFor(row, task);
  const price = priceFor(row, mode);
  if (score === null || price === null || !Number.isFinite(score) || !Number.isFinite(price) || price < 0 || score < 0) return null;
  const cost = Math.max(price, MIN_COST);
  if (preference === "speed") {
    // Speed is throughput and latency: tokens per second, and the wait for the
    // first answer token when it is measured (10 s counts as neutral).
    const speed = row.performance.output_tokens_per_second;
    if (speed === null || !Number.isFinite(speed) || speed <= 0) return null;
    if (score === 0) return 0;
    const ttfa = row.performance.time_to_first_answer_token_seconds;
    const latency = ttfa !== null && ttfa !== undefined && Number.isFinite(ttfa) && ttfa > 0 ? Math.pow(10 / Math.max(ttfa, 0.05), 0.1) : 1;
    const exponent = Math.max(0, Math.min(1, priceSensitivity));
    return (score * Math.pow(speed / 100, 0.1) * latency) / Math.pow(cost, exponent);
  }
  if (score === 0) return 0;
  const exponent = preference === "price" ? 1 : Math.max(0, Math.min(1, priceSensitivity));
  return score / Math.pow(cost, exponent);
}

// These are model-selection indices, not scores on the same scale as AA.
export function valueUnit(mode: CostMode, preference: ValueMode = "price"): string {
  if (preference === "price") return mode === "task" ? "score / $ per task" : "score / $ per 1M tokens";
  return "relative value index";
}

export function formatValue(value: number | null, _mode: ValueMode): string {
  if (value === null) return "–";
  if (value === Infinity) return "Free";
  if (!Number.isFinite(value)) return "–";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function scoreUnit(task: Task): string {
  return task.scale === "percent" ? "benchmark %" : "index points";
}
