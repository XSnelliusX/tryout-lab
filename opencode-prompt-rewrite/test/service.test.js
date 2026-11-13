import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createService } from "../service.js"
import { resolveGatewaySettings } from "../usage.js"

const GRILL_JSON = JSON.stringify({
  diagnosis: "Auth flow and test expectations are ambiguous.",
  missing_angles: ["Auth mechanism", "Regression test expectation"],
  ready_without_questions: false,
  questions: [
    {
      id: "q1",
      question: "Which auth path is broken?",
      why: "OAuth vs session cookies require different fixes.",
      options: [
        { id: "a", label: "OAuth callback", detail: "Token exchange and redirect" },
        { id: "b", label: "Session middleware", detail: "Cookie verification" },
      ],
    },
  ],
})

const REWRITE_JSON = JSON.stringify({
  rewritten_prompt: "Diagnose the 401 failure in OAuth callback handling and add an integration test.",
  improvements: ["Pinned OAuth callback scope", "Added integration test requirement"],
  recommendation: {
    route_id: "r1",
    variant: "high",
    task_tier: "deep_reasoning",
    reason: "High reasoning effort fits multi-file auth debugging.",
    alternative: {
      route_id: "r2",
      reason: "Faster option if only checking logs.",
    },
  },
  warnings: [],
})

function fixture({ busy = false, sessionModel, modelsList, gatewaySettings, generate, onProgress } = {}) {
  let activeModel = sessionModel ?? { providerID: "openai", id: "gpt-4o-mini" }
  const prompts = []
  const switches = []
  const created = []
  const calls = []
  const progressEvents = []
  const sessions = new Map([["ses_test", { id: "ses_test", title: "Auth bug", model: activeModel, time: busy ? { busy: 2, idle: 1 } : { busy: 1, idle: 2 } }]])
  sessions.set("ses_other", { id: "ses_other", title: "Other window", model: activeModel, time: { busy: 1, idle: 2 } })

  const ctx = {
    options: {},
    location: { directory: "/repo" },
    session: {
      get: async ({ sessionID }) => {
        const s = sessions.get(sessionID)
        if (!s) throw new Error("missing session")
        return { ...s, model: activeModel }
      },
      context: async () => [{ type: "user", text: "login returns 401 after OAuth redirect" }],
      create: async ({ location, model }) => {
        const next = { id: "ses_home_1", location, model, time: { busy: 1, idle: 2 } }
        created.push(next)
        activeModel = model
        sessions.set(next.id, next)
        return next
      },
      switchModel: async ({ model }) => {
        switches.push(model)
        activeModel = model
      },
      prompt: async (args) => prompts.push(args),
    },
    model: {
      default: async () => ({ providerID: "openai", id: "gpt-4o-mini" }),
      list: async () =>
        modelsList ?? [
          { providerID: "anthropic", id: "claude-opus-4", name: "Claude Opus", variants: ["medium", "high"], capabilities: { reasoning: true } },
          { providerID: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
          { providerID: "disabled", id: "old", enabled: false, name: "Disabled" },
        ],
    },
    experimental: {
      generate: {
        text: async (args, opts) => {
          calls.push(args)
          return generate ? generate(args, opts) : { text: REWRITE_JSON }
        },
      },
    },
  }

  return createService(ctx, {
    timeoutMs: 2000,
    gatewaySettings,
    onProgress: (ev) => {
      progressEvents.push(ev)
      onProgress?.(ev)
    },
  }).then((service) => ({
    service,
    ctx,
    prompts,
    switches,
    created,
    calls,
    progressEvents,
    sessions,
    setModel: (m) => { activeModel = m },
    setBusy: (b) => {
      const s = sessions.get("ses_test")
      sessions.set("ses_test", { ...s, time: b ? { busy: 5, idle: 1 } : { busy: 1, idle: 5 } })
    },
  }))
}

test("grill -> rewrite with answers -> refine flow builds context and emits progress events", async () => {
  let step = 0
  const f = await fixture({
    generate: async () => ({ text: step++ === 0 ? GRILL_JSON : REWRITE_JSON }),
  })

  const grillResult = await f.service.grill({
    targetKey: "session:ses_test",
    sessionID: "ses_test",
    text: "fix auth",
    requestID: "req_grill_1",
  })
  assert.equal(grillResult.questions.length, 1)
  assert.equal(grillResult.diagnosis, "Auth flow and test expectations are ambiguous.")
  assert.equal(grillResult.availableModels.length, 2)

  const rewriteResult = await f.service.rewrite({
    targetKey: "session:ses_test",
    sessionID: "ses_test",
    text: "fix auth",
    grillID: "req_grill_1",
    answers: [{ questionID: "q1", question: "Which auth path is broken?", selectedLabels: ["OAuth callback"], customText: "Keep JWT untouched" }],
    requestID: "req_rew_1",
  })
  assert.deepEqual(rewriteResult.route, { providerID: "anthropic", id: "claude-opus-4", variant: "high" })
  assert.ok(f.calls[1].prompt.includes("OAuth callback"))
  assert.ok(f.calls[1].prompt.includes("Keep JWT untouched"))

  await f.service.rewrite({
    targetKey: "session:ses_test",
    sessionID: "ses_test",
    text: "fix auth",
    previousRewrite: rewriteResult.text,
    refineInstruction: "Add negative test cases for expired tokens",
    requestID: "req_ref_1",
  })
  assert.ok(f.calls[2].prompt.includes("Add negative test cases for expired tokens"))

  const phases = f.progressEvents.map((e) => `${e.status}:${e.phase}`)
  assert.ok(phases.includes("running:grilling"))
  assert.ok(phases.includes("questions:awaiting_answers"))
  assert.ok(phases.includes("running:rewriting"))
  assert.ok(phases.includes("running:refining"))
  assert.ok(phases.includes("ready:ready"))
})

test("runs concurrently across different target windows while guarding same window", async () => {
  let releaseFirst
  const firstBarrier = new Promise((r) => { releaseFirst = r })
  const f = await fixture({
    generate: async (args) => {
      if (args.prompt.includes("first window")) await firstBarrier
      return { text: REWRITE_JSON }
    },
  })

  const first = f.service.rewrite({
    targetKey: "session:ses_test",
    sessionID: "ses_test",
    text: "first window prompt",
    requestID: "req_win_1",
  })
  await new Promise((r) => setTimeout(r, 15))

  const snap = f.service.jobs()
  assert.equal(snap.active.length, 1)
  assert.equal(snap.active[0].targetKey, "session:ses_test")

  await assert.rejects(
    f.service.rewrite({ targetKey: "session:ses_test", sessionID: "ses_test", text: "dup", requestID: "req_win_dup" }),
    /already running for this window/,
  )

  const second = await f.service.rewrite({
    targetKey: "session:ses_other",
    sessionID: "ses_other",
    text: "second window prompt",
    requestID: "req_win_2",
  })
  assert.equal(second.targetKey, "session:ses_other")

  releaseFirst()
  const finished = await first
  assert.equal(finished.targetKey, "session:ses_test")
  assert.equal(f.service.jobs().active.length, 0)
})

test("cancel aborts in-flight generation by targetKey or requestID", async () => {
  const f = await fixture({
    generate: async (_args, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }),
  })

  const promise = f.service.rewrite({
    targetKey: "session:ses_test",
    sessionID: "ses_test",
    text: "slow prompt",
    requestID: "req_cancel_1",
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(f.service.cancel({ targetKey: "session:ses_test" }), { cancelled: true })
  assert.deepEqual(f.service.cancel({ requestID: "unknown" }), { cancelled: false })
  await assert.rejects(promise, /cancelled or timed out/)
  assert.ok(f.progressEvents.some((e) => e.status === "cancelled" && e.requestID === "req_cancel_1"))
})

test("submit allows edited prompt text and explicit selectedModel override, enforces safety guards", async () => {
  const f = await fixture()
  const proposal = await f.service.propose({
    sessionID: "ses_test",
    text: "fix auth",
    requestID: "req_sub_1",
  })

  const edited = "Edited prompt with extra constraint."
  const chosen = { providerID: "anthropic", id: "claude-opus-4", variant: "medium" }
  const submitted = await f.service.submit({
    resultID: proposal.id,
    text: edited,
    applyRoute: true,
    selectedModel: chosen,
  })
  assert.deepEqual(submitted, { sessionID: "ses_test", queued: false, switched: true })
  assert.deepEqual(f.switches[0], chosen)
  assert.equal(f.prompts[0].text, edited)

  await assert.rejects(
    f.service.submit({ resultID: proposal.id, text: edited, applyRoute: false }),
    /expired/,
  )
})

test("submit guards against busy session or model change when applying route", async () => {
  const f = await fixture()
  const p1 = await f.service.rewrite({ sessionID: "ses_test", text: "fix", requestID: "req_busy_1" })
  f.setBusy(true)
  await assert.rejects(
    f.service.submit({ resultID: p1.id, text: p1.text, applyRoute: true }),
    /session is busy/i,
  )
  const queuedOk = await f.service.submit({ resultID: p1.id, text: p1.text, applyRoute: false })
  assert.equal(queuedOk.queued, true)
  assert.equal(queuedOk.switched, false)

  f.setBusy(false)
  const p2 = await f.service.rewrite({ sessionID: "ses_test", text: "fix 2", requestID: "req_mut_1" })
  f.setModel({ providerID: "anthropic", id: "claude-opus-4" })
  await assert.rejects(
    f.service.submit({ resultID: p2.id, text: p2.text, applyRoute: true }),
    /session model changed/,
  )
})

test("start screen stays stateless until submit and retry reuses created session on failure", async () => {
  const f = await fixture()
  const proposal = await f.service.rewrite({
    text: "build feature x",
    requestID: "req_home_1",
  })
  assert.equal(f.created.length, 0)
  assert.equal(proposal.sessionID, null)

  let failOnce = true
  f.ctx.session.prompt = async (args) => {
    if (failOnce) {
      failOnce = false
      throw new Error("rpc hiccup")
    }
    f.prompts.push(args)
  }

  await assert.rejects(
    f.service.submit({ resultID: proposal.id, text: proposal.text, applyRoute: true }),
    /New session: ses_home_1; retrying this proposal reuses it/,
  )
  assert.equal(f.created.length, 1)

  const retried = await f.service.submit({ resultID: proposal.id, text: proposal.text, applyRoute: true })
  assert.equal(retried.sessionID, "ses_home_1")
  assert.equal(f.created.length, 1)
  assert.equal(f.prompts.length, 1)
})

function assertStrictJson(value, path = "$") {
  assert.notEqual(value, undefined, `Unexpected undefined at ${path}`)
  if (value === null) return
  if (typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `Non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertStrictJson(item, `${path}[${i}]`))
    return
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assert.notEqual(v, undefined, `Unexpected undefined key at ${path}.${k}`)
      assertStrictJson(v, `${path}.${k}`)
    }
    return
  }
  assert.fail(`Invalid JSON type ${typeof value} at ${path}`)
}

test("models, grill, rewrite, jobs and progress payloads contain only strict JSON values (no undefined)", async () => {
  let step = 0
  const f = await fixture({
    sessionModel: { providerID: "openai", id: "gpt-4o-mini", variant: undefined, extra: undefined },
    generate: async () => ({ text: step++ === 0 ? GRILL_JSON : REWRITE_JSON }),
  })
  assertStrictJson(await f.service.models(), "models")
  assertStrictJson(
    await f.service.grill({ targetKey: "session:ses_test", sessionID: "ses_test", text: "fix auth", requestID: "req_json_1" }),
    "grill",
  )
  assertStrictJson(
    await f.service.rewrite({ targetKey: "session:ses_test", sessionID: "ses_test", text: "fix auth", requestID: "req_json_2" }),
    "rewrite",
  )
  assertStrictJson(f.service.jobs(), "jobs")
  assertStrictJson(f.progressEvents, "progressEvents")
})

test("models RPC lists normalized UI models and provider failures never leak secrets", async () => {
  const f = await fixture({
    generate: async () => {
      throw new Error("Bearer sk-secret-token failed")
    },
  })
  const list = await f.service.models()
  assert.deepEqual(list.models.map((m) => m.id), ["claude-opus-4", "gpt-4o-mini"])

  await assert.rejects(
    async () => {
      try {
        await f.service.rewrite({ sessionID: "ses_test", text: "hi", requestID: "req_sec_1" })
      } catch (err) {
        assert.doesNotMatch(err.message, /sk-secret/)
        throw err
      }
    },
    /Rewrite generation failed/,
  )
})

test("service defaults base rewrite model to terra on low and logs gateway usage.jsonl", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-svc-"))
  try {
    const gatewaySettings = resolveGatewaySettings({
      GATEWAY_COST_DIR: dir,
      GATEWAY_ENV_FILE: join(dir, "missing.env"),
    })
    let step = 0
    const f = await fixture({
      sessionModel: { providerID: "acc-anthropic", id: "claude-5.5-opus-anthropic" },
      modelsList: [
        {
          providerID: "acc-openai",
          id: "gpt-6.1-terra-openai",
          name: "GPT 6.1 Terra",
          variants: ["none", "low", "medium", "high", "xhigh", "max"],
          cost: { input: 1, output: 5 },
        },
        {
          providerID: "acc-anthropic",
          id: "claude-5.5-haiku-anthropic",
          name: "Claude 5.5 Haiku",
          cost: { input: 0.1, output: 0.5 },
        },
        {
          providerID: "acc-anthropic",
          id: "claude-5.5-opus-anthropic",
          name: "Claude 5.5 Opus",
          cost: { input: 5, output: 17 },
        },
      ],
      gatewaySettings,
      generate: async () => ({
        text: step++ === 0
          ? GRILL_JSON
          : JSON.stringify({
              rewritten_prompt: "Add unit test coverage for auth callback.",
              improvements: ["Added unit test scope"],
              recommendation: {
                route_id: "r1",
                task_tier: "quick",
                reason: "Best performance-cost value for a focused task.",
              },
              warnings: [],
            }),
      }),
    })

    const modelsResp = await f.service.models()
    assert.equal(modelsResp.defaultRewriteModel, "acc-openai/gpt-6.1-terra-openai#low")
    assertStrictJson(modelsResp, "terraModels")

    const grillRes = await f.service.grill({
      targetKey: "session:ses_test",
      sessionID: "ses_test",
      text: "add tests",
      requestID: "req_terra_grill_1",
    })
    assert.equal(grillRes.model, "acc-openai/gpt-6.1-terra-openai#low")
    assert.deepEqual(f.calls[0].model, { providerID: "acc-openai", id: "gpt-6.1-terra-openai", variant: "low" })
    assert.ok(grillRes.usage.costUSD > 0)

    const rewriteRes = await f.service.rewrite({
      targetKey: "session:ses_test",
      sessionID: "ses_test",
      text: "add tests",
      grillID: grillRes.id,
      requestID: "req_terra_rw_1",
    })
    assert.equal(rewriteRes.model, "acc-openai/gpt-6.1-terra-openai#low")
    assert.equal(rewriteRes.route.id, "claude-5.5-haiku-anthropic")
    assert.ok(rewriteRes.routeBenchmark?.perfScore > 30)
    assertStrictJson(rewriteRes, "terraRewrite")

    const lines = readFileSync(gatewaySettings.usageLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].tool, "prompt-rewriter")
    assert.equal(lines[0].agent, "grill")
    assert.equal(lines[0].model_id, "gpt-6.1-terra-openai")
    assert.equal(lines[1].tool, "prompt-rewriter")
    assert.equal(lines[1].agent, "rewrite")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("inspect and dismiss manage completed and in-flight jobs across targets", async () => {
  let rejectInFlight
  let callIdx = 0
  const f = await fixture({
    generate: (_args, opts) => {
      callIdx += 1
      if (callIdx <= 2) return Promise.resolve({ text: REWRITE_JSON })
      return new Promise((_, reject) => {
        rejectInFlight = reject
        opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })))
      })
    },
  })

  // 1. Finished proposal can be inspected and dismissed cleanly
  const rw = await f.service.rewrite({
    targetKey: "session:ses_test",
    sessionID: "ses_test",
    text: "improve tests",
    requestID: "req_fin_1",
  })
  const inspected = await f.service.inspect({ targetKey: "session:ses_test" })
  assert.equal(inspected.kind, "proposal")
  assert.equal(inspected.proposal.id, rw.id)

  const dismissed = await f.service.dismiss({ targetKey: "session:ses_test", requestID: "req_fin_1" })
  assert.equal(dismissed.dismissed, true)
  const afterDismiss = await f.service.inspect({ targetKey: "session:ses_test" })
  assert.equal(afterDismiss.kind, "none")

  // 2. Submitting cleans up inspectable state
  const rw2 = await f.service.rewrite({
    targetKey: "session:ses_test",
    sessionID: "ses_test",
    text: "improve tests again",
    requestID: "req_fin_2",
  })
  await f.service.submit({ resultID: rw2.id, text: rw2.text, applyRoute: false })
  const afterSubmit = await f.service.inspect({ targetKey: "session:ses_test" })
  assert.equal(afterSubmit.kind, "none")

  // 3. In-flight job is aborted and immediately cleared from active jobs by dismiss
  const pendingPromise = f.service.rewrite({
    targetKey: "session:ses_other",
    sessionID: "ses_other",
    text: "long running",
    requestID: "req_live_1",
  })
  await new Promise((r) => setTimeout(r, 20))
  const midInspect = await f.service.inspect({ targetKey: "session:ses_other" })
  assert.equal(midInspect.kind, "running")
  assert.equal(midInspect.snapshot.requestID, "req_live_1")

  const killRes = await f.service.dismiss({ targetKey: "session:ses_other", requestID: "req_live_1" })
  assert.equal(killRes.dismissed, true)
  const jobsAfter = await f.service.jobs()
  assert.equal(jobsAfter.active.length, 0)
  await assert.rejects(pendingPromise)
  rejectInFlight?.(new Error("done"))
})
