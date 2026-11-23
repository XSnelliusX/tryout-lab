import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  benchmarkHint,
  blended3to1,
  buildBenchmarkDb,
  computeValueMetrics,
  formatBenchmarkChip,
  formatVariantsNote,
  loadBenchmarks,
  lookupBenchmark,
  resetBenchmarkCache,
  selectCandidateRoutes,
} from "../benchmarks.js"
import { CATALOG, COMPARISON, makeGatewayDir } from "./fixtures.js"

test("buildBenchmarkDb joins catalog rows with comparison variants and skips non-chat rows", () => {
  const db = buildBenchmarkDb({ catalog: CATALOG, comparison: COMPARISON })
  assert.deepEqual(Object.keys(db.models).sort(), [
    "gw-alpha/model-a",
    "gw-alpha/model-b",
    "gw-beta/model-a-beta",
    "gw-beta/model-c",
  ])
  assert.deepEqual(db.gatewayProviders, ["gw-alpha", "gw-beta"])
  assert.equal(db.hasCatalog, true)
  assert.equal(db.hasBenchmarks, true)
  assert.equal(db.attribution, "Test attribution")

  const a = db.models["gw-alpha/model-a"]
  assert.equal(a.benchmark.matched, true)
  assert.equal(a.benchmark.perfScore, 45)
  assert.equal(a.benchmark.bestEffort, "high")
  assert.equal(a.benchmark.primaryEffort, "high")
  assert.deepEqual(Object.keys(a.benchmark.variants).sort(), ["high", "low"])
  assert.equal(a.benchmark.variants.low.perfScore, 30)
  assert.equal(a.benchmark.variants.high.ttft, 12)
  assert.equal(a.benchmark.capabilities.engineering, 47)
  assert.equal(a.pricing.inputPer1M, 1)
  assert.equal(a.pricing.tiers.length, 1)
  assert.equal(a.maxInputTokens, 200000)
  assert.equal(a.firstParty, true)
  assert.equal(db.models["gw-beta/model-a-beta"].firstParty, false)
  assert.equal(db.models["gw-beta/model-c"].deprecated, true)

  // Variant is scoped to providers listed by the comparison; model-b has no intelligence index but is matched.
  const b = db.models["gw-alpha/model-b"]
  assert.equal(b.benchmark.matched, true)
  assert.equal(b.benchmark.intelligenceEstimated, true)
  assert.equal(b.benchmark.variants["non-reasoning"].effort, "non-reasoning")

  // Aliases: ids, catalog aliases, release slug, and provider-token suffix stripping derived from catalog fields.
  assert.equal(db.aliases["model-a-latest"], "gw-alpha/model-a")
  assert.equal(db.aliases["model-a-release"], "gw-alpha/model-a")
  assert.equal(db.aliases["model-c"], "gw-beta/model-c")
})

test("buildBenchmarkDb without a comparison keeps prices, limits and capabilities but no scores", () => {
  const db = buildBenchmarkDb({ catalog: CATALOG, comparison: null })
  assert.equal(db.hasCatalog, true)
  assert.equal(db.hasBenchmarks, false)
  const a = db.models["gw-alpha/model-a"]
  assert.equal(a.benchmark.matched, false)
  assert.equal(a.benchmark.perfScore, null)
  assert.equal(a.pricing.blended3to1Per1M, 2)
  assert.equal(a.capabilities.vision, true)
  const hit = lookupBenchmark({ providerID: "gw-alpha", id: "model-a" }, null, db)
  assert.equal(hit.perfScore, undefined)
  assert.equal(hit.blended3to1Per1M, 2)
  assert.equal(benchmarkHint(db), "run /model-comparison for benchmark scores")
})

test("buildBenchmarkDb tolerates missing or empty inputs", () => {
  for (const input of [undefined, {}, { catalog: null, comparison: null }, { catalog: { rows: [] }, comparison: { models: [] } }]) {
    const db = buildBenchmarkDb(input)
    assert.deepEqual(db.models, {})
    assert.equal(db.hasCatalog, false)
    assert.equal(db.hasBenchmarks, false)
  }
})

test("loadBenchmarks builds from gateway files, caches by mtime, and reflects file changes", () => {
  const g = makeGatewayDir({ comparison: null })
  try {
    resetBenchmarkCache()
    const first = loadBenchmarks({ settings: g.settings })
    assert.equal(first.hasBenchmarks, false)
    assert.equal(Object.keys(first.models).length, 4)
    assert.equal(loadBenchmarks({ settings: g.settings }), first, "cached while files are unchanged")

    mkdirSync(join(g.dir, "model-comparison", "data"), { recursive: true })
    writeFileSync(g.settings.comparisonPath, JSON.stringify(COMPARISON))
    const second = loadBenchmarks({ settings: g.settings })
    assert.notEqual(second, first)
    assert.equal(second.hasBenchmarks, true)
    assert.equal(benchmarkHint(second), null)
  } finally {
    g.cleanup()
    resetBenchmarkCache()
  }
})

test("loadBenchmarks returns an empty db when nothing is installed", () => {
  const g = makeGatewayDir({ catalog: null, comparison: null })
  try {
    resetBenchmarkCache()
    const db = loadBenchmarks({ settings: g.settings })
    assert.deepEqual(db.models, {})
    assert.equal(db.hasCatalog, false)
  } finally {
    g.cleanup()
    resetBenchmarkCache()
  }
})

test("PROMPT_REWRITE_BENCHMARKS_FILE / opts.path override loads a prebuilt db", () => {
  const g = makeGatewayDir({ catalog: null, comparison: null })
  try {
    const file = join(g.dir, "prebuilt.json")
    writeFileSync(file, JSON.stringify(buildBenchmarkDb({ catalog: CATALOG, comparison: COMPARISON })))
    resetBenchmarkCache()
    const viaOpt = loadBenchmarks({ path: file })
    assert.ok(viaOpt.models["gw-alpha/model-a"])
    assert.equal(viaOpt.hasBenchmarks, true)

    process.env.PROMPT_REWRITE_BENCHMARKS_FILE = file
    try {
      resetBenchmarkCache()
      assert.ok(loadBenchmarks({ settings: g.settings }).models["gw-beta/model-c"])
    } finally {
      delete process.env.PROMPT_REWRITE_BENCHMARKS_FILE
      resetBenchmarkCache()
    }
  } finally {
    g.cleanup()
  }
})

test("lookupBenchmark resolves variant effort metrics and prefers live prices", () => {
  const db = buildBenchmarkDb({ catalog: CATALOG, comparison: COMPARISON })

  const low = lookupBenchmark({ providerID: "gw-alpha", id: "model-a", cost: { input: 1, output: 5 } }, "low", db)
  assert.equal(low.effort, "low")
  assert.equal(low.blended3to1Per1M, 2)
  assert.equal(low.perfScore, 30)
  assert.ok(low.balanceScore > 0)

  const high = lookupBenchmark({ providerID: "gw-alpha", id: "model-a" }, "high", db)
  assert.equal(high.perfScore, 45)
  assert.match(formatBenchmarkChip(high), /perf 45\.0.*bal/)

  // Alias and loose version-separator resolution
  assert.equal(lookupBenchmark({ providerID: "other", id: "model-a-latest" }, null, db).key, "gw-alpha/model-a")

  const note = formatVariantsNote({ providerID: "gw-alpha", id: "model-a" }, db)
  assert.match(note, /low perf 30/)
  assert.match(note, /high perf 45/)

  // Unknown model with live cost still returns price-only metrics; with nothing, null.
  assert.deepEqual(lookupBenchmark({ providerID: "x", id: "unknown", cost: { input: 1, output: 3 } }, null, db), {
    matched: false,
    inputPer1M: 1,
    outputPer1M: 3,
    blended3to1Per1M: 1.5,
  })
  assert.equal(lookupBenchmark({ providerID: "x", id: "unknown" }, null, db), null)
})

test("blended3to1 and computeValueMetrics handle valid and zero-cost models safely", () => {
  assert.equal(blended3to1(1, 5), 2)
  const paid = computeValueMetrics(50, 2)
  assert.equal(paid.valueRatio, 25)
  assert.ok(paid.balanceScore > 30)

  const free = computeValueMetrics(30, 0)
  assert.equal(free.valueRatio, null)
  assert.ok(Number.isFinite(free.balanceScore))
})

function routeModels(db) {
  return Object.values(db.models).map((r) => ({
    providerID: r.providerID,
    id: r.id,
    name: r.name,
    cost: { input: r.pricing.inputPer1M, output: r.pricing.outputPer1M },
  }))
}

test("selectCandidateRoutes keeps current and default models, dedupes deployments, and respects the cap", () => {
  const db = buildBenchmarkDb({ catalog: CATALOG, comparison: COMPARISON })
  const models = routeModels(db)
  const current = { providerID: "gw-beta", id: "model-c" }
  const picked = selectCandidateRoutes(models, current, db, {
    limit: 3,
    defaultRewrite: { providerID: "gw-alpha", id: "model-b" },
  })
  const keys = picked.map((x) => x.key)
  assert.equal(picked.length, 3)
  assert.ok(keys.includes("gw-beta/model-c"))
  assert.ok(keys.includes("gw-alpha/model-b"))
})

test("selectCandidateRoutes provider preference is data-driven: preferredProviders, then first-party routes", () => {
  const db = buildBenchmarkDb({ catalog: CATALOG, comparison: COMPARISON })
  // model-a is served by gw-alpha (creator's own route) and gw-beta (same price, different id so both survive dedupe by id).
  const same = [
    { providerID: "gw-beta", id: "model-a", cost: { input: 1, output: 5 } },
    { providerID: "gw-alpha", id: "model-a", cost: { input: 1, output: 5 } },
  ]
  const pickFor = (options) =>
    selectCandidateRoutes(same, null, db, { limit: 1, ...options }).map((x) => x.key)
  assert.deepEqual(pickFor({}), ["gw-alpha/model-a"], "first-party route wins ties by default")
  assert.deepEqual(pickFor({ preferredProviders: ["gw-beta"] }), ["gw-beta/model-a"])
  assert.deepEqual(
    selectCandidateRoutes(same, { providerID: "gw-beta", id: "zzz" }, db, { limit: 1 }).map((x) => x.key),
    ["gw-beta/model-a"],
    "session provider outranks everything",
  )
})
