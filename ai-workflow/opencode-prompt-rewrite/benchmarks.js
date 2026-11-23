import { readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { expandHome, indexCatalog, resolveGatewaySettings } from "./gateway.js"

// Benchmark + pricing db, built at runtime from files the ai-gateway module maintains:
//   (a) the gateway model catalog       $GATEWAY_COST_DIR/models.json
//   (b) the model-comparison snapshot   $GATEWAY_COST_DIR/model-comparison/data/models.json
//       (written by `/model-comparison`; scores originate from Artificial Analysis,
//        fetched by the ai-gateway module, never bundled here)
//   (c) its recommendations             $GATEWAY_COST_DIR/model-comparison/data/recommendations.json
//       (the comparison's engine: the workload score definitions, and the picks per task tier
//        that Herdr's cc-models and the dashboard use too)
// See ../ai-gateway/README.md. PROMPT_REWRITE_BENCHMARKS_FILE may point at a prebuilt db instead.

export const BENCHMARK_HINT = "run /model-comparison for benchmark scores"

const EMPTY_DB = () => ({
  schemaVersion: 2,
  indexVersion: null,
  hasCatalog: false,
  hasBenchmarks: false,
  gatewayProviders: [],
  models: {},
  aliases: {},
})

let cache = { signature: null, db: null }

function statMtime(p) {
  try {
    return statSync(p).mtimeMs
  } catch {
    return null
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function anyScores(models) {
  return Object.values(models).some((r) => r?.benchmark?.perfScore != null || r?.benchmark?.matched)
}

function loadPrebuilt(target, forceReload) {
  const mtime = statMtime(target)
  if (mtime == null) return EMPTY_DB()
  const signature = `file:${target}:${mtime}`
  if (!forceReload && cache.signature === signature) return cache.db
  const parsed = readJson(target)
  if (!parsed) return EMPTY_DB()
  const models = parsed.models && typeof parsed.models === "object" ? parsed.models : {}
  const db = {
    schemaVersion: parsed.schemaVersion ?? 1,
    indexVersion: parsed.indexVersion ?? null,
    hasCatalog: Object.keys(models).length > 0,
    hasBenchmarks: anyScores(models),
    gatewayProviders: Array.isArray(parsed.gatewayProviders) ? parsed.gatewayProviders : [],
    models,
    aliases: parsed.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {},
  }
  cache = { signature, db }
  return db
}

/**
 * Load the benchmark db. Cached by the mtimes of the catalog and comparison files.
 * Options: { path, settings, forceReload }. `path` (or PROMPT_REWRITE_BENCHMARKS_FILE)
 * selects a prebuilt db file instead of building from the gateway files.
 */
export function loadBenchmarks(opts = {}) {
  const override = expandHome(opts.path || process.env.PROMPT_REWRITE_BENCHMARKS_FILE || "")
  if (override) return loadPrebuilt(override, opts.forceReload)

  const settings = opts.settings ?? resolveGatewaySettings()
  const recommendationsPath = settings.recommendationsPath ?? join(dirname(settings.comparisonPath), "recommendations.json")
  const catalogMtime = statMtime(settings.catalogModelsPath)
  const comparisonMtime = statMtime(settings.comparisonPath)
  const recommendationsMtime = statMtime(recommendationsPath)
  const signature = `gw:${settings.catalogModelsPath}:${catalogMtime}|${settings.comparisonPath}:${comparisonMtime}|${recommendationsPath}:${recommendationsMtime}`
  if (!opts.forceReload && cache.signature === signature) return cache.db

  const catalogDoc = catalogMtime == null ? null : readJson(settings.catalogModelsPath)
  const comparison = comparisonMtime == null ? null : readJson(settings.comparisonPath)
  const recommendations = recommendationsMtime == null ? null : readJson(recommendationsPath)
  const db = catalogDoc || comparison ? buildBenchmarkDb({ catalog: catalogDoc, comparison, recommendations }) : EMPTY_DB()
  cache = { signature, db }
  return db
}

export function resetBenchmarkCache() {
  cache = { signature: null, db: null }
}

/** One-line hint for the UI's existing warning surface when scores are unavailable. */
export function benchmarkHint(db = loadBenchmarks()) {
  return db?.hasBenchmarks ? null : BENCHMARK_HINT
}

// ---------------------------------------------------------------------------
// Pure db builder: gateway catalog + model-comparison snapshot -> lookup db
// ---------------------------------------------------------------------------

// Workload scores come from the comparison's recommendation engine: its definitions travel
// in recommendations.json (method.workloads), so this plugin and Herdr's cc-models score a
// model the same way. DEFAULT_WORKLOADS is only the fallback for a missing file and mirrors
// ai-gateway/model-comparison/engine.mjs. Only current AA benchmarks are used: retired ones
// (tau2, IFBench, GPQA, Terminal-Bench Hard, LiveCodeBench) are missing for most current
// models, and averaging them in made older models look stronger than newer ones.
const DEFAULT_WORKLOADS = {
  coding: { parts: [["terminal_bench_40", 0.6], ["intelligence", 0.4]] },
  agentic: { parts: [["automation_bench", 0.6], ["intelligence", 0.4]] },
}

function workloadScore(scores, spec) {
  let sum = 0
  let weight = 0
  for (const [id, w] of spec?.parts ?? []) {
    const v = numOrNull(scores?.[id])
    if (v == null) continue
    sum += v * w
    weight += w
  }
  return weight > 0 ? sum / weight : null
}

// The variant's cost per task on this gateway route (AA token counts at the route's price).
// Older snapshots have no explicit routes: their aggregate cost is only trusted for a single route.
function routeCostPerTask(m, providerId, modelId) {
  if (Array.isArray(m?.gateway_routes)) {
    const r = m.gateway_routes.find((x) => x.provider_id === providerId && x.model_id === modelId)
    return numOrNull(r?.cost_per_task_usd)
  }
  const single = (m?.gateway_ids ?? []).length === 1 && (m?.gateway_providers ?? []).length <= 1
  return single ? numOrNull(m?.pricing?.gateway_cost_per_task_usd) : null
}

function summarizeVariant(m, capabilityIds, workloads, gw) {
  const scores = m?.scores && typeof m.scores === "object" ? m.scores : {}
  const capabilities = {}
  for (const id of capabilityIds) {
    const v = numOrNull(scores[id])
    if (v != null) capabilities[id] = round(v, 1)
  }
  const perf = m?.performance || {}
  return {
    effort: m.effort || (m.is_reasoning === false || m.non_reasoning ? "non-reasoning" : "default"),
    isReasoning: m.is_reasoning !== false,
    deprecated: m.release_deprecated === true,
    intelligenceIndex: round(numOrNull(scores.intelligence), 1),
    codingScore: round(workloadScore(scores, workloads.coding), 1),
    agenticScore: round(workloadScore(scores, workloads.agentic), 1),
    capabilities,
    terminalBench: round(numOrNull(scores.terminal_bench_40), 1),
    outputSpeed: round(numOrNull(perf.output_tokens_per_second), 0),
    ttft: round(numOrNull(perf.time_to_first_token_seconds), 2),
    costPerTaskUSD: round(routeCostPerTask(m, gw?.provider_id, gw?.model_id), 4),
    referenceInputPer1M: round(numOrNull(m?.pricing?.effective_input_per_1m), 4),
    referenceOutputPer1M: round(numOrNull(m?.pricing?.effective_output_per_1m), 4),
  }
}

// Performance score on the 0-100 Intelligence Index scale; null when AA has not indexed the
// variant (no estimate from other benchmarks: that mixed scales and retired benchmarks).
function unifiedPerf(summary) {
  return summary.intelligenceIndex
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "")

function isFirstParty(creator, providerName, upstreamProvider) {
  const c = norm(creator)
  if (c.length < 3) return false
  return [providerName, upstreamProvider].some((v) => {
    const n = norm(v)
    return n.length >= 3 && (n === c || n.includes(c) || c.includes(n))
  })
}

function pickRelease(models) {
  const groups = new Map()
  for (const m of models) {
    const k = m.release_slug || m.slug
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(m)
  }
  const score = (list) =>
    (list.some((m) => numOrNull(m?.scores?.intelligence) != null) ? 2 : 0) + (list.some((m) => m.is_primary) ? 1 : 0)
  return [...groups.values()].sort(
    (a, b) =>
      score(b) - score(a) ||
      String(b[0].release_date || "").localeCompare(String(a[0].release_date || "")) ||
      String(a[0].slug).localeCompare(String(b[0].slug)),
  )[0]
}

/**
 * Pure. Build the lookup db from a gateway catalog document ({rows}) and an optional
 * model-comparison snapshot ({models, metrics, source}). Either may be null.
 * Catalog rows define the keys (`provider/model`); the comparison supplies scores per effort variant.
 */
export function buildBenchmarkDb({ catalog, comparison, recommendations } = {}) {
  const idx = indexCatalog(catalog)
  const workloads = recommendations?.method?.workloads ?? DEFAULT_WORKLOADS
  const rows = idx.rows.filter((r) => !r.mode || r.mode === "chat" || r.mode === "responses")

  const compModels = Array.isArray(comparison?.models) ? comparison.models : []
  const capabilityIds = (Array.isArray(comparison?.metrics) ? comparison.metrics : [])
    .filter((x) => x?.kind === "capability" && x.id)
    .map((x) => x.id)

  const byGatewayId = new Map()
  for (const m of compModels) {
    for (const id of m?.gateway_ids ?? []) {
      if (!byGatewayId.has(id)) byGatewayId.set(id, [])
      byGatewayId.get(id).push(m)
    }
  }

  // Tokens that commonly trail a route id (derived from the catalog's own provider fields).
  const routeTokens = new Set()
  for (const r of rows) {
    for (const v of [r.provider_id, r.provider_name, r.upstream_provider]) {
      for (const t of String(v || "").toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) routeTokens.add(t)
    }
  }

  const models = {}
  const aliases = {}
  const setAlias = (alias, key) => {
    const k = String(alias || "").trim().toLowerCase()
    if (k && !aliases[k]) aliases[k] = key
  }
  const sortedRows = [...rows].sort((a, b) => `${a.provider_id}/${a.model_id}`.localeCompare(`${b.provider_id}/${b.model_id}`))

  for (const gw of sortedRows) {
    const key = `${gw.provider_id}/${gw.model_id}`
    const candidates = (byGatewayId.get(gw.model_id) ?? []).filter(
      (m) => !Array.isArray(m.gateway_providers) || m.gateway_providers.length === 0 || m.gateway_providers.includes(gw.provider_id),
    )
    const release = candidates.length ? pickRelease(candidates) : []

    const variantsMap = {}
    const primaryKeys = new Set()
    for (const m of release) {
      const s = summarizeVariant(m, capabilityIds, workloads, gw)
      const perf = unifiedPerf(s)
      const vIn = numOrNull(gw.input_per_1M) ?? s.referenceInputPer1M
      const vOut = numOrNull(gw.output_per_1M) ?? s.referenceOutputPer1M
      const vBlend = blended3to1(vIn, vOut)
      const { valueRatio, balanceScore } = computeValueMetrics(perf, vBlend, s.costPerTaskUSD)
      const entry = { ...s, perfScore: perf, blended3to1Per1M: round(vBlend, 4), valueRatio, balanceScore }
      const effortKey = String(s.effort || "default").toLowerCase()
      const prev = variantsMap[effortKey]
      if (!prev || (entry.perfScore ?? -1) > (prev.perfScore ?? -1)) variantsMap[effortKey] = entry
      if (m.is_primary) primaryKeys.add(effortKey)
    }
    const vList = Object.values(variantsMap)
    const best = (list) => [...list].sort((a, b) => (b.perfScore ?? 0) - (a.perfScore ?? 0))[0] || null
    const bestVariant = best(vList)
    const primarySummary = best(vList.filter((v) => primaryKeys.has(String(v.effort || "default").toLowerCase()))) || bestVariant

    const refIn = bestVariant?.referenceInputPer1M
    const refOut = bestVariant?.referenceOutputPer1M
    const effIn = numOrNull(gw.input_per_1M) ?? refIn
    const effOut = numOrNull(gw.output_per_1M) ?? refOut
    const blended = blended3to1(effIn, effOut)
    const perfScore = bestVariant?.perfScore ?? null
    const intel = bestVariant?.intelligenceIndex ?? null
    const { valueRatio, balanceScore } = computeValueMetrics(perfScore, blended, bestVariant?.costPerTaskUSD)
    const first = release[0]

    const record = {
      key,
      providerID: gw.provider_id,
      id: gw.model_id,
      name: gw.model_name || gw.model_id,
      providerName: gw.provider_name || null,
      upstreamProvider: gw.upstream_provider || null,
      aliases: Array.isArray(gw.aliases) ? gw.aliases : [],
      releaseName: first?.release_name || null,
      releaseSlug: first?.release_slug || null,
      releaseDate: first?.release_date || null,
      creator: first?.creator || null,
      firstParty: isFirstParty(first?.creator, gw.provider_name, gw.upstream_provider),
      deprecated: release.length > 0 && release.every((m) => m.release_deprecated === true),
      maxInputTokens: numOrNull(gw.max_input_tokens),
      maxOutputTokens: numOrNull(gw.max_output_tokens),
      effortLevels: Array.isArray(gw.effort_levels) ? gw.effort_levels : [],
      capabilities: {
        tools: gw.tools === true,
        vision: gw.vision === true,
        pdf: gw.pdf === true,
        audio: gw.audio === true,
        video: gw.video === true,
      },
      pricing: {
        inputPer1M: round(effIn, 4),
        outputPer1M: round(effOut, 4),
        cacheReadPer1M: round(numOrNull(gw.cache_read_per_1M), 4),
        cacheWritePer1M: round(numOrNull(gw.cache_write_per_1M), 4),
        blended3to1Per1M: round(blended, 4),
        tiers: Array.isArray(gw.tiers) ? gw.tiers : [],
      },
      benchmark: {
        matched: release.length > 0,
        intelligenceIndex: intel,
        intelligenceEstimated: false,
        perfScore,
        codingScore: bestVariant?.codingScore ?? null,
        agenticScore: bestVariant?.agenticScore ?? null,
        terminalBench: bestVariant?.terminalBench ?? null,
        costPerTaskUSD: bestVariant?.costPerTaskUSD ?? null,
        capabilities: bestVariant?.capabilities ?? {},
        outputSpeed: bestVariant?.outputSpeed ?? null,
        ttft: bestVariant?.ttft ?? null,
        valueRatio,
        balanceScore,
        primaryEffort: primarySummary?.effort || null,
        bestEffort: bestVariant?.effort || null,
        variants: variantsMap,
      },
    }
    models[key] = record

    setAlias(gw.model_id, key)
    for (const a of record.aliases) setAlias(a, key)
    if (record.releaseSlug) setAlias(record.releaseSlug, key)
    const last = /^(.*)-([a-z0-9]+)$/i.exec(String(gw.model_id))
    if (last && routeTokens.has(last[2].toLowerCase())) setAlias(last[1], key)
  }

  const providers = [...idx.providerIds].sort()
  const scored = Object.values(models).some((r) => r.benchmark.perfScore != null)
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    attribution: comparison?.source?.attribution || null,
    indexVersion: comparison?.intelligence_index_version_label ?? comparison?.intelligence_index_version ?? null,
    hasCatalog: rows.length > 0,
    hasBenchmarks: scored,
    // The engine's ranked picks per workload, tier and profile (see benchmarkPicks in core.js).
    recommendations: recommendations?.grid ? { generatedAt: recommendations.generated_at ?? null, grid: recommendations.grid } : null,
    gatewayProviders: providers,
    count: rows.length,
    matchedCount: Object.values(models).filter((r) => r.benchmark.matched).length,
    models,
    aliases,
  }
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null
  return Number(v.toFixed(d))
}

export function blended3to1(inPer1M, outPer1M) {
  const i = numOrNull(inPer1M)
  const o = numOrNull(outPer1M)
  if (i == null || o == null) return null
  return (3 * i + o) / 4
}

// balanceScore = perf / price^0.35. The price is the cost per task when the comparison knows it
// for this route and effort (AA's token counts at the gateway price), else the blended per-1M price.
// Per task matters: an xhigh variant costs several times its low variant at the same token price.
export function computeValueMetrics(perfScore, blendedPer1M, costPerTask = null) {
  const perf = numOrNull(perfScore)
  const blend = numOrNull(blendedPer1M)
  const task = numOrNull(costPerTask)
  if (perf == null || (blend == null && task == null)) return { valueRatio: null, balanceScore: null }
  const valueRatio = blend != null && blend > 0 ? round(perf / blend, 2) : null
  const price = task ?? blend
  const balanceScore = round(perf / Math.pow(Math.max(price, task != null ? 0.05 : 0.08), 0.35), 2)
  return { valueRatio, balanceScore }
}

function stripModelDecorators(id) {
  return String(id || "")
    .trim()
    .toLowerCase()
    .replace(/-\d{8}(?=$|[-:])/, "")
    .replace(/:\w+$/, "")
    .replace(/@[\w.-]+$/, "")
}

function parseInputModel(model, variant) {
  if (typeof model === "string") {
    const raw = model.trim()
    const hashIdx = raw.indexOf("#")
    const base = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
    const inlineVariant = hashIdx >= 0 ? raw.slice(hashIdx + 1) : null
    const slashIdx = base.indexOf("/")
    return {
      providerID: slashIdx >= 0 ? base.slice(0, slashIdx) : "",
      id: slashIdx >= 0 ? base.slice(slashIdx + 1) : base,
      cost: null,
      variant: variant ?? inlineVariant ?? null,
    }
  }
  if (!model || typeof model !== "object") {
    return { providerID: "", id: "", cost: null, variant: variant ?? null }
  }
  return {
    providerID: String(model.providerID || ""),
    id: String(model.id || ""),
    cost: model.cost || null,
    variant: variant ?? model.variant ?? null,
  }
}

function resolveRecord(parsed, db) {
  const models = db?.models || {}
  const aliases = db?.aliases || {}
  const { providerID, id } = parsed
  if (!id) return null

  const exactKey = providerID ? `${providerID}/${id}` : ""
  if (exactKey && models[exactKey]) return models[exactKey]

  const lowerId = id.toLowerCase()
  if (aliases[lowerId] && models[aliases[lowerId]]) return models[aliases[lowerId]]

  const stripped = stripModelDecorators(id)
  if (aliases[stripped] && models[aliases[stripped]]) return models[aliases[stripped]]

  // Normalize version separator differences (e.g. 4-5 vs 4.5)
  const looseCandidates = [stripped.replace(/(\d)-(\d)/g, "$1.$2"), stripped.replace(/(\d)\.(\d)/g, "$1-$2")]
  for (const cand of looseCandidates) {
    if (aliases[cand] && models[aliases[cand]]) return models[aliases[cand]]
  }

  for (const rec of Object.values(models)) {
    const recId = String(rec.id || "").toLowerCase()
    if (recId === lowerId || stripModelDecorators(recId) === stripped) return rec
  }
  return null
}

function pickVariantSummary(record, requestedEffort) {
  const variants = record?.benchmark?.variants
  if (!variants || typeof variants !== "object") return null

  const req = requestedEffort ? String(requestedEffort).trim().toLowerCase() : ""
  if (req) {
    if (variants[req]) return variants[req]
    if ((req === "none" || req === "minimal") && variants["non-reasoning"]) return variants["non-reasoning"]
    if (req === "xhigh" && variants["max"]) return variants["max"]
  }

  const primary = String(record?.benchmark?.primaryEffort || "").toLowerCase()
  if (primary && variants[primary]) return variants[primary]
  const best = String(record?.benchmark?.bestEffort || "").toLowerCase()
  if (best && variants[best]) return variants[best]
  return Object.values(variants)[0] || null
}

function stripNullish(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

export function lookupBenchmark(model, variant, db = loadBenchmarks()) {
  const parsed = parseInputModel(model, variant)
  const record = resolveRecord(parsed, db)

  const liveIn = numOrNull(parsed.cost?.input)
  const liveOut = numOrNull(parsed.cost?.output)
  const recPricing = record?.pricing || {}
  const inputPer1M = liveIn ?? numOrNull(recPricing.inputPer1M)
  const outputPer1M = liveOut ?? numOrNull(recPricing.outputPer1M)
  const blended = round(blended3to1(inputPer1M, outputPer1M), 4)

  if (!record) {
    if (blended == null) return null
    return stripNullish({
      matched: false,
      inputPer1M: round(inputPer1M, 4),
      outputPer1M: round(outputPer1M, 4),
      blended3to1Per1M: blended,
    })
  }

  const bench = record.benchmark || {}
  const chosenVariant = pickVariantSummary(record, parsed.variant)
  const perfScore = numOrNull(chosenVariant?.perfScore) ?? numOrNull(bench.perfScore)
  const codingScore = numOrNull(chosenVariant?.codingScore) ?? numOrNull(bench.codingScore)
  const agenticScore = numOrNull(chosenVariant?.agenticScore) ?? numOrNull(bench.agenticScore)
  const intelligenceIndex = numOrNull(chosenVariant?.intelligenceIndex) ?? numOrNull(bench.intelligenceIndex)
  const outputSpeed = numOrNull(chosenVariant?.outputSpeed) ?? numOrNull(bench.outputSpeed)
  const ttft = numOrNull(chosenVariant?.ttft) ?? numOrNull(bench.ttft)
  // The comparison's cost per task holds at gateway prices; a live price that differs falls back to per-1M.
  const livePriceDiffers = (liveIn != null && liveIn !== numOrNull(recPricing.inputPer1M)) || (liveOut != null && liveOut !== numOrNull(recPricing.outputPer1M))
  const costPerTaskUSD = livePriceDiffers ? null : numOrNull(chosenVariant?.costPerTaskUSD) ?? (chosenVariant ? null : numOrNull(bench.costPerTaskUSD))
  const { valueRatio, balanceScore } = computeValueMetrics(perfScore, blended, costPerTaskUSD)

  return stripNullish({
    matched: Boolean(bench.matched),
    key: record.key,
    effort: chosenVariant?.effort || parsed.variant || undefined,
    primaryEffort: bench.primaryEffort || undefined,
    bestEffort: bench.bestEffort || undefined,
    intelligenceIndex: intelligenceIndex ?? undefined,
    intelligenceEstimated: intelligenceIndex == null && perfScore != null ? true : undefined,
    perfScore: perfScore ?? undefined,
    codingScore: codingScore ?? undefined,
    agenticScore: agenticScore ?? undefined,
    costPerTaskUSD: costPerTaskUSD ?? undefined,
    outputSpeed: outputSpeed ?? undefined,
    ttft: ttft ?? undefined,
    inputPer1M: inputPer1M != null ? round(inputPer1M, 4) : undefined,
    outputPer1M: outputPer1M != null ? round(outputPer1M, 4) : undefined,
    cacheReadPer1M: numOrNull(parsed.cost?.cache?.read) ?? numOrNull(recPricing.cacheReadPer1M) ?? undefined,
    blended3to1Per1M: blended ?? undefined,
    valueRatio: valueRatio ?? undefined,
    balanceScore: balanceScore ?? undefined,
    deprecated: record.deprecated ? true : undefined,
  })
}

export function formatCostPer1M(price) {
  if (typeof price !== "number" || !Number.isFinite(price)) return null
  if (price === 0) return "$0"
  if (price < 0.1) return `$${price.toFixed(3)}/1M`
  if (price < 10) return `$${price.toFixed(2)}/1M`
  return `$${price.toFixed(1)}/1M`
}

export function formatBenchmarkChip(b) {
  if (!b) return ""
  const parts = []
  if (typeof b.perfScore === "number") {
    const prefix = b.intelligenceEstimated ? "~" : ""
    parts.push(`perf ${prefix}${b.perfScore.toFixed(1)}`)
  }
  if (typeof b.codingScore === "number") parts.push(`code ${b.codingScore.toFixed(1)}`)
  const p = formatCostPer1M(b.blended3to1Per1M)
  if (p) parts.push(p)
  if (typeof b.balanceScore === "number") parts.push(`bal ${b.balanceScore.toFixed(0)}`)
  if (typeof b.outputSpeed === "number") parts.push(`${Math.round(b.outputSpeed)}t/s`)
  return parts.join(" · ")
}

export function formatVariantsNote(model, db = loadBenchmarks()) {
  const rec = resolveRecord(parseInputModel(model, null), db)
  const variants = rec?.benchmark?.variants
  if (!variants || typeof variants !== "object") return ""
  const order = ["non-reasoning", "none", "low", "medium", "high", "xhigh", "max", "default"]
  const entries = Object.values(variants).sort((a, b) => {
    const ia = order.indexOf(String(a.effort).toLowerCase())
    const ib = order.indexOf(String(b.effort).toLowerCase())
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  if (entries.length <= 1) return ""
  return entries
    .slice(0, 6)
    .map((v) => {
      const parts = [v.effort]
      if (v.perfScore != null) parts.push(`perf ${v.perfScore}`)
      if (v.codingScore != null) parts.push(`code ${v.codingScore}`)
      if (v.costPerTaskUSD != null) parts.push(`$${v.costPerTaskUSD}/task`)
      if (v.ttft != null && v.ttft >= 3) parts.push(`ttft ${v.ttft}s`)
      return parts.join(" ")
    })
    .join(" | ")
}

// The rewrite model's task tiers mapped to the engine's tiers (ai-gateway model-comparison/engine.mjs).
export const TASK_TIERS = { quick: "light", standard: "standard", complex: "hard", deep_reasoning: "frontier" }

/**
 * The comparison engine's ranked picks per task tier, for agentic coding on the balanced budget:
 * { quick: [{ key, variant, score, costPerTaskUSD, reason }], standard: [...], ... }. Empty
 * without recommendations.json. Each pick is a gateway route (key = provider/model) at an effort.
 */
export function engineTierPicks(db = loadBenchmarks(), { workload = "coding", profile = "balanced" } = {}) {
  const grid = db?.recommendations?.grid?.[workload]
  const out = {}
  if (!grid) return out
  for (const [taskTier, engineTier] of Object.entries(TASK_TIERS)) {
    const result = grid[engineTier]?.[profile]
    if (!result?.ranked?.length) continue
    out[taskTier] = result.ranked.map((p, i) => ({
      key: `${p.provider_id}/${p.model_id}`,
      variant: p.variant ?? null,
      score: p.score,
      costPerTaskUSD: p.cost_per_task_usd,
      reason: i === 0 ? result.reason : null,
    }))
  }
  return out
}

// Lower is better. Order: the session's own provider, then user-configured preferred providers
// (plugin option `preferredProviders`, in order), then routes served by the model's own creator
// (derived from catalog/comparison data), then everything else.
function dedupeProviderPriority(providerID, preferredProviderID, preferredProviders, record) {
  if (preferredProviderID && providerID === preferredProviderID) return 0
  const idx = preferredProviders.indexOf(providerID)
  if (idx >= 0) return 1 + idx / 1000
  if (record?.firstParty) return 2
  return 3
}

export function selectCandidateRoutes(models, currentModel, db = loadBenchmarks(), options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 40
  const defaultRewrite = options.defaultRewrite || null
  const currentKey = currentModel ? `${currentModel.providerID}/${currentModel.id}` : ""
  const defaultKey = defaultRewrite ? `${defaultRewrite.providerID}/${defaultRewrite.id}` : ""
  const preferredProvider = currentModel?.providerID || ""
  const preferredProviders = Array.isArray(options.preferredProviders) ? options.preferredProviders : []

  // Step 1: enrich every candidate model with live/benchmark metrics
  const enriched = models.map((m) => {
    const key = `${m.providerID}/${m.id}`
    const bench = lookupBenchmark(m, m.variant || null, db)
    const variantsNote = formatVariantsNote(m, db)
    return {
      model: m,
      key,
      bench,
      variantsNote,
      isCurrent: key === currentKey,
      isDefaultRewrite: key === defaultKey,
      priority: dedupeProviderPriority(m.providerID, preferredProvider, preferredProviders, db?.models?.[key]),
    }
  })

  // Step 2: pick one canonical deployment per model_id for benchmark-driven diversity
  const byId = new Map()
  for (const item of enriched) {
    const bare = String(item.model.id || item.key).toLowerCase()
    const prev = byId.get(bare)
    if (!prev) {
      byId.set(bare, item)
      continue
    }
    if (item.isCurrent) {
      byId.set(bare, item)
      continue
    }
    if (prev.isCurrent) continue
    const itemCost = item.bench?.blended3to1Per1M ?? Infinity
    const prevCost = prev.bench?.blended3to1Per1M ?? Infinity
    if (itemCost < prevCost - 1e-6 || (Math.abs(itemCost - prevCost) < 1e-6 && item.priority < prev.priority)) {
      byId.set(bare, item)
    }
  }
  const uniquePool = [...byId.values()]

  // Step 3: stratified Performance-Cost selection across unique models
  const selected = []
  const seen = new Set()
  const addItem = (item) => {
    if (!item || seen.has(item.key) || selected.length >= limit) return false
    seen.add(item.key)
    selected.push(item)
    return true
  }

  for (const item of enriched) {
    if (item.isCurrent) addItem(item)
  }
  for (const item of enriched) {
    if (item.isDefaultRewrite) addItem(item)
  }

  const activeUnique = uniquePool.filter((x) => !x.bench?.deprecated)
  const byBalance = (a, b) => (b.bench?.balanceScore ?? -1) - (a.bench?.balanceScore ?? -1)

  // The comparison engine's ranked picks per task tier come first (its top 3 per tier, in tier
  // order), so the routes the rewrite model is pointed at (benchmark_picks) are always offered.
  const tierPicks = engineTierPicks(db)
  if (Object.keys(tierPicks).length) {
    const byKey = new Map(enriched.map((x) => [x.key, x]))
    for (const picks of Object.values(tierPicks)) {
      for (const p of picks.slice(0, 3)) addItem(byKey.get(p.key))
    }
  }

  // Without engine picks (no recommendations.json yet), fixed price/score tiers as before.
  // Budget high-value tier (cheap & capable)
  const budget = activeUnique
    .filter((x) => (x.bench?.blended3to1Per1M ?? Infinity) <= 0.65 && (x.bench?.perfScore ?? 0) >= 22)
    .sort(byBalance)
  for (const item of budget.slice(0, 8)) addItem(item)

  // Mid-tier balanced workhorses
  const mid = activeUnique
    .filter((x) => {
      const p = x.bench?.blended3to1Per1M ?? Infinity
      return p > 0.65 && p <= 4.5 && (x.bench?.perfScore ?? 0) >= 28
    })
    .sort(byBalance)
  for (const item of mid.slice(0, 10)) addItem(item)

  // Frontier high-capability tier (ordered by perf + balance)
  const frontier = activeUnique
    .filter((x) => (x.bench?.perfScore ?? 0) >= 48)
    .sort((a, b) => {
      const dp = (b.bench?.perfScore ?? 0) - (a.bench?.perfScore ?? 0)
      return Math.abs(dp) > 3 ? dp : byBalance(a, b)
    })
  for (const item of frontier.slice(0, 8)) addItem(item)

  // Fill with remaining unique benchmarked models before duplicating deployments across providers
  for (const item of [...activeUnique].filter((x) => x.bench?.balanceScore != null).sort(byBalance)) addItem(item)
  for (const item of [...uniquePool].filter((x) => x.bench?.balanceScore != null).sort(byBalance)) addItem(item)

  // Finally round-robin across remaining models by provider so synthetic/unbenchmarked catalogs fill evenly
  if (selected.length < limit) {
    const byProvider = new Map()
    for (const item of enriched) {
      if (seen.has(item.key)) continue
      const p = item.model.providerID || ""
      if (!byProvider.has(p)) byProvider.set(p, [])
      byProvider.get(p).push(item)
    }
    const providers = [...byProvider.keys()].sort()
    for (const p of providers) byProvider.get(p).sort((a, b) => a.key.localeCompare(b.key))
    let round = 0
    while (selected.length < limit) {
      let addedAny = false
      for (const p of providers) {
        const list = byProvider.get(p)
        if (round < list.length) {
          addItem(list[round])
          addedAny = true
          if (selected.length >= limit) break
        }
      }
      if (!addedAny) break
      round++
    }
  }

  return selected.sort((a, b) => a.key.localeCompare(b.key))
}
