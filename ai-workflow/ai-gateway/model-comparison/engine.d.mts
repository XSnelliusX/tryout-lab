// Types for engine.mjs (the recommendation engine), used by the web app.

export type Profile = "lean" | "balanced" | "max";
export type TierName = "light" | "standard" | "hard" | "frontier";

export interface WorkloadSpec {
  label: string;
  description: string;
  parts: [string, number][];
}

export interface TierSpec {
  label: string;
  description: string;
  /** Share of the best score a pick must reach, from quality-first to cost-first sensitivity (see floorFor). */
  floor: { quality: number; cost: number };
  /** Multiplies the cost sensitivity: points a cost doubling must buy at this tier. */
  priceScale: number;
}

export interface CriterionSpec {
  label: string;
  metric: string | null;
  description: string;
}

/** A role's defaults: what it is for, its tier and its needs (weights in %). */
export interface RoleDefaults {
  label: string;
  tier: TierName;
  needs: Record<string, number>;
}

/** roleProfile(): the effective profile of one configured role. */
export interface RoleProfile {
  key: string;
  label: string;
  tier: TierName;
  needs: Record<string, number> | null;
  workload: string | null;
}

export const ENGINE_VERSION: number;
export const PROFILES: Profile[];
export const SENSITIVITY: Record<Profile, number>;
export const SENSITIVITY_RANGE: [number, number];
export const WORKLOADS: Record<string, WorkloadSpec>;
export const TIERS: Record<TierName, TierSpec>;
export const ROLE_PROFILES: Record<string, RoleDefaults>;
export const CRITERIA: Record<string, CriterionSpec>;
export const ANSWER_TOKENS: number;
export const SPEED_POINTS_PER_DOUBLING: number;
export const MIN_COST: number;
export const METHOD: {
  engine_version: number;
  min_cost_per_task_usd: number;
  objective: string;
  sensitivity: Record<Profile, number>;
  workloads: Record<string, WorkloadSpec>;
  tiers: Record<TierName, TierSpec>;
  criteria: Record<string, CriterionSpec>;
  answer_tokens: number;
  speed_points_per_doubling: number;
  roles: Record<string, RoleDefaults>;
};

/** Anything shaped like a snapshot row (the web app passes its Row). */
export interface EngineRow {
  slug: string;
  scores: Record<string, number | null | undefined>;
}

export interface Candidate {
  id: string;
  provider_id: string;
  model_id: string;
  variant: string | null;
  effort: string | null;
  slug: string;
  name: string;
  release: string;
  release_slug: string;
  release_date: string | null;
  creator: string;
  cost: number;
  free: boolean;
  speed: number | null;
  ttfa: number | null;
  row: EngineRow;
}

export interface PickView {
  id: string;
  provider_id: string;
  model_id: string;
  variant: string | null;
  effort: string | null;
  slug: string;
  name: string;
  release: string;
  creator: string;
  score: number;
  score_pct_of_best: number | null;
  estimated?: boolean;
  cost_per_task_usd: number;
  free?: boolean;
  output_tokens_per_second: number | null;
  time_to_first_answer_token_seconds: number | null;
  /** Role picks: the score per need (0-100), the two parts of speed and the seconds to a typical answer. */
  breakdown?: Record<string, number>;
  speed_parts?: SpeedParts;
  response_seconds?: number | null;
}

/** Speed 0-100 split into latency (time to the first answer token) and throughput (tokens per second). */
export interface SpeedParts {
  latency: number | null;
  throughput: number | null;
}

export interface RecommendResult {
  workload: string;
  workload_label: string;
  tier: TierName;
  profile: Profile;
  sensitivity: number;
  floor_share: number;
  per_doubling: number;
  speed_weight: number;
  pool: number;
  eligible: number;
  best: PickView;
  pick: PickView;
  cheaper: PickView | null;
  stronger: PickView | null;
  ranked: PickView[];
  reason: string;
}

export interface CandidateOptions {
  includeDeprecated?: boolean;
  allowMaxEffort?: boolean;
  providers?: string[] | null;
  exclude?: string[];
  requireTools?: boolean;
  includeFree?: boolean;
  costMode?: "task" | "blended";
  maxCost?: number | null;
  rows?: EngineRow[];
}

export interface CriteriaContext {
  best: Record<string, number>;
  fastest: number | null;
  latency: number | null;
  throughput: number | null;
}

export interface RecommendOptions {
  workload?: string | WorkloadSpec;
  needs?: Record<string, number> | null;
  context?: CriteriaContext | null;
  label?: string | null;
  tier?: TierName;
  profile?: Profile;
  sensitivity?: number;
  speedWeight?: number;
  perDoubling?: number;
  floor?: number;
  preferProviders?: string[];
  limit?: number;
}

export interface CurrentModel {
  model: string;
  variant: string | null;
  id: string;
  known: boolean;
  deprecated: boolean;
  score: number | null;
  cost_per_task_usd: number | null;
  release?: string;
  name?: string;
  slug?: string;
  placeholder?: boolean;
  output_tokens_per_second?: number | null;
  time_to_first_answer_token_seconds?: number | null;
  breakdown?: Record<string, number>;
  speed_parts?: SpeedParts;
  response_seconds?: number | null;
}

export interface SetupSummary {
  /** Cost of one task on every role, in USD. */
  cost_usd: number;
  /** Average fit over the roles. */
  fit: number;
  roles: number;
}

export interface RoleRecommendation {
  role: string;
  label: string;
  /** "role" when scored on needs, else the workload name of a `recommend.workload` override. */
  workload: string;
  tier: TierName;
  needs: { key: string; label: string; weight: number }[];
  current: CurrentModel;
  /** Per profile, plus "custom" when recommendRoles got a sensitivity. */
  picks: Partial<Record<Profile | "custom", RecommendResult | null>>;
}

/** The engine's part of the Herdr config (roles and model policy; no prompts or paths). */
export interface EngineConfig {
  roles: Record<string, { model?: string; variant?: string; tier?: number; recommend?: Record<string, unknown> }>;
  model_policy: { providers?: string[]; exclude?: string[]; allow_max_effort?: boolean };
}

export interface RoleOptions {
  profiles?: Profile[];
  sensitivity?: number | null;
  providers?: string[] | null;
  maxCost?: number | null;
  speedWeight?: number;
}

export interface RolesResult {
  providers: string[];
  exclude: string[];
  candidates: number;
  summary: Record<string, SetupSummary | null>;
  roles: RoleRecommendation[];
}

export interface CurvePoint extends SetupSummary {
  sensitivity: number;
}

export type RolesSection =
  | { available: false }
  | ({ available: true; config?: EngineConfig } & RolesResult);

export interface RecommendationsDocument {
  schema_version: number;
  generated_at: string;
  snapshot_generated_at: string | null;
  aa_fetched_at: string | null;
  method: typeof METHOD;
  grid: Record<string, Record<TierName, Record<Profile, RecommendResult | null>>>;
  roles: RolesSection;
}

export function resolveWorkload(workload: string | WorkloadSpec): WorkloadSpec;
export function workloadScore(row: { scores?: Record<string, number | null | undefined> } | null | undefined, workload: string | WorkloadSpec): { value: number; estimated: boolean } | null;
export function buildCandidates(snapshot: { models?: EngineRow[] } | null, options?: CandidateOptions): Candidate[];
export function recommend(candidates: Candidate[], options?: RecommendOptions): RecommendResult | null;
export function formatCost(v: number | null | undefined): string;
export function label(c: { model_id: string; variant: string | null } | null | undefined): string;
export function explain(r: RecommendResult): string;
export function roleProfile(name: string, spec?: Record<string, unknown>): RoleProfile;
export function responseSeconds(ttfa: number | null | undefined, tps: number | null | undefined): number | null;
export function criteriaContext(rows: EngineRow[] | null | undefined): CriteriaContext;
export function roleFit(candidate: { row: EngineRow; speed?: number | null; ttfa?: number | null }, needs: Record<string, number>, ctx: CriteriaContext): { value: number; estimated: boolean; breakdown: Record<string, number>; response_seconds: number | null; speed_parts?: SpeedParts } | null;
export function buildDocument(snapshot: unknown, config: unknown, options?: { now?: Date }): RecommendationsDocument;
export function floorFor(tier: TierName, sensitivity: number): number;
export function perDoublingFor(tier: TierName, sensitivity: number): number;
export function speedScore(ttfa: number | null, tps: number | null, ctx: CriteriaContext): { value: number; latency: number | null; throughput: number | null } | null;
export function recommendRoles(snapshot: { models?: EngineRow[] } | null, config: EngineConfig, options?: RoleOptions): RolesResult;
export function setupCurve(snapshot: { models?: EngineRow[] } | null, config: EngineConfig, options?: RoleOptions, steps?: number): CurvePoint[];
export function engineConfig(config: unknown): EngineConfig;
