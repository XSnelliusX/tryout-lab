import { SENSITIVITY, buildCandidates, recommend, recommendRoles, setupCurve, type CurvePoint, type RecommendResult, type RecommendationsDocument, type RolesResult, type TierName } from "./engine";
import { PRICE_MAX, SPEED_WEIGHT, type Filters } from "./filters";
import { WORKLOAD_PREFIX, type CostMode, type Task } from "./tasks";
import type { Row, Snapshot } from "./types";

// The recommendations are the shared engine (engine.mjs) applied to the
// dashboard's criteria: one cost sensitivity, the max cost per task, the
// gateway provider and whether speed counts. Herdr's cc-models and the prompt
// rewriter use the same engine (at the lean, balanced and max presets).

export interface TierRecommendation {
  difficulty: "Easy" | "Medium" | "Difficult" | "Hardest";
  tier: TierName;
  result: RecommendResult | null;
}

export const DIFFICULTY_TIERS: { difficulty: TierRecommendation["difficulty"]; tier: TierName }[] = [
  { difficulty: "Easy", tier: "light" },
  { difficulty: "Medium", tier: "standard" },
  { difficulty: "Difficult", tier: "hard" },
  { difficulty: "Hardest", tier: "frontier" },
];

/** The preset named by a sensitivity, when it is one. */
export function presetFor(sensitivity: number): "lean" | "balanced" | "max" | null {
  const hit = (Object.entries(SENSITIVITY) as ["lean" | "balanced" | "max", number][]).find(([, k]) => Math.abs(k - sensitivity) < 1e-6);
  return hit ? hit[0] : null;
}

/** The engine workload for a dashboard task: a named blend, or the task's single metric. */
export function workloadFor(task: Task): string {
  return task.score.startsWith(WORKLOAD_PREFIX) ? task.score.slice(WORKLOAD_PREFIX.length) : `metric:${task.score}`;
}

// Superseded releases are never recommended, whatever the table shows.
export function recommendByDifficulty(rows: Row[], task: Task, sensitivity: number, speed: boolean, costMode: CostMode = "task"): TierRecommendation[] {
  const candidates = buildCandidates(null, { rows, costMode, includeFree: true, includeDeprecated: false });
  const workload = workloadFor(task);
  return DIFFICULTY_TIERS.map(({ difficulty, tier }) => ({
    difficulty, tier,
    result: recommend(candidates, { workload, tier, sensitivity, speedWeight: speed ? SPEED_WEIGHT : 0 }),
  }));
}

export interface RolePlan {
  /** Picks at the selected sensitivity are under picks.custom. */
  roles: RolesResult;
  /** Cost and fit of the setup across sensitivities, for the trade-off curve. */
  curve: CurvePoint[];
  /** Recomputed for the dashboard criteria (false: the document's own picks, e.g. an older document). */
  live: boolean;
}

/** The Herdr roles under the dashboard criteria, or null when no Herdr config is known. */
export function planRoles(snapshot: Snapshot, doc: RecommendationsDocument | null, filters: Filters): RolePlan | null {
  const section = doc?.roles;
  if (!section?.available) return null;
  if (!section.config) {
    const preset = presetFor(filters.sensitivity) ?? "balanced";
    const roles = { ...section, roles: section.roles.map((r) => ({ ...r, picks: { ...r.picks, custom: r.picks[preset] ?? null } })), summary: { ...section.summary, custom: section.summary[preset] ?? null } };
    return { roles, curve: [], live: false };
  }
  const options = {
    providers: filters.gatewayProvider ? [filters.gatewayProvider] : null,
    maxCost: filters.maxPrice < PRICE_MAX ? filters.maxPrice : null,
    speedWeight: filters.valueMode === "speed" ? SPEED_WEIGHT : 0,
  };
  const snap = { models: snapshot.models };
  return {
    roles: recommendRoles(snap, section.config, { ...options, profiles: [], sensitivity: filters.sensitivity }),
    curve: setupCurve(snap, section.config, options),
    live: true,
  };
}
