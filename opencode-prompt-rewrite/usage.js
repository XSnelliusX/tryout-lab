import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { lookupBenchmark } from "./benchmarks.js"

let cachedCatalogPath = null
let cachedCatalogMtime = -1
let cachedCatalog = null

function expandHome(p) {
  if (!p) return ""
  const s = String(p).trim()
  if (s === "~") return homedir()
  if (s.startsWith("~/")) return join(homedir(), s.slice(2))
  return s
}

function parseEnvFile(filePath) {
  const vars = {}
  if (!filePath) return vars
  try {
    const raw = readFileSync(filePath, "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
      if (!match) continue
      const key = match[1]
      let val = match[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      vars[key] = val
    }
  } catch {
    // Env file is optional
  }
  return vars
}

export function resolveGatewaySettings(env = process.env) {
  const envFile = expandHome(env.GATEWAY_ENV_FILE || "~/.config/ai-gateway/env")
  const fileVars = parseEnvFile(envFile)
  const get = (name, fallback = "") => {
    const v = env[name]
    if (v !== undefined && String(v).trim() !== "") return String(v).trim()
    const fv = fileVars[name]
    if (fv !== undefined && String(fv).trim() !== "") return String(fv).trim()
    return fallback
  }

  const costDir = expandHome(get("GATEWAY_COST_DIR", "~/.gateway-cost"))
  const disabledRaw = get("GATEWAY_USAGE_DISABLED", "").toLowerCase()
  const usageDisabled = disabledRaw === "1" || disabledRaw === "true" || disabledRaw === "yes"

  return {
    envFile,
    costDir,
    usageDisabled,
    usageLogPath: join(costDir, "usage.jsonl"),
    catalogModelsPath: join(costDir, "models.json"),
  }
}

export function loadGatewayCatalog(catalogPath) {
  if (!catalogPath) return { byKey: new Map(), byId: new Map() }
  try {
    const st = statSync(catalogPath)
    if (cachedCatalog && cachedCatalogPath === catalogPath && cachedCatalogMtime === st.mtimeMs) {
      return cachedCatalog
    }
    const doc = JSON.parse(readFileSync(catalogPath, "utf8"))
    const byKey = new Map()
    const byId = new Map()
    for (const row of doc?.rows ?? []) {
      if (!row?.provider_id || !row?.model_id) continue
      const key = `${row.provider_id}/${row.model_id}`
      byKey.set(key, row)
      const lowerId = String(row.model_id).toLowerCase()
      if (!byId.has(lowerId)) byId.set(lowerId, row)
    }
    cachedCatalogPath = catalogPath
    cachedCatalogMtime = st.mtimeMs
    cachedCatalog = { byKey, byId }
    return cachedCatalog
  } catch {
    return { byKey: new Map(), byId: new Map() }
  }
}

function num(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback
}

function roundUSD(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0
  return Number(Math.max(0, v).toFixed(8))
}

export function resolveModelPricing(model, inputTokens = 0, opts = {}) {
  const providerID = String(model?.providerID || "unknown")
  const modelID = String(model?.id || "unknown")
  const key = `${providerID}/${modelID}`

  const catalog = opts.catalog || loadGatewayCatalog(opts.catalogModelsPath)
  const gwRow = catalog.byKey.get(key) || catalog.byId.get(modelID.toLowerCase()) || null

  const liveIn = typeof model?.cost?.input === "number" ? model.cost.input : null
  const liveOut = typeof model?.cost?.output === "number" ? model.cost.output : null
  const liveCacheRead = typeof model?.cost?.cache?.read === "number" ? model.cost.cache.read : null
  const liveCacheWrite = typeof model?.cost?.cache?.write === "number" ? model.cost.cache.write : null

  let inputPer1M = liveIn ?? (gwRow ? num(gwRow.input_per_1M, null) : null)
  let outputPer1M = liveOut ?? (gwRow ? num(gwRow.output_per_1M, null) : null)
  let cacheReadPer1M = liveCacheRead ?? (gwRow ? num(gwRow.cache_read_per_1M, null) : null)
  let cacheWritePer1M = liveCacheWrite ?? (gwRow ? num(gwRow.cache_write_per_1M, null) : null)

  // Apply gateway context-size tier pricing when inputTokens exceeds threshold
  if (Array.isArray(gwRow?.tiers) && gwRow.tiers.length > 0 && inputTokens > 0) {
    const sorted = [...gwRow.tiers]
      .filter((t) => typeof t?.size === "number" && inputTokens > t.size)
      .sort((a, b) => b.size - a.size)
    const tier = sorted[0]
    if (tier) {
      if (typeof tier.input_per_1M === "number") inputPer1M = tier.input_per_1M
      if (typeof tier.output_per_1M === "number") outputPer1M = tier.output_per_1M
      if (typeof tier.cache_read_per_1M === "number") cacheReadPer1M = tier.cache_read_per_1M
      if (typeof tier.cache_write_per_1M === "number") cacheWritePer1M = tier.cache_write_per_1M
    }
  }

  // Fallback to bundled AA/catalog benchmarks pricing if runtime model lacks cost fields
  if (inputPer1M == null || outputPer1M == null) {
    const bench = lookupBenchmark(model, model?.variant || null)
    if (inputPer1M == null && typeof bench?.inputPer1M === "number") inputPer1M = bench.inputPer1M
    if (outputPer1M == null && typeof bench?.outputPer1M === "number") outputPer1M = bench.outputPer1M
    if (cacheReadPer1M == null && typeof bench?.cacheReadPer1M === "number") cacheReadPer1M = bench.cacheReadPer1M
  }

  const isGateway = Boolean(
    catalog.byKey.has(key) ||
      providerID.startsWith("acc-") ||
      model?.provider?.source === "gateway" ||
      String(model?.provider?.name || "").toLowerCase().includes("gateway"),
  )

  return {
    providerID,
    modelID,
    modelName: String(model?.name || gwRow?.model_name || modelID),
    upstreamProvider: gwRow?.upstream_provider ?? null,
    billing: isGateway ? "gateway" : "other",
    inputPer1M: num(inputPer1M, 0),
    outputPer1M: num(outputPer1M, 0),
    cacheReadPer1M: num(cacheReadPer1M, 0),
    cacheWritePer1M: num(cacheWritePer1M, 0),
  }
}

export function extractTokenCounts(generated, promptText, outputText) {
  const u = generated?.usage || generated?.totalUsage || generated?.meta?.usage || null
  const t = generated?.tokens || generated?.meta?.tokens || null

  const reportedInput =
    u?.inputTokens ?? u?.input_tokens ?? u?.promptTokens ?? u?.prompt_tokens ?? t?.input ?? t?.input_tokens
  const reportedOutput =
    u?.outputTokens ?? u?.output_tokens ?? u?.completionTokens ?? u?.completion_tokens ?? t?.output ?? t?.output_tokens
  const reportedReasoning =
    u?.reasoningTokens ?? u?.reasoning_tokens ?? u?.outputTokenDetails?.reasoningTokens ?? t?.reasoning ?? 0
  const reportedCacheRead =
    u?.cacheReadTokens ??
    u?.cache_read_tokens ??
    u?.cachedInputTokens ??
    u?.inputTokenDetails?.cacheReadTokens ??
    t?.cache?.read ??
    0
  const reportedCacheWrite =
    u?.cacheWriteTokens ?? u?.cache_write_tokens ?? u?.inputTokenDetails?.cacheWriteTokens ?? t?.cache?.write ?? 0

  const hasReported = typeof reportedInput === "number" && typeof reportedOutput === "number"
  const inputTokens = hasReported
    ? Math.max(0, Math.round(reportedInput))
    : String(promptText || "").length > 0
      ? Math.max(1, Math.ceil(String(promptText).length / 4))
      : 0
  const outputTokens = hasReported
    ? Math.max(0, Math.round(reportedOutput))
    : String(outputText || "").length > 0
      ? Math.max(1, Math.ceil(String(outputText).length / 4))
      : 0
  const reasoningTokens = hasReported ? Math.max(0, Math.round(num(reportedReasoning, 0))) : 0
  const cacheReadTokens = hasReported ? Math.max(0, Math.round(num(reportedCacheRead, 0))) : 0
  const cacheWriteTokens = hasReported ? Math.max(0, Math.round(num(reportedCacheWrite, 0))) : 0

  return {
    estimated: !hasReported,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens,
  }
}

export function buildUsageStats({ generated, promptText, outputText, model, settings = resolveGatewaySettings(), catalog }) {
  const tokens = extractTokenCounts(generated, promptText, outputText)
  const pricing = resolveModelPricing(model, tokens.inputTokens, {
    catalogModelsPath: settings.catalogModelsPath,
    catalog,
  })

  // Reasoning tokens are billed at the output rate.
  const computedCost =
    (tokens.inputTokens * pricing.inputPer1M +
      (tokens.outputTokens + tokens.reasoningTokens) * pricing.outputPer1M +
      tokens.cacheReadTokens * pricing.cacheReadPer1M +
      tokens.cacheWriteTokens * pricing.cacheWritePer1M) /
    1_000_000

  const reportedCost =
    typeof generated?.cost === "number" && Number.isFinite(generated.cost) && generated.cost >= 0
      ? roundUSD(generated.cost)
      : 0
  const costUSD = roundUSD(computedCost > 0 || reportedCost === 0 ? computedCost : reportedCost)

  return {
    providerID: pricing.providerID,
    modelID: pricing.modelID,
    modelName: pricing.modelName,
    upstreamProvider: pricing.upstreamProvider,
    billing: pricing.billing,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    reasoningTokens: tokens.reasoningTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    totalTokens: tokens.totalTokens,
    inputPer1M: pricing.inputPer1M,
    outputPer1M: pricing.outputPer1M,
    cacheReadPer1M: pricing.cacheReadPer1M,
    cacheWritePer1M: pricing.cacheWritePer1M,
    costUSD,
    reportedCostUSD: reportedCost,
    estimated: tokens.estimated,
  }
}

export function toPublicUsageSummary(stats) {
  if (!stats) return null
  return {
    providerID: String(stats.providerID || ""),
    modelID: String(stats.modelID || ""),
    modelName: String(stats.modelName || ""),
    inputTokens: num(stats.inputTokens, 0),
    outputTokens: num(stats.outputTokens, 0),
    reasoningTokens: num(stats.reasoningTokens, 0),
    totalTokens: num(stats.totalTokens, 0),
    costUSD: roundUSD(stats.costUSD),
    estimated: Boolean(stats.estimated),
    billing: String(stats.billing || "other"),
  }
}

export function recordGatewayUsage({
  requestID,
  phase,
  sessionID,
  stats,
  settings = resolveGatewaySettings(),
  timestamp = new Date().toISOString(),
}) {
  if (!stats || settings.usageDisabled || !settings.usageLogPath) {
    return { logged: false, reason: settings.usageDisabled ? "disabled" : "missing-stats" }
  }

  const record = {
    ts: timestamp,
    event_id: `rw:${requestID}:${phase || "rewrite"}`,
    tool: "prompt-rewriter",
    billing: stats.billing || "other",
    agent: phase || "rewrite",
    session_id: sessionID || "prompt-rewrite",
    provider_id: stats.providerID,
    model_id: stats.modelID,
    model_name: stats.modelName,
    upstream_provider: stats.upstreamProvider ?? null,
    gateway: stats.billing === "gateway",
    input_tokens: stats.inputTokens,
    output_tokens: stats.outputTokens,
    reasoning_tokens: stats.reasoningTokens,
    cache_read_tokens: stats.cacheReadTokens,
    cache_write_tokens: stats.cacheWriteTokens,
    input_per_1M: stats.inputPer1M,
    output_per_1M: stats.outputPer1M,
    cache_read_per_1M: stats.cacheReadPer1M,
    cache_write_per_1M: stats.cacheWritePer1M,
    cost: stats.costUSD,
    reported_cost: stats.reportedCostUSD ?? 0,
    estimated: Boolean(stats.estimated),
  }

  try {
    mkdirSync(dirname(settings.usageLogPath), { recursive: true })
    appendFileSync(settings.usageLogPath, JSON.stringify(record) + "\n", "utf8")
    return { logged: true, path: settings.usageLogPath, record }
  } catch (err) {
    return { logged: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function formatUsd(costUSD, estimated = false) {
  if (typeof costUSD !== "number" || !Number.isFinite(costUSD) || costUSD < 0) return null
  const prefix = estimated ? "~$" : "$"
  if (costUSD === 0) return "$0.00"
  if (costUSD < 0.0001) return `${estimated ? "~" : ""}<$0.0001`
  if (costUSD < 0.01) return `${prefix}${costUSD.toFixed(4)}`
  if (costUSD < 1) return `${prefix}${costUSD.toFixed(3)}`
  return `${prefix}${costUSD.toFixed(2)}`
}

export function formatTokensCompact(totalTokens, estimated = false) {
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens <= 0) return ""
  const prefix = estimated ? "~" : ""
  if (totalTokens >= 1000) return `${prefix}${(totalTokens / 1000).toFixed(1)}k tok`
  return `${prefix}${Math.round(totalTokens)} tok`
}
