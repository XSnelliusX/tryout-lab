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
import { isGatewayProvider, loadGatewayCatalog } from "../gateway.js"
import { isolateGatewayEnv } from "./fixtures.js"

isolateGatewayEnv()

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
            provider_id: "gw-alpha",
            model_id: "model-a",
            model_name: "Model A",
            upstream_provider: "alpha",
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
      { providerID: "gw-alpha", id: "model-a" },
      10000,
      { catalogModelsPath: modelsPath },
    )
    assert.equal(base.inputPer1M, 1)
    assert.equal(base.outputPer1M, 5)
    assert.equal(base.billing, "gateway")

    const tiered = resolveModelPricing(
      { providerID: "gw-alpha", id: "model-a" },
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
    writeFileSync(
      settings.catalogModelsPath,
      JSON.stringify({ rows: [{ provider_id: "gw-alpha", model_id: "model-a", input_per_1M: 1, output_per_1M: 5 }] }),
    )

    const stats = buildUsageStats({
      generated: { text: "improved prompt", usage: { inputTokens: 10000, outputTokens: 2000, reasoningTokens: 500 } },
      promptText: "draft",
      outputText: "improved prompt",
      model: {
        providerID: "gw-alpha",
        id: "model-a",
        name: "Model A",
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

test("gateway membership comes from the catalog's providers or the configured prefix, never a hardcoded id", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-gwm-"))
  try {
    const env = { GATEWAY_COST_DIR: dir, GATEWAY_ENV_FILE: join(dir, "env"), GATEWAY_PROVIDER_PREFIX: "" }
    writeFileSync(join(dir, "env"), "export GATEWAY_PROVIDER_PREFIX=gwx\n# comment\n")
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ base_url: "https://invalid.example", rows: [{ provider_id: "gw-alpha", model_id: "model-a" }] }),
    )
    const settings = resolveGatewaySettings(env)
    assert.equal(settings.providerPrefix, "gwx", "env file supplies GATEWAY_PROVIDER_PREFIX when the env var is empty")
    assert.equal(resolveGatewaySettings({ ...env, GATEWAY_PROVIDER_PREFIX: "other-" }).providerPrefix, "other")
    const catalog = loadGatewayCatalog(settings.catalogModelsPath)

    assert.equal(isGatewayProvider("gw-alpha", catalog, settings), true, "listed in catalog")
    assert.equal(isGatewayProvider("gwx-new", catalog, settings), true, "configured prefix")
    assert.equal(isGatewayProvider("native", catalog, settings), false)
    assert.equal(isGatewayProvider("gw-other", catalog, { providerPrefix: "" }), false, "no prefix configured")

    const priced = resolveModelPricing({ providerID: "gw-other", id: "m", cost: { input: 1, output: 2 } }, 0, { catalog, settings })
    assert.equal(priced.billing, "other")
    const viaPrefix = resolveModelPricing({ providerID: "gwx-new", id: "m", cost: { input: 1, output: 2 } }, 0, { catalog, settings })
    assert.equal(viaPrefix.billing, "gateway")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
