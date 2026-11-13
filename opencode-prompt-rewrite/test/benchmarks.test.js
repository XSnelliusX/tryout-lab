import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  blended3to1,
  computeValueMetrics,
  formatBenchmarkChip,
  formatVariantsNote,
  loadBenchmarks,
  lookupBenchmark,
  selectCandidateRoutes,
} from "../benchmarks.js"

test("loadBenchmarks loads compact AA dataset with zero org-specific keys", () => {
  const db = loadBenchmarks()
  assert.ok(Object.keys(db.models).length >= 150)
  assert.ok(db.models["acc-openai/gpt-6.1-terra-openai"])
  const raw = readFileSync(new URL("../data/model-benchmarks.json", import.meta.url), "utf8")
  const orgPattern = new RegExp(`t${"re"}nd`, "i")
  assert.equal(orgPattern.test(raw), false, "Bundled benchmark data must not contain internal org strings")
})

test("lookupBenchmark resolves model and variant effort metrics and computes live price balance", () => {
  const db = loadBenchmarks()

  const terraLow = lookupBenchmark(
    { providerID: "acc-openai", id: "gpt-6.1-terra-openai", cost: { input: 1, output: 5 } },
    "low",
    db,
  )
  assert.ok(terraLow)
  assert.equal(terraLow.effort, "low")
  assert.equal(terraLow.blended3to1Per1M, 2)
  assert.ok(terraLow.perfScore >= 25 && terraLow.perfScore <= 35)
  assert.ok(terraLow.balanceScore > 0)

  const terraHigh = lookupBenchmark(
    { providerID: "acc-openai", id: "gpt-6.1-terra-openai", cost: { input: 1, output: 5 } },
    "high",
    db,
  )
  assert.ok(terraHigh.perfScore > terraLow.perfScore)

  const haiku = lookupBenchmark({ providerID: "acc-anthropic", id: "claude-5.5-haiku-anthropic" }, null, db)
  assert.ok(haiku)
  assert.ok(haiku.balanceScore > 50)
  assert.match(formatBenchmarkChip(haiku), /perf 36\.5.*bal/)

  const vNote = formatVariantsNote({ providerID: "acc-openai", id: "gpt-6.1-terra-openai" }, db)
  assert.match(vNote, /low perf/)
  assert.match(vNote, /high perf/)
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

test("selectCandidateRoutes selects budget, balanced, frontier, current and default Terra within cap", () => {
  const db = loadBenchmarks()
  const syntheticLarge = Object.values(db.models)
    .filter((r) => r.providerID !== "catalog")
    .map((r) => ({
      providerID: r.providerID,
      id: r.id,
      name: r.name,
      variants: r.effortLevels,
      cost: { input: r.pricing.inputPer1M, output: r.pricing.outputPer1M },
    }))

  const current = { providerID: "acc-anthropic", id: "claude-5.5-opus-anthropic" }
  const defaultTerra = { providerID: "acc-openai", id: "gpt-6.1-terra-openai", variant: "low" }
  const picked = selectCandidateRoutes(syntheticLarge, current, db, { limit: 24, defaultRewrite: defaultTerra })

  assert.equal(picked.length, 24)
  const keys = new Set(picked.map((x) => x.key))
  assert.ok(keys.has("acc-anthropic/claude-5.5-opus-anthropic"))
  assert.ok(keys.has("acc-openai/gpt-6.1-terra-openai"))
  assert.ok(
    picked.some((x) => (x.bench?.blended3to1Per1M ?? Infinity) <= 0.5 && (x.bench?.balanceScore ?? 0) >= 45),
    "Expected at least one budget high-value model in curated routes",
  )
  assert.ok(
    picked.some((x) => (x.bench?.perfScore ?? 0) >= 50),
    "Expected at least one frontier model in curated routes",
  )
})
