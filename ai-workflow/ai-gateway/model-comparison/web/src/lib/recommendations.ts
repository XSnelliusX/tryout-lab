import { buildCandidates, recommend, type Profile, type RecommendResult, type TierName } from "./engine";
import { WORKLOAD_PREFIX, type CostMode, type Task, type ValueMode } from "./tasks";
import type { Row } from "./types";

// The difficulty cards are the shared engine (engine.mjs) applied to the rows in
// view: Easy, Medium and Difficult are its light, standard and hard tiers, and
// the focus picks the budget profile. Herdr's cc-models and the prompt rewriter
// use the same engine, so the dashboard shows what they will recommend.

export interface DifficultyRecommendation {
  difficulty: "Easy" | "Medium" | "Difficult";
  tier: TierName;
  profile: Profile;
  result: RecommendResult | null;
}

export const DIFFICULTY_TIERS: { difficulty: DifficultyRecommendation["difficulty"]; tier: TierName }[] = [
  { difficulty: "Easy", tier: "light" },
  { difficulty: "Medium", tier: "standard" },
  { difficulty: "Difficult", tier: "hard" },
];

export function profileFor(focus: ValueMode): { profile: Profile; speedWeight: number } {
  if (focus === "price") return { profile: "lean", speedWeight: 0 };
  if (focus === "speed") return { profile: "balanced", speedWeight: 2 };
  return { profile: "balanced", speedWeight: 0 };
}

/** The engine workload for a dashboard task: a named blend, or the task's single metric. */
export function workloadFor(task: Task): string {
  return task.score.startsWith(WORKLOAD_PREFIX) ? task.score.slice(WORKLOAD_PREFIX.length) : `metric:${task.score}`;
}

// Superseded releases are never recommended, whatever the table shows.
export function recommendByDifficulty(rows: Row[], task: Task, costMode: CostMode, focus: ValueMode): DifficultyRecommendation[] {
  const candidates = buildCandidates(null, { rows, costMode, includeFree: true, includeDeprecated: false });
  const { profile, speedWeight } = profileFor(focus);
  const workload = workloadFor(task);
  return DIFFICULTY_TIERS.map(({ difficulty, tier }) => ({
    difficulty, tier, profile,
    result: recommend(candidates, { workload, tier, profile, speedWeight }),
  }));
}
