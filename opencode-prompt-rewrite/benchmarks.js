import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const BUNDLED_BENCHMARKS_PATH = fileURLToPath(new URL("./data/model-benchmarks.json", import.meta.url))

let cachedPath = null
let cachedMtime = -1
let cachedDb = null

function expandHome(p) {
  if (!p) return ""
  const s = String(p).trim()
  if (s === "~") return homedir()
  if (s.startsWith("~/")) return join(homedir(), s.slice(2))
  return s
}

function resolveBenchmarksPath(explicitPath) {
  if (explicitPath) return expandHome(explicitPath)
  const envFile = expandHome(process.env.PROMPT_REWRITE_BENCHMARKS_FILE || "")
  if (envFile) return envFile
  const costDir = expandHome(process.env.GATEWAY_COST_DIR || "~/.gateway-cost")
  const overridePath = join(costDir, "aa-benchmarks.json")
  try {
    statSync(overridePath)
    return overridePath
  } catch {
    return BUNDLED_BENCHMARKS_PATH
  }
}

export function loadBenchmarks(opts = {}) {
  const target = resolveBenchmarksPath(opts.path)
  if (!target) return { schemaVersion: 1, models: {}, aliases: {} }

  try {
    const st = statSync(target)
    if (!opts.forceReload && cachedDb && cachedPath === target && cachedMtime === st.mtimeMs) {
      return cachedDb
    }
    const parsed = JSON.parse(readFileSync(target, "utf8"))
    const db = {
      schemaVersion: parsed?.schemaVersion ?? 1,
      indexVersion: parsed?.indexVersion ?? null,
      models: parsed?.models && typeof parsed.models === "object" ? parsed.models : {},
      aliases: parsed?.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {},
    }
    cachedPath = target
    cachedMtime = st.mtimeMs
    cachedDb = db
    return db
  } catch {
    return { schemaVersion: 1, models: {}, aliases: {} }
  }
}

export function resetBenchmarkCache() {
  cachedPath = null
  cachedMtime = -1
  cachedDb = null
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

export function computeValueMetrics(perfScore, blendedPer1M) {
  const perf = numOrNull(perfScore)
  const blend = numOrNull(blendedPer1M)
  if (perf == null || blend == null) return { valueRatio: null, balanceScore: null }
  const valueRatio = blend > 0 ? round(perf / blend, 2) : null
  const balanceScore = round(perf / Math.pow(Math.max(blend, 0.08), 0.35), 2)
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

  // Normalize version separator differences (e.g. 4-5 vs 4.5, remove vendor suffix like -openai / -anthropic)
  const looseCandidates = [
    stripped.replace(/-(openai|anthropic|vertex|bedrock|aws|azure|google)$/, ""),
    stripped.replace(/(\d)-(\d)/g, "$1.$2"),
  ]
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
  const reasoningScore = numOrNull(chosenVariant?.reasoningScore) ?? numOrNull(bench.reasoningScore)
  const intelligenceIndex = numOrNull(chosenVariant?.intelligenceIndex) ?? numOrNull(bench.intelligenceIndex)
  const outputSpeed = numOrNull(chosenVariant?.outputSpeed) ?? numOrNull(bench.outputSpeed)
  const ttft = numOrNull(chosenVariant?.ttft) ?? numOrNull(bench.ttft)
  const { valueRatio, balanceScore } = computeValueMetrics(perfScore, blended)

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
    reasoningScore: reasoningScore ?? undefined,
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
      if (v.ttft != null && v.ttft >= 3) parts.push(`ttft ${v.ttft}s`)
      return parts.join(" ")
    })
    .join(" | ")
}

function dedupeProviderPriority(providerID, preferredProviderID) {
  if (preferredProviderID && providerID === preferredProviderID) return 0
  if (providerID === "acc-openai" || providerID === "acc-anthropic" || providerID === "acc-vertex-ai") return 1
  if (providerID === "openai" || providerID === "anthropic" || providerID === "google") return 2
  if (providerID === "acc-3rd-party" || providerID === "acc-aws-bedrock" || providerID === "acc-azure") return 3
  return 4
}

export function selectCandidateRoutes(models, currentModel, db = loadBenchmarks(), options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 40
  const defaultRewrite = options.defaultRewrite || null
  const currentKey = currentModel ? `${currentModel.providerID}/${currentModel.id}` : ""
  const defaultKey = defaultRewrite ? `${defaultRewrite.providerID}/${defaultRewrite.id}` : ""
  const preferredProvider = currentModel?.providerID || ""

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
      priority: dedupeProviderPriority(m.providerID, preferredProvider),
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
