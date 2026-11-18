import { DEFAULT_PRICE_SENSITIVITY, priceFor, scoreFor, valueFor, type CostMode, type Task, type ValueMode } from "./tasks";
import type { Row } from "./types";
import { paretoFrontier } from "./pareto";

export interface Recommendation {
  difficulty: string;
  minimum: number;
  maximum: number | null;
  eligible: number;
  model: Row | null;
  comparison: { cheaper: Row; scoreGainPercent: number; costIncreasePercent: number } | null;
  nextUpgrade: { model: Row; scoreGainPercent: number; costIncreasePercent: number } | null;
}

// Describe the closest lower-cost, positive-price alternative. Zero costs and
// zero baseline scores don't support a meaningful percentage comparison.
export function premiumComparison(model: Row, candidates: Row[], task: Task, costMode: CostMode): Recommendation["comparison"] {
  const score = scoreFor(model, task), cost = priceFor(model, costMode);
  if (score === null || cost === null || cost <= 0) return null;
  const cheaper = candidates.filter((r) => {
    const s = scoreFor(r, task), c = priceFor(r, costMode);
    return r.slug !== model.slug && s !== null && s > 0 && s <= score && c !== null && c > 0 && c < cost;
  }).sort((a, b) => (scoreFor(b, task)! - scoreFor(a, task)!) || (priceFor(a, costMode)! - priceFor(b, costMode)!))[0];
  if (!cheaper) return null;
  return { cheaper, scoreGainPercent: ((score / scoreFor(cheaper, task)!) - 1) * 100, costIncreasePercent: ((cost / priceFor(cheaper, costMode)!) - 1) * 100 };
}

export function nextEfficientUpgrade(model: Row, candidates: Row[], task: Task, costMode: CostMode): Recommendation["nextUpgrade"] {
  const score = scoreFor(model, task), cost = priceFor(model, costMode);
  if (score === null || score <= 0 || cost === null || cost <= 0) return null;
  const frontier = paretoFrontier(candidates.flatMap((r) => {
    const s = scoreFor(r, task), c = priceFor(r, costMode);
    return s !== null && c !== null && c >= 0 ? [{ id: r.slug, score: s, cost: c }] : [];
  }));
  const upgrade = frontier.find((p) => p.score > score && p.cost > cost);
  if (!upgrade) return null;
  const candidate = candidates.find((r) => r.slug === upgrade.id)!;
  return { model: candidate, scoreGainPercent: (upgrade.score / score - 1) * 100, costIncreasePercent: (upgrade.cost / cost - 1) * 100 };
}

export function compareCandidateToBaseline(candidate: Row, baseline: Row, task: Task, costMode: CostMode): Recommendation["nextUpgrade"] {
  const currentScore = scoreFor(baseline, task), currentCost = priceFor(baseline, costMode);
  const nextScore = scoreFor(candidate, task), nextCost = priceFor(candidate, costMode);
  if (candidate.slug === baseline.slug || currentScore === null || currentScore <= 0 || currentCost === null || currentCost <= 0 ||
      nextScore === null || nextScore <= currentScore || nextCost === null || nextCost <= currentCost) return null;
  return { model: candidate, scoreGainPercent: (nextScore / currentScore - 1) * 100, costIncreasePercent: (nextCost / currentCost - 1) * 100 };
}

export function recommendByDifficulty(rows: Row[], task: Task, costMode: CostMode, focus: ValueMode, sensitivity = DEFAULT_PRICE_SENSITIVITY): Recommendation[] {
  const eligibleRows = rows.filter((r) => valueFor(r, task, costMode, focus, sensitivity) !== null);
  const scores = eligibleRows.map((r) => scoreFor(r, task)).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!scores.length) return [];
  const quantile = (p: number) => scores[Math.floor((scores.length - 1) * p)];
  const tiers: { difficulty: string; minimum: number; maximum: number | null }[] = [
    { difficulty: "Easy", minimum: quantile(0.25), maximum: quantile(0.5) },
    { difficulty: "Medium", minimum: quantile(0.5), maximum: quantile(0.75) },
    { difficulty: "Difficult", minimum: quantile(0.75), maximum: null },
  ];
  return tiers.map(({ difficulty, minimum, maximum }) => {
    const candidates = eligibleRows.filter((r) => {
      const score = scoreFor(r, task);
      return score !== null && score >= minimum && (maximum === null || score < maximum);
    });
    candidates.sort((a, b) => {
      const x = valueFor(a, task, costMode, focus, sensitivity)!;
      const y = valueFor(b, task, costMode, focus, sensitivity)!;
      return x === y ? (scoreFor(b, task) ?? 0) - (scoreFor(a, task) ?? 0) : y > x ? 1 : -1;
    });
    const model = candidates[0] ?? null;
    const topScorer = candidates.reduce<Row | null>((best, r) => !best || scoreFor(r, task)! > scoreFor(best, task)! ? r : best, null);
    return { difficulty, minimum, maximum, eligible: candidates.length, model, comparison: model ? premiumComparison(model, candidates, task, costMode) : null, nextUpgrade: model && topScorer ? compareCandidateToBaseline(topScorer, model, task, costMode) : null };
  });
}
