import test from "node:test"
import assert from "node:assert/strict"
import { createRewriteStore, formatElapsed, phaseLabel } from "../store.js"

test("formatElapsed and phaseLabel format timers and phases cleanly", () => {
  assert.equal(formatElapsed(0), "0.0s")
  assert.equal(formatElapsed(-50), "0.0s")
  assert.equal(formatElapsed(1540), "1.5s")
  assert.equal(formatElapsed(65400), "1m 05s")

  assert.equal(phaseLabel("loading_context"), "context")
  assert.equal(phaseLabel("grilling"), "grilling")
  assert.equal(phaseLabel("rewriting"), "rewriting")
  assert.equal(phaseLabel("refining"), "refining")
  assert.equal(phaseLabel("awaiting_answers"), "questions")
  assert.equal(phaseLabel("ready"), "ready")
  assert.equal(phaseLabel("error"), "error")
  assert.equal(phaseLabel("cancelled"), "cancelled")
  assert.equal(phaseLabel("other"), "working")
})

test("createRewriteStore manages grill answers, review edits, model overrides and stale progress guards", () => {
  let notifications = 0
  const store = createRewriteStore(() => { notifications++ })

  store.ensure("session:s1", { sessionID: "s1", label: "Auth fix" })
  store.beginRun("session:s1", {
    requestID: "req_1",
    phase: "grilling",
    detail: "Analyzing",
    model: "openai/gpt-5",
    draftText: "fix auth",
    flowMode: "grill",
    sessionID: "s1",
    label: "Auth fix",
  })
  assert.equal(store.hasRunning(), true)

  // Stale event from another request is ignored while req_1 is running
  assert.equal(
    store.applyProgress({ targetKey: "session:s1", requestID: "req_old", status: "error", error: "old fail" }),
    false,
  )
  assert.equal(store.get("session:s1").stage, "running")

  assert.equal(
    store.applyProgress({ targetKey: "session:s1", requestID: "req_1", status: "running", phase: "grilling", detail: "Reading context" }),
    true,
  )

  store.applyGrillResult("session:s1", {
    id: "req_1",
    model: "openai/gpt-5",
    original: "fix auth",
    diagnosis: "Need scope",
    missingAngles: ["Tests"],
    questions: [
      {
        id: "q1",
        question: "Which module?",
        why: "Avoid touching unrelated middleware",
        options: [
          { id: "a", label: "OAuth", detail: "Callback handler" },
          { id: "b", label: "Session", detail: "Cookie parser" },
        ],
      },
      {
        id: "q2",
        question: "Add tests?",
        why: "Safety",
        options: [{ id: "a", label: "Yes" }],
      },
    ],
  })
  assert.equal(store.get("session:s1").stage, "questions")

  // Toggle option selection on q1, leave q2 empty
  store.selectOption("session:s1", "q1", "a")
  store.setCustomAnswer("session:s1", "q1", "Keep middleware intact")
  assert.deepEqual(store.buildAnswersPayload("session:s1"), [
    {
      questionID: "q1",
      question: "Which module?",
      selectedLabels: ["OAuth"],
      customText: "Keep middleware intact",
    },
  ])
  // Deselect q1 option
  store.selectOption("session:s1", "q1", "a")
  assert.deepEqual(store.buildAnswersPayload("session:s1")[0].selectedLabels, [])

  // Run rewrite -> apply proposal
  store.beginRun("session:s1", {
    requestID: "req_2",
    phase: "rewriting",
    detail: "Generating",
    draftText: "fix auth",
    flowMode: "grill",
    sessionID: "s1",
    keepPrevious: true,
  })
  store.applyProposalResult("session:s1", {
    id: "req_2",
    model: "openai/gpt-5",
    original: "fix auth",
    text: "Improved prompt text",
    route: { providerID: "anthropic", id: "claude-opus-4", variant: "high" },
    taskTier: "deep_reasoning",
    reason: "Complex auth task",
    improvements: ["Clarified scope"],
    warnings: [],
  })

  const s1 = store.get("session:s1")
  assert.equal(s1.stage, "review")
  assert.equal(s1.editedText, "Improved prompt text")
  assert.equal(s1.applyRoute, true)

  store.setEditedText("session:s1", "User edited prompt")
  store.toggleApplyRoute("session:s1")
  assert.equal(store.get("session:s1").applyRoute, false)
  store.setModelOverride("session:s1", { providerID: "openai", id: "gpt-5" })
  assert.equal(store.get("session:s1").applyRoute, true)
  assert.deepEqual(store.get("session:s1").selectedModelOverride, { providerID: "openai", id: "gpt-5" })
  assert.ok(notifications > 0)
})

test("createRewriteStore tracks multiple windows independently and formats footer summaries", () => {
  const store = createRewriteStore()
  const now = 100000

  assert.equal(store.getFooterSummary("session:s1", now).visible, false)

  store.beginRun("session:s1", {
    requestID: "req_s1",
    phase: "rewriting",
    detail: "Generating",
    model: "openai/gpt-5",
    draftText: "refactor store",
    sessionID: "s1",
    label: "Store refactor",
  })
  store.ensure("session:s1", { label: "Store refactor" })
  // Override startedAt cleanly via progress event for deterministic timing check
  store.applyProgress({
    targetKey: "session:s1",
    requestID: "req_s1",
    status: "running",
    phase: "rewriting",
    detail: "Crafting prompt",
    model: "openai/gpt-5",
    startedAt: now - 4200,
  })

  // Same window footer shows active model & elapsed time
  const sameWin = store.getFooterSummary("session:s1", now)
  assert.equal(sameWin.visible, true)
  assert.equal(sameWin.tone, "info")
  assert.match(sameWin.text, /rewriting/)
  assert.match(sameWin.text, /gpt-5/)
  assert.match(sameWin.text, /4\.2s/)

  // Switching to session:s2 keeps session:s1 running visibly in footer
  const switchedWin = store.getFooterSummary("session:s2", now)
  assert.equal(switchedWin.visible, true)
  assert.equal(switchedWin.tone, "info")
  assert.match(switchedWin.text, /Store refactor/)
  assert.match(switchedWin.text, /4\.2s/)

  // Second window reaches ready state
  store.beginRun("session:s2", {
    requestID: "req_s2",
    phase: "rewriting",
    detail: "Working",
    draftText: "hello",
    sessionID: "s2",
    label: "Window 2",
  })
  store.applyProposalResult("session:s2", {
    id: "req_s2",
    original: "hello",
    text: "Improved hello",
    route: { providerID: "anthropic", id: "claude-sonnet-4" },
  })

  const s2Footer = store.getFooterSummary("session:s2", now)
  assert.equal(s2Footer.tone, "success")
  assert.match(s2Footer.text, /ready/)
  assert.match(s2Footer.text, /claude-sonnet-4/)
  assert.match(s2Footer.text, /bg: 1 running/)
})

test("applyCancelled fallback stages, error handling and hydrateServerJobs behave safely", () => {
  const store = createRewriteStore()

  store.beginRun("session:a", {
    requestID: "req_a",
    phase: "grilling",
    draftText: "draft content",
    sessionID: "a",
    label: "A",
  })
  assert.equal(store.applyCancelled("session:a", "wrong_id"), false)
  assert.equal(store.applyCancelled("session:a", "req_a"), true)
  assert.equal(store.get("session:a").stage, "draft")

  // Remote cancelled progress event also uses fallback stage cleanly
  store.beginRun("session:a", {
    requestID: "req_a2",
    phase: "grilling",
    draftText: "draft content",
    sessionID: "a",
    label: "A",
  })
  store.applyProgress({ targetKey: "session:a", requestID: "req_a2", status: "cancelled", detail: "Cancelled" })
  assert.equal(store.get("session:a").stage, "draft")

  store.hydrateServerJobs({
    active: [
      { targetKey: "session:a", requestID: "req_ignored", model: "openai/gpt-5", startedAt: 5000 }, // ignored since non-idle
      { targetKey: "session:b", sessionID: "b", requestID: "req_b", model: "openai/gpt-5", startedAt: 5000 },
    ],
  })
  assert.equal(store.get("session:a").stage, "draft")
  assert.equal(store.get("session:b").stage, "running")
  assert.equal(store.get("session:b").rewriteModel, "openai/gpt-5")
})

test("store accumulates window cost without double-counting and stores base rewrite model", () => {
  const store = createRewriteStore()
  store.setDefaultRewriteModel("acc-openai/gpt-6.1-terra-openai#low")
  assert.equal(store.getDefaultRewriteModel(), "acc-openai/gpt-6.1-terra-openai#low")

  store.beginRun("session:c", {
    requestID: "req_c1",
    phase: "grilling",
    draftText: "add auth",
    sessionID: "c",
    label: "C",
  })
  store.applyGrillResult("session:c", {
    id: "req_c1",
    questions: [],
    usage: { costUSD: 0.0012, totalTokens: 600, estimated: true },
  })
  // Duplicate progress event with same requestID must not double-count cost
  store.applyProgress({
    targetKey: "session:c",
    requestID: "req_c1",
    status: "questions",
    phase: "awaiting_answers",
    detail: "Ready",
    startedAt: 100,
    usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600, costUSD: 0.0012, estimated: true },
  })
  assert.equal(store.get("session:c").windowCostUSD, 0.0012)
  assert.equal(store.get("session:c").windowTokens, 600)

  store.beginRun("session:c", {
    requestID: "req_c2",
    phase: "rewriting",
    draftText: "add auth",
    sessionID: "c",
    label: "C",
    keepPrevious: true,
  })
  store.applyProposalResult("session:c", {
    id: "req_c2",
    text: "Improved prompt",
    route: { providerID: "acc-anthropic", id: "claude-5.5-haiku-anthropic" },
    improvements: [],
    warnings: [],
    usage: { costUSD: 0.0028, totalTokens: 1400, estimated: true },
  })
  assert.equal(store.get("session:c").windowCostUSD, 0.004)
  assert.equal(store.get("session:c").windowTokens, 2000)
  const footer = store.getFooterSummary("session:c", 200)
  assert.match(footer.text, /~\$0\.0040/)
})
