// Small synthetic gateway catalog + model-comparison snapshot. All ids are made up.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveGatewaySettings } from "../gateway.js"

export const CATALOG = {
  generated_at: "2026-01-01T00:00:00Z",
  count: 5,
  rows: [
    {
      provider_id: "gw-alpha",
      provider_name: "Alpha Labs",
      model_id: "model-a",
      model_name: "Model A",
      aliases: ["model-a-latest"],
      mode: "chat",
      max_input_tokens: 200000,
      max_output_tokens: 32000,
      input_per_1M: 1,
      output_per_1M: 5,
      cache_read_per_1M: 0.1,
      cache_write_per_1M: 1.25,
      tiers: [{ size: 100000, input_per_1M: 2, output_per_1M: 7.5 }],
      tools: true,
      vision: true,
      effort_levels: ["none", "low", "medium", "high"],
      upstream_provider: "alpha",
    },
    {
      provider_id: "gw-alpha",
      provider_name: "Alpha Labs",
      model_id: "model-b",
      model_name: "Model B",
      aliases: [],
      mode: "chat",
      input_per_1M: 0.1,
      output_per_1M: 0.5,
      effort_levels: [],
      upstream_provider: "alpha",
    },
    {
      provider_id: "gw-beta",
      provider_name: "Beta Cloud",
      model_id: "model-c",
      model_name: "Model C",
      aliases: [],
      mode: "chat",
      input_per_1M: 5,
      output_per_1M: 17,
      effort_levels: ["low", "high"],
      upstream_provider: "cloud",
    },
    {
      provider_id: "gw-beta",
      provider_name: "Beta Cloud",
      model_id: "model-a-beta",
      model_name: "Model A (Beta Cloud)",
      aliases: [],
      mode: "chat",
      input_per_1M: 1,
      output_per_1M: 5,
      effort_levels: ["low"],
      upstream_provider: "cloud",
    },
    { provider_id: "gw-beta", provider_name: "Beta Cloud", model_id: "image-x", mode: "image_generation", input_per_1M: 1, output_per_1M: 1 },
  ],
}

function variant(slug, effort, intelligence, extra = {}) {
  return {
    slug,
    name: slug,
    creator: "Alpha Labs",
    release_slug: extra.release_slug ?? "model-a-release",
    release_name: "Model A",
    release_date: "2026-01-01",
    release_deprecated: extra.deprecated ?? false,
    gateway_ids: extra.gateway_ids ?? ["model-a", "model-a-beta"],
    gateway_providers: extra.gateway_providers ?? ["gw-alpha", "gw-beta"],
    effort,
    is_reasoning: effort !== "non-reasoning",
    is_primary: extra.primary ?? false,
    scores: { intelligence, engineering: intelligence == null ? undefined : intelligence + 2, gpqa: 60, ifbench: 50, terminal_bench_40: 40 },
    performance: { output_tokens_per_second: 100, time_to_first_token_seconds: effort === "high" ? 12 : 1 },
    pricing: { effective_input_per_1m: 1, effective_output_per_1m: 5 },
  }
}

export const COMPARISON = {
  schema_version: 2,
  intelligence_index_version_label: "T1",
  source: { attribution: "Test attribution" },
  metrics: [
    { id: "intelligence", kind: "index" },
    { id: "engineering", kind: "capability" },
  ],
  models: [
    variant("model-a-low", "low", 30),
    variant("model-a-high", "high", 45, { primary: true }),
    variant("model-b-x", "non-reasoning", null, { release_slug: "model-b-release", gateway_ids: ["model-b"], gateway_providers: ["gw-alpha"], primary: true }),
    variant("model-c-x", "high", 60, { release_slug: "model-c-release", gateway_ids: ["model-c"], gateway_providers: ["gw-beta"], primary: true, deprecated: true }),
  ],
}

// Same snapshot in schema 3: explicit gateway routes with a cost per task per route and effort.
export const COMPARISON_ROUTES = {
  ...COMPARISON,
  schema_version: 3,
  models: COMPARISON.models.map((m) => ({
    ...m,
    gateway_routes: m.gateway_ids.map((id, i) => ({
      provider_id: m.gateway_providers[i], model_id: id, effort_levels: [],
      cost_per_task_usd: { "model-a-low": [0.2, 0.25], "model-a-high": [0.9, 1.2] }[m.slug]?.[i] ?? 0.5,
    })),
  })),
}

// A data/recommendations.json as the comparison engine writes it (only the fields read here).
const pick = (provider_id, model_id, variant, score, cost) => ({ provider_id, model_id, variant, score, cost_per_task_usd: cost })
export const RECOMMENDATIONS = {
  schema_version: 1,
  generated_at: "2026-01-01T00:00:00Z",
  method: { workloads: { coding: { parts: [["terminal_bench_40", 0.6], ["intelligence", 0.4]] }, agentic: { parts: [["automation_bench", 0.6], ["intelligence", 0.4]] } } },
  grid: {
    coding: {
      light: { balanced: { reason: "cheap enough", ranked: [pick("gw-alpha", "model-b", null, 20, 0.01)] } },
      standard: { balanced: { reason: "good enough", ranked: [pick("gw-alpha", "missing-model", "low", 99, 0.1), pick("gw-alpha", "model-a", "low", 36, 0.2)] } },
      hard: { balanced: { reason: "strong", ranked: [pick("gw-alpha", "model-a", "high", 42, 0.9)] } },
      frontier: { balanced: { reason: "strongest", ranked: [pick("gw-beta", "model-c", "max", 60, 5)] } },
    },
  },
}

/** Create a temp GATEWAY_COST_DIR with the synthetic files. Returns { dir, settings, cleanup }. */
export function makeGatewayDir({ catalog = CATALOG, comparison = COMPARISON, recommendations = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rw-gw-"))
  if (catalog) writeFileSync(join(dir, "models.json"), JSON.stringify(catalog))
  if (comparison) {
    mkdirSync(join(dir, "model-comparison", "data"), { recursive: true })
    writeFileSync(join(dir, "model-comparison", "data", "models.json"), JSON.stringify(comparison))
  }
  if (recommendations) {
    mkdirSync(join(dir, "model-comparison", "data"), { recursive: true })
    writeFileSync(join(dir, "model-comparison", "data", "recommendations.json"), JSON.stringify(recommendations))
  }
  const settings = resolveGatewaySettings({ GATEWAY_COST_DIR: dir, GATEWAY_ENV_FILE: join(dir, "missing.env") })
  return { dir, settings, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Point process-wide default settings at an empty gateway dir so tests never read real machine data. */
export function isolateGatewayEnv() {
  const g = makeGatewayDir({ catalog: null, comparison: null })
  process.env.GATEWAY_COST_DIR = g.dir
  process.env.GATEWAY_ENV_FILE = join(g.dir, "missing.env")
  delete process.env.PROMPT_REWRITE_BENCHMARKS_FILE
  return g
}
