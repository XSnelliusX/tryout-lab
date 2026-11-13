#!/usr/bin/env node
// Builds a compact, privacy-clean benchmark & pricing index (data/model-benchmarks.json)
// from an Artificial Analysis enriched dataset + gateway models catalog.
//
// Zero provider credentials or organization-specific paths are hardcoded here.
// Pass --aa <path> --gw <path> --out <path> or set MODEL_COMPARISON_FILE / GATEWAY_COST_DIR.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

function expandHome(p) {
  if (!p) return ""
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function argVal(flag, fallback) {
  const idx = process.argv.indexOf(flag)
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)))

function weightedMean(pairs) {
  let sum = 0
  let wSum = 0
  for (const [val, w, scale = 1] of pairs) {
    if (val == null || !Number.isFinite(val)) continue
    sum += val * scale * w
    wSum += w
  }
  return wSum > 0 ? sum / wSum : null
}

function summarizeVariant(v) {
  if (!v || typeof v !== "object") return null
  const coding = weightedMean([
    [num(v.terminalBench40), 2.2, 100],
    [num(v.terminalbenchHard), 2.0, 100],
    [num(v.frontierCode), 2.0, 100],
    [num(v.frontierCode20), 1.6, 100],
    [num(v.terminalBench21), 1.2, 100],
    [num(v.scicode), 1.3, 100],
    [num(v.livecodebench), 1.2, 100],
  ])
  const reasoning = weightedMean([
    [num(v.hle), 2.0, 100],
    [num(v.hleDiamond), 1.5, 100],
    [num(v.gpqa), 1.4, 100],
    [num(v.ifbench), 1.5, 100],
    [num(v.lcr), 1.1, 100],
    [num(v.tau2), 1.3, 100],
    [num(v.critpt), 1.0, 100],
  ])
  const evalComposite = weightedMean([
    [coding, 1.3, 1],
    [reasoning, 1.0, 1],
    [num(v.ifbench), 0.7, 100],
  ])
  const intel = num(v.intelligenceIndex)
  const capEng = num(v.capabilities?.engineering)
  const speed = num(v.headline?.outputSpeed) ?? num(v.outputSpeed)
  const ttft = num(v.headline?.medianTimeToFirstToken) ?? num(v.timeToFirstToken)
  const inputPrice = num(v.price1mInputTokens)
  const outputPrice = num(v.price1mOutputTokens)

  return {
    effort: v.effort || (v.isReasoning === false ? "non-reasoning" : "default"),
    isReasoning: v.isReasoning !== false,
    deprecated: v.deprecated === true,
    intelligenceIndex: round(intel, 1),
    codingScore: round(coding, 1),
    reasoningScore: round(reasoning, 1),
    evalScore: round(evalComposite, 1),
    engineeringCap: round(capEng, 1),
    ifbench: round(num(v.ifbench) != null ? v.ifbench * 100 : null, 1),
    gpqa: round(num(v.gpqa) != null ? v.gpqa * 100 : null, 1),
    terminalBench: round((num(v.terminalBench40) ?? num(v.terminalbenchHard)) != null ? (num(v.terminalBench40) ?? num(v.terminalbenchHard)) * 100 : null, 1),
    outputSpeed: round(speed, 0),
    ttft: round(ttft, 2),
    aaInputPer1M: round(inputPrice, 4),
    aaOutputPer1M: round(outputPrice, 4),
  }
}

// Compute unified performance score on AA Intelligence Index-equivalent scale (~0-100).
// When AA Intelligence Index v5 is published, use it directly; when missing (legacy/non-primary),
// map raw evalComposite (~15-75) conservatively so models remain comparable without inflating old models.
function unifiedPerf(summary) {
  if (!summary) return null
  if (summary.intelligenceIndex != null) return summary.intelligenceIndex
  if (summary.evalScore == null) return null
  // Empirical mapping checked against AA v5: eval ~23 -> ~7, eval ~55 -> ~34, eval ~70 -> ~55
  const mapped = Math.max(2, summary.evalScore * 0.85 - 12)
  return round(mapped, 1)
}

function blended3to1(inPrice, outPrice) {
  if (inPrice == null || outPrice == null) return null
  return (3 * inPrice + outPrice) / 4
}

export function buildCompactBenchmarks({ aaDoc, gwDoc, excludeProviders = [] }) {
  const excludedSet = new Set(
    (Array.isArray(excludeProviders) ? excludeProviders : String(excludeProviders || "").split(","))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  const remapExcluded = (providerID, modelID) => {
    if (!excludedSet.has(String(providerID || "").toLowerCase())) return { providerID, modelID }
    return { providerID: "catalog", modelID }
  }

  const gwByKey = new Map()
  for (const r of gwDoc?.rows ?? []) {
    if (!r?.provider_id || !r?.model_id) continue
    const isExcluded = excludedSet.has(String(r.provider_id).toLowerCase())
    const { providerID, modelID } = remapExcluded(r.provider_id, r.model_id)
    const k = `${providerID}/${modelID}`
    // Prefer non-excluded gateway rows when colliding on catalog/<model_id>
    if (!gwByKey.has(k) || !isExcluded) {
      gwByKey.set(k, isExcluded ? { ...r, provider_id: providerID, tiers: undefined } : r)
    }
  }

  const aaByKey = new Map()
  const aliases = {}
  const models = {}

  for (const row of aaDoc?.rows ?? []) {
    if (!row?.provider_id || !row?.model_id) continue
    if (row.mode && row.mode !== "chat" && row.mode !== "responses") continue
    const isExcluded = excludedSet.has(String(row.provider_id).toLowerCase())
    const { providerID, modelID } = remapExcluded(row.provider_id, row.model_id)
    const key = `${providerID}/${modelID}`
    if (!aaByKey.has(key) || !isExcluded) {
      aaByKey.set(key, isExcluded ? { ...row, provider_id: providerID } : row)
    }
  }

  // Prefer live gateway row metadata (costs/tiers/aliases), enriched by AA rows when matched.
  const allKeys = new Set([...gwByKey.keys(), ...aaByKey.keys()])
  const rowsOut = []

  for (const key of [...allKeys].sort()) {
    const gw = gwByKey.get(key)
    const aaRow = aaByKey.get(key)
    const sourceRow = gw || aaRow
    if (sourceRow?.mode && sourceRow.mode !== "chat" && sourceRow.mode !== "responses") continue

    const in1m = num(gw?.input_per_1M) ?? num(aaRow?.input_per_1M)
    const out1m = num(gw?.output_per_1M) ?? num(aaRow?.output_per_1M)
    const cacheRead1m = num(gw?.cache_read_per_1M) ?? num(aaRow?.cache_read_per_1M)
    const cacheWrite1m = num(gw?.cache_write_per_1M) ?? num(aaRow?.cache_write_per_1M)

    const variantsMap = {}
    let primarySummary = null
    if (aaRow?.aa?.matched) {
      const variants = Array.isArray(aaRow.aa.variants) ? aaRow.aa.variants : []
      for (const v of variants) {
        const s = summarizeVariant(v)
        if (!s) continue
        const perf = unifiedPerf(s)
        const vIn = in1m ?? s.aaInputPer1M
        const vOut = out1m ?? s.aaOutputPer1M
        const vBlend = blended3to1(vIn, vOut)
        const vValue = perf != null && vBlend != null && vBlend > 0 ? round(perf / vBlend, 2) : null
        const vBal = perf != null && vBlend != null ? round(perf / Math.pow(Math.max(vBlend, 0.08), 0.35), 2) : null
        const vEntry = {
          ...s,
          perfScore: perf,
          blended3to1Per1M: round(vBlend, 4),
          valueRatio: vValue,
          balanceScore: vBal,
        }
        const effortKey = String(s.effort || "default").toLowerCase()
        // Keep best-scoring entry if multiple share an effort key
        const prev = variantsMap[effortKey]
        if (!prev || (vEntry.intelligenceIndex ?? -1) > (prev.intelligenceIndex ?? -1) || (vEntry.perfScore ?? -1) > (prev.perfScore ?? -1)) {
          variantsMap[effortKey] = vEntry
        }
        if (aaRow.aa.primary_variant_slug && v.slug === aaRow.aa.primary_variant_slug) {
          primarySummary = vEntry
        }
      }
      if (!primarySummary) {
        const pv = aaRow.aa.primary_variant
        if (pv) {
          const allV = Object.values(variantsMap)
          primarySummary =
            allV.find((x) => x.effort === (pv.effort || "default")) ||
            allV.sort((a, b) => (b.intelligenceIndex ?? b.perfScore ?? 0) - (a.intelligenceIndex ?? a.perfScore ?? 0))[0] ||
            null
        }
      }
    }

    const vList = Object.values(variantsMap)
    const bestVariant = vList
      .slice()
      .sort((a, b) => (b.intelligenceIndex ?? b.perfScore ?? 0) - (a.intelligenceIndex ?? a.perfScore ?? 0))[0] || primarySummary

    const effIn = in1m ?? bestVariant?.aaInputPer1M
    const effOut = out1m ?? bestVariant?.aaOutputPer1M
    const blended = blended3to1(effIn, effOut)
    const perfScore = bestVariant?.perfScore ?? null
    const intel = bestVariant?.intelligenceIndex ?? null

    // Compare both strict ValueRatio (score/price) and balanced utility (score / price^0.35)
    const valueRatio = perfScore != null && blended != null && blended > 0 ? round(perfScore / blended, 2) : null
    const balanceScore = perfScore != null && blended != null ? round(perfScore / Math.pow(Math.max(blended, 0.08), 0.35), 2) : null

    const releaseDeprecated = Boolean(aaRow?.aa?.release?.deprecated)

    const record = {
      key,
      providerID: sourceRow.provider_id,
      id: sourceRow.model_id,
      name: sourceRow.model_name || sourceRow.model_id,
      aliases: Array.isArray(sourceRow.aliases) ? sourceRow.aliases : [],
      releaseName: aaRow?.aa?.release?.name || null,
      releaseSlug: aaRow?.aa?.release?.slug || null,
      releaseDate: aaRow?.aa?.release?.release_date || null,
      creator: aaRow?.aa?.release?.creator?.name || null,
      deprecated: releaseDeprecated,
      maxInputTokens: num(gw?.max_input_tokens) ?? num(aaRow?.max_input_tokens),
      maxOutputTokens: num(gw?.max_output_tokens) ?? num(aaRow?.max_output_tokens),
      effortLevels: Array.isArray(gw?.effort_levels) && gw.effort_levels.length
        ? gw.effort_levels
        : Array.isArray(aaRow?.aa?.effort_levels)
          ? aaRow.aa.effort_levels
          : [],
      pricing: {
        inputPer1M: round(effIn, 4),
        outputPer1M: round(effOut, 4),
        cacheReadPer1M: round(cacheRead1m, 4),
        cacheWritePer1M: round(cacheWrite1m, 4),
        blended3to1Per1M: round(blended, 4),
        tiers: Array.isArray(gw?.tiers) ? gw.tiers : [],
      },
      benchmark: {
        matched: Boolean(aaRow?.aa?.matched),
        intelligenceIndex: intel,
        intelligenceEstimated: intel == null && perfScore != null,
        perfScore,
        codingScore: bestVariant?.codingScore ?? null,
        reasoningScore: bestVariant?.reasoningScore ?? null,
        ifbench: bestVariant?.ifbench ?? null,
        gpqa: bestVariant?.gpqa ?? null,
        terminalBench: bestVariant?.terminalBench ?? null,
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
    rowsOut.push(record)

    // Register lookup aliases (model_id, aliases, normalized release slug), preferring non-catalog rows
    const preferAlias = !key.startsWith("catalog/")
    const idAlias = String(sourceRow.model_id).toLowerCase()
    if (!aliases[idAlias] || preferAlias) aliases[idAlias] = key
    for (const a of record.aliases) {
      const k = String(a).toLowerCase()
      if (!aliases[k] || preferAlias) aliases[k] = key
    }
    if (record.releaseSlug) {
      const s = String(record.releaseSlug).toLowerCase()
      if (!aliases[s] || preferAlias) aliases[s] = key
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    attribution: aaDoc?.source?.attribution || "Data from Artificial Analysis (https://artificialanalysis.ai) combined with local gateway catalog pricing.",
    indexVersion: aaDoc?.source?.intelligence_index_version || "5.0",
    count: rowsOut.length,
    matchedCount: rowsOut.filter((r) => r.benchmark.matched).length,
    models,
    aliases,
  }
}

function isMain() {
  if (!process.argv[1]) return false
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const aaPath = expandHome(argVal("--aa", process.env.MODEL_COMPARISON_FILE || ""))
  const costDir = expandHome(process.env.GATEWAY_COST_DIR || "~/.gateway-cost")
  const gwPath = expandHome(argVal("--gw", join(costDir, "models.json")))
  const outPath = resolve(argVal("--out", join(ROOT, "data", "model-benchmarks.json")))
  const excludeProviders = argVal("--exclude-providers", process.env.BENCHMARK_EXCLUDE_PROVIDERS || "")
  const printTop = process.argv.includes("--summary")

  if (!aaPath) {
    console.error("Usage: node scripts/build-benchmarks.mjs --aa <models_aa_enriched.json> [--gw <models.json>] [--out <path>] [--exclude-providers p1,p2] [--summary]")
    process.exit(1)
  }

  const aaDoc = JSON.parse(readFileSync(aaPath, "utf8"))
  let gwDoc = { rows: [] }
  try {
    gwDoc = JSON.parse(readFileSync(gwPath, "utf8"))
  } catch {}

  const out = buildCompactBenchmarks({ aaDoc, gwDoc, excludeProviders })
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8")

  const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1)
  console.log(`Wrote ${outPath} (${out.count} models, ${out.matchedCount} AA-matched, ${kb} KB)`)

  if (printTop) {
    const scored = Object.values(out.models)
      .filter((m) => m.benchmark.perfScore != null)
      .sort((a, b) => (b.benchmark.balanceScore ?? 0) - (a.benchmark.balanceScore ?? 0))
    console.log("\nTop 25 by Performance-Cost Balance:")
    for (const m of scored.slice(0, 25)) {
      const b = m.benchmark
      const p = m.pricing
      console.log(
        `${m.key.padEnd(42)} | perf=${String(b.perfScore).padStart(4)}${b.intelligenceEstimated ? "*" : " "} code=${String(b.codingScore ?? "-").padStart(4)} | $${String(p.blended3to1Per1M ?? "-").padEnd(6)}/1M | val=${String(b.valueRatio ?? "-").padStart(5)} | bal=${String(b.balanceScore ?? "-").padStart(5)} | spd=${String(b.outputSpeed ?? "-").padStart(3)} | dep=${m.deprecated}`,
      )
    }
    const terras = Object.values(out.models).filter((m) => m.key.includes("terra"))
    console.log("\nTerra models:")
    for (const t of terras) {
      console.log(t.key, JSON.stringify({ efforts: t.effortLevels, pricing: t.pricing, bench: t.benchmark }))
    }
  }
}
