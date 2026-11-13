import { compactModelName, modelRef } from "./core.js"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function formatCostUsd(costUSD, estimated = false) {
  if (typeof costUSD !== "number" || !Number.isFinite(costUSD) || costUSD < 0) return ""
  const prefix = estimated ? "~$" : "$"
  if (costUSD === 0) return "$0.00"
  if (costUSD < 0.0001) return `${estimated ? "~" : ""}<$0.0001`
  if (costUSD < 0.01) return `${prefix}${costUSD.toFixed(4)}`
  if (costUSD < 1) return `${prefix}${costUSD.toFixed(3)}`
  return `${prefix}${costUSD.toFixed(2)}`
}

export function formatTokensCompact(totalTokens, estimated = false) {
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens <= 0) return ""
  const prefix = estimated ? "~" : ""
  if (totalTokens >= 1000) return `${prefix}${(totalTokens / 1000).toFixed(1)}k tok`
  return `${prefix}${Math.round(totalTokens)} tok`
}

export function formatUsageLine(usage) {
  if (!usage || typeof usage.costUSD !== "number") return ""
  const usd = formatCostUsd(usage.costUSD, Boolean(usage.estimated))
  const tok = formatTokensCompact(usage.totalTokens, Boolean(usage.estimated))
  return tok ? `${usd} (${tok})` : usd
}

export function formatElapsed(ms) {
  const safe = Math.max(0, Number(ms) || 0)
  const totalTenths = Math.floor(safe / 100)
  const secs = totalTenths / 10
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const rem = Math.floor(secs % 60)
  return `${mins}m ${String(rem).padStart(2, "0")}s`
}

export function phaseLabel(phase) {
  switch (phase) {
    case "loading_context":
      return "context"
    case "grilling":
      return "grilling"
    case "rewriting":
      return "rewriting"
    case "refining":
      return "refining"
    case "awaiting_answers":
      return "questions"
    case "ready":
      return "ready"
    case "error":
      return "error"
    case "cancelled":
      return "cancelled"
    default:
      return "working"
  }
}

export function createRewriteStore(onChange) {
  const windows = new Map()
  const recordedUsageIds = new Set()
  let defaultRewriteModel = null
  const maxEntries = 30

  const notify = () => {
    try {
      onChange?.()
    } catch {}
  }

  function recordUsageIntoPatch(existing, requestID, usage, basePatch) {
    if (!usage || typeof usage.costUSD !== "number") return basePatch
    const dedupeId = requestID ? String(requestID) : ""
    const prevCost = Number(existing?.windowCostUSD || 0)
    const prevTokens = Number(existing?.windowTokens || 0)
    const prevEst = Boolean(existing?.windowEstimated)
    if (dedupeId && recordedUsageIds.has(dedupeId)) {
      return {
        ...basePatch,
        lastUsage: usage,
      }
    }
    if (dedupeId) recordedUsageIds.add(dedupeId)
    return {
      ...basePatch,
      lastUsage: usage,
      windowCostUSD: Number((prevCost + usage.costUSD).toFixed(8)),
      windowTokens: prevTokens + (Number(usage.totalTokens) || 0),
      windowEstimated: prevEst || Boolean(usage.estimated),
    }
  }

  function touch(targetKey, patch = {}) {
    if (!targetKey) return undefined
    const existing = windows.get(targetKey)
    if (!existing && windows.size >= maxEntries) {
      // Evict oldest idle/non-running entry first.
      for (const [k, v] of windows) {
        if (v.stage !== "running") {
          windows.delete(k)
          break
        }
      }
      if (windows.size >= maxEntries) {
        const oldest = windows.keys().next().value
        if (oldest !== undefined) windows.delete(oldest)
      }
    }
    const next = {
      targetKey,
      sessionID: null,
      label: targetKey.startsWith("home:") ? "Start screen" : "Session",
      stage: "idle", // idle | draft | running | questions | review | error
      phase: "",
      phaseDetail: "",
      flowMode: "grill",
      rewriteModel: undefined,
      startedAt: 0,
      requestID: undefined,
      draftText: "",
      grill: undefined,
      answers: {}, // questionID -> { selectedIds: string[], customText: string }
      proposal: undefined,
      editedText: "",
      applyRoute: false,
      selectedModelOverride: undefined,
      lastUsage: undefined,
      windowCostUSD: 0,
      windowTokens: 0,
      windowEstimated: false,
      error: undefined,
      updatedAt: Date.now(),
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    }
    windows.set(targetKey, next)
    return next
  }

  function get(targetKey) {
    return targetKey ? windows.get(targetKey) : undefined
  }

  function ensure(targetKey, meta = {}) {
    const existing = windows.get(targetKey)
    if (existing) {
      if (meta.label || meta.sessionID !== undefined) {
        return touch(targetKey, {
          ...(meta.label ? { label: meta.label } : {}),
          ...(meta.sessionID !== undefined ? { sessionID: meta.sessionID } : {}),
        })
      }
      return existing
    }
    const created = touch(targetKey, meta)
    notify()
    return created
  }

  function setDraft(targetKey, patch) {
    const next = touch(targetKey, {
      ...patch,
      ...(patch.stage ? {} : { stage: get(targetKey)?.stage === "idle" ? "draft" : get(targetKey)?.stage }),
    })
    notify()
    return next
  }

  function beginRun(targetKey, { requestID, phase, detail, model, draftText, flowMode, sessionID, label, keepPrevious }) {
    const prev = get(targetKey)
    const next = touch(targetKey, {
      ...(sessionID !== undefined ? { sessionID } : {}),
      ...(label ? { label } : {}),
      ...(draftText !== undefined ? { draftText } : {}),
      ...(flowMode ? { flowMode } : {}),
      ...(model !== undefined ? { rewriteModel: model } : {}),
      stage: "running",
      phase: phase || "loading_context",
      phaseDetail: detail || "Starting…",
      requestID,
      startedAt: Date.now(),
      error: undefined,
      ...(!keepPrevious ? { proposal: undefined, editedText: "", applyRoute: false, selectedModelOverride: undefined } : {}),
    })
    if (!keepPrevious && phase === "grilling" && prev?.grill?.id !== requestID) {
      next.grill = undefined
      next.answers = {}
    }
    notify()
    return next
  }

  function fallbackStageFor(entry) {
    if (entry?.proposal) return "review"
    if (entry?.grill?.questions?.length) return "questions"
    if (entry?.draftText) return "draft"
    return "idle"
  }

  function applyProgress(event) {
    if (!event?.targetKey) return false
    const entry = windows.get(event.targetKey)
    // Ignore stale events from an older superseded request.
    if (entry?.requestID && event.requestID && entry.requestID !== event.requestID && entry.stage === "running") {
      return false
    }
    if (!entry && event.status !== "running") return false

    const nextStage = event.status === "running"
      ? "running"
      : event.status === "questions"
        ? (entry?.grill ? "questions" : entry?.stage ?? "idle")
        : event.status === "ready"
          ? (entry?.proposal ? "review" : entry?.stage ?? "idle")
          : event.status === "error"
            ? "error"
            : event.status === "cancelled"
              ? fallbackStageFor(entry)
              : entry?.stage ?? "idle"

    const patch = recordUsageIntoPatch(entry, event.requestID, event.usage, {
      ...(event.sessionID ? { sessionID: event.sessionID } : {}),
      requestID: event.requestID ?? entry?.requestID,
      stage: nextStage,
      phase: event.phase ?? entry?.phase ?? "",
      phaseDetail: event.detail ?? entry?.phaseDetail ?? "",
      ...(event.model ? { rewriteModel: event.model } : {}),
      ...(event.startedAt ? { startedAt: event.startedAt } : {}),
      ...(event.error ? { error: event.error } : {}),
    })
    touch(event.targetKey, patch)
    notify()
    return true
  }

  function applyGrillResult(targetKey, result) {
    const entry = get(targetKey)
    if (entry?.requestID && result?.id && entry.requestID !== result.id) return undefined
    if (result?.defaultRewriteModel !== undefined) defaultRewriteModel = result.defaultRewriteModel || null
    const answers = {}
    for (const q of result.questions ?? []) {
      answers[q.id] = { selectedIds: [], customText: "" }
    }
    const patch = recordUsageIntoPatch(entry, result.id, result.usage, {
      stage: "questions",
      phase: "awaiting_answers",
      phaseDetail: `${(result.questions ?? []).length} clarifying question(s)`,
      grill: result,
      answers,
      rewriteModel: result.model || entry?.rewriteModel,
      error: undefined,
      requestID: result.id,
    })
    const next = touch(targetKey, patch)
    notify()
    return next
  }

  function selectOption(targetKey, questionID, optionID) {
    const entry = get(targetKey)
    if (!entry) return
    const cur = entry.answers?.[questionID] ?? { selectedIds: [], customText: "" }
    const already = cur.selectedIds.includes(optionID)
    const selectedIds = already ? [] : [optionID]
    touch(targetKey, {
      answers: {
        ...entry.answers,
        [questionID]: { ...cur, selectedIds },
      },
    })
    notify()
  }

  function setCustomAnswer(targetKey, questionID, customText) {
    const entry = get(targetKey)
    if (!entry) return
    const cur = entry.answers?.[questionID] ?? { selectedIds: [], customText: "" }
    touch(targetKey, {
      answers: {
        ...entry.answers,
        [questionID]: { ...cur, customText },
      },
    })
    notify()
  }

  function buildAnswersPayload(targetKey) {
    const entry = get(targetKey)
    const questions = entry?.grill?.questions ?? []
    return questions.map((q) => {
      const state = entry.answers?.[q.id] ?? { selectedIds: [], customText: "" }
      const selectedLabels = (state.selectedIds ?? [])
        .map((id) => q.options?.find((o) => o.id === id)?.label)
        .filter(Boolean)
      return {
        questionID: q.id,
        question: q.question,
        selectedLabels,
        customText: state.customText ?? "",
      }
    }).filter((a) => a.selectedLabels.length > 0 || a.customText.trim().length > 0)
  }

  function applyProposalResult(targetKey, proposal) {
    const entry = get(targetKey)
    if (entry?.requestID && proposal?.id && entry.requestID !== proposal.id) return undefined
    if (proposal?.defaultRewriteModel !== undefined) defaultRewriteModel = proposal.defaultRewriteModel || null
    const patch = recordUsageIntoPatch(entry, proposal.id, proposal.usage, {
      stage: "review",
      phase: "ready",
      phaseDetail: "Improved prompt ready",
      proposal,
      editedText: proposal.text,
      applyRoute: Boolean(proposal.route),
      selectedModelOverride: undefined,
      rewriteModel: proposal.model || entry?.rewriteModel,
      error: undefined,
      requestID: proposal.id,
    })
    const next = touch(targetKey, patch)
    notify()
    return next
  }

  function setEditedText(targetKey, editedText) {
    touch(targetKey, { editedText })
    notify()
  }

  function toggleApplyRoute(targetKey, nextValue) {
    const entry = get(targetKey)
    if (!entry) return
    const activeTarget = entry.selectedModelOverride ?? entry.proposal?.route
    if (!activeTarget && nextValue !== false) return
    const applyRoute = nextValue !== undefined ? Boolean(nextValue) : !entry.applyRoute
    touch(targetKey, { applyRoute })
    notify()
  }

  function setModelOverride(targetKey, model) {
    touch(targetKey, {
      selectedModelOverride: model || undefined,
      applyRoute: Boolean(model),
    })
    notify()
  }

  function applyError(targetKey, requestID, message) {
    const entry = get(targetKey)
    if (entry?.requestID && requestID && entry.requestID !== requestID) return false
    touch(targetKey, {
      stage: "error",
      phase: "error",
      phaseDetail: "Failed",
      error: message,
    })
    notify()
    return true
  }

  function applyCancelled(targetKey, requestID) {
    const entry = get(targetKey)
    if (!entry) return false
    if (entry.requestID && requestID && entry.requestID !== requestID) return false
    touch(targetKey, {
      stage: fallbackStageFor(entry),
      phase: "cancelled",
      phaseDetail: "Cancelled",
      error: undefined,
    })
    notify()
    return true
  }

  function clearProposal(targetKey) {
    const entry = get(targetKey)
    if (!entry) return
    touch(targetKey, {
      stage: "idle",
      phase: "",
      phaseDetail: "",
      draftText: "",
      grill: undefined,
      answers: {},
      proposal: undefined,
      editedText: "",
      applyRoute: false,
      selectedModelOverride: undefined,
      error: undefined,
    })
    notify()
  }

  function resetToDraft(targetKey, keepDraft = true) {
    const entry = get(targetKey)
    touch(targetKey, {
      stage: "draft",
      phase: "",
      phaseDetail: "",
      draftText: keepDraft ? (entry?.draftText || entry?.proposal?.original || "") : "",
      grill: undefined,
      answers: {},
      proposal: undefined,
      editedText: "",
      applyRoute: false,
      selectedModelOverride: undefined,
      error: undefined,
    })
    notify()
  }

  function hydrateServerJobs(snapshot) {
    let changed = false
    for (const active of snapshot?.active ?? []) {
      const existing = windows.get(active.targetKey)
      if (!existing || existing.stage === "idle") {
        touch(active.targetKey, {
          sessionID: active.sessionID ?? null,
          requestID: active.requestID,
          stage: "running",
          phase: "rewriting",
          phaseDetail: "Running on server",
          rewriteModel: active.model || undefined,
          startedAt: active.startedAt || Date.now(),
        })
        changed = true
      }
    }
    if (changed) notify()
  }

  function hasRunning() {
    for (const entry of windows.values()) {
      if (entry.stage === "running") return true
    }
    return false
  }

  function listWindows() {
    return [...windows.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  function getFooterSummary(currentTargetKey, now = Date.now()) {
    const current = currentTargetKey ? windows.get(currentTargetKey) : undefined
    const othersRunning = []
    const othersReady = []
    const othersQuestions = []

    for (const entry of windows.values()) {
      if (entry.targetKey === currentTargetKey) continue
      if (entry.stage === "running") othersRunning.push(entry)
      else if (entry.stage === "review" && entry.proposal) othersReady.push(entry)
      else if (entry.stage === "questions" && entry.grill) othersQuestions.push(entry)
    }

    const spinnerIdx = Math.floor(now / 150) % SPINNER_FRAMES.length
    const spin = SPINNER_FRAMES[spinnerIdx]

    const bgParts = []
    if (othersRunning.length > 0) bgParts.push(`${othersRunning.length} running`)
    if (othersQuestions.length > 0) bgParts.push(`${othersQuestions.length} grill`)
    if (othersReady.length > 0) bgParts.push(`${othersReady.length} ready`)
    const bgSuffix = bgParts.length > 0 ? ` · bg: ${bgParts.join(", ")}` : ""

    if (current?.stage === "running") {
      const modelTag = current.rewriteModel ? ` · ${compactModelName(current.rewriteModel)}` : ""
      const elapsed = formatElapsed(now - (current.startedAt || now))
      return {
        visible: true,
        tone: "info",
        text: ` ✦ rw ${spin} ${phaseLabel(current.phase)}${modelTag} · ${elapsed}${bgSuffix} `,
        current,
        othersRunning,
        othersReady,
        othersQuestions,
      }
    }

    if (current?.stage === "questions" && current.grill) {
      const count = current.grill.questions?.length ?? 0
      return {
        visible: true,
        tone: "warning",
        text: ` ✦ rw ? ${count} question${count === 1 ? "" : "s"} · /rw${bgSuffix} `,
        current,
        othersRunning,
        othersReady,
        othersQuestions,
      }
    }

    if (current?.stage === "review" && current.proposal) {
      const route = current.selectedModelOverride ?? current.proposal.route
      const modelHint = route ? ` · ★ ${compactModelName(modelRef(route))}` : ""
      const costHint = current.windowCostUSD > 0 ? ` · ${formatCostUsd(current.windowCostUSD, current.windowEstimated)}` : ""
      return {
        visible: true,
        tone: "success",
        text: ` ✦ rw ✓ ready${modelHint}${costHint} · /rw${bgSuffix} `,
        current,
        othersRunning,
        othersReady,
        othersQuestions,
      }
    }

    if (current?.stage === "error" && current.error) {
      return {
        visible: true,
        tone: "error",
        text: ` ✦ rw ! failed · /rw-last${bgSuffix} `,
        current,
        othersRunning,
        othersReady,
        othersQuestions,
      }
    }

    if (othersRunning.length > 0) {
      const first = othersRunning[0]
      const elapsed = formatElapsed(now - (first.startedAt || now))
      const modelTag = first.rewriteModel ? ` · ${compactModelName(first.rewriteModel)}` : ""
      const extra = othersRunning.length > 1 ? ` (+${othersRunning.length - 1})` : ""
      return {
        visible: true,
        tone: "info",
        text: ` ✦ rw ${spin} ${phaseLabel(first.phase)} (${first.label}${extra})${modelTag} · ${elapsed} `,
        current,
        othersRunning,
        othersReady,
        othersQuestions,
      }
    }

    if (othersQuestions.length > 0 || othersReady.length > 0) {
      return {
        visible: true,
        tone: othersReady.length > 0 ? "success" : "warning",
        text: ` ✦ rw [${bgParts.join(", ")} in other window] `,
        current,
        othersRunning,
        othersReady,
        othersQuestions,
      }
    }

    return {
      visible: false,
      tone: "muted",
      text: "",
      current,
      othersRunning,
      othersReady,
      othersQuestions,
    }
  }

  function setDefaultRewriteModel(refString) {
    defaultRewriteModel = refString || null
    notify()
  }

  function getDefaultRewriteModel() {
    return defaultRewriteModel
  }

  return {
    get,
    ensure,
    setDraft,
    beginRun,
    applyProgress,
    applyGrillResult,
    selectOption,
    setCustomAnswer,
    buildAnswersPayload,
    applyProposalResult,
    setEditedText,
    toggleApplyRoute,
    setModelOverride,
    setDefaultRewriteModel,
    getDefaultRewriteModel,
    applyError,
    applyCancelled,
    clearProposal,
    resetToDraft,
    hydrateServerJobs,
    hasRunning,
    listWindows,
    getFooterSummary,
  }
}
