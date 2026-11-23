import type { Row, Scores } from "./types";

// Test fixture builder. Lives outside *.test.ts so it is typechecked but not run.
export interface RowFixture extends Partial<Omit<Row, "scores">> {
  scores?: Partial<Scores>;
  blended?: number | null;
  costPerTask?: number | null;
}

const emptyScores: Scores = {
  intelligence: null,
  coding: null,
  agentic: null,
  engineering: null,
  strategy_and_ops: null,
  finance_and_accounting: null,
  economics: null,
  legal: null,
  healthcare_and_medical: null,
};

export function makeRow({ scores, blended, costPerTask, ...rest }: RowFixture): Row {
  const mergedScores: Scores = { ...emptyScores };
  for (const [key, value] of Object.entries(scores ?? {})) {
    if (value !== undefined) mergedScores[key] = value;
  }
  return {
    slug: "m",
    name: "M",
    creator: "C",
    release_date: null,
    release_slug: "",
    gateway_ids: ["m"],
    non_reasoning: false,
    scores: mergedScores,
    pricing: {
      aa_input_per_1m: null,
      aa_output_per_1m: null,
      gateway_input_per_1m: blended == null ? null : blended,
      gateway_output_per_1m: blended == null ? null : blended,
      effective_input_per_1m: blended == null ? null : blended,
      effective_output_per_1m: blended == null ? null : blended,
      blended_3_to_1_per_1m: blended ?? null,
      gateway_blended_3_to_1_per_1m: blended ?? null,
      aa_blended_3_to_1_per_1m: null,
      price_source: blended == null ? "none" : "gateway",
      gateway_price_differs_from_aa: false,
      free_at_gateway: blended === 0,
      aa_cost_per_task_usd: costPerTask ?? null,
      gateway_cost_per_task_usd: costPerTask ?? null,
      cost_per_task_source: costPerTask == null ? "none" : "gateway_estimate",
    },
    performance: {
      output_tokens_per_second: null,
      time_to_first_token_seconds: null,
      time_to_first_answer_token_seconds: null,
      end_to_end_seconds: null,
    },
    modalities: { input: [], output: [] },
    hosts: [],
    intelligence_index_cost_per_task_usd: costPerTask ?? null,
    value_per_blended_usd: null,
    value_per_cost_per_task_usd: null,
    warnings: [],
    ...rest,
  };
}
