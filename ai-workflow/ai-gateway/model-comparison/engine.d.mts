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
  floor: Record<Profile, number>;
  perDoubling: Record<Profile, number>;
}

export interface RoleProfile {
  workload: string;
  tier: TierName;
  speed: number;
}

export const ENGINE_VERSION: number;
export const PROFILES: Profile[];
export const WORKLOADS: Record<string, WorkloadSpec>;
export const TIERS: Record<TierName, TierSpec>;
export const ROLE_PROFILES: Record<string, RoleProfile>;
export const MIN_COST: number;
export const METHOD: {
  engine_version: number;
  min_cost_per_task_usd: number;
  objective: string;
  workloads: Record<string, WorkloadSpec>;
  tiers: Record<TierName, TierSpec>;
  roles: Record<string, RoleProfile>;
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
}

export interface RecommendResult {
  workload: string;
  workload_label: string;
  tier: TierName;
  profile: Profile;
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
  rows?: EngineRow[];
}

export interface RecommendOptions {
  workload?: string | WorkloadSpec;
  tier?: TierName;
  profile?: Profile;
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
  placeholder?: boolean;
}

export interface RoleRecommendation {
  role: string;
  workload: string;
  tier: TierName;
  speed_weight: number;
  current: CurrentModel;
  picks: Record<Profile, RecommendResult | null>;
}

export type RolesSection =
  | { available: false }
  | { available: true; providers: string[]; exclude: string[]; candidates: number; roles: RoleRecommendation[] };

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
export function buildDocument(snapshot: unknown, config: unknown, options?: { now?: Date }): RecommendationsDocument;
