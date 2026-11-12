import { candidateRoutes, findModel, makeMessages, modelRef, parseModelRef, parseProposal, recentContext } from "./core.js"

const unbox = (value) => value?.data ?? value
const sameModel = (a, b) => a?.providerID === b?.providerID && a?.id === b?.id && a?.variant === b?.variant
const busy = (session) => (session.time?.busy ?? 0) > (session.time?.idle ?? 0)
export async function createService(ctx, options = {}) {
  const configuredModel = ctx.options?.model === undefined ? undefined : parseModelRef(ctx.options.model)
  const timeoutMs = options.timeoutMs ?? 45000
  const pending = new Map()
  const proposals = new Map()
  const seenRequests = new Set()
  async function propose(input, rpcContext = {}) {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 30000) {
      throw new Error("Enter a prompt between 1 and 30,000 characters. Nothing was submitted.")
    }
    if (typeof input.requestID !== "string" || !/^[\w-]{8,100}$/.test(input.requestID)) throw new Error("Invalid request ID")
    if (seenRequests.has(input.requestID)) throw new Error("This request ID was already used; invoke /rewrite again")
    if ([...pending.values()].some((p) => p.sessionID === input.sessionID)) throw new Error("A rewrite is already running for this session")
    const requestedModel = input.model === undefined ? undefined : parseModelRef(input.model)
    seenRequests.add(input.requestID)
    if (seenRequests.size > 10000) seenRequests.delete(seenRequests.values().next().value)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    rpcContext.signal?.addEventListener("abort", cancel, { once: true })
    if (rpcContext.signal?.aborted) cancel()
    const timer = setTimeout(cancel, timeoutMs)
    pending.set(input.requestID, { controller, sessionID: input.sessionID })
    const started = Date.now()
    try {
      const [session, models, messages] = await Promise.all([
        input.sessionID ? ctx.session.get({ sessionID: input.sessionID }) : { model: input.currentModel },
        ctx.model.list(),
        input.sessionID ? ctx.session.context({ sessionID: input.sessionID }) : [],
      ]).then((items) => items.map(unbox))
      if (!input.sessionID) {
        const selected = session.model ?? unbox(await ctx.model.default())
        if (!selected?.id || !selected?.providerID) throw new Error("Choose a working model before sending your first prompt")
        session.model = { providerID: selected.providerID, id: selected.id, ...(selected.variant ? { variant: selected.variant } : {}) }
        findModel(models, session.model)
      }
      if (controller.signal.aborted) throw new Error("cancelled")
      const ref = requestedModel ?? configuredModel ?? session.model
      if (!ref?.providerID || !ref?.id) throw new Error("Choose a rewrite model or a working model before rewriting.")
      findModel(models, ref)
      const routes = candidateRoutes(models)
      const recent = recentContext(messages)
      const messagesForModel = makeMessages({ text: input.text, context: recent, currentModel: session.model, routes })
      const prompt = `${messagesForModel[0].content}\n\nINPUT JSON:\n${messagesForModel[1].content}`
      let generated
      try {
        generated = unbox(await ctx.experimental.generate.text({ model: ref, prompt }, { signal: controller.signal }))
      } catch {
        throw new Error("Rewrite generation failed. Check the selected model and its connection. Nothing was submitted.")
      }
      if (typeof generated?.text !== "string") throw new Error("The model returned no text. Nothing was submitted.")
      const proposal = parseProposal(generated.text, routes)
      if (controller.signal.aborted) throw new Error("cancelled")
      const result = {
        id: input.requestID, sessionID: input.sessionID ?? null, startModel: session.model ?? null, original: input.text, ...proposal,
        model: modelRef(ref), latencyMs: Date.now() - started,
        contextMessages: recent.length, contextTruncated: recent.some((m) => m.truncated),
      }
      // An acceptance handle expires, is single-use, and belongs to this exact session snapshot.
      for (const [key, value] of proposals) if (Date.now() - value.created > 30 * 60000) proposals.delete(key)
      if (proposals.size >= 100) proposals.delete(proposals.keys().next().value)
      proposals.set(result.id, { result, sessionModel: session.model, location: { directory: ctx.location.directory },
        targetSessionID: input.sessionID, created: Date.now(), submitting: false })
      return result
    } catch (error) {
      const aborted = controller.signal.aborted
      const message = aborted ? "Rewrite cancelled or timed out. Nothing was submitted. The provider may still charge for work already done."
        : error instanceof SyntaxError ? "The model returned invalid JSON. Nothing was submitted." : error.message
      throw new Error(message)
    } finally {
      clearTimeout(timer)
      rpcContext.signal?.removeEventListener("abort", cancel)
      pending.delete(input.requestID)
    }
  }

  function cancel({ requestID }) {
    const item = pending.get(requestID)
    item?.controller.abort()
    return { cancelled: Boolean(item) }
  }

  async function submit({ resultID, text, applyRoute }) {
    const stored = proposals.get(resultID)
    if (!stored || Date.now() - stored.created > 30 * 60000) throw new Error("This proposal expired; invoke /rewrite again")
    if (stored.submitting) throw new Error("This proposal is already being submitted")
    if (typeof text !== "string" || !text.trim() || text.length > 40000) throw new Error("Invalid prompt; nothing was submitted")
    const result = stored.result
    // Lock before the first await: concurrent RPCs must not submit the same handle twice.
    stored.submitting = true
    let switched = false
    try {
      if (applyRoute && !result.route) throw new Error("No model change was recommended")
      if (applyRoute && text !== result.text) throw new Error("The edited/original prompt needs a fresh routing recommendation; send it with the current model instead")
      let session
      if (!stored.targetSessionID) {
        const model = applyRoute ? result.route : stored.sessionModel
        findModel(unbox(await ctx.model.list()), model)
        // Home-screen rewrite stays stateless until explicit acceptance.
        session = unbox(await ctx.session.create({ location: stored.location, model }))
        stored.targetSessionID = session.id
        stored.sessionModel = session.model ?? model
        switched = applyRoute && !sameModel(result.startModel, model)
      } else session = unbox(await ctx.session.get({ sessionID: stored.targetSessionID }))
      if (applyRoute && !sameModel(session.model, stored.sessionModel)) throw new Error("The session model changed during review. Nothing was submitted; keep the current model or rewrite again.")
      if (applyRoute && busy(session)) throw new Error("The session is busy. Queue the prompt with its current model instead; no model was changed.")
      if (applyRoute && !sameModel(session.model, result.route)) {
        findModel(unbox(await ctx.model.list()), result.route)
        await ctx.session.switchModel({ sessionID: stored.targetSessionID, model: result.route })
        switched = true
      }
      const queued = busy(session)
      await ctx.session.prompt({
        sessionID: stored.targetSessionID, id: `msg_rewrite_${resultID.replaceAll("-", "")}`,
        text, delivery: queued ? "queue" : "steer",
        metadata: { source: "prompt-rewrite", rewriteID: resultID },
      })
      proposals.delete(resultID)
      return { sessionID: stored.targetSessionID, queued, switched }
    } catch (error) {
      stored.submitting = false
      // Do not blindly restore: another client may have changed the model in the meantime.
      const detail = switched ? "Submission failed after applying the model recommendation. The model remains changed; check the session before retrying." : error.message
      throw new Error(!result.sessionID && stored.targetSessionID ? `${detail} New session: ${stored.targetSessionID}; retrying this proposal reuses it.` : detail)
    }
  }

  return { propose, cancel, submit, dispose() { for (const item of pending.values()) item.controller.abort(); pending.clear(); proposals.clear() } }
}
