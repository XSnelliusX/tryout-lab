import test from "node:test"
import assert from "node:assert/strict"
import {
  candidateRoutes,
  compactModelName,
  extractJsonObject,
  findDefaultRewriteModel,
  findModel,
  formatRoutesForPrompt,
  makeGrillMessages,
  makeMessages,
  makeRewriteMessages,
  modelRef,
  parseGrillResponse,
  parseInvocation,
  parseModelRef,
  parseProposal,
  recentContext,
  serializeModelsForUI,
  variants,
} from "../core.js"

const MODELS = [
  {
    providerID: "anthropic",
    id: "claude-opus-4",
    name: "Claude Opus",
    family: "claude",
    variants: ["low", "medium", "high"],
    capabilities: { reasoning: true, toolcall: true },
    limit: { context: 200000, output: 32000 },
    cost: { input: 15, output: 75 },
  },
  {
    providerID: "openai",
    id: "gpt-5",
    name: "GPT-5",
    family: "gpt",
    variants: [{ id: "minimal" }, { id: "high" }],
    capabilities: { reasoning: true, toolcall: true },
    limit: { context: 256000, output: 32000 },
    cost: [{ input: 5, output: 15 }],
  },
  { providerID: "disabled", id: "old", enabled: false, name: "Disabled" },
  { providerID: "embed", id: "text-embedding-3", type: "embedding", name: "Embedder" },
]

test("parseInvocation parses flags, short aliases, mode, help and text", () => {
  assert.deepEqual(parseInvocation("  make tests faster  "), {
    model: undefined,
    mode: "grill",
    help: false,
    text: "make tests faster",
  })
  assert.deepEqual(parseInvocation("--model=openai/gpt-5#high --fast add unit tests"), {
    model: "openai/gpt-5#high",
    mode: "direct",
    help: false,
    text: "add unit tests",
  })
  assert.deepEqual(parseInvocation("-m anthropic/claude-opus-4 --no-grill --grill fix auth"), {
    model: "anthropic/claude-opus-4",
    mode: "grill",
    help: false,
    text: "fix auth",
  })
  assert.deepEqual(parseInvocation("--direct check logs"), {
    model: undefined,
    mode: "direct",
    help: false,
    text: "check logs",
  })
  assert.deepEqual(parseInvocation("--help"), {
    model: undefined,
    mode: "grill",
    help: true,
    text: "",
  })
  assert.throws(() => parseInvocation("--model"), /Flag --model requires a value/)
  assert.throws(() => parseInvocation("-m="), /Flag --model requires a value/)
})

test("parseModelRef, modelRef, compactModelName and findModel validate availability", () => {
  assert.deepEqual(parseModelRef("openai/gpt-5#high"), { providerID: "openai", id: "gpt-5", variant: "high" })
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude-3.5-sonnet#medium"), {
    providerID: "openrouter",
    id: "anthropic/claude-3.5-sonnet",
    variant: "medium",
  })
  assert.throws(() => parseModelRef("gpt-5"))
  assert.throws(() => parseModelRef("provider/model#a/b"))
  assert.throws(() => parseModelRef("provider/"))
  assert.equal(compactModelName("anthropic/claude-opus-4#high"), "claude-opus-4#high")
  assert.equal(compactModelName(undefined), "default")
  assert.equal(modelRef({ providerID: "openai", id: "gpt-5", variant: "high" }), "openai/gpt-5#high")

  assert.equal(findModel(MODELS, { providerID: "openai", id: "gpt-5", variant: "high" }).id, "gpt-5")
  assert.throws(() => findModel(MODELS, { providerID: "disabled", id: "old" }), /Model\/effort unavailable/)
  assert.throws(() => findModel(MODELS, { providerID: "openai", id: "gpt-5", variant: "max" }), /Model\/effort unavailable/)
})

test("serializeModelsForUI excludes disabled/non-chat models and omits undefined fields for strict JSON RPC validation", () => {
  const uiModels = serializeModelsForUI([
    ...MODELS,
    { providerID: "minimal", id: "bare-model" },
  ])
  assert.deepEqual(
    uiModels.map((m) => `${m.providerID}/${m.id}`),
    ["anthropic/claude-opus-4", "minimal/bare-model", "openai/gpt-5"],
  )
  assert.deepEqual(uiModels[2].variants, ["minimal", "high"])
  assert.equal(uiModels[2].input, 5)
  assert.equal(uiModels[2].output, 15)
  assert.equal(uiModels[0].contextLimit, 200000)

  const checkJsonStrict = (val, path = "$") => {
    if (val === null) return
    if (typeof val === "string" || typeof val === "boolean") return
    if (typeof val === "number") {
      assert.ok(Number.isFinite(val), `Non-finite number at ${path}`)
      return
    }
    if (Array.isArray(val)) {
      val.forEach((item, idx) => checkJsonStrict(item, `${path}[${idx}]`))
      return
    }
    if (typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        assert.notEqual(v, undefined, `Found undefined at ${path}.${k}`)
        checkJsonStrict(v, `${path}.${k}`)
      }
      return
    }
    assert.fail(`Invalid JSON value at ${path}: ${typeof val}`)
  }

  checkJsonStrict(uiModels, "uiModels")
  checkJsonStrict(candidateRoutes([...MODELS, { providerID: "minimal", id: "bare-model" }]), "candidateRoutes")
})

test("candidateRoutes balances providers round-robin within 40-model cap and includes current model", () => {
  const many = []
  for (const p of ["alpha", "beta", "gamma", "delta", "zeta"]) {
    for (let i = 0; i < 12; i++) {
      many.push({ providerID: p, id: `m-${String(i).padStart(2, "0")}`, name: `Model ${p} ${i}` })
    }
  }
  const current = { providerID: "zeta", id: "m-11" }
  const routes = candidateRoutes(many, current)
  assert.equal(routes.length, 40)
  const providers = new Set(routes.map((r) => r.model.providerID))
  assert.deepEqual([...providers].sort(), ["alpha", "beta", "delta", "gamma", "zeta"])
  assert.ok(routes.some((r) => r.model.providerID === "zeta" && r.model.id === "m-11"))

  const defaultList = candidateRoutes(MODELS, { providerID: "openai", id: "gpt-5" })
  assert.equal(defaultList.length, 2)
  assert.deepEqual(defaultList[0].variants, ["low", "medium", "high"])
})

test("recentContext keeps only user and assistant prose within budget", () => {
  const context = recentContext([
    { type: "user", text: "first message" },
    { type: "system", text: "secret system instructions" },
    {
      type: "assistant",
      content: [
        { type: "reasoning", text: "internal reasoning" },
        { type: "tool", output: "SECRET_ENV=1" },
        { type: "text", text: "visible reply" },
      ],
    },
    { type: "user", text: "1234567890" },
  ], 15, 10)
  assert.equal(context.length, 2)
  assert.equal(context[0].role, "assistant")
  assert.equal(context[0].text, "reply")
  assert.equal(context[0].truncated, true)
  assert.equal(context[1].text, "1234567890")
})

test("makeGrillMessages and makeRewriteMessages build structured payloads", () => {
  const grillMsgs = makeGrillMessages({
    text: "fix auth",
    context: [{ role: "user", text: "login returns 401", truncated: false }],
    currentModel: { providerID: "openai", id: "gpt-5" },
    sessionTitle: "Auth bug",
  })
  assert.equal(grillMsgs[0].role, "system")
  const grillPayload = JSON.parse(grillMsgs[1].content)
  assert.equal(grillPayload.draft_to_rewrite, "fix auth")
  assert.equal(grillPayload.session_title, "Auth bug")

  const rewriteArgs = {
    text: "fix auth",
    context: [],
    currentModel: { providerID: "openai", id: "gpt-5" },
    routes: candidateRoutes(MODELS),
    grillContext: { diagnosis: "Scope unclear", answers: [{ question: "Target?", selected: ["JWT"] }] },
    refinement: { previous_rewrite: "Old rewrite", instruction: "Keep it brief" },
  }
  const msgs = makeRewriteMessages(rewriteArgs)
  assert.deepEqual(makeMessages(rewriteArgs), msgs)
  const payload = JSON.parse(msgs[1].content)
  assert.equal(payload.grill_context.diagnosis, "Scope unclear")
  assert.equal(payload.refinement.instruction, "Keep it brief")
  assert.equal(payload.routing.available_choices[0].variants[2], "high")
})

test("extractJsonObject unwraps fences and extracts braced objects with escaped strings", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"a\": 1}\n```"), { a: 1 })
  assert.deepEqual(
    extractJsonObject('Here is the JSON:\n{"msg":"contains } and { \\"braces\\"","ok":true}\nThanks!'),
    { msg: 'contains } and { "braces"', ok: true },
  )
  assert.throws(() => extractJsonObject("no json here"), SyntaxError)
})

test("parseGrillResponse validates and normalizes clarifying questions", () => {
  const parsed = parseGrillResponse(JSON.stringify({
    diagnosis: "Target module and test scope are unstated.",
    missing_angles: ["Target module", "Acceptance criteria"],
    ready_without_questions: false,
    questions: [
      {
        id: "q1",
        question: "Which auth flow is failing?",
        why: "Session cookies vs OAuth require different fixes.",
        options: [
          { id: "a", label: "OAuth callback", detail: "Token exchange and redirect handling" },
          { id: "b", label: "Session middleware", detail: "Cookie verification" },
        ],
      },
    ],
  }))
  assert.equal(parsed.readyWithoutQuestions, false)
  assert.equal(parsed.questions.length, 1)
  assert.equal(parsed.questions[0].options[1].id, "b")

  const empty = parseGrillResponse(JSON.stringify({
    diagnosis: "Already crisp and unambiguous.",
    missing_angles: [],
    ready_without_questions: false,
    questions: [],
  }))
  assert.equal(empty.readyWithoutQuestions, true)

  assert.throws(() => parseGrillResponse(JSON.stringify({ diagnosis: "", questions: [] })), /invalid grill analysis/)
})

test("parseProposal validates improvements, routes, variants, alternatives and warnings", () => {
  const routes = candidateRoutes(MODELS)

  const rich = parseProposal(JSON.stringify({
    rewritten_prompt: "Diagnose why OAuth callback returns 401 and add integration test coverage.",
    improvements: ["Clarified failure mode (OAuth 401)", "Added integration test expectation"],
    recommendation: {
      route_id: "r1",
      variant: "high",
      task_tier: "deep_reasoning",
      reason: "Multi-file auth debugging benefits from high reasoning effort.",
      alternative: {
        route_id: "r2",
        variant: "minimal",
        reason: "Fast sanity check option if urgent.",
      },
    },
    warnings: [],
  }), routes)

  assert.deepEqual(rich.route, { providerID: "anthropic", id: "claude-opus-4", variant: "high" })
  assert.equal(rich.taskTier, "deep_reasoning")
  assert.equal(rich.improvements.length, 2)
  assert.deepEqual(rich.alternative, {
    model: { providerID: "openai", id: "gpt-5", variant: "minimal" },
    reason: "Fast sanity check option if urgent.",
  })
  assert.deepEqual(rich.warnings, [])

  const badVariant = parseProposal(JSON.stringify({
    rewritten_prompt: "Inspect routes.",
    improvements: ["Tightened scope"],
    recommendation: { route_id: "r1", variant: "ultra", task_tier: "standard", reason: "Needs Opus." },
    warnings: [],
  }), routes)
  assert.deepEqual(badVariant.route, { providerID: "anthropic", id: "claude-opus-4" })
  assert.match(badVariant.warnings[0], /Unsupported reasoning effort "ultra"/)

  const unknownRoute = parseProposal(JSON.stringify({
    rewritten_prompt: "Run tests.",
    recommendation: { route_id: "r99", reason: "Nonexistent." },
    warnings: [],
  }), routes)
  assert.equal(unknownRoute.route, null)
  assert.match(unknownRoute.warnings[0], /Unsupported model suggestion/)

  assert.throws(
    () => parseProposal(JSON.stringify({
      rewritten_prompt: "same text",
      recommendation: { route_id: "keep", reason: "same text" },
      warnings: [],
    }), routes),
    /instead of a rewrite/,
  )
})

test("findDefaultRewriteModel selects terra on low and includes benchmark metrics in prompt routes", () => {
  const catalog = [
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
      variants: ["low", "high"],
      cost: { input: 5, output: 17 },
    },
  ]

  const def = findDefaultRewriteModel(catalog)
  assert.deepEqual(def, { providerID: "acc-openai", id: "gpt-6.1-terra-openai", variant: "low" })

  // Object-map variants (OpenCode provider catalog shape) are handled cleanly alongside arrays
  assert.deepEqual(
    variants({ providerID: "p", id: "m", variants: { none: {}, low: {}, high: { disabled: true }, x: false } }),
    ["none", "low"],
  )

  const routes = candidateRoutes(catalog, { providerID: "acc-anthropic", id: "claude-5.5-opus-anthropic" })
  const promptRoutes = formatRoutesForPrompt(routes)
  const haikuRoute = promptRoutes.find((r) => r.model === "acc-anthropic/claude-5.5-haiku-anthropic")
  assert.ok(haikuRoute)
  assert.ok(typeof haikuRoute.perfScore === "number")
  assert.ok(typeof haikuRoute.balanceScore === "number")
  assert.ok(typeof haikuRoute.blended3to1USDPer1M === "number")
})
