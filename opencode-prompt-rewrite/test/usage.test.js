import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildUsageStats,
  extractTokenCounts,
  formatUsd,
  recordGatewayUsage,
  resolveGatewaySettings,
  resolveModelPricing,
} from "../usage.js"

test("extractTokenCounts uses reported usage when available and estimates otherwise", () => {
  const exact = extractTokenCounts(
    { text: "ok", usage: { inputTokens: 1200, outputTokens: 350, reasoningTokens: 150, cacheReadTokens: 400 } },
    "ignored prompt",
    "ignored output",
  )
  assert.equal(exact.estimated, false)
  assert.equal(exact.inputTokens, 1200)
  assert.equal(exact.outputTokens, 350)
  assert.equal(exact.reasoningTokens, 150)
  assert.equal(exact.totalTokens, 2100)

  const est = extractTokenCounts({ text: "abcd".repeat(25) }, "x".repeat(400), "y".repeat(100))
  assert.equal(est.estimated, true)
  assert.equal(est.inputTokens, 100)
  assert.equal(est.outputTokens, 25)
  assert.equal(est.totalTokens, 125)
})

test("resolveModelPricing applies gateway catalog prices including context tiers", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-usage-"))
  try {
    const modelsPath = join(dir, "models.json")
    writeFileSync(
      modelsPath,
      JSON.stringify({
        rows: [
          {
            provider_id: "acc-openai",
            model_id: "gpt-6.1-terra-openai",
            model_name: "GPT 6.1 Terra",
            upstream_provider: "openai",
            input_per_1M: 1,
            output_per_1M: 5,
            cache_read_per_1M: 0.05,
            cache_write_per_1M: 1.25,
            tiers: [{ size: 272000, input_per_1M: 2, output_per_1M: 7.5, cache_read_per_1M: 0.1 }],
          },
        ],
      }),
    )

    const base = resolveModelPricing(
      { providerID: "acc-openai", id: "gpt-6.1-terra-openai" },
      10000,
      { catalogModelsPath: modelsPath },
    )
    assert.equal(base.inputPer1M, 1)
    assert.equal(base.outputPer1M, 5)
    assert.equal(base.billing, "gateway")

    const tiered = resolveModelPricing(
      { providerID: "acc-openai", id: "gpt-6.1-terra-openai" },
      300000,
      { catalogModelsPath: modelsPath },
    )
    assert.equal(tiered.inputPer1M, 2)
    assert.equal(tiered.outputPer1M, 7.5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buildUsageStats and recordGatewayUsage log gateway-compatible JSONL under prompt-rewriter tool", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-log-"))
  try {
    const settings = resolveGatewaySettings({
      GATEWAY_COST_DIR: dir,
      GATEWAY_ENV_FILE: join(dir, "missing.env"),
    })
    assert.equal(settings.costDir, dir)
    assert.equal(settings.usageDisabled, false)

    const stats = buildUsageStats({
      generated: { text: "improved prompt", usage: { inputTokens: 10000, outputTokens: 2000, reasoningTokens: 500 } },
      promptText: "draft",
      outputText: "improved prompt",
      model: {
        providerID: "acc-openai",
        id: "gpt-6.1-terra-openai",
        name: "GPT 6.1 Terra",
        cost: { input: 1, output: 5, cache: { read: 0.05, write: 1.25 } },
      },
      settings,
    })

    // 10k * $1/1M = $0.01; (2000 + 500) * $5/1M = $0.0125 => $0.0225
    assert.equal(stats.costUSD, 0.0225)
    assert.equal(stats.estimated, false)
    assert.equal(formatUsd(stats.costUSD, false), "$0.022")

    const logged = recordGatewayUsage({
      requestID: "req_12345678",
      phase: "rewrite",
      sessionID: "ses_abc",
      stats,
      settings,
      timestamp: "2026-11-13T05:00:00.000Z",
    })
    assert.equal(logged.logged, true)

    const lines = readFileSync(settings.usageLogPath, "utf8").trim().split("\n")
    assert.equal(lines.length, 1)
    const row = JSON.parse(lines[0])
    assert.equal(row.event_id, "rw:req_12345678:rewrite")
    assert.equal(row.tool, "prompt-rewriter")
    assert.equal(row.agent, "rewrite")
    assert.equal(row.billing, "gateway")
    assert.equal(row.gateway, true)
    assert.equal(row.input_tokens, 10000)
    assert.equal(row.output_tokens, 2000)
    assert.equal(row.reasoning_tokens, 500)
    assert.equal(row.cost, 0.0225)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
