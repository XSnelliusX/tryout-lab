import { DEFAULT_PRICE_SENSITIVITY, TASKS, priceFor, scoreFor, valueFor, type CostMode, type Task, type ValueMode } from "./tasks";
import type { Row } from "./types";

export interface Kpis {
  medianScore: number | null;
  bestValue: Row | null;
  topScore: Row | null;
  cheapestAboveMedian: Row | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Headline figures for the active task. The cheapest card only considers models
// at or above the median score of the set, so a cheap but weak model can't win.
// Ties on price go to the higher score.
export function computeKpis(rows: Row[], task: Task, mode: CostMode, preference: ValueMode = "price", sensitivity = DEFAULT_PRICE_SENSITIVITY): Kpis {
  const medianScore = median(rows.map((r) => scoreFor(r, task)).filter((v): v is number => v !== null));

  let bestValue: Row | null = null;
  let bestV = -Infinity;
  let topScore: Row | null = null;
  let topS = -Infinity;
  let cheapest: Row | null = null;
  let cheapestCost = Infinity;
  let cheapestScore = -Infinity;

  for (const r of rows) {
    const v = valueFor(r, task, mode, preference, sensitivity);
    if (v !== null && (v > bestV || (v === bestV && (scoreFor(r, task) ?? 0) > (bestValue ? scoreFor(bestValue, task) ?? 0 : 0)))) {
      bestV = v;
      bestValue = r;
    }

    const s = scoreFor(r, task);
    if (s !== null && s > topS) {
      topS = s;
      topScore = r;
    }

    const c = priceFor(r, mode);
    if (c === null || c < 0 || s === null || medianScore === null || s < medianScore) continue;
    if (c < cheapestCost || (c === cheapestCost && s > cheapestScore)) {
      cheapestCost = c;
      cheapestScore = s;
      cheapest = r;
    }
  }

  return { medianScore, bestValue, topScore, cheapestAboveMedian: cheapest };
}

// Upper bound for each radar axis across all models, so the shapes stay comparable.
export function indexMaxima(rows: Row[], tasks: Task[] = TASKS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) {
    let max = 0;
    for (const r of rows) {
      const v = scoreFor(r, t);
      if (v !== null && v > max) max = v;
    }
    out[t.score] = Math.max(10, Math.ceil(max / 10) * 10);
  }
  return out;
}
