// Shape of the dashboard data (window.__MODEL_COMPARISON__ / data/models.json), written by cmd/aasync.
// Keep in sync with internal/catalog/snapshot.go.

export interface Snapshot {
  schema_version: number;
  generated_at: string;
  intelligence_index_version: number;
  intelligence_index_version_label?: string;
  aa_fetched_at?: string;
  gateway_fetched_at?: string;
  source: Source;
  counts: Counts;
  unmatched_gateway_models: string[];
  unmatched_details?: UnmatchedModel[];
  ambiguous_matches: Review[];
  metrics?: Metric[];
  models: Row[];
}

export interface Source {
  artificial_analysis: string;
  gateway: string;
  attribution: string;
  aa_methodology?: string;
  aa_pages?: string[];
  aa_manifests?: Manifest[];
}

export interface Manifest {
  page: string;
  page_url: string;
  path: string;
  bytes: number;
  sha256: string;
  dataset_type: string;
  count: number;
}

export interface Counts {
  gateway_chat_models: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  rows: number;
  catalog_rows?: number;
  releases?: number;
  variants?: number;
  primary_with_intelligence?: number;
  primary_with_capabilities?: number;
  with_intelligence?: number;
  deprecated?: number;
}

export interface UnmatchedModel {
  gateway: string;
  provider: string;
  reason: string;
  closest?: string[];
}

export interface Review {
  gateway: string;
  candidates: string[];
  chosen?: string;
}

export interface ProviderOption {
  id: string;
  name: string;
}

export interface Metric {
  id: string;
  label: string;
  short_label: string;
  group: string;
  kind: "index" | "capability" | "benchmark";
  scale: "index" | "percent";
  description: string;
  radar: boolean;
  default: boolean;
}

export interface Scores {
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  engineering: number | null;
  strategy_and_ops: number | null;
  finance_and_accounting: number | null;
  economics: number | null;
  legal: number | null;
  healthcare_and_medical: number | null;
  [metric: string]: number | null;
}

export interface Pricing {
  aa_input_per_1m: number | null;
  aa_output_per_1m: number | null;
  gateway_input_per_1m: number | null;
  gateway_output_per_1m: number | null;
  effective_input_per_1m?: number | null;
  effective_output_per_1m?: number | null;
  blended_3_to_1_per_1m: number | null;
  gateway_blended_3_to_1_per_1m?: number | null;
  aa_blended_3_to_1_per_1m?: number | null;
  price_source?: "gateway" | "aa_host" | "aa_model" | "none";
  gateway_price_model?: string;
  gateway_price_provider?: string;
  gateway_price_differs_from_aa: boolean;
  free_at_gateway: boolean;
  aa_cost_per_task_usd?: number | null;
  gateway_cost_per_task_usd?: number | null;
  cost_per_task_source?: "gateway_estimate" | "aa_host" | "aa_model" | "none";
  provider_input_per_1m?: number | null;
  provider_output_per_1m?: number | null;
  provider_cost_per_task_usd?: number | null;
  provider_host?: string;
}

export interface Performance {
  output_tokens_per_second: number | null;
  time_to_first_token_seconds: number | null;
  time_to_first_answer_token_seconds: number | null;
  end_to_end_seconds: number | null;
}

export interface Modalities {
  input: string[];
  output: string[];
}

export interface Host {
  host: string;
  host_slug: string;
  label?: string;
  host_api_id?: string;
  input_per_1m: number | null;
  output_per_1m: number | null;
  cost_per_task_usd: number | null;
  context_window_tokens?: number | null;
  output_tokens_per_second: number | null;
  time_to_first_token_seconds: number | null;
}

export interface MatchInfo {
  source: string;
  query: string;
  score: number;
  mode: string;
  matched_on: string;
  effort_hint?: string;
  alternatives?: { release_slug: string; release_name: string; score: number; deprecated: boolean }[];
}

export interface Row {
  slug: string;
  name: string;
  creator: string;
  release_date: string | null;
  release_slug?: string;
  release_name?: string;
  release_deprecated?: boolean;
  deprecated_to?: string;
  gateway_ids: string[];
  gateway_providers?: string[];
  gateway_provider_names?: string[];
  aliases?: string[];
  upstream_models?: string[];
  effort?: string;
  efforts?: string[];
  non_reasoning: boolean;
  is_reasoning?: boolean;
  is_primary?: boolean;
  scores: Scores;
  raw_scores?: Scores;
  pricing: Pricing;
  performance: Performance;
  performance_source?: string;
  context_window_tokens?: number | null;
  gateway_context_window_tokens?: number | null;
  gateway_max_output_tokens?: number | null;
  is_open_weights?: boolean | null;
  license_name?: string;
  modalities?: Modalities;
  hosts?: Host[];
  intelligence_index_cost_per_task_usd: number | null;
  value_per_blended_usd: number | null;
  value_per_cost_per_task_usd: number | null;
  warnings?: string[];
  match?: MatchInfo;
}
