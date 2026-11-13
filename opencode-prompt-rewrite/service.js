import {
  candidateRoutes,
  compactModelName,
  findDefaultRewriteModel,
  findModel,
  makeGrillMessages,
  makeRewriteMessages,
  modelRef,
  parseGrillResponse,
  parseModelRef,
  parseProposal,
  recentContext,
  serializeModelsForUI,
} from "./core.js"
import { lookupBenchmark } from "./benchmarks.js"
import { buildUsageStats, recordGatewayUsage, resolveGatewaySettings, toPublicUsageSummary } from "./usage.js"

const unbox = (value) => value?.data ?? value
const findModelSafe = (models, ref) =>
  (models ?? []).find((m) => m.providerID === ref?.providerID && m.id === ref?.id) ?? null
const sameModel = (a, b) =>
  a?.providerID === b?.providerID &&
  a?.id === b?.id &&
  (a?.variant || undefined) === (b?.variant || undefined)
const compactRef = (ref) =>
  ref?.providerID && ref?.id
    ? { providerID: String(ref.providerID), id: String(ref.id), ...(ref.variant ? { variant: String(ref.variant) } : {}) }
    : null
const busy = (session) => (session?.time?.busy ?? 0) > (session?.time?.idle ?? 0)
const TTL_MS = 30 * 60000

/**
 * Ensures an RPC return or event payload strictly conforms to recursive JsonValue
 * validation (no `undefined` property values, `NaN`, `Infinity`, or non-plain objects).
 */
function toJsonValue(value) {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : toJsonValue(item)))
  if (typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      const sanitized = toJsonValue(v)
      if (sanitized !== undefined) out[k] = sanitized
    }
    return out
  }
  return undefined
}

function defaultTargetKey(input, ctx) {
  if (typeof input?.targetKey === "string" && input.targetKey.trim()) return input.targetKey.trim()
  if (input?.sessionID) return input.sessionID
  return `home:${ctx?.location?.directory ?? "default"}`
}

function pruneMap(map, maxSize) {
  const now = Date.now()
  for (const [key, value] of map) {
    if (now - (value.created ?? value.updatedAt ?? now) > TTL_MS) map.delete(key)
  }
  while (map.size >= maxSize) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

export async function createService(ctx, options = {}) {
  const configuredModel = ctx.options?.model === undefined ? undefined : parseModelRef(ctx.options.model)
  const timeoutMs = options.timeoutMs ?? 90000
  const gatewaySettings = options.gatewaySettings ?? resolveGatewaySettings()
  const shouldLogUsage = options.gatewaySettings ? true : !options.disableUsageLog && !process.env.NODE_TEST_CONTEXT
  const pending = new Map() // targetKey -> { requestID, targetKey, sessionID, phase, model, startedAt, controller }
  const grills = new Map() // grillID -> stored grill entry
  const proposals = new Map() // resultID -> stored proposal entry
  const latestByTarget = new Map() // targetKey -> latest job/result snapshot
  const seenRequests = new Set()
  const dismissedRequests = new Set()

  const emitProgress = (payload) => {
    const event = toJsonValue({
      ...payload,
      updatedAt: Date.now(),
    })
    if (event.requestID && dismissedRequests.has(event.requestID)) {
      return
    }
    latestByTarget.set(event.targetKey, {
      ...event,
      created: event.updatedAt,
    })
    pruneMap(latestByTarget, 100)
    try {
      options.onProgress?.(event)
    } catch {
      // Event delivery is best-effort and must never fail generation.
    }
  }

  async function resolveContextAndModel(input, controller) {
    const [session, models, messages] = await Promise.all([
      input.sessionID ? ctx.session.get({ sessionID: input.sessionID }) : { model: input.currentModel },
      ctx.model.list(),
      input.sessionID ? ctx.session.context({ sessionID: input.sessionID }) : [],
    ]).then((items) => items.map(unbox))

    if (!input.sessionID) {
      const selected = session.model ?? unbox(await ctx.model.default())
      if (!selected?.id || !selected?.providerID) {
        throw new Error("Choose a working model before sending your first prompt")
      }
      session.model = {
        providerID: selected.providerID,
        id: selected.id,
        ...(selected.variant ? { variant: selected.variant } : {}),
      }
      findModel(models, session.model)
    }
    if (controller.signal.aborted) throw new Error("cancelled")

    const defaultRewrite = findDefaultRewriteModel(models)
    const requestedModel = input.model === undefined ? undefined : parseModelRef(input.model)
    const ref = requestedModel ?? configuredModel ?? defaultRewrite ?? session.model
    if (!ref?.providerID || !ref?.id) {
      throw new Error("Choose a rewrite model or a working model before rewriting.")
    }
    const resolvedModel = findModel(models, ref)
    return { session, models, messages, ref, resolvedModel, defaultRewrite }
  }

  async function runGeneration(targetKey, input, rpcContext, phase, detail, execute) {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 30000) {
      throw new Error("Enter a prompt between 1 and 30,000 characters. Nothing was submitted.")
    }
    if (typeof input.requestID !== "string" || !/^[\w-]{8,100}$/.test(input.requestID)) {
      throw new Error("Invalid request ID")
    }
    if (seenRequests.has(input.requestID)) {
      throw new Error("This request ID was already used; invoke /rewrite again")
    }
    if (pending.has(targetKey)) {
      throw new Error("A rewrite is already running for this window")
    }
    // Validate explicit override syntax before registering seen request or spawning work.
    if (input.model !== undefined) parseModelRef(input.model)

    seenRequests.add(input.requestID)
    if (seenRequests.size > 10000) seenRequests.delete(seenRequests.values().next().value)

    const controller = new AbortController()
    const cancel = () => controller.abort()
    rpcContext?.signal?.addEventListener("abort", cancel, { once: true })
    if (rpcContext?.signal?.aborted) cancel()
    const timer = setTimeout(cancel, timeoutMs)
    const startedAt = Date.now()
    const job = {
      requestID: input.requestID,
      targetKey,
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      controller,
      startedAt,
      model: input.model ?? "",
    }
    pending.set(targetKey, job)

    emitProgress({
      requestID: input.requestID,
      targetKey,
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      status: "running",
      phase: "loading_context",
      detail: "Reading session context & models",
      model: input.model ?? "",
      startedAt,
    })

    try {
      const resolved = await resolveContextAndModel(input, controller)
      const activeModel = modelRef(resolved.ref)
      job.model = activeModel
      emitProgress({
        requestID: input.requestID,
        targetKey,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        status: "running",
        phase,
        detail: `${detail} (${compactModelName(activeModel)})`,
        model: activeModel,
        startedAt,
      })

      const result = await execute({ ...resolved, activeModel, startedAt, controller })
      if (controller.signal.aborted) throw new Error("cancelled")
      return result
    } catch (error) {
      const aborted = controller.signal.aborted
      const message = aborted
        ? "Rewrite cancelled or timed out. Nothing was submitted. The provider may still charge for work already done."
        : error instanceof SyntaxError
          ? "The model returned invalid JSON. Nothing was submitted."
          : error.message
      emitProgress({
        requestID: input.requestID,
        targetKey,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        status: aborted ? "cancelled" : "error",
        phase: aborted ? "cancelled" : "error",
        detail: aborted ? "Cancelled" : "Failed",
        model: job.model || "",
        startedAt,
        error: message,
      })
      throw new Error(message)
    } finally {
      clearTimeout(timer)
      rpcContext?.signal?.removeEventListener("abort", cancel)
      if (pending.get(targetKey)?.requestID === input.requestID) {
        pending.delete(targetKey)
      }
    }
  }

  async function callModel(ref, resolvedModel, messages, signal, meta = {}) {
    const prompt = `${messages[0].content}\n\nINPUT JSON:\n${messages[1].content}`
    let generated
    try {
      generated = unbox(await ctx.experimental.generate.text({ model: ref, prompt }, { signal }))
    } catch {
      throw new Error("Rewrite generation failed. Check the selected model and its connection. Nothing was submitted.")
    }
    if (typeof generated?.text !== "string") {
      throw new Error("The model returned no text. Nothing was submitted.")
    }
    const modelForCost = resolvedModel ? { ...resolvedModel, ...(ref.variant ? { variant: ref.variant } : {}) } : ref
    const stats = buildUsageStats({
      generated,
      promptText: prompt,
      outputText: generated.text,
      model: modelForCost,
      settings: gatewaySettings,
    })
    if (shouldLogUsage) {
      recordGatewayUsage({
        requestID: meta.requestID,
        phase: meta.phase || "rewrite",
        sessionID: meta.sessionID,
        stats,
        settings: gatewaySettings,
      })
    }
    return {
      text: generated.text,
      usage: toPublicUsageSummary(stats),
    }
  }

  async function grill(input, rpcContext = {}) {
    const targetKey = defaultTargetKey(input, ctx)
    return runGeneration(
      targetKey,
      input,
      rpcContext,
      "grilling",
      "Analyzing prompt for missing angles",
      async ({ session, models, messages, ref, resolvedModel, defaultRewrite, activeModel, startedAt, controller }) => {
        const recent = recentContext(messages)
        const routes = candidateRoutes(models, session.model)
        const messagesForModel = makeGrillMessages({
          text: input.text,
          context: recent,
          currentModel: session.model,
          sessionTitle: session.title,
        })
        const generated = await callModel(ref, resolvedModel, messagesForModel, controller.signal, {
          requestID: input.requestID,
          phase: "grill",
          sessionID: input.sessionID,
        })
        const parsed = parseGrillResponse(generated.text)
        if (controller.signal.aborted) throw new Error("cancelled")

        const result = toJsonValue({
          id: input.requestID,
          targetKey,
          sessionID: input.sessionID ?? null,
          startModel: compactRef(session.model),
          model: activeModel,
          defaultRewriteModel: defaultRewrite ? modelRef(defaultRewrite) : null,
          original: input.text,
          ...parsed,
          latencyMs: Date.now() - startedAt,
          contextMessages: recent.length,
          contextTruncated: recent.some((m) => m.truncated),
          candidateCount: routes.length,
          availableModels: serializeModelsForUI(models),
          usage: generated.usage,
        })

        pruneMap(grills, 100)
        grills.set(result.id, {
          id: result.id,
          targetKey,
          sessionID: input.sessionID ?? null,
          data: result,
          created: Date.now(),
        })

        emitProgress({
          requestID: input.requestID,
          targetKey,
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
          status: "questions",
          phase: "awaiting_answers",
          detail: parsed.questions.length ? `${parsed.questions.length} clarifying question(s)` : "Ready to rewrite",
          model: activeModel,
          startedAt,
          usage: generated.usage,
        })

        return result
      },
    )
  }

  async function rewrite(input, rpcContext = {}) {
    const targetKey = defaultTargetKey(input, ctx)
    const isRefine = typeof input.refineInstruction === "string" && input.refineInstruction.trim().length > 0
    return runGeneration(
      targetKey,
      input,
      rpcContext,
      isRefine ? "refining" : "rewriting",
      isRefine ? "Refining prompt" : "Crafting improved prompt",
      async ({ session, models, messages, ref, resolvedModel, defaultRewrite, activeModel, startedAt, controller }) => {
        const routes = candidateRoutes(models, session.model)
        const recent = recentContext(messages)
        const storedGrill = input.grillID ? grills.get(input.grillID)?.data : undefined

        let grillContext
        if (storedGrill || (Array.isArray(input.answers) && input.answers.length > 0)) {
          grillContext = {
            diagnosis: storedGrill?.diagnosis ?? undefined,
            missing_angles: storedGrill?.missingAngles ?? undefined,
            answers: (input.answers ?? []).map((a) => ({
              question: a.question || a.questionID,
              selected: a.selectedLabels ?? [],
              custom_answer: a.customText?.trim() || undefined,
            })),
          }
        }

        const refinement = isRefine
          ? {
              previous_rewrite: input.previousRewrite ?? "",
              instruction: input.refineInstruction.trim(),
            }
          : undefined

        const messagesForModel = makeRewriteMessages({
          text: input.text,
          context: recent,
          currentModel: session.model,
          routes,
          grillContext,
          refinement,
          sessionTitle: session.title,
        })
        const generated = await callModel(ref, resolvedModel, messagesForModel, controller.signal, {
          requestID: input.requestID,
          phase: isRefine ? "refine" : "rewrite",
          sessionID: input.sessionID,
        })
        const proposal = parseProposal(generated.text, routes)
        if (controller.signal.aborted) throw new Error("cancelled")

        const targetModelRef = proposal.route ?? session.model
        const routeBenchmark = targetModelRef
          ? lookupBenchmark(
              findModelSafe(models, targetModelRef) || targetModelRef,
              targetModelRef.variant || null,
            )
          : null
        const altBenchmark = proposal.alternative?.model
          ? lookupBenchmark(
              findModelSafe(models, proposal.alternative.model) || proposal.alternative.model,
              proposal.alternative.model.variant || null,
            )
          : null

        const result = toJsonValue({
          id: input.requestID,
          targetKey,
          sessionID: input.sessionID ?? null,
          startModel: compactRef(session.model),
          original: input.text,
          ...proposal,
          model: activeModel,
          defaultRewriteModel: defaultRewrite ? modelRef(defaultRewrite) : null,
          latencyMs: Date.now() - startedAt,
          contextMessages: recent.length,
          contextTruncated: recent.some((m) => m.truncated),
          candidateCount: routes.length,
          availableModels: serializeModelsForUI(models),
          grillID: input.grillID ?? null,
          usage: generated.usage,
          ...(routeBenchmark ? { routeBenchmark } : {}),
          ...(altBenchmark ? { alternativeBenchmark: altBenchmark } : {}),
        })

        pruneMap(proposals, 100)
        proposals.set(result.id, {
          result,
          sessionModel: session.model,
          location: { directory: ctx.location.directory },
          targetSessionID: input.sessionID,
          created: Date.now(),
          submitting: false,
        })

        emitProgress({
          requestID: input.requestID,
          targetKey,
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
          status: "ready",
          phase: "ready",
          detail: "Improved prompt ready",
          model: activeModel,
          startedAt,
          usage: generated.usage,
        })

        return result
      },
    )
  }

  // Backward-compatible alias for direct one-shot rewrite callers.
  async function propose(input, rpcContext = {}) {
    return rewrite(input, rpcContext)
  }

  function cancel({ requestID, targetKey } = {}) {
    let target
    if (targetKey && pending.has(targetKey)) {
      const candidate = pending.get(targetKey)
      if (!requestID || candidate.requestID === requestID) target = candidate
    } else if (requestID) {
      for (const item of pending.values()) {
        if (item.requestID === requestID) {
          target = item
          break
        }
      }
    }
    if (!target) return { cancelled: false }
    target.controller.abort()
    return { cancelled: true }
  }

  function rememberDismissed(id) {
    if (!id) return
    dismissedRequests.add(id)
    if (dismissedRequests.size > 1000) dismissedRequests.delete(dismissedRequests.values().next().value)
  }

  function dismiss({ requestID, targetKey } = {}) {
    let dismissed = false
    if (requestID) rememberDismissed(requestID)

    for (const [k, item] of pending) {
      if ((targetKey && k === targetKey && (!requestID || item.requestID === requestID)) || (requestID && item.requestID === requestID)) {
        rememberDismissed(item.requestID)
        pending.delete(k)
        item.controller.abort()
        dismissed = true
      }
    }

    for (const [id, entry] of proposals) {
      if ((targetKey && entry.result?.targetKey === targetKey) || (requestID && id === requestID)) {
        proposals.delete(id)
        dismissed = true
      }
    }

    for (const [id, entry] of grills) {
      if ((targetKey && entry.targetKey === targetKey) || (requestID && id === requestID)) {
        grills.delete(id)
        dismissed = true
      }
    }

    if (targetKey && latestByTarget.has(targetKey)) {
      const snap = latestByTarget.get(targetKey)
      if (!requestID || snap?.requestID === requestID) {
        latestByTarget.delete(targetKey)
        dismissed = true
      }
    } else if (requestID) {
      for (const [k, snap] of latestByTarget) {
        if (snap?.requestID === requestID) {
          latestByTarget.delete(k)
          dismissed = true
        }
      }
    }

    return { dismissed }
  }

  function inspect({ requestID, targetKey } = {}) {
    const now = Date.now()
    for (const [id, entry] of proposals) {
      if (now - entry.created > TTL_MS) proposals.delete(id)
    }
    for (const [id, entry] of grills) {
      if (now - entry.created > TTL_MS) grills.delete(id)
    }

    if (requestID && proposals.has(requestID)) {
      return toJsonValue({ kind: "proposal", proposal: proposals.get(requestID).result })
    }
    if (targetKey) {
      let latestProposal
      for (const entry of proposals.values()) {
        if (entry.result?.targetKey === targetKey) latestProposal = entry
      }
      if (latestProposal) {
        return toJsonValue({ kind: "proposal", proposal: latestProposal.result })
      }
    }

    if (requestID && grills.has(requestID)) {
      return toJsonValue({ kind: "grill", grill: grills.get(requestID).data })
    }
    if (targetKey) {
      let latestGrill
      for (const entry of grills.values()) {
        if (entry.targetKey === targetKey) latestGrill = entry
      }
      if (latestGrill) {
        return toJsonValue({ kind: "grill", grill: latestGrill.data })
      }
    }

    const active = targetKey ? pending.get(targetKey) : undefined
    if (active && (!requestID || active.requestID === requestID)) {
      return toJsonValue({
        kind: "running",
        snapshot: {
          requestID: active.requestID,
          targetKey: active.targetKey,
          sessionID: active.sessionID ?? null,
          model: active.model,
          startedAt: active.startedAt,
        },
      })
    }

    const snap = targetKey ? latestByTarget.get(targetKey) : undefined
    if (snap && (!requestID || snap.requestID === requestID)) {
      return toJsonValue({ kind: "snapshot", snapshot: snap })
    }

    return { kind: "none" }
  }

  async function submit({ resultID, text, applyRoute, selectedModel }) {
    const stored = proposals.get(resultID)
    if (!stored || Date.now() - stored.created > TTL_MS) {
      throw new Error("This proposal expired; invoke /rewrite again")
    }
    if (stored.submitting) throw new Error("This proposal is already being submitted")
    if (typeof text !== "string" || !text.trim() || text.length > 40000) {
      throw new Error("Invalid prompt; nothing was submitted")
    }

    const result = stored.result
    // Lock before first await: concurrent RPCs must not submit the same handle twice.
    stored.submitting = true
    let switched = false
    try {
      const chosenRoute = selectedModel ?? result.route
      if (applyRoute && !chosenRoute) throw new Error("No model change was selected")

      let session
      if (!stored.targetSessionID) {
        const model = applyRoute ? chosenRoute : stored.sessionModel
        findModel(unbox(await ctx.model.list()), model)
        // Home-screen rewrite stays stateless until explicit acceptance.
        session = unbox(await ctx.session.create({ location: stored.location, model }))
        stored.targetSessionID = session.id
        stored.sessionModel = session.model ?? model
        switched = Boolean(applyRoute && !sameModel(result.startModel, model))
      } else {
        session = unbox(await ctx.session.get({ sessionID: stored.targetSessionID }))
      }

      if (applyRoute && !sameModel(session.model, stored.sessionModel)) {
        throw new Error("The session model changed during review. Nothing was submitted; keep the current model or rewrite again.")
      }
      if (applyRoute && busy(session)) {
        throw new Error("The session is busy. Queue the prompt with its current model instead; no model was changed.")
      }
      if (applyRoute && !sameModel(session.model, chosenRoute)) {
        findModel(unbox(await ctx.model.list()), chosenRoute)
        await ctx.session.switchModel({ sessionID: stored.targetSessionID, model: chosenRoute })
        switched = true
      }

      const queued = busy(session)
      await ctx.session.prompt({
        sessionID: stored.targetSessionID,
        id: `msg_rewrite_${resultID.replaceAll("-", "")}`,
        text,
        delivery: queued ? "queue" : "steer",
        metadata: { source: "prompt-rewrite", rewriteID: resultID },
      })
      proposals.delete(resultID)
      if (result.grillID) grills.delete(result.grillID)
      if (latestByTarget.get(result.targetKey)?.requestID === resultID) {
        latestByTarget.delete(result.targetKey)
      }
      return { sessionID: stored.targetSessionID, queued, switched }
    } catch (error) {
      stored.submitting = false
      const detail = switched
        ? "Submission failed after applying the model recommendation. The model remains changed; check the session before retrying."
        : error.message
      throw new Error(!result.sessionID && stored.targetSessionID
        ? `${detail} New session: ${stored.targetSessionID}; retrying this proposal reuses it.`
        : detail)
    }
  }

  function jobs({ targetKey } = {}) {
    const active = []
    for (const item of pending.values()) {
      if (targetKey && item.targetKey !== targetKey) continue
      active.push({
        requestID: item.requestID,
        targetKey: item.targetKey,
        sessionID: item.sessionID ?? null,
        model: item.model,
        startedAt: item.startedAt,
      })
    }
    const recent = []
    for (const snap of latestByTarget.values()) {
      if (targetKey && snap.targetKey !== targetKey) continue
      recent.push(snap)
    }
    return toJsonValue({ active, recent })
  }

  async function models() {
    const list = unbox(await ctx.model.list())
    const defRef = configuredModel ?? findDefaultRewriteModel(list)
    return toJsonValue({
      models: serializeModelsForUI(list),
      defaultRewriteModel: defRef ? modelRef(defRef) : null,
    })
  }

  return {
    grill,
    rewrite,
    propose,
    cancel,
    dismiss,
    inspect,
    submit,
    jobs,
    models,
    dispose() {
      for (const item of pending.values()) item.controller.abort()
      pending.clear()
      grills.clear()
      proposals.clear()
      latestByTarget.clear()
      dismissedRequests.clear()
    },
  }
}
