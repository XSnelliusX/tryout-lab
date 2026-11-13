import { createMemo, createSignal, For, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import { Rewrite } from "./rpc.js"
import { compactModelName, modelRef, parseInvocation } from "./core.js"
import {
  createRewriteStore,
  formatCostUsd,
  formatElapsed,
  formatTokensCompact,
  formatUsageLine,
  phaseLabel,
  SPINNER_FRAMES,
} from "./store.js"
import { resolvePalette } from "./theme.js"

const unbox = (value: any) => value?.data ?? value
const errMessage = (error: any) => error?.message ?? "The rewrite failed. Nothing was submitted."

function formatAge(ms: number) {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function formatPrice1M(price?: number) {
  if (typeof price !== "number" || !Number.isFinite(price)) return ""
  if (price === 0) return "$0"
  if (price < 0.1) return `$${price.toFixed(3)}/1M`
  if (price < 10) return `$${price.toFixed(2)}/1M`
  return `$${price.toFixed(1)}/1M`
}

function formatBenchChip(b: any) {
  if (!b || typeof b !== "object") return ""
  const parts: string[] = []
  if (typeof b.perfScore === "number") parts.push(`perf ${b.estimated ? "~" : ""}${b.perfScore.toFixed(1)}`)
  if (typeof b.codingScore === "number") parts.push(`code ${b.codingScore.toFixed(1)}`)
  const p = formatPrice1M(b.blended3to1Per1M)
  if (p) parts.push(p)
  if (typeof b.balanceScore === "number") parts.push(`bal ${Math.round(b.balanceScore)}`)
  if (typeof b.outputSpeed === "number") parts.push(`${Math.round(b.outputSpeed)}t/s`)
  return parts.join(" · ")
}

function cycleFocus<T extends string>(items: readonly T[], current: string, delta: 1 | -1): T {
  if (items.length === 0) return current as T
  const idx = items.indexOf(current as T)
  if (idx === -1) return delta > 0 ? items[0] : items[items.length - 1]
  return items[(idx + delta + items.length) % items.length]
}

function truncateText(text: string, maxCols: number) {
  if (!text) return ""
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= maxCols) return clean
  return maxCols > 1 ? `${clean.slice(0, maxCols - 1)}…` : clean.slice(0, maxCols)
}

/**
 * Fires actions on mouseUp (with stopPropagation + microtask/timer defer) rather than mouseDown
 * so dialog size/stage changes never shift bounds under an active pointer press and leak
 * the matching mouseUp onto OpenCode's backdrop close handler.
 */
function pressHandlers(
  onPress: (() => void) | undefined,
  opts?: { isDisabled?: () => boolean; isDisposed?: () => boolean; onHover?: (v: boolean) => void },
) {
  return {
    onMouseOver: () => {
      if (!opts?.isDisabled?.()) opts?.onHover?.(true)
    },
    onMouseOut: () => opts?.onHover?.(false),
    onMouseDown: (e: any) => {
      e?.stopPropagation?.()
    },
    onMouseUp: (e: any) => {
      e?.stopPropagation?.()
      if (opts?.isDisabled?.() || !onPress) return
      if (typeof e?.button === "number" && e.button !== 0) return
      setTimeout(() => {
        if (!opts?.isDisposed?.()) onPress()
      }, 0)
    },
  }
}

function scrollBoxToY(scrollEl: any, y: number) {
  if (!scrollEl) return
  try {
    const nextY = Math.max(0, y)
    if (typeof scrollEl.scrollTo === "function") scrollEl.scrollTo(nextY)
    else if ("scrollTop" in scrollEl) scrollEl.scrollTop = nextY
  } catch {}
}

function ActionButton(props: {
  label: string
  shortcut?: string
  variant?: "primary" | "success" | "warning" | "danger" | "secondary" | "ghost"
  active?: boolean
  focused?: boolean
  disabled?: boolean
  palette: any
  onPress: () => void
}) {
  const [hovered, setHovered] = createSignal(false)
  const palette = () => props.palette
  const isLit = () => !props.disabled && (hovered() || Boolean(props.focused))

  const colors = () => {
    const p = palette()
    const lit = isLit()
    const active = Boolean(props.active)
    const hoverBg = p.bgHover ?? p.bgElevated ?? p.bgPanel
    if (props.disabled) return { fg: p.textFaint, keyFg: p.textFaint, bg: undefined }
    if (props.variant === "primary") {
      return {
        fg: p.textActionPrimary,
        keyFg: p.textActionPrimary,
        bg: lit ? p.borderActive ?? p.accent : p.bgActionPrimary,
      }
    }
    if (props.variant === "success") {
      return {
        fg: p.success,
        keyFg: p.success,
        bg: lit || active ? p.bgBadgeSuccess ?? hoverBg : p.bgPanel,
      }
    }
    if (props.variant === "warning") {
      return {
        fg: p.warning,
        keyFg: p.warning,
        bg: lit || active ? p.bgBadgeWarning ?? hoverBg : p.bgPanel,
      }
    }
    if (props.variant === "danger") {
      return {
        fg: p.error,
        keyFg: p.error,
        bg: lit || active ? p.bgBadgeError ?? hoverBg : undefined,
      }
    }
    if (lit || active) {
      return { fg: p.accent, keyFg: p.accent, bg: hoverBg }
    }
    if (props.variant === "ghost") {
      return { fg: p.textMuted, keyFg: p.textMuted, bg: undefined }
    }
    return { fg: p.textBase, keyFg: p.accent, bg: p.bgPanel }
  }

  return (
    <box
      flexDirection="row"
      gap={1}
      backgroundColor={colors().bg}
      paddingX={1}
      {...pressHandlers(() => props.onPress(), { isDisabled: () => Boolean(props.disabled), onHover: setHovered })}
    >
      <Show when={props.focused}>
        <text fg={colors().keyFg} bold>▸</text>
      </Show>
      <Show when={props.shortcut}>
        <text fg={colors().keyFg} bold={isLit() || props.variant === "primary"}>
          {`[${props.shortcut}]`}
        </text>
      </Show>
      <text fg={colors().fg} bold={isLit() || props.variant === "primary" || props.active}>
        {props.label}
      </text>
    </box>
  )
}

function PillChip(props: {
  label: string
  color?: string
  borderColor?: string
  bg?: string
  bold?: boolean
  active?: boolean
  focused?: boolean
  disabled?: boolean
  palette: any
  onPress?: () => void
}) {
  const [hovered, setHovered] = createSignal(false)
  const isLit = () => !props.disabled && (hovered() || Boolean(props.focused))
  const hoverBg = () => props.palette.bgHover ?? props.palette.bgElevated ?? props.palette.bgBadgeInfo ?? props.palette.bgPanel

  return (
    <box
      backgroundColor={
        props.disabled
          ? undefined
          : isLit() || props.active
            ? props.bg ?? hoverBg()
            : props.palette.bgPanel
      }
      paddingX={1}
      {...pressHandlers(() => props.onPress?.(), {
        isDisabled: () => Boolean(props.disabled || !props.onPress),
        onHover: setHovered,
      })}
    >
      <text
        fg={
          props.disabled
            ? props.palette.textFaint
            : isLit()
              ? (props.color && props.color !== props.palette.textMuted ? props.color : props.palette.accent)
              : props.color ?? props.palette.textBase
        }
        bold={isLit() || props.bold || props.active}
      >
        {props.focused ? "▸ " : ""}{props.label}
      </text>
    </box>
  )
}

function Stepper(props: { stage: string; flowMode: string; compact?: boolean; palette: any }) {
  const p = () => props.palette
  const stepIndex = () => {
    if (props.stage === "draft") return 1
    if (props.stage === "questions") return 2
    if (props.stage === "review") return 3
    if (props.stage === "running") return 2
    return 1
  }
  const colorFor = (idx: number) => {
    const cur = stepIndex()
    if (idx < cur) return p().success
    if (idx === cur) return p().accent
    return p().textMuted
  }
  return (
    <box flexDirection="row" gap={1}>
      <text fg={colorFor(1)} bold={stepIndex() === 1}>1 Draft</text>
      <text fg={p().textFaint}>›</text>
      <text fg={colorFor(2)} bold={stepIndex() === 2}>
        {props.flowMode === "direct" ? "2 Analyze" : props.compact ? "2 Grill" : "2 Grill Me"}
      </text>
      <text fg={p().textFaint}>›</text>
      <text fg={colorFor(3)} bold={stepIndex() === 3}>
        {props.compact ? "3 Review" : "3 Review & Model"}
      </text>
    </box>
  )
}

export default {
  id: "prompt-rewrite.tui",
  setup(api: any) {
    const rpc = api.client.rpc(Rewrite)
    let disposed = false
    const palette = () => resolvePalette(api.theme)

    const [storeTick, setStoreTick] = createSignal(0)
    const [nowMs, setNowMs] = createSignal(Date.now())
    const [dialogOpen, setDialogOpen] = createSignal(false)
    const [dialogTargetKey, setDialogTargetKey] = createSignal<string | undefined>(undefined)
    const [subView, setSubView] = createSignal<"main" | "models" | "sessions">("main")
    const [sessionsCursor, setSessionsCursor] = createSignal(0)
    const [cachedModels, setCachedModels] = createSignal<any[]>([])
    const [defaultRewriteModel, setDefaultRewriteModel] = createSignal<string | null>(null)

    const store = createRewriteStore(() => setStoreTick((n) => n + 1))
    const localRequests = new Set<string>()
    const discardedRequests = new Set<string>()
    const submittingTargets = new Set<string>()
    let dialogSeq = 0
    let closingMode: "background" | "discard" | "keep" | null = null
    let openedSessionsFromMain = false
    let syncModalViewState: (() => void) | undefined

    const rememberDiscarded = (requestID?: string) => {
      if (!requestID) return
      discardedRequests.add(requestID)
      if (discardedRequests.size > 200) {
        const oldest = discardedRequests.values().next().value
        if (oldest !== undefined) discardedRequests.delete(oldest)
      }
    }

    const findCachedBench = (refOrStr: any) => {
      const refStr = typeof refOrStr === "string" ? refOrStr : refOrStr ? modelRef(refOrStr) : ""
      if (!refStr) return null
      const bare = refStr.split("#")[0]
      const found = cachedModels().find((m) => `${m.providerID}/${m.id}` === bare)
      return found?.benchmark ?? null
    }

    const effectiveBaseModel = () => defaultRewriteModel() ?? store.getDefaultRewriteModel()

    let ticker: any
    const syncTicker = () => {
      if (disposed) return
      if (store.hasRunning()) {
        if (!ticker) {
          setNowMs(Date.now())
          ticker = setInterval(() => setNowMs(Date.now()), 150)
        }
      } else if (ticker) {
        clearInterval(ticker)
        ticker = undefined
      }
    }

    const requestOptions = (sessionID?: string) => {
      const route = api.ui.router.current()
      const id = sessionID ?? (route?.type === "session" ? route.sessionID : undefined)
      return {
        location: (id && api.data?.session?.get?.(id)?.location) || api.location || api.data?.location?.default?.(),
      }
    }

    const currentTarget = () => {
      const route = api.ui.router.current()
      if (route?.type === "session" && route.sessionID) {
        const title = api.data?.session?.get?.(route.sessionID)?.title
        const label = typeof title === "string" && title.trim()
          ? title.trim().slice(0, 28)
          : `Session ${route.sessionID.slice(0, 8)}`
        return {
          targetKey: `session:${route.sessionID}`,
          sessionID: route.sessionID,
          label,
        }
      }
      if (route?.type === "home") {
        const dir = requestOptions().location?.directory ?? "default"
        return {
          targetKey: `home:${dir}`,
          sessionID: undefined,
          label: "Start screen",
        }
      }
      return undefined
    }

    const selectedModel = () => {
      const selected = api.ui.model?.current?.()
      return selected?.providerID && selected?.modelID
        ? { providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) }
        : undefined
    }

    const toast = (text: string, variant = "info") => {
      try {
        api.ui.toast.show({ title: "/rewrite", message: text, variant })
      } catch {}
    }

    const canAppendToComposer = () =>
      typeof api.client?.tui?.appendPrompt === "function" || typeof api.ui?.prompt?.append === "function"

    async function insertIntoComposer(text: string) {
      try {
        if (typeof api.client?.tui?.appendPrompt === "function") {
          await api.client.tui.appendPrompt({ body: { text } })
        } else if (typeof api.ui?.prompt?.append === "function") {
          await api.ui.prompt.append(text)
        } else {
          toast("Prompt composer insertion is not supported in this host.", "warning")
          return false
        }
        toast("Inserted rewritten prompt into composer.", "success")
        return true
      } catch (error) {
        toast(errMessage(error), "error")
        return false
      }
    }

    async function loadModelsIfNeeded(sessionID?: string) {
      if (cachedModels().length > 0 && defaultRewriteModel()) return
      try {
        const res = unbox(await rpc.models({}, requestOptions(sessionID)))
        if (Array.isArray(res?.models)) setCachedModels(res.models)
        if (res?.defaultRewriteModel) {
          setDefaultRewriteModel(res.defaultRewriteModel)
          store.setDefaultRewriteModel(res.defaultRewriteModel)
        }
      } catch {}
    }

    async function hydrateCompletedTarget(targetKey: string, requestID?: string) {
      if (disposed || (requestID && discardedRequests.has(requestID))) return
      try {
        const entry = store.get(targetKey)
        const res = unbox(
          await rpc.inspect(
            { targetKey, ...(requestID ? { requestID } : {}) },
            requestOptions(entry?.sessionID ?? undefined),
          ),
        )
        if (disposed || (requestID && discardedRequests.has(requestID))) return
        if (res?.kind === "proposal" && res.proposal) {
          store.applyProposalResult(targetKey, { ...res.proposal, targetKey })
          syncTicker()
        } else if (res?.kind === "grill" && res.grill) {
          store.applyGrillResult(targetKey, { ...res.grill, targetKey })
          syncTicker()
        } else {
          await refreshServerJobs()
        }
      } catch {}
    }

    async function refreshServerJobs() {
      try {
        const snap = unbox(await rpc.jobs({}, requestOptions()))
        if (disposed) return
        store.reconcileServerJobs(snap, localRequests)
        for (const recent of snap?.recent ?? []) {
          if (!recent?.targetKey || (recent.requestID && discardedRequests.has(recent.requestID))) continue
          if (recent.status === "ready" || recent.status === "questions") {
            const cur = store.get(recent.targetKey)
            const alreadyHave =
              (recent.status === "ready" && cur?.stage === "review" && cur?.proposal?.id === recent.requestID) ||
              (recent.status === "questions" && cur?.stage === "questions" && cur?.grill?.id === recent.requestID)
            if (!alreadyHave && (!cur || cur.stage === "idle" || cur.hydrated)) {
              void hydrateCompletedTarget(recent.targetKey, recent.requestID)
            }
          }
        }
        syncTicker()
      } catch {}
    }

    // Subscribe to live server RPC progress events so window switches stay updated.
    const unsubProgress = rpc.events?.on?.("progress", (event: any) => {
      if (disposed) return
      const data = event?.data ?? event
      if (data?.requestID && discardedRequests.has(data.requestID)) return
      store.applyProgress(data)
      if (
        (data?.status === "ready" || data?.status === "questions") &&
        data?.targetKey &&
        data?.requestID &&
        !localRequests.has(data.requestID)
      ) {
        void hydrateCompletedTarget(data.targetKey, data.requestID)
      }
      syncTicker()
    })

    // Sync any already-running or completed server jobs on startup.
    void refreshServerJobs()

    async function startGrill(
      target: { targetKey: string; sessionID?: string; label: string },
      text: string,
      rewriteModel?: string,
      opts?: { openDialog?: boolean },
    ) {
      const requestID = globalThis.crypto.randomUUID()
      const options = requestOptions(target.sessionID)
      localRequests.add(requestID)
      store.beginRun(target.targetKey, {
        requestID,
        phase: "grilling",
        detail: "Analyzing draft & session context",
        model: rewriteModel,
        draftText: text,
        flowMode: "grill",
        sessionID: target.sessionID ?? null,
        label: target.label,
      })
      syncTicker()
      if (opts?.openDialog !== false && currentTarget()?.targetKey === target.targetKey) {
        openStudio(target.targetKey, "main")
      }

      try {
        const curModel = !target.sessionID ? selectedModel() : undefined
        const raw = await rpc.grill(
          {
            targetKey: target.targetKey,
            ...(target.sessionID ? { sessionID: target.sessionID } : curModel ? { currentModel: curModel } : {}),
            text,
            ...(rewriteModel ? { model: rewriteModel } : {}),
            requestID,
          },
          options,
        )
        const result = unbox(raw)
        if (disposed || discardedRequests.has(requestID)) return
        if (Array.isArray(result?.availableModels)) setCachedModels(result.availableModels)
        if (result?.defaultRewriteModel) setDefaultRewriteModel(result.defaultRewriteModel)

        if (!result?.questions?.length || result.readyWithoutQuestions) {
          // Prompt is already sharp -> flow straight into generating the improved prompt without stealing focus if backgrounded.
          store.applyGrillResult(target.targetKey, result)
          syncTicker()
          await startRewrite(target, {
            text,
            rewriteModel,
            grillID: result.id,
            answers: [],
            openDialog: false,
          })
          return
        }

        store.applyGrillResult(target.targetKey, result)
        syncTicker()
        if (!dialogOpen() || dialogTargetKey() !== target.targetKey || currentTarget()?.targetKey !== target.targetKey) {
          toast(`Clarifying questions ready for ${target.label}. Run /rw to answer.`, "info")
        }
      } catch (error: any) {
        if (disposed || discardedRequests.has(requestID)) return
        const msg = errMessage(error)
        if (/cancelled/i.test(msg)) {
          store.applyCancelled(target.targetKey, requestID)
        } else {
          store.applyError(target.targetKey, requestID, msg)
          toast(`${msg} Your draft is preserved in /rw-last.`, "error")
        }
        syncTicker()
      } finally {
        localRequests.delete(requestID)
      }
    }

    async function startRewrite(
      target: { targetKey: string; sessionID?: string; label: string },
      params: {
        text: string
        rewriteModel?: string
        grillID?: string
        answers?: any[]
        previousRewrite?: string
        refineInstruction?: string
        openDialog?: boolean
      },
    ) {
      const requestID = globalThis.crypto.randomUUID()
      const options = requestOptions(target.sessionID)
      const isRefine = Boolean(params.refineInstruction?.trim())
      localRequests.add(requestID)
      store.beginRun(target.targetKey, {
        requestID,
        phase: isRefine ? "refining" : "rewriting",
        detail: isRefine ? "Refining improved prompt" : "Crafting improved prompt & evaluating models",
        model: params.rewriteModel,
        draftText: params.text,
        flowMode: params.grillID ? "grill" : "direct",
        sessionID: target.sessionID ?? null,
        label: target.label,
        keepPrevious: isRefine || Boolean(params.grillID),
      })
      syncTicker()
      if (params.openDialog && currentTarget()?.targetKey === target.targetKey) {
        openStudio(target.targetKey, "main")
      }

      try {
        const curModel = !target.sessionID ? selectedModel() : undefined
        const raw = await rpc.rewrite(
          {
            targetKey: target.targetKey,
            ...(target.sessionID ? { sessionID: target.sessionID } : curModel ? { currentModel: curModel } : {}),
            text: params.text,
            ...(params.rewriteModel ? { model: params.rewriteModel } : {}),
            ...(params.grillID ? { grillID: params.grillID } : {}),
            ...(params.answers?.length ? { answers: params.answers } : {}),
            ...(params.previousRewrite ? { previousRewrite: params.previousRewrite } : {}),
            ...(params.refineInstruction ? { refineInstruction: params.refineInstruction } : {}),
            requestID,
          },
          options,
        )
        const proposal = { ...unbox(raw), targetKey: target.targetKey }
        if (disposed || discardedRequests.has(requestID)) return
        if (Array.isArray(proposal?.availableModels)) setCachedModels(proposal.availableModels)
        if (proposal?.defaultRewriteModel) setDefaultRewriteModel(proposal.defaultRewriteModel)
        store.applyProposalResult(target.targetKey, proposal)
        syncTicker()

        if (!dialogOpen() || dialogTargetKey() !== target.targetKey || currentTarget()?.targetKey !== target.targetKey) {
          toast(`Improved prompt ready for ${target.label}. Run /rw to review.`, "success")
        }
      } catch (error: any) {
        if (disposed || discardedRequests.has(requestID)) return
        const msg = errMessage(error)
        if (/cancelled/i.test(msg)) {
          store.applyCancelled(target.targetKey, requestID)
        } else {
          store.applyError(target.targetKey, requestID, msg)
          toast(`${msg} Your draft is preserved in /rw-last.`, "error")
        }
        syncTicker()
      } finally {
        localRequests.delete(requestID)
      }
    }

    async function cancelWindow(targetKey: string) {
      const entry = store.get(targetKey)
      if (!entry || entry.stage !== "running" || !entry.requestID) return false
      try {
        const res = unbox(await rpc.cancel({ requestID: entry.requestID, targetKey }, requestOptions(entry.sessionID ?? undefined)))
        store.applyCancelled(targetKey, entry.requestID)
        syncTicker()
        return Boolean(res?.cancelled)
      } catch (error) {
        store.applyCancelled(targetKey, entry.requestID)
        syncTicker()
        toast(errMessage(error), "error")
        return false
      }
    }

    async function discardWindow(targetKey: string) {
      const entry = store.get(targetKey)
      const requestID = entry?.requestID
      if (requestID) rememberDiscarded(requestID)
      store.removeWindow(targetKey)
      syncTicker()
      try {
        await rpc.dismiss(
          { targetKey, ...(requestID ? { requestID } : {}) },
          requestOptions(entry?.sessionID ?? undefined),
        )
      } catch {}
    }

    async function submitProposal(targetKey: string, textToSend: string, applyModelSwitch: boolean) {
      if (submittingTargets.has(targetKey)) return
      const entry = store.get(targetKey)
      const result = entry?.proposal
      if (!result) return
      const cur = currentTarget()
      if (cur?.targetKey !== result.targetKey) {
        toast("Active window changed. Return to that session/location and run /rw-last; nothing was submitted.", "warning")
        return
      }
      if (!result.sessionID && result.startModel && selectedModel() && modelRef(selectedModel()) !== modelRef(result.startModel)) {
        toast("The starting model changed during review. Re-run /rw with the new selection; nothing was submitted.", "warning")
        return
      }

      const targetModel = entry.selectedModelOverride ?? result.route
      submittingTargets.add(targetKey)

      let sent: any
      try {
        const payload: any = {
          resultID: result.id,
          text: textToSend,
          applyRoute: Boolean(applyModelSwitch && targetModel),
        }
        if (applyModelSwitch && entry.selectedModelOverride) {
          payload.selectedModel = entry.selectedModelOverride
        }
        sent = unbox(await rpc.submit(payload, requestOptions(result.sessionID ?? undefined)))
      } catch (error) {
        submittingTargets.delete(targetKey)
        toast(errMessage(error), "error")
        openStudio(targetKey, "main", { force: true })
        return
      }

      submittingTargets.delete(targetKey)
      store.removeWindow(targetKey)
      syncTicker()
      closingMode = "keep"
      setDialogOpen(false)
      api.ui.dialog.clear()
      if (!result.sessionID) {
        await api.data?.session?.sync?.(sent.sessionID).catch(() => {})
        api.ui.router.navigate({ type: "session", sessionID: sent.sessionID })
      }
      const msg = sent.switched
        ? (sent.queued ? "Switched model & queued prompt." : "Switched model & submitted prompt.")
        : (sent.queued ? "Prompt queued with current model." : "Prompt submitted.")
      toast(msg, "success")
    }

    function openFromFooter() {
      if (disposed) return
      void refreshServerJobs()
      const target = currentTarget()
      const cur = target ? store.get(target.targetKey) : undefined
      const curHasWork = Boolean(
        cur &&
          (cur.stage === "running" ||
            cur.stage === "review" ||
            cur.stage === "questions" ||
            cur.stage === "error" ||
            (cur.stage === "draft" && Boolean(cur.draftText?.trim()))),
      )
      if (curHasWork && cur) {
        openStudio(cur.targetKey, "main", { force: true })
        return
      }
      const active = store.listActiveWindows()
      if (active.length > 0) {
        openedSessionsFromMain = false
        openStudio(target?.targetKey ?? active[0].targetKey, "sessions", { force: true })
        return
      }
      if (!target) {
        toast("Use /rw from the start screen or inside a session.", "warning")
        return
      }
      store.ensure(target.targetKey, { sessionID: target.sessionID ?? null, label: target.label })
      store.setDraft(target.targetKey, {
        stage: "draft",
        sessionID: target.sessionID ?? null,
        label: target.label,
      })
      openStudio(target.targetKey, "main", { force: true })
    }

    function openStudio(targetKey: string, initialSubView: "main" | "sessions" = "main", opts?: { force?: boolean }) {
      if (disposed) return
      const targetChanged = dialogTargetKey() !== targetKey
      setDialogTargetKey(targetKey)
      setSubView(initialSubView)
      if (initialSubView === "sessions") setSessionsCursor(0)
      else openedSessionsFromMain = false
      if (targetChanged) syncModalViewState?.()
      const entry = targetKey ? store.get(targetKey) : undefined
      void loadModelsIfNeeded(entry?.sessionID ?? undefined)

      if (dialogOpen() && !opts?.force) return
      closingMode = null
      const mySeq = ++dialogSeq
      setDialogOpen(true)

      const width = api.renderer?.width ?? 100
      const termH = () => Math.max(22, api.renderer?.height ?? 36)
      const dialogSize = width >= 124 ? "xlarge" : width >= 92 ? "large" : "medium"
      const dialogCols = () => (dialogSize === "xlarge" ? 112 : dialogSize === "large" ? 84 : 56)
      const isNarrow = () => dialogCols() < 76
      const isShort = () => termH() < 28

      api.ui.dialog.show(
        () => {
          const [modelPickerPurpose, setModelPickerPurpose] = createSignal<"rewrite" | "session">("rewrite")
          const [modelFilter, setModelFilter] = createSignal("")
          const [modelCursor, setModelCursor] = createSignal(0)
          const [modelFocusZone, setModelFocusZone] = createSignal<"filter" | "default" | "list" | "back">("filter")
          const [modelVariantIdx, setModelVariantIdx] = createSignal(-1)

          const [draftFocus, setDraftFocus] = createSignal<string>("editor")
          const [runningFocus, setRunningFocus] = createSignal<"bg" | "cancel" | "discard">("bg")

          const [focusedQ, setFocusedQ] = createSignal(0)
          const [editingQId, setEditingQId] = createSignal<string | undefined>(undefined)
          const [qFocusZone, setQFocusZone] = createSignal<"list" | "actions">("list")
          const [qOptIdx, setQOptIdx] = createSignal(0)
          const [qActionFocus, setQActionFocus] = createSignal<"generate" | "skip" | "draft" | "bg" | "discard">("generate")

          const [reviewTab, setReviewTab] = createSignal<"preview" | "edit" | "compare">("preview")
          const [refiningOpen, setRefiningOpen] = createSignal(false)
          const [refineText, setRefineText] = createSignal("")
          const [confirmSwitchOpen, setConfirmSwitchOpen] = createSignal(false)
          const [reviewFocus, setReviewFocus] = createSignal<string>("send")
          const [errorFocus, setErrorFocus] = createSignal<"retry" | "draft" | "bg" | "discard">("retry")

          let draftEditor: any
          let promptEditor: any
          let refineEditor: any
          let qEditor: any
          let filterEditor: any
          let previewScroll: any
          let grillScroll: any
          let modelsScroll: any
          let sessionsScroll: any

          syncModalViewState = () => {
            setReviewTab("preview")
            setRefiningOpen(false)
            setRefineText("")
            setConfirmSwitchOpen(false)
            setFocusedQ(0)
            setEditingQId(undefined)
            setQFocusZone("list")
            setQOptIdx(0)
            setQActionFocus("generate")
            setRunningFocus("bg")
            setErrorFocus("retry")
            setReviewFocus("send")
            setDraftFocus("editor")
          }
          onCleanup(() => {
            syncModalViewState = undefined
          })

          const activeEntry = createMemo(() => {
            storeTick()
            const key = dialogTargetKey()
            return key ? store.get(key) : undefined
          })

          const activeWindowsList = createMemo(() => {
            storeTick()
            return store.listActiveWindows()
          })

          const selectedSessionIdx = () =>
            Math.max(0, Math.min(sessionsCursor(), Math.max(0, activeWindowsList().length - 1)))

          const isTyping = createMemo(() => {
            if (subView() === "models") return modelFocusZone() === "filter"
            if (subView() === "sessions") return false
            const e = activeEntry()
            if (!e) return false
            if (e.stage === "draft") return draftFocus() === "editor"
            if (e.stage === "questions" && editingQId()) return true
            if (e.stage === "review") {
              if (reviewTab() === "edit" && reviewFocus() === "editor-edit") return true
              if (refiningOpen() && reviewFocus() === "refine-input") return true
            }
            return false
          })

          const p = () => palette()

          const hasPreservableWork = (e: any) => {
            if (!e) return false
            if (e.stage === "running" || e.stage === "questions" || e.stage === "review" || e.stage === "error") return true
            if (e.stage === "draft" && Boolean(e.draftText?.trim())) return true
            return false
          }

          const setConfirmOpen = (open: boolean) => {
            setConfirmSwitchOpen(open)
            setReviewFocus(open ? "confirm-send" : "send")
          }

          const flushPendingTextEdits = () => {
            const e = activeEntry()
            if (!e) return
            if (e.stage === "draft" && draftEditor && typeof draftEditor.plainText === "string") {
              store.setDraft(e.targetKey, { draftText: draftEditor.plainText })
            } else if (e.stage === "review" && reviewTab() === "edit" && promptEditor && typeof promptEditor.plainText === "string") {
              store.setEditedText(e.targetKey, promptEditor.plainText)
            } else if (e.stage === "questions" && editingQId() && qEditor && typeof qEditor.plainText === "string") {
              store.setCustomAnswer(e.targetKey, editingQId()!, qEditor.plainText)
            }
          }

          const scrollModelIntoView = (idx: number, list: any[]) => {
            let y = 0
            for (let i = 0; i < idx && i < list.length; i++) {
              const m = list[i]
              y += m.benchmark || (m.variants?.length ?? 0) > 0 ? 2 : 1
            }
            scrollBoxToY(modelsScroll, Math.max(0, y - 2))
          }

          const scrollGrillIntoView = (qIdx: number, questions: any[]) => {
            let y = 0
            for (let i = 0; i < qIdx && i < questions.length; i++) {
              const q = questions[i]
              y += 3 + (q.options?.length ?? 0) + (q.why ? 1 : 0)
            }
            scrollBoxToY(grillScroll, Math.max(0, y - 1))
          }

          const openModels = (purpose: "rewrite" | "session") => {
            flushPendingTextEdits()
            setConfirmOpen(false)
            setModelPickerPurpose(purpose)
            setModelFilter("")
            setModelCursor(0)
            setModelVariantIdx(-1)
            setModelFocusZone("filter")
            setSubView("models")
            void loadModelsIfNeeded(activeEntry()?.sessionID ?? undefined)
            queueMicrotask(() => filterEditor?.focus?.())
          }

          const openSessionsList = () => {
            flushPendingTextEdits()
            openedSessionsFromMain = subView() === "main" && Boolean(activeEntry())
            setConfirmOpen(false)
            setEditingQId(undefined)
            setSessionsCursor(0)
            setSubView("sessions")
            void refreshServerJobs()
          }

          const inspectWindow = (targetKey: string) => {
            openedSessionsFromMain = false
            syncModalViewState?.()
            setDialogTargetKey(targetKey)
            setSubView("main")
            const targetEntry = store.get(targetKey)
            if (targetEntry?.stage === "draft") {
              setDraftFocus("editor")
              queueMicrotask(() => draftEditor?.focus?.())
            }
          }

          const openCurrentDraftFromSessions = () => {
            const target = currentTarget()
            if (!target) {
              toast("Use /rw from the start screen or inside a session.", "warning")
              return
            }
            const existing = store.ensure(target.targetKey, { sessionID: target.sessionID ?? null, label: target.label })
            if (existing.stage === "idle") {
              store.setDraft(target.targetKey, {
                stage: "draft",
                sessionID: target.sessionID ?? null,
                label: target.label,
              })
            }
            inspectWindow(target.targetKey)
          }

          const filteredModels = createMemo(() => {
            const q = modelFilter().trim().toLowerCase()
            const base = effectiveBaseModel()
            const purpose = modelPickerPurpose()
            const list = cachedModels().filter((m) =>
              !q || `${m.providerID}/${m.id} ${m.name ?? ""} ${m.family ?? ""}`.toLowerCase().includes(q),
            )
            return list.slice().sort((a, b) => {
              const aDep = a.benchmark?.deprecated ? 1 : 0
              const bDep = b.benchmark?.deprecated ? 1 : 0
              if (aDep !== bDep) return aDep - bDep
              if (purpose === "rewrite" && base) {
                const aBase = base.startsWith(`${a.providerID}/${a.id}`) ? 1 : 0
                const bBase = base.startsWith(`${b.providerID}/${b.id}`) ? 1 : 0
                if (aBase !== bBase) return bBase - aBase
              }
              const aBal = typeof a.benchmark?.balanceScore === "number" ? a.benchmark.balanceScore : -1
              const bBal = typeof b.benchmark?.balanceScore === "number" ? b.benchmark.balanceScore : -1
              if (aBal !== bBal) return bBal - aBal
              return `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`)
            })
          })

          const closeModalToBackground = () => {
            flushPendingTextEdits()
            closingMode = "background"
            setDialogOpen(false)
            api.ui.dialog.clear()
          }

          const closeDialogUIOnly = () => {
            closingMode = "keep"
            setDialogOpen(false)
            api.ui.dialog.clear()
          }

          const closeAndKillWindow = (targetKey?: string) => {
            const key = targetKey ?? activeEntry()?.targetKey ?? dialogTargetKey()
            closingMode = "discard"
            setDialogOpen(false)
            api.ui.dialog.clear()
            if (key) void discardWindow(key)
          }

          const handleInsertToComposer = async (e: any) => {
            if (!e?.proposal) return
            const txt = ((reviewTab() === "edit" ? promptEditor?.plainText : undefined) ?? e.editedText ?? e.proposal.text).trim()
            const ok = await insertIntoComposer(txt)
            if (ok) {
              closeDialogUIOnly()
              void discardWindow(e.targetKey)
            }
          }

          const triggerStartFromDraft = () => {
            const e = activeEntry()
            if (!e) return
            const text = (draftEditor?.plainText ?? e.draftText ?? "").trim()
            if (!text) {
              toast("Enter a prompt first before rewriting.", "warning")
              return
            }
            store.setDraft(e.targetKey, { draftText: text })
            const target = { targetKey: e.targetKey, sessionID: e.sessionID ?? undefined, label: e.label }
            if (e.flowMode === "direct") {
              void startRewrite(target, { text, rewriteModel: e.rewriteModel, openDialog: true })
            } else {
              void startGrill(target, text, e.rewriteModel, { openDialog: true })
            }
          }

          const triggerGenerateFromGrill = (skipAnswers = false) => {
            const e = activeEntry()
            if (!e?.grill) return
            flushPendingTextEdits()
            const answers = skipAnswers ? [] : store.buildAnswersPayload(e.targetKey)
            setEditingQId(undefined)
            setQFocusZone("list")
            setConfirmOpen(false)
            setRefiningOpen(false)
            setReviewTab("preview")
            setReviewFocus("send")
            void startRewrite(
              { targetKey: e.targetKey, sessionID: e.sessionID ?? undefined, label: e.label },
              {
                text: e.grill.original,
                rewriteModel: e.rewriteModel,
                grillID: e.grill.id,
                answers,
                openDialog: true,
              },
            )
          }

          const triggerRefine = (instruction: string) => {
            const e = activeEntry()
            const trimmed = instruction.trim()
            if (!e?.proposal || !trimmed) return
            setConfirmOpen(false)
            setRefiningOpen(false)
            setRefineText("")
            setReviewTab("preview")
            setReviewFocus("send")
            void startRewrite(
              { targetKey: e.targetKey, sessionID: e.sessionID ?? undefined, label: e.label },
              {
                text: e.proposal.original,
                rewriteModel: e.rewriteModel,
                grillID: e.proposal.grillID ?? e.grill?.id,
                answers: e.grill ? store.buildAnswersPayload(e.targetKey) : undefined,
                previousRewrite: e.editedText || e.proposal.text,
                refineInstruction: trimmed,
                openDialog: true,
              },
            )
          }

          const draftRing = (): string[] => [
            "editor",
            "mode-grill",
            "mode-direct",
            "model",
            "start",
            "bg",
            "discard",
          ]

          const moveDraftFocus = (delta: 1 | -1) => {
            const next = cycleFocus(draftRing(), draftFocus(), delta)
            setDraftFocus(next)
            if (next === "editor") queueMicrotask(() => draftEditor?.focus?.())
            else draftEditor?.blur?.()
          }

          const activateDraftFocus = () => {
            const e = activeEntry()
            if (!e) return
            switch (draftFocus()) {
              case "mode-grill":
                store.setDraft(e.targetKey, { flowMode: "grill" })
                return
              case "mode-direct":
                store.setDraft(e.targetKey, { flowMode: "direct" })
                return
              case "model":
                openModels("rewrite")
                return
              case "start":
                triggerStartFromDraft()
                return
              case "bg":
                closeModalToBackground()
                return
              case "discard":
                closeAndKillWindow(e.targetKey)
                return
            }
          }

          const modelZones = (): ("filter" | "default" | "list" | "back")[] =>
            modelPickerPurpose() === "rewrite" ? ["filter", "default", "list", "back"] : ["filter", "list", "back"]

          const moveModelZone = (delta: 1 | -1) => {
            const next = cycleFocus(modelZones(), modelFocusZone(), delta)
            setModelFocusZone(next)
            if (next === "filter") queueMicrotask(() => filterEditor?.focus?.())
            else filterEditor?.blur?.()
          }

          const applyModelSelection = (m: any, variant?: string) => {
            const e = activeEntry()
            if (!m || !e) return
            const refStr = `${m.providerID}/${m.id}${variant ? `#${variant}` : ""}`
            if (modelPickerPurpose() === "rewrite") {
              store.setDraft(e.targetKey, { rewriteModel: refStr })
            } else {
              store.setModelOverride(e.targetKey, { providerID: m.providerID, id: m.id, ...(variant ? { variant } : {}) })
            }
            setSubView("main")
          }

          const resetModelSelectionToDefault = () => {
            const e = activeEntry()
            if (e) store.setDraft(e.targetKey, { rewriteModel: undefined })
            setSubView("main")
          }

          const qActionOrder = ["generate", "skip", "draft", "bg", "discard"] as const

          const resetToDraftView = (e: any) => {
            setFocusedQ(0)
            setQFocusZone("list")
            setQOptIdx(0)
            setEditingQId(undefined)
            setConfirmOpen(false)
            setRefiningOpen(false)
            setDraftFocus("editor")
            store.resetToDraft(e.targetKey, true)
            queueMicrotask(() => draftEditor?.focus?.())
          }

          const triggerRetryError = (e: any) => {
            const text = e.draftText || e.proposal?.original
            if (!text) {
              resetToDraftView(e)
              return
            }
            const target = { targetKey: e.targetKey, sessionID: e.sessionID ?? undefined, label: e.label }
            if (e.grill?.questions?.length) {
              store.setDraft(e.targetKey, { stage: "questions" })
            } else if (e.flowMode === "direct") {
              void startRewrite(target, { text, rewriteModel: e.rewriteModel, openDialog: true })
            } else {
              void startGrill(target, text, e.rewriteModel, { openDialog: true })
            }
          }

          const switchReviewTab = (tab: "preview" | "edit" | "compare", nextFocus?: string) => {
            const e = activeEntry()
            if (reviewTab() === "edit" && tab !== "edit") {
              if (e && promptEditor && typeof promptEditor.plainText === "string") {
                store.setEditedText(e.targetKey, promptEditor.plainText)
              }
              promptEditor?.blur?.()
            }
            setConfirmOpen(false)
            setRefiningOpen(false)
            setReviewTab(tab)
            if (tab === "edit") {
              setReviewFocus(nextFocus ?? "editor-edit")
              queueMicrotask(() => promptEditor?.focus?.())
            } else if (nextFocus) {
              setReviewFocus(nextFocus)
            } else {
              setReviewFocus(tab === "compare" ? "tab-compare" : "send")
            }
          }

          const startEditPrompt = () => switchReviewTab("edit", "editor-edit")
          const finishEditPrompt = (e: any) => {
            if (e && promptEditor && typeof promptEditor.plainText === "string") {
              store.setEditedText(e.targetKey, promptEditor.plainText)
            }
            promptEditor?.blur?.()
            setReviewTab("preview")
            setReviewFocus("send")
          }

          const openCustomRefine = () => {
            switchReviewTab("preview")
            setRefiningOpen(true)
            setReviewFocus("refine-input")
            queueMicrotask(() => refineEditor?.focus?.())
          }

          const reviewRing = (e: any): string[] => {
            const targetModel = e?.selectedModelOverride ?? e?.proposal?.route
            if (confirmSwitchOpen()) return ["confirm-send", "confirm-cancel"]
            if (reviewTab() === "edit") {
              return [
                "editor-edit",
                "tab-preview",
                "tab-compare",
                "send",
                ...(canAppendToComposer() ? ["composer"] : []),
                "original",
                "bg",
                "discard",
              ]
            }
            if (refiningOpen()) return ["refine-input", "refine-apply", "refine-cancel"]
            return [
              ...(targetModel ? ["switch-toggle"] : []),
              "switch-model",
              "tab-preview",
              "tab-edit",
              "tab-compare",
              "ref-shorter",
              "ref-detail",
              "ref-tests",
              "ref-grill",
              "ref-custom",
              "send",
              ...(canAppendToComposer() ? ["composer"] : []),
              "original",
              "bg",
              "discard",
            ]
          }

          const moveReviewFocus = (delta: 1 | -1) => {
            const e = activeEntry()
            const ring = reviewRing(e)
            const next = cycleFocus(ring, reviewFocus(), delta)
            setReviewFocus(next)
            if (next === "editor-edit") queueMicrotask(() => promptEditor?.focus?.())
            else if (next === "refine-input") queueMicrotask(() => refineEditor?.focus?.())
            else {
              promptEditor?.blur?.()
              refineEditor?.blur?.()
            }
          }

          const triggerSendReview = (e: any, applyModelOverride?: boolean) => {
            if (!e?.proposal) return
            const text = ((reviewTab() === "edit" ? promptEditor?.plainText : undefined) ?? e.editedText ?? e.proposal.text).trim()
            if (!text) {
              toast("Rewritten prompt cannot be empty.", "warning")
              return
            }
            if (reviewTab() === "edit") {
              store.setEditedText(e.targetKey, text)
              promptEditor?.blur?.()
              setReviewTab("preview")
            }
            const targetModel = e.selectedModelOverride ?? e.proposal.route
            if (applyModelOverride === undefined && e.applyRoute && targetModel && !confirmSwitchOpen()) {
              setConfirmOpen(true)
              return
            }
            setConfirmOpen(false)
            void submitProposal(e.targetKey, text, applyModelOverride ?? Boolean(e.applyRoute && targetModel))
          }

          const triggerRegrill = (e: any) => {
            if (!e?.proposal) return
            setConfirmOpen(false)
            setRefiningOpen(false)
            setReviewTab("preview")
            setFocusedQ(0)
            setQOptIdx(0)
            setQFocusZone("list")
            setEditingQId(undefined)
            void startGrill(
              { targetKey: e.targetKey, sessionID: e.sessionID ?? undefined, label: e.label },
              e.editedText || e.proposal.original,
              e.rewriteModel,
              { openDialog: true },
            )
          }

          const activateReviewFocus = (focusId: string) => {
            const e = activeEntry()
            if (!e?.proposal) return
            switch (focusId) {
              case "switch-toggle":
                setConfirmOpen(false)
                store.toggleApplyRoute(e.targetKey)
                return
              case "switch-model":
                openModels("session")
                return
              case "tab-preview":
                switchReviewTab("preview", "tab-preview")
                return
              case "tab-edit":
                if (reviewTab() === "edit") finishEditPrompt(e)
                else startEditPrompt()
                return
              case "tab-compare":
                switchReviewTab(reviewTab() === "compare" ? "preview" : "compare", "tab-compare")
                return
              case "ref-shorter":
                triggerRefine("Make it tighter and more concise without losing constraints or verification.")
                return
              case "ref-detail":
                triggerRefine("Expand with explicit edge cases, acceptance criteria, and clear execution steps.")
                return
              case "ref-tests":
                triggerRefine("Emphasize test coverage, failure modes, and strict verification steps.")
                return
              case "ref-grill":
                triggerRegrill(e)
                return
              case "ref-custom":
                openCustomRefine()
                return
              case "refine-apply":
                triggerRefine(refineEditor?.plainText ?? refineText())
                return
              case "refine-cancel":
                refineEditor?.blur?.()
                setRefiningOpen(false)
                setReviewFocus("ref-custom")
                return
              case "confirm-send":
                triggerSendReview(e, true)
                return
              case "confirm-cancel":
                setConfirmOpen(false)
                return
              case "composer":
                void handleInsertToComposer(e)
                return
              case "original":
                setConfirmOpen(false)
                void submitProposal(e.targetKey, e.proposal.original, false)
                return
              case "bg":
                closeModalToBackground()
                return
              case "discard":
                closeAndKillWindow(e.targetKey)
                return
              case "send":
              default:
                triggerSendReview(e)
                return
            }
          }

          onMount(() => {
            const e = activeEntry()
            if (e?.stage === "draft" && draftFocus() === "editor") queueMicrotask(() => draftEditor?.focus?.())
          })

          api.keymap.layer(() => {
            const e = activeEntry()
            const stage = e?.stage ?? "idle"
            const curSub = subView()
            const inMain = curSub === "main"
            const inModels = curSub === "models"
            const inSessions = curSub === "sessions"
            const nav = !isTyping()
            const reviewNormalNav =
              inMain && stage === "review" && nav && !confirmSwitchOpen() && !refiningOpen() && reviewTab() !== "edit"

            const activateQuestionOpt = () => {
              const q = e?.grill?.questions?.[focusedQ()]
              if (!q || !e) return
              const opts = q.options ?? []
              if (qOptIdx() < opts.length) {
                const opt = opts[qOptIdx()]
                if (opt) store.selectOption(e.targetKey, q.id, opt.id)
              } else {
                setEditingQId(q.id)
                queueMicrotask(() => qEditor?.focus?.())
              }
            }

            const moveGrillRow = (delta: 1 | -1) => {
              const qs = e?.grill?.questions ?? []
              if (qs.length === 0) return
              if (qFocusZone() === "actions") {
                if (delta < 0) {
                  const lastQIdx = qs.length - 1
                  const lastQ = qs[lastQIdx]
                  setQFocusZone("list")
                  setFocusedQ(lastQIdx)
                  setQOptIdx(lastQ?.options?.length ?? 0)
                  scrollGrillIntoView(lastQIdx, qs)
                }
                return
              }
              const curQ = focusedQ()
              const maxOpt = qs[curQ]?.options?.length ?? 0
              const curOpt = qOptIdx()
              if (delta > 0) {
                if (curOpt < maxOpt) {
                  setQOptIdx(curOpt + 1)
                } else if (curQ < qs.length - 1) {
                  const nextQ = curQ + 1
                  setFocusedQ(nextQ)
                  setQOptIdx(0)
                  scrollGrillIntoView(nextQ, qs)
                } else {
                  setQFocusZone("actions")
                  setQActionFocus("generate")
                }
              } else {
                if (curOpt > 0) {
                  setQOptIdx(curOpt - 1)
                } else if (curQ > 0) {
                  const prevQ = curQ - 1
                  const prevMax = qs[prevQ]?.options?.length ?? 0
                  setFocusedQ(prevQ)
                  setQOptIdx(prevMax)
                  scrollGrillIntoView(prevQ, qs)
                }
              }
            }

            const activateQAction = () => {
              if (qActionFocus() === "skip") triggerGenerateFromGrill(true)
              else if (qActionFocus() === "draft" && e) resetToDraftView(e)
              else if (qActionFocus() === "bg") closeModalToBackground()
              else if (qActionFocus() === "discard" && e) closeAndKillWindow(e.targetKey)
              else triggerGenerateFromGrill(false)
            }

            return {
              mode: "modal",
              priority: 20,
              commands: [
                // Global modal Escape / Background controls
                {
                  bind: "escape",
                  title: inModels ? "Back" : inSessions ? (openedSessionsFromMain ? "Back" : "Close list") : "Background",
                  enabled: inMain || inModels || inSessions,
                  run: () => {
                    if (inModels) {
                      setSubView("main")
                      return
                    }
                    if (inSessions) {
                      if (openedSessionsFromMain) {
                        openedSessionsFromMain = false
                        setSubView("main")
                      } else {
                        closeDialogUIOnly()
                      }
                      return
                    }
                    if (stage === "questions" && editingQId()) {
                      flushPendingTextEdits()
                      qEditor?.blur?.()
                      setEditingQId(undefined)
                      return
                    }
                    if (stage === "review" && confirmSwitchOpen()) {
                      setConfirmOpen(false)
                      return
                    }
                    if (stage === "review" && refiningOpen()) {
                      refineEditor?.blur?.()
                      setRefiningOpen(false)
                      setReviewFocus("ref-custom")
                      return
                    }
                    if (stage === "review" && reviewTab() === "edit") {
                      if (e) finishEditPrompt(e)
                      return
                    }
                    if (!hasPreservableWork(e)) {
                      closeAndKillWindow(e?.targetKey)
                      return
                    }
                    closeModalToBackground()
                  },
                },
                {
                  bind: "ctrl+b",
                  title: "Move to background",
                  enabled: inMain || inModels,
                  run: closeModalToBackground,
                },
                {
                  bind: "b",
                  title: "Move to background",
                  enabled: (inMain || inModels) && nav && !confirmSwitchOpen(),
                  run: closeModalToBackground,
                },
                {
                  bind: "x",
                  title: "Discard rewrite",
                  enabled: inMain && nav && !confirmSwitchOpen() && !refiningOpen(),
                  run: () => e && closeAndKillWindow(e.targetKey),
                },
                {
                  bind: "l",
                  title: "Active rewrites list",
                  enabled: inMain && nav && !confirmSwitchOpen() && !refiningOpen(),
                  run: openSessionsList,
                },

                // Active Rewrites List (sessions view) controls
                {
                  bind: "up",
                  title: "Previous rewrite",
                  enabled: inSessions,
                  run: () => {
                    const nextIdx = Math.max(0, selectedSessionIdx() - 1)
                    setSessionsCursor(nextIdx)
                    scrollBoxToY(sessionsScroll, Math.max(0, nextIdx * 2 - 2))
                  },
                },
                {
                  bind: "down",
                  title: "Next rewrite",
                  enabled: inSessions,
                  run: () => {
                    const nextIdx = Math.min(Math.max(0, activeWindowsList().length - 1), selectedSessionIdx() + 1)
                    setSessionsCursor(nextIdx)
                    scrollBoxToY(sessionsScroll, Math.max(0, nextIdx * 2 - 2))
                  },
                },
                {
                  bind: "return",
                  title: "Inspect rewrite",
                  enabled: inSessions,
                  run: () => {
                    const item = activeWindowsList()[selectedSessionIdx()]
                    if (item) inspectWindow(item.targetKey)
                    else openCurrentDraftFromSessions()
                  },
                },
                {
                  bind: "s",
                  title: "Stop running rewrite",
                  enabled: inSessions,
                  run: () => {
                    const item = activeWindowsList()[selectedSessionIdx()]
                    if (item?.stage === "running") void cancelWindow(item.targetKey)
                  },
                },
                ...(["d", "x", "delete", "backspace"] as const).map((k) => ({
                  bind: k,
                  title: "Discard rewrite",
                  enabled: inSessions,
                  run: () => {
                    const item = activeWindowsList()[selectedSessionIdx()]
                    if (item) void discardWindow(item.targetKey)
                  },
                })),
                {
                  bind: "n",
                  title: "New draft in current session",
                  enabled: inSessions,
                  run: openCurrentDraftFromSessions,
                },

                // Model picker controls
                {
                  bind: "ctrl+d",
                  title: "Done / Back",
                  enabled: inModels || (inMain && stage === "questions" && Boolean(editingQId())) || (inMain && stage === "review" && (reviewTab() === "edit" || refiningOpen())),
                  run: () => {
                    if (inModels) setSubView("main")
                    else if (stage === "questions") {
                      flushPendingTextEdits()
                      qEditor?.blur?.()
                      setEditingQId(undefined)
                    } else if (stage === "review") {
                      if (e && reviewTab() === "edit") finishEditPrompt(e)
                      else {
                        refineEditor?.blur?.()
                        setRefiningOpen(false)
                        setReviewFocus("send")
                      }
                    }
                  },
                },
                {
                  bind: "tab",
                  title: "Next model zone",
                  enabled: inModels,
                  run: () => moveModelZone(1),
                },
                {
                  bind: "shift+tab",
                  title: "Previous model zone",
                  enabled: inModels,
                  run: () => moveModelZone(-1),
                },
                {
                  bind: "up",
                  title: "Previous model",
                  enabled: inModels,
                  run: () => {
                    const list = filteredModels()
                    const nextIdx = Math.max(0, modelCursor() - 1)
                    setModelVariantIdx(-1)
                    setModelCursor(nextIdx)
                    scrollModelIntoView(nextIdx, list)
                  },
                },
                {
                  bind: "down",
                  title: "Next model",
                  enabled: inModels,
                  run: () => {
                    const list = filteredModels()
                    const nextIdx = Math.min(Math.max(0, list.length - 1), modelCursor() + 1)
                    setModelVariantIdx(-1)
                    setModelCursor(nextIdx)
                    scrollModelIntoView(nextIdx, list)
                  },
                },
                {
                  bind: "left",
                  title: "Previous effort variant",
                  enabled: inModels && modelFocusZone() !== "filter",
                  run: () => setModelVariantIdx((v) => Math.max(-1, v - 1)),
                },
                {
                  bind: "right",
                  title: "Next effort variant",
                  enabled: inModels && modelFocusZone() !== "filter",
                  run: () => {
                    const m = filteredModels()[modelCursor()]
                    const max = (m?.variants?.length ?? 0) - 1
                    setModelVariantIdx((v) => Math.min(max, v + 1))
                  },
                },
                {
                  bind: "return",
                  title: "Select model",
                  enabled: inModels,
                  run: () => {
                    if (modelFocusZone() === "back") {
                      setSubView("main")
                      return
                    }
                    if (modelFocusZone() === "default") {
                      resetModelSelectionToDefault()
                      return
                    }
                    const m = filteredModels()[modelCursor()]
                    if (!m) return
                    const v = modelVariantIdx() >= 0 ? m.variants?.[modelVariantIdx()] : undefined
                    applyModelSelection(m, v)
                  },
                },
                {
                  bind: "space",
                  title: "Activate model control",
                  enabled: inModels && modelFocusZone() !== "filter",
                  run: () => {
                    if (modelFocusZone() === "back") {
                      setSubView("main")
                      return
                    }
                    if (modelFocusZone() === "default") {
                      resetModelSelectionToDefault()
                      return
                    }
                    const m = filteredModels()[modelCursor()]
                    if (m) applyModelSelection(m, modelVariantIdx() >= 0 ? m.variants?.[modelVariantIdx()] : undefined)
                  },
                },

                // Draft controls
                {
                  bind: "tab",
                  title: "Next control",
                  enabled: inMain && stage === "draft",
                  run: () => moveDraftFocus(1),
                },
                {
                  bind: "shift+tab",
                  title: "Previous control",
                  enabled: inMain && stage === "draft",
                  run: () => moveDraftFocus(-1),
                },
                {
                  bind: "right",
                  title: "Next button",
                  enabled: inMain && stage === "draft" && nav,
                  run: () => moveDraftFocus(1),
                },
                {
                  bind: "down",
                  title: "Next button",
                  enabled: inMain && stage === "draft" && nav,
                  run: () => moveDraftFocus(1),
                },
                {
                  bind: "left",
                  title: "Previous button",
                  enabled: inMain && stage === "draft" && nav,
                  run: () => moveDraftFocus(-1),
                },
                {
                  bind: "up",
                  title: "Previous button",
                  enabled: inMain && stage === "draft" && nav,
                  run: () => moveDraftFocus(-1),
                },
                {
                  bind: "return",
                  title: "Activate button",
                  enabled: inMain && stage === "draft" && nav,
                  run: activateDraftFocus,
                },
                {
                  bind: "space",
                  title: "Activate button",
                  enabled: inMain && stage === "draft" && nav,
                  run: activateDraftFocus,
                },
                {
                  bind: "ctrl+s",
                  title: "Continue",
                  enabled: inMain && stage === "draft",
                  run: triggerStartFromDraft,
                },
                {
                  bind: "ctrl+g",
                  title: "Toggle Grill Me / Direct",
                  enabled: inMain && stage === "draft" && Boolean(e),
                  run: () => e && store.setDraft(e.targetKey, { flowMode: e.flowMode === "grill" ? "direct" : "grill" }),
                },
                {
                  bind: "ctrl+m",
                  title: "Pick rewrite model",
                  enabled: inMain && stage === "draft",
                  run: () => openModels("rewrite"),
                },
                {
                  bind: "m",
                  title: "Pick rewrite model",
                  enabled: inMain && stage === "draft" && nav,
                  run: () => openModels("rewrite"),
                },

                // Running controls
                ...(["tab", "right", "down"] as const).map((k) => ({
                  bind: k,
                  title: "Next running button",
                  enabled: inMain && stage === "running",
                  run: () => setRunningFocus((f) => cycleFocus(["bg", "cancel", "discard"], f, 1)),
                })),
                ...(["shift+tab", "left", "up"] as const).map((k) => ({
                  bind: k,
                  title: "Previous running button",
                  enabled: inMain && stage === "running",
                  run: () => setRunningFocus((f) => cycleFocus(["bg", "cancel", "discard"], f, -1)),
                })),
                ...(["return", "space"] as const).map((k) => ({
                  bind: k,
                  title: "Activate running button",
                  enabled: inMain && stage === "running" && Boolean(e),
                  run: () => {
                    if (!e) return
                    if (runningFocus() === "cancel") void cancelWindow(e.targetKey)
                    else if (runningFocus() === "discard") closeAndKillWindow(e.targetKey)
                    else closeModalToBackground()
                  },
                })),
                {
                  bind: "c",
                  title: "Cancel to draft",
                  enabled: inMain && stage === "running" && Boolean(e),
                  run: () => e && void cancelWindow(e.targetKey),
                },

                // Grill Me navigation & action bar controls
                {
                  bind: "tab",
                  title: "Switch questions / buttons",
                  enabled: inMain && stage === "questions",
                  run: () => {
                    if (editingQId()) {
                      flushPendingTextEdits()
                      qEditor?.blur?.()
                      setEditingQId(undefined)
                      setQFocusZone("actions")
                      setQActionFocus("generate")
                      return
                    }
                    if (qFocusZone() === "list") {
                      setQFocusZone("actions")
                      setQActionFocus("generate")
                    } else {
                      const nextBtn = cycleFocus(qActionOrder, qActionFocus(), 1)
                      if (nextBtn === qActionOrder[0]) setQFocusZone("list")
                      else setQActionFocus(nextBtn)
                    }
                  },
                },
                {
                  bind: "shift+tab",
                  title: "Previous focus in Grill Me",
                  enabled: inMain && stage === "questions",
                  run: () => {
                    if (editingQId()) {
                      flushPendingTextEdits()
                      qEditor?.blur?.()
                      setEditingQId(undefined)
                      setQFocusZone("list")
                      return
                    }
                    if (qFocusZone() === "actions") {
                      const prevBtn = cycleFocus(qActionOrder, qActionFocus(), -1)
                      if (prevBtn === qActionOrder[qActionOrder.length - 1]) setQFocusZone("list")
                      else setQActionFocus(prevBtn)
                    } else {
                      setQFocusZone("actions")
                      setQActionFocus("discard")
                    }
                  },
                },
                {
                  bind: "up",
                  title: "Previous option / question",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => moveGrillRow(-1),
                },
                {
                  bind: "down",
                  title: "Next option / question",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => moveGrillRow(1),
                },
                ...(["pageup", "["] as const).map((k) => ({
                  bind: k,
                  title: "Previous question",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    const qs = e?.grill?.questions ?? []
                    const nextQ = Math.max(0, focusedQ() - 1)
                    setQFocusZone("list")
                    setQOptIdx(0)
                    setFocusedQ(nextQ)
                    scrollGrillIntoView(nextQ, qs)
                  },
                })),
                ...(["pagedown", "]"] as const).map((k) => ({
                  bind: k,
                  title: "Next question",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    const qs = e?.grill?.questions ?? []
                    const nextQ = Math.min(Math.max(0, qs.length - 1), focusedQ() + 1)
                    setQFocusZone("list")
                    setQOptIdx(0)
                    setFocusedQ(nextQ)
                    scrollGrillIntoView(nextQ, qs)
                  },
                })),
                {
                  bind: "left",
                  title: "Previous option / button",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") {
                      setQActionFocus((cur) => cycleFocus(qActionOrder, cur, -1))
                      return
                    }
                    const q = e?.grill?.questions?.[focusedQ()]
                    const max = q?.options?.length ?? 0
                    setQOptIdx((i) => (i <= 0 ? max : i - 1))
                  },
                },
                {
                  bind: "right",
                  title: "Next option / button",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") {
                      setQActionFocus((cur) => cycleFocus(qActionOrder, cur, 1))
                      return
                    }
                    const q = e?.grill?.questions?.[focusedQ()]
                    const max = q?.options?.length ?? 0
                    setQOptIdx((i) => (i >= max ? 0 : i + 1))
                  },
                },
                {
                  bind: "space",
                  title: "Toggle option / press button",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") activateQAction()
                    else activateQuestionOpt()
                  },
                },
                ...[1, 2, 3, 4, 5].map((num) => ({
                  bind: String(num),
                  title: `Pick option ${num}`,
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    const q = e?.grill?.questions?.[focusedQ()]
                    const opt = q?.options?.[num - 1]
                    if (e && q && opt) {
                      setQFocusZone("list")
                      setQOptIdx(num - 1)
                      store.selectOption(e.targetKey, q.id, opt.id)
                    }
                  },
                })),
                {
                  bind: "e",
                  title: "Add custom answer",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    const q = e?.grill?.questions?.[focusedQ()]
                    if (q) {
                      setQFocusZone("list")
                      setQOptIdx(q.options?.length ?? 0)
                      setEditingQId(q.id)
                      queueMicrotask(() => qEditor?.focus?.())
                    }
                  },
                },
                {
                  bind: "ctrl+s",
                  title: "Generate improved prompt",
                  enabled: inMain && stage === "questions",
                  run: () => triggerGenerateFromGrill(false),
                },
                {
                  bind: "return",
                  title: "Pick option / activate action",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") activateQAction()
                    else activateQuestionOpt()
                  },
                },
                {
                  bind: "s",
                  title: "Skip questions & rewrite",
                  enabled: inMain && stage === "questions" && nav,
                  run: () => triggerGenerateFromGrill(true),
                },

                // Review controls
                {
                  bind: "tab",
                  title: "Next control",
                  enabled: inMain && stage === "review",
                  run: () => moveReviewFocus(1),
                },
                {
                  bind: "shift+tab",
                  title: "Previous control",
                  enabled: inMain && stage === "review",
                  run: () => moveReviewFocus(-1),
                },
                {
                  bind: "right",
                  title: "Next button / pill",
                  enabled: inMain && stage === "review" && nav,
                  run: () => moveReviewFocus(1),
                },
                {
                  bind: "left",
                  title: "Previous button / pill",
                  enabled: inMain && stage === "review" && nav,
                  run: () => moveReviewFocus(-1),
                },
                {
                  bind: "return",
                  title: "Activate focused button",
                  enabled: inMain && stage === "review" && nav,
                  run: () => activateReviewFocus(reviewFocus()),
                },
                {
                  bind: "space",
                  title: "Activate focused button",
                  enabled: inMain && stage === "review" && nav,
                  run: () => activateReviewFocus(reviewFocus()),
                },
                {
                  bind: "n",
                  title: "Cancel switch confirmation",
                  enabled: inMain && stage === "review" && confirmSwitchOpen(),
                  run: () => setConfirmOpen(false),
                },
                {
                  bind: "ctrl+s",
                  title: "Save edits",
                  enabled: inMain && stage === "review" && reviewTab() === "edit",
                  run: () => finishEditPrompt(e),
                },
                {
                  bind: "ctrl+s",
                  title: "Apply refinement",
                  enabled: inMain && stage === "review" && refiningOpen(),
                  run: () => triggerRefine(refineEditor?.plainText ?? refineText()),
                },
                {
                  bind: "e",
                  title: "Edit prompt",
                  enabled: reviewNormalNav,
                  run: startEditPrompt,
                },
                {
                  bind: "f",
                  title: "Refine with instruction",
                  enabled: reviewNormalNav,
                  run: openCustomRefine,
                },
                {
                  bind: "c",
                  title: "Compare original",
                  enabled: reviewNormalNav,
                  run: () => switchReviewTab(reviewTab() === "compare" ? "preview" : "compare", "tab-compare"),
                },
                {
                  bind: "r",
                  title: "Toggle recommended model",
                  enabled: reviewNormalNav && Boolean(e?.selectedModelOverride ?? e?.proposal?.route),
                  run: () => {
                    if (e) store.toggleApplyRoute(e.targetKey)
                  },
                },
                {
                  bind: "m",
                  title: "Choose model",
                  enabled: reviewNormalNav,
                  run: () => openModels("session"),
                },
                {
                  bind: "g",
                  title: "Re-grill",
                  enabled: reviewNormalNav,
                  run: () => e && triggerRegrill(e),
                },
                {
                  bind: "o",
                  title: "Send original",
                  enabled: reviewNormalNav,
                  run: () => {
                    if (e?.proposal) void submitProposal(e.targetKey, e.proposal.original, false)
                  },
                },
                {
                  bind: "i",
                  title: "Insert into composer",
                  enabled: reviewNormalNav && canAppendToComposer(),
                  run: () => {
                    if (e?.proposal) void handleInsertToComposer(e)
                  },
                },
                {
                  bind: "up",
                  title: "Scroll up",
                  enabled: reviewNormalNav,
                  run: () => previewScroll?.scrollBy?.(-2),
                },
                {
                  bind: "down",
                  title: "Scroll down",
                  enabled: reviewNormalNav,
                  run: () => previewScroll?.scrollBy?.(2),
                },
                {
                  bind: "pageup",
                  title: "Page up",
                  enabled: reviewNormalNav,
                  run: () => previewScroll?.scrollBy?.(-8),
                },
                {
                  bind: "pagedown",
                  title: "Page down",
                  enabled: reviewNormalNav,
                  run: () => previewScroll?.scrollBy?.(8),
                },

                // Error controls
                ...(["tab", "right", "down"] as const).map((k) => ({
                  bind: k,
                  title: "Next error button",
                  enabled: inMain && stage === "error",
                  run: () => setErrorFocus((c) => cycleFocus(["retry", "draft", "bg", "discard"], c, 1)),
                })),
                ...(["shift+tab", "left", "up"] as const).map((k) => ({
                  bind: k,
                  title: "Previous error button",
                  enabled: inMain && stage === "error",
                  run: () => setErrorFocus((c) => cycleFocus(["retry", "draft", "bg", "discard"], c, -1)),
                })),
                ...(["return", "space"] as const).map((k) => ({
                  bind: k,
                  title: "Activate error button",
                  enabled: inMain && stage === "error" && Boolean(e),
                  run: () => {
                    if (!e) return
                    if (errorFocus() === "retry") triggerRetryError(e)
                    else if (errorFocus() === "draft") resetToDraftView(e)
                    else if (errorFocus() === "bg") closeModalToBackground()
                    else closeAndKillWindow(e.targetKey)
                  },
                })),
              ],
            }
          })

          const activeTargetKey = () => (subView() === "main" ? activeEntry()?.targetKey : undefined)

          return (
            <box
              flexDirection="column"
              paddingX={1}
              paddingY={isShort() ? 0 : 1}
              gap={1}
              onMouseDown={(e: any) => e?.stopPropagation?.()}
              onMouseUp={(e: any) => e?.stopPropagation?.()}
            >
              {/* Header Bar */}
              <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                <box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
                  <text fg={p().accent} bold>✦ PROMPT REWRITE</text>
                  <Show when={subView() === "main" && activeEntry()}>
                    {(entry) => (
                      <Stepper stage={entry().stage} flowMode={entry().flowMode} compact={isNarrow()} palette={p()} />
                    )}
                  </Show>
                  <Show when={subView() === "sessions"}>
                    <text fg={p().info} bold>{`Active Rewrites (${activeWindowsList().length})`}</text>
                  </Show>
                </box>
                <box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Show when={subView() === "main" && activeWindowsList().length > 0}>
                    <PillChip
                      label={`Active (${activeWindowsList().length}) [L]`}
                      color={p().info}
                      palette={p()}
                      onPress={openSessionsList}
                    />
                  </Show>
                  <Show when={subView() === "main" && activeEntry()}>
                    {(entry) => (
                      <box flexDirection="row" gap={1} flexWrap="wrap">
                        <text fg={p().info}>{truncateText(entry().label, isNarrow() ? 14 : 24)}</text>
                        <Show when={entry().rewriteModel || effectiveBaseModel()}>
                          <text fg={p().textMuted}>
                            {`· ${truncateText(compactModelName(entry().rewriteModel || effectiveBaseModel()!), isNarrow() ? 18 : 28)}`}
                          </text>
                        </Show>
                        <Show when={entry().windowCostUSD > 0}>
                          <text fg={p().success} bold>
                            {`· ${formatCostUsd(entry().windowCostUSD, entry().windowEstimated)}${entry().windowTokens > 0 && !isNarrow() ? ` (${formatTokensCompact(entry().windowTokens, entry().windowEstimated)})` : ""}`}
                          </text>
                        </Show>
                      </box>
                    )}
                  </Show>
                </box>
              </box>

              {/* Window changed notice */}
              <Show when={subView() === "main" && activeEntry() && currentTarget()?.targetKey !== activeEntry()?.targetKey}>
                <box backgroundColor={p().bgBadgeWarning ?? p().bgElevated} paddingX={1}>
                  <text fg={p().warning} wrapMode="word">
                    {`Window changed since opening — return to "${activeEntry()?.label}" before submitting.`}
                  </text>
                </box>
              </Show>

              {/* SUB-VIEW: ACTIVE REWRITES LIST */}
              <Show when={subView() === "sessions"}>
                <box flexDirection="column" gap={1}>
                  <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                    <text fg={p().textMuted}>
                      ↑↓ select · Enter inspect · S stop running · D discard · Esc {openedSessionsFromMain ? "back" : "close"}
                    </text>
                    <box flexDirection="row" gap={1} flexWrap="wrap">
                      <ActionButton
                        label="New Draft"
                        shortcut="N"
                        variant="secondary"
                        palette={p()}
                        onPress={openCurrentDraftFromSessions}
                      />
                      <ActionButton
                        label={openedSessionsFromMain ? "Back" : "Close"}
                        shortcut="Esc"
                        variant="ghost"
                        palette={p()}
                        onPress={() => {
                          if (openedSessionsFromMain) {
                            openedSessionsFromMain = false
                            setSubView("main")
                          } else {
                            closeDialogUIOnly()
                          }
                        }}
                      />
                    </box>
                  </box>
                  <Show
                    when={activeWindowsList().length > 0}
                    fallback={
                      <box border borderStyle="rounded" borderColor={p().borderSubtle} padding={1}>
                        <text fg={p().textMuted}>No active or saved rewrites across sessions.</text>
                      </box>
                    }
                  >
                    <scrollbox
                      ref={(el: any) => { sessionsScroll = el }}
                      height={Math.max(5, Math.min(18, termH() - (isShort() ? 9 : 12)))}
                    >
                      <box flexDirection="column" gap={0}>
                        <For each={activeWindowsList()}>
                          {(item: any, idx: () => number) => {
                            const [rowHovered, setRowHovered] = createSignal(false)
                            const selected = () => idx() === selectedSessionIdx()
                            const isCurrent = () => item.targetKey === currentTarget()?.targetKey
                            const statusMeta = () => {
                              if (item.stage === "running") {
                                const spin = SPINNER_FRAMES[Math.floor(nowMs() / 150) % SPINNER_FRAMES.length]
                                return {
                                  color: p().info,
                                  text: `${spin} ${phaseLabel(item.phase)} · ${formatElapsed(nowMs() - (item.startedAt || nowMs()))}`,
                                }
                              }
                              if (item.stage === "review") {
                                return {
                                  color: p().success,
                                  text: `✓ ready · ${formatAge(nowMs() - (item.updatedAt || nowMs()))}`,
                                }
                              }
                              if (item.stage === "questions") {
                                const count = item.grill?.questions?.length ?? 0
                                return {
                                  color: p().warning,
                                  text: `? ${count} Q(s) · ${formatAge(nowMs() - (item.updatedAt || nowMs()))}`,
                                }
                              }
                              if (item.stage === "error") {
                                return {
                                  color: p().error,
                                  text: `! failed · ${formatAge(nowMs() - (item.updatedAt || nowMs()))}`,
                                }
                              }
                              return {
                                color: p().accent,
                                text: `✎ draft · ${formatAge(nowMs() - (item.updatedAt || nowMs()))}`,
                              }
                            }
                            const preview = () => truncateText(
                              String(item.proposal?.text || item.draftText || item.error || ""),
                              Math.max(36, dialogCols() - 10),
                            )
                            return (
                              <box
                                backgroundColor={selected() || rowHovered() ? p().bgHover ?? p().bgElevated ?? p().bgPanel : undefined}
                                paddingX={1}
                                flexDirection="column"
                                gap={0}
                                {...pressHandlers(() => setSessionsCursor(idx()), { onHover: setRowHovered })}
                              >
                                <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                                  <box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                                    <text fg={selected() ? p().accent : p().textBase} bold={selected()}>
                                      {`${selected() ? "▸ " : "  "}${item.label}${isCurrent() ? " (current)" : ""}`}
                                    </text>
                                    <text fg={statusMeta().color} bold>
                                      {statusMeta().text}
                                    </text>
                                  </box>
                                  <box flexDirection="row" gap={1}>
                                    <ActionButton
                                      label="Inspect"
                                      shortcut={selected() ? "↵" : undefined}
                                      variant={selected() ? "primary" : "ghost"}
                                      palette={p()}
                                      onPress={() => inspectWindow(item.targetKey)}
                                    />
                                    <Show when={item.stage === "running"}>
                                      <ActionButton
                                        label="Stop"
                                        shortcut={selected() ? "S" : undefined}
                                        variant="warning"
                                        palette={p()}
                                        onPress={() => void cancelWindow(item.targetKey)}
                                      />
                                    </Show>
                                    <ActionButton
                                      label="Discard"
                                      shortcut={selected() ? "D" : undefined}
                                      variant="danger"
                                      palette={p()}
                                      onPress={() => void discardWindow(item.targetKey)}
                                    />
                                  </box>
                                </box>
                                <Show when={preview()}>
                                  <text fg={p().textMuted}>{`    ${preview()}`}</text>
                                </Show>
                              </box>
                            )
                          }}
                        </For>
                      </box>
                    </scrollbox>
                  </Show>
                </box>
              </Show>

              {/* SUB-VIEW: INLINE MODEL PICKER */}
              <Show when={subView() === "models"}>
                <box flexDirection="column" gap={1}>
                  <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                    <box flexDirection="column" gap={0}>
                      <text fg={p().accent} bold>
                        {modelPickerPurpose() === "rewrite"
                          ? effectiveBaseModel()
                            ? `Select Rewrite Model (base: ${compactModelName(effectiveBaseModel()!)})`
                            : "Select Rewrite Model (defaults to session model)"
                          : "Select Session Working Model (perf / cost ranked)"}
                      </text>
                      <text fg={p().textMuted}>
                        ↑↓ model · ←→ #effort variant · Tab switch zone · Enter select
                      </text>
                    </box>
                    <ActionButton
                      label="Back"
                      shortcut="Esc"
                      focused={modelFocusZone() === "back"}
                      variant="ghost"
                      palette={p()}
                      onPress={() => setSubView("main")}
                    />
                  </box>
                  <box
                    border
                    borderStyle="single"
                    borderColor={modelFocusZone() === "filter" ? p().borderActive : p().borderSubtle}
                    backgroundColor={p().bgFormField}
                    title=" Filter models "
                    paddingX={1}
                    {...pressHandlers(() => {
                      setModelFocusZone("filter")
                      queueMicrotask(() => filterEditor?.focus?.())
                    })}
                  >
                    <textarea
                      ref={(el: any) => { filterEditor = el }}
                      initialValue={modelFilter()}
                      placeholder="Filter by provider, model id, or family…"
                      placeholderColor={p().textFaint}
                      height={1}
                      textColor={p().textFormField}
                      cursorColor={p().accent}
                      onContentChange={() => {
                        const raw = filterEditor?.plainText ?? ""
                        const cleaned = raw.replace(/[\r\n]+/g, " ")
                        setModelFilter(cleaned)
                        setModelCursor(0)
                        setModelVariantIdx(-1)
                      }}
                    />
                  </box>
                  <Show when={modelPickerPurpose() === "rewrite"}>
                    <box flexDirection="row" gap={1}>
                      <ActionButton
                        label={effectiveBaseModel()
                          ? `Use Base (${compactModelName(effectiveBaseModel()!)})`
                          : "Use Base / Session Default"}
                        variant="secondary"
                        focused={modelFocusZone() === "default"}
                        palette={p()}
                        onPress={resetModelSelectionToDefault}
                      />
                    </box>
                  </Show>
                  <scrollbox
                    ref={(el: any) => { modelsScroll = el }}
                    height={Math.max(6, Math.min(18, termH() - (isShort() ? 11 : 14)))}
                  >
                    <box flexDirection="column" gap={0}>
                      <For each={filteredModels()}>
                        {(m: any, idx: () => number) => {
                          const [rowHovered, setRowHovered] = createSignal(false)
                          const fullRef = `${m.providerID}/${m.id}`
                          const highlighted = () => idx() === modelCursor()
                          const lit = () => highlighted() || rowHovered()
                          const isBase = () => effectiveBaseModel()?.startsWith(fullRef)
                          const ctxLabel = m.contextLimit ? ` · ${Math.round(m.contextLimit / 1000)}k ctx` : ""
                          const flags = [
                            m.reasoning ? "reasoning" : "",
                            m.toolcall ? "tools" : "",
                            m.benchmark?.deprecated ? "deprecated" : "",
                          ].filter(Boolean).join(" · ")
                          const benchLine = formatBenchChip(m.benchmark)
                          const highValue = (m.benchmark?.balanceScore ?? 0) >= 45 && !m.benchmark?.deprecated
                          return (
                            <box
                              flexDirection="column"
                              backgroundColor={lit() ? p().bgHover ?? p().bgElevated ?? p().bgPanel : undefined}
                              paddingX={1}
                              {...pressHandlers(() => applyModelSelection(m), { onHover: setRowHovered })}
                            >
                              <box flexDirection="row" justifyContent="spaceBetween" flexWrap="wrap" gap={1}>
                                <text fg={lit() ? p().accent : p().textBase} bold={lit()}>
                                  {`${highlighted() ? "▸ " : "  "}${fullRef}${isBase() ? " [base]" : ""}`}
                                </text>
                                <text fg={p().textMuted}>
                                  {`${m.name && m.name !== m.id ? m.name : ""}${ctxLabel}${flags ? ` · ${flags}` : ""}`}
                                </text>
                              </box>
                              <Show when={benchLine || (m.variants?.length ?? 0) > 0}>
                                <box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                                  <Show when={benchLine}>
                                    <text fg={m.benchmark?.deprecated ? p().textFaint : highValue ? p().success : p().info}>
                                      {`  ${benchLine}`}
                                    </text>
                                  </Show>
                                  <Show when={(m.variants?.length ?? 0) > 0}>
                                    <text fg={p().textFaint}>{benchLine ? "· Effort:" : "  Effort:"}</text>
                                    <For each={m.variants}>
                                      {(v: string, vIdx: () => number) => {
                                        const vFocused = () => highlighted() && modelVariantIdx() === vIdx()
                                        return (
                                          <PillChip
                                            label={`#${v}`}
                                            color={vFocused() ? p().accent : p().info}
                                            focused={vFocused()}
                                            palette={p()}
                                            onPress={() => applyModelSelection(m, v)}
                                          />
                                        )
                                      }}
                                    </For>
                                  </Show>
                                </box>
                              </Show>
                            </box>
                          )
                        }}
                      </For>
                      <Show when={filteredModels().length === 0}>
                        <text fg={p().textMuted}>{`No enabled chat models match "${modelFilter()}".`}</text>
                      </Show>
                    </box>
                  </scrollbox>
                </box>
              </Show>

              {/* MAIN FLOWS (keyed by targetKey string so switching windows resets uncontrolled textareas) */}
              <Show when={activeTargetKey()} keyed>
                {() => (
                  <Show when={activeEntry()}>
                    {(entry) => (
                      <Switch>
                        {/* 1. DRAFT STUDIO */}
                        <Match when={entry().stage === "draft"}>
                          <box flexDirection="column" gap={1}>
                            <box
                              border
                              borderStyle="rounded"
                              borderColor={draftFocus() === "editor" ? p().borderActive : p().border}
                              backgroundColor={p().bgFormField}
                              title=" Draft Prompt (Tab to options) "
                              paddingX={1}
                              {...pressHandlers(() => {
                                setDraftFocus("editor")
                                queueMicrotask(() => draftEditor?.focus?.())
                              })}
                            >
                              <textarea
                                ref={(el: any) => { draftEditor = el }}
                                initialValue={entry().draftText}
                                placeholder="Describe what you want done, constraints, files, and acceptance criteria…"
                                placeholderColor={p().textFaint}
                                height={Math.max(5, Math.min(18, termH() - (isShort() ? 10 : 13)))}
                                textColor={p().textFormField}
                                cursorColor={p().accent}
                                wrapMode="word"
                                onContentChange={() => store.setDraft(entry().targetKey, { draftText: draftEditor?.plainText ?? "" })}
                              />
                            </box>

                            {/* Mode & Model Options Strip */}
                            <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                              <box flexDirection="row" gap={1} flexWrap="wrap">
                                <PillChip
                                  label={entry().flowMode === "grill" ? "(●) Grill Me [Ctrl+G]" : "(○) Grill Me [Ctrl+G]"}
                                  color={entry().flowMode === "grill" ? p().accent : p().textMuted}
                                  active={entry().flowMode === "grill"}
                                  bold={entry().flowMode === "grill"}
                                  focused={draftFocus() === "mode-grill"}
                                  palette={p()}
                                  onPress={() => {
                                    setDraftFocus("mode-grill")
                                    store.setDraft(entry().targetKey, { flowMode: "grill" })
                                  }}
                                />
                                <PillChip
                                  label={entry().flowMode === "direct" ? "(●) Direct Rewrite" : "(○) Direct Rewrite"}
                                  color={entry().flowMode === "direct" ? p().info : p().textMuted}
                                  active={entry().flowMode === "direct"}
                                  bold={entry().flowMode === "direct"}
                                  focused={draftFocus() === "mode-direct"}
                                  palette={p()}
                                  onPress={() => {
                                    setDraftFocus("mode-direct")
                                    store.setDraft(entry().targetKey, { flowMode: "direct" })
                                  }}
                                />
                              </box>
                              <PillChip
                                label={`Model: ${
                                  entry().rewriteModel
                                    ? compactModelName(entry().rewriteModel)
                                    : effectiveBaseModel()
                                      ? `${compactModelName(effectiveBaseModel()!)} (base)`
                                      : "session default"
                                } [${draftFocus() === "editor" ? "Ctrl+M" : "M"}]`}
                                color={p().secondary}
                                focused={draftFocus() === "model"}
                                palette={p()}
                                onPress={() => openModels("rewrite")}
                              />
                            </box>

                            {/* Action Buttons */}
                            <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                              <ActionButton
                                label={entry().flowMode === "grill" ? "Analyze & Grill Me" : "Improve Prompt"}
                                shortcut="Ctrl+S"
                                variant="primary"
                                focused={draftFocus() === "start"}
                                palette={p()}
                                onPress={triggerStartFromDraft}
                              />
                              <box flexDirection="row" gap={1} flexWrap="wrap">
                                <ActionButton
                                  label="Background"
                                  shortcut={entry().draftText?.trim() ? "Esc" : "Ctrl+B"}
                                  variant="secondary"
                                  focused={draftFocus() === "bg"}
                                  palette={p()}
                                  onPress={closeModalToBackground}
                                />
                                <ActionButton
                                  label="Discard"
                                  shortcut={draftFocus() === "editor" ? undefined : "X"}
                                  variant="danger"
                                  focused={draftFocus() === "discard"}
                                  palette={p()}
                                  onPress={() => closeAndKillWindow(entry().targetKey)}
                                />
                              </box>
                            </box>
                          </box>
                        </Match>

                        {/* 2. LIVE PROGRESS / WAITING VIEW */}
                        <Match when={entry().stage === "running"}>
                          {(() => {
                            const spin = () => SPINNER_FRAMES[Math.floor(nowMs() / 150) % SPINNER_FRAMES.length]
                            const elapsed = () => formatElapsed(nowMs() - (entry().startedAt || nowMs()))
                            const draftSnippet = () =>
                              entry().draftText ? truncateText(entry().draftText, Math.max(30, dialogCols() - 14)) : ""
                            return (
                              <box flexDirection="column" gap={1}>
                                <box
                                  border
                                  borderStyle="rounded"
                                  borderColor={p().info}
                                  backgroundColor={p().bgPanel}
                                  title=" Working in Background "
                                  padding={1}
                                  flexDirection="column"
                                  gap={1}
                                >
                                  <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                                    <text fg={p().info} bold>
                                      {`${spin()} ${entry().phaseDetail || phaseLabel(entry().phase)}`}
                                    </text>
                                    <text fg={p().accent} bold>{elapsed()}</text>
                                  </box>
                                  <box flexDirection="column" gap={0}>
                                    <text fg={p().textBase}>
                                      {`Model: ${entry().rewriteModel || effectiveBaseModel() || (selectedModel() ? modelRef(selectedModel()!) : "resolving…")} · Target: ${entry().label}`}
                                    </text>
                                    <Show when={draftSnippet()}>
                                      <text fg={p().textMuted}>{`Draft: "${draftSnippet()}"`}</text>
                                    </Show>
                                    <text fg={p().textMuted}>
                                      Press Esc or B to return to chat while this runs — progress stays live in the footer.
                                    </text>
                                  </box>
                                </box>
                                <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                                  <ActionButton
                                    label="Background"
                                    shortcut="Esc / B"
                                    variant="primary"
                                    focused={runningFocus() === "bg"}
                                    palette={p()}
                                    onPress={closeModalToBackground}
                                  />
                                  <box flexDirection="row" gap={1} flexWrap="wrap">
                                    <ActionButton
                                      label="Cancel to Draft"
                                      shortcut="C"
                                      variant="secondary"
                                      focused={runningFocus() === "cancel"}
                                      palette={p()}
                                      onPress={() => void cancelWindow(entry().targetKey)}
                                    />
                                    <ActionButton
                                      label="Discard"
                                      shortcut="X"
                                      variant="danger"
                                      focused={runningFocus() === "discard"}
                                      palette={p()}
                                      onPress={() => closeAndKillWindow(entry().targetKey)}
                                    />
                                  </box>
                                </box>
                              </box>
                            )
                          })()}
                        </Match>

                        {/* 3. GRILL ME CLARIFYING QUESTIONS */}
                        <Match when={entry().stage === "questions" && entry().grill}>
                          <box flexDirection="column" gap={1}>
                            {/* Compact Diagnosis Summary */}
                            <box backgroundColor={p().bgPanel} paddingX={1} flexDirection="column" gap={0}>
                              <text fg={p().textBase} wrapMode="word">
                                {`✦ Grill Me (${entry().grill.questions.length} Qs · ${(entry().grill.latencyMs / 1000).toFixed(1)}s${entry().grill.usage ? ` · ${formatUsageLine(entry().grill.usage)}` : ""}) — ${entry().grill.diagnosis}`}
                              </text>
                              <Show when={entry().grill.missingAngles?.length > 0}>
                                <text fg={p().warning} wrapMode="word">
                                  {`Gaps: ${entry().grill.missingAngles.join(" · ")}`}
                                </text>
                              </Show>
                            </box>

                            {/* Questions List */}
                            <scrollbox
                              ref={(el: any) => { grillScroll = el }}
                              height={Math.max(6, Math.min(20, termH() - (isShort() ? 11 : 14)))}
                            >
                              <box flexDirection="column" gap={1}>
                                <For each={entry().grill.questions}>
                                  {(q: any, qIdx: () => number) => {
                                    const isFocused = () => qFocusZone() === "list" && focusedQ() === qIdx()
                                    const ans = () => entry().answers?.[q.id] ?? { selectedIds: [], customText: "" }
                                    const isEditingCustom = () => editingQId() === q.id
                                    const [customHover, setCustomHover] = createSignal(false)
                                    const customFocused = () => isFocused() && qOptIdx() >= (q.options?.length ?? 0)
                                    return (
                                      <box
                                        backgroundColor={isFocused() ? p().bgElevated ?? p().bgPanel : undefined}
                                        paddingX={1}
                                        flexDirection="column"
                                        gap={0}
                                        {...pressHandlers(() => {
                                          setQFocusZone("list")
                                          setFocusedQ(qIdx())
                                        })}
                                      >
                                        <text fg={isFocused() ? p().accent : p().textBase} bold wrapMode="word">
                                          {`${isFocused() ? "▸ " : "  "}Q${qIdx() + 1}: ${q.question}`}
                                        </text>
                                        <Show when={q.why}>
                                          <text fg={p().textMuted} wrapMode="word">{`  Why: ${q.why}`}</text>
                                        </Show>
                                        <box flexDirection="column" gap={0}>
                                          <For each={q.options ?? []}>
                                            {(opt: any, optIdx: () => number) => {
                                              const [optHover, setOptHover] = createSignal(false)
                                              const picked = () => (ans().selectedIds ?? []).includes(opt.id)
                                              const optLit = () => optHover() || (isFocused() && qOptIdx() === optIdx())
                                              return (
                                                <box
                                                  flexDirection="row"
                                                  gap={1}
                                                  backgroundColor={optLit() ? p().bgHover ?? p().bgBadgeInfo ?? p().bgPanel : undefined}
                                                  {...pressHandlers(
                                                    () => {
                                                      setQFocusZone("list")
                                                      setFocusedQ(qIdx())
                                                      setQOptIdx(optIdx())
                                                      store.selectOption(entry().targetKey, q.id, opt.id)
                                                    },
                                                    { onHover: setOptHover },
                                                  )}
                                                >
                                                  <text
                                                    fg={picked() ? p().success : optLit() ? p().accent : isFocused() ? p().info : p().textMuted}
                                                    bold={picked() || optLit()}
                                                  >
                                                    {`  ${optLit() ? "▸" : " "} ${picked() ? "(●)" : "(○)"} ${optIdx() + 1}`}
                                                  </text>
                                                  <text fg={picked() ? p().success : optLit() ? p().accent : p().textBase} bold={picked() || optLit()} wrapMode="word">
                                                    {`${opt.label}${opt.detail ? ` — ${opt.detail}` : ""}`}
                                                  </text>
                                                </box>
                                              )
                                            }}
                                          </For>
                                        </box>
                                        <Show
                                          when={isEditingCustom()}
                                          fallback={
                                            <box
                                              flexDirection="row"
                                              gap={1}
                                              backgroundColor={customHover() || customFocused() ? p().bgHover ?? p().bgBadgeInfo ?? p().bgPanel : undefined}
                                              {...pressHandlers(
                                                () => {
                                                  setQFocusZone("list")
                                                  setFocusedQ(qIdx())
                                                  setQOptIdx(q.options?.length ?? 0)
                                                  setEditingQId(q.id)
                                                  queueMicrotask(() => qEditor?.focus?.())
                                                },
                                                { onHover: setCustomHover },
                                              )}
                                            >
                                              <text fg={customHover() || customFocused() ? p().accent : ans().customText?.trim() ? p().info : p().textFaint} bold={customHover() || customFocused()}>
                                                {`  ${customFocused() ? "▸ " : "  "}${
                                                  ans().customText?.trim()
                                                    ? `✎ Custom: ${ans().customText.trim()}`
                                                    : "+ Custom answer / note [E]"
                                                }`}
                                              </text>
                                            </box>
                                          }
                                        >
                                          <box flexDirection="column" gap={0} border borderStyle="single" borderColor={p().borderActive} backgroundColor={p().bgFormField} paddingX={1}>
                                            <textarea
                                              ref={(el: any) => { qEditor = el }}
                                              initialValue={ans().customText ?? ""}
                                              placeholder="Add specific details or constraints…"
                                              placeholderColor={p().textFaint}
                                              height={2}
                                              textColor={p().textFormField}
                                              cursorColor={p().accent}
                                              wrapMode="word"
                                              onContentChange={() => store.setCustomAnswer(entry().targetKey, q.id, qEditor?.plainText ?? "")}
                                            />
                                            <box flexDirection="row" justifyContent="flexEnd">
                                              <ActionButton
                                                label="Done Note"
                                                shortcut="Esc"
                                                variant="secondary"
                                                palette={p()}
                                                onPress={() => {
                                                  flushPendingTextEdits()
                                                  qEditor?.blur?.()
                                                  setEditingQId(undefined)
                                                }}
                                              />
                                            </box>
                                          </box>
                                        </Show>
                                      </box>
                                    )
                                  }}
                                </For>
                              </box>
                            </scrollbox>

                            {/* Action Bar */}
                            <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                              <box flexDirection="row" gap={1} flexWrap="wrap">
                                <ActionButton
                                  label="Generate Improved Prompt"
                                  shortcut="Ctrl+S"
                                  variant="primary"
                                  focused={qFocusZone() === "actions" && qActionFocus() === "generate"}
                                  palette={p()}
                                  onPress={() => triggerGenerateFromGrill(false)}
                                />
                                <ActionButton
                                  label="Skip & Rewrite"
                                  shortcut="S"
                                  variant="secondary"
                                  focused={qFocusZone() === "actions" && qActionFocus() === "skip"}
                                  palette={p()}
                                  onPress={() => triggerGenerateFromGrill(true)}
                                />
                                <ActionButton
                                  label="Edit Draft"
                                  variant="secondary"
                                  focused={qFocusZone() === "actions" && qActionFocus() === "draft"}
                                  palette={p()}
                                  onPress={() => resetToDraftView(entry())}
                                />
                              </box>
                              <box flexDirection="row" gap={1} flexWrap="wrap">
                                <ActionButton
                                  label="Background"
                                  shortcut="Esc"
                                  variant="ghost"
                                  focused={qFocusZone() === "actions" && qActionFocus() === "bg"}
                                  palette={p()}
                                  onPress={closeModalToBackground}
                                />
                                <ActionButton
                                  label="Discard"
                                  shortcut="X"
                                  variant="danger"
                                  focused={qFocusZone() === "actions" && qActionFocus() === "discard"}
                                  palette={p()}
                                  onPress={() => closeAndKillWindow(entry().targetKey)}
                                />
                              </box>
                            </box>
                          </box>
                        </Match>

                        {/* 4. REVIEW, EDIT & MODEL RECOMMENDATION STUDIO */}
                        <Match when={entry().stage === "review" && entry().proposal}>
                          {(() => {
                            const result = () => entry().proposal
                            const targetModel = () => entry().selectedModelOverride ?? result().route
                            const modelLabel = () => {
                              const tm = targetModel()
                              if (tm) return modelRef(tm)
                              return result().startModel ? `Keep ${modelRef(result().startModel)}` : "Keep current"
                            }
                            const targetBench = () => {
                              if (entry().selectedModelOverride) return findCachedBench(entry().selectedModelOverride)
                              if (result().routeBenchmark) return result().routeBenchmark
                              return findCachedBench(targetModel() ?? result().startModel)
                            }
                            const altBench = () =>
                              result().alternativeBenchmark ?? (result().alternative?.model ? findCachedBench(result().alternative.model) : null)
                            const costBadge = () => {
                              const callUsage = result().usage
                              const callStr = callUsage ? formatUsageLine(callUsage) : ""
                              const totUsd = entry().windowCostUSD
                              const totStr = totUsd > 0 && callUsage && Math.abs(totUsd - callUsage.costUSD) > 1e-7
                                ? ` · tot ${formatCostUsd(totUsd, entry().windowEstimated)}`
                                : ""
                              return callStr ? `${callStr}${totStr}` : "cost tracked"
                            }
                            const lineCount = () => (entry().editedText || "").split(/\r?\n/).length
                            const charCount = () => (entry().editedText || "").length
                            const edited = () => (entry().editedText || "").trim() !== (result().text || "").trim()
                            const workspaceH = () => {
                              const overhead = (isShort() ? 14 : 17) + (refiningOpen() ? 3 : 0)
                              return Math.max(5, Math.min(22, termH() - overhead))
                            }

                            return (
                              <box flexDirection="column" gap={1}>
                                {/* Compact Model Recommendation Header */}
                                <box
                                  border
                                  borderStyle="rounded"
                                  borderColor={entry().applyRoute ? p().success : targetModel() ? p().borderActive : p().border}
                                  backgroundColor={p().bgPanel}
                                  paddingX={1}
                                  flexDirection="column"
                                  gap={0}
                                >
                                  <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                                    <box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                                      <text fg={entry().applyRoute ? p().success : targetModel() ? p().accent : p().info} bold>
                                        {entry().selectedModelOverride
                                          ? `★ Chosen: ${modelLabel()}`
                                          : result().route
                                            ? `★ Route: ${modelLabel()}`
                                            : `✓ ${modelLabel()}`}
                                      </text>
                                      <text fg={p().textMuted}>
                                        {`[${result().taskTier}] · ${(result().latencyMs / 1000).toFixed(1)}s · ${costBadge()}`}
                                      </text>
                                    </box>
                                    <box flexDirection="row" gap={1} flexWrap="wrap">
                                      <Show when={Boolean(targetModel())}>
                                        <PillChip
                                          label={entry().applyRoute ? "✓ Switch ON [R]" : "Switch OFF [R]"}
                                          color={entry().applyRoute ? p().success : p().textMuted}
                                          bg={entry().applyRoute ? p().bgBadgeSuccess : undefined}
                                          active={entry().applyRoute}
                                          bold={entry().applyRoute}
                                          focused={reviewFocus() === "switch-toggle"}
                                          palette={p()}
                                          onPress={() => {
                                            setConfirmOpen(false)
                                            store.toggleApplyRoute(entry().targetKey)
                                          }}
                                        />
                                      </Show>
                                      <PillChip
                                        label="Model… [M]"
                                        color={p().secondary}
                                        focused={reviewFocus() === "switch-model"}
                                        palette={p()}
                                        onPress={() => openModels("session")}
                                      />
                                    </box>
                                  </box>
                                  <Show when={targetBench() || result().tradeoffSummary || (!isShort() && result().alternative)}>
                                    <text fg={p().info} wrapMode="word">
                                      {(() => {
                                        const chip = formatBenchChip(targetBench())
                                        const mainPart = chip && result().tradeoffSummary
                                          ? `${chip} — ${result().tradeoffSummary}`
                                          : chip || result().tradeoffSummary || ""
                                        const altPart = !isShort() && result().alternative
                                          ? `Alt: ${modelRef(result().alternative.model)}${formatBenchChip(altBench()) ? ` (${formatBenchChip(altBench())})` : ""}`
                                          : ""
                                        return [mainPart, altPart].filter(Boolean).join("  ·  ")
                                      })()}
                                    </text>
                                  </Show>
                                  <text fg={p().textBase} wrapMode="word">
                                    {isShort() ? truncateText(result().reason, Math.max(40, dialogCols() - 8)) : result().reason}
                                  </text>
                                </box>

                                {/* Compact Improvements & Warnings Strip */}
                                <Show when={(result().improvements?.length ?? 0) > 0 || (result().warnings?.length ?? 0) > 0}>
                                  <box flexDirection="column" gap={0} paddingX={1}>
                                    <Show when={result().improvements?.length > 0}>
                                      <text fg={p().info} wrapMode="word">
                                        {isShort()
                                          ? `✦ ${truncateText(result().improvements.join(" · "), Math.max(40, dialogCols() - 6))}`
                                          : `✦ Improved: ${result().improvements.join(" · ")}`}
                                      </text>
                                    </Show>
                                    <Show when={result().warnings?.length > 0}>
                                      <text fg={p().warning} wrapMode="word">
                                        {`⚠ ${result().warnings.join(" · ")}`}
                                      </text>
                                    </Show>
                                  </box>
                                </Show>

                                {/* Unified Workspace Mode Tabs */}
                                <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                                  <box flexDirection="row" gap={1} flexWrap="wrap">
                                    <PillChip
                                      label={reviewTab() === "preview" ? "▸ Preview" : "Preview"}
                                      color={reviewTab() === "preview" ? p().accent : p().textMuted}
                                      active={reviewTab() === "preview"}
                                      bold={reviewTab() === "preview"}
                                      focused={reviewFocus() === "tab-preview"}
                                      palette={p()}
                                      onPress={() => switchReviewTab("preview", "tab-preview")}
                                    />
                                    <PillChip
                                      label={reviewTab() === "edit" ? "✓ Done Editing [Ctrl+S]" : "✎ Edit [E]"}
                                      color={reviewTab() === "edit" ? p().accent : p().textMuted}
                                      active={reviewTab() === "edit"}
                                      bold={reviewTab() === "edit"}
                                      focused={reviewFocus() === "tab-edit"}
                                      palette={p()}
                                      onPress={() => {
                                        if (reviewTab() === "edit") finishEditPrompt(entry())
                                        else startEditPrompt()
                                      }}
                                    />
                                    <PillChip
                                      label={reviewTab() === "compare" ? "▸ Compare [C]" : "⇄ Compare [C]"}
                                      color={reviewTab() === "compare" ? p().accent : p().textMuted}
                                      active={reviewTab() === "compare"}
                                      bold={reviewTab() === "compare"}
                                      focused={reviewFocus() === "tab-compare"}
                                      palette={p()}
                                      onPress={() => switchReviewTab(reviewTab() === "compare" ? "preview" : "compare", "tab-compare")}
                                    />
                                  </box>
                                  <text fg={edited() ? p().warning : p().textMuted}>
                                    {`${lineCount()}L · ${charCount()}c${edited() ? " · edited" : ""}`}
                                  </text>
                                </box>

                                {/* Main Prompt Workspace */}
                                <Show when={reviewTab() === "preview"}>
                                  <box border borderStyle="rounded" borderColor={p().border} paddingX={1}>
                                    <scrollbox
                                      ref={(el: any) => { previewScroll = el }}
                                      height={workspaceH()}
                                    >
                                      <text fg={p().textBase} wrapMode="word">{entry().editedText}</text>
                                    </scrollbox>
                                  </box>
                                </Show>

                                <Show when={reviewTab() === "edit"}>
                                  <box
                                    border
                                    borderStyle="rounded"
                                    borderColor={reviewFocus() === "editor-edit" ? p().borderActive : p().border}
                                    backgroundColor={p().bgFormField}
                                    title=" Edit Prompt Inline (Ctrl+S or Esc when done) "
                                    paddingX={1}
                                    {...pressHandlers(() => {
                                      setReviewFocus("editor-edit")
                                      queueMicrotask(() => promptEditor?.focus?.())
                                    })}
                                  >
                                    <textarea
                                      ref={(el: any) => { promptEditor = el }}
                                      initialValue={entry().editedText}
                                      height={workspaceH()}
                                      textColor={p().textFormField}
                                      cursorColor={p().accent}
                                      wrapMode="word"
                                      onContentChange={() => store.setEditedText(entry().targetKey, promptEditor?.plainText ?? entry().editedText)}
                                    />
                                  </box>
                                </Show>

                                <Show when={reviewTab() === "compare"}>
                                  <box border borderStyle="rounded" borderColor={p().border} paddingX={1}>
                                    <scrollbox
                                      ref={(el: any) => { previewScroll = el }}
                                      height={workspaceH()}
                                    >
                                      <box flexDirection="column" gap={1}>
                                        <box flexDirection="column" gap={0} backgroundColor={p().diffBgRemoved} paddingX={1}>
                                          <text fg={p().diffRemoved} bold>- ORIGINAL DRAFT</text>
                                          <text fg={p().textMuted} wrapMode="word">{result().original}</text>
                                        </box>
                                        <box flexDirection="column" gap={0} backgroundColor={p().diffBgAdded} paddingX={1}>
                                          <text fg={p().diffAdded} bold>+ IMPROVED PROMPT</text>
                                          <text fg={p().textBase} wrapMode="word">{entry().editedText}</text>
                                        </box>
                                      </box>
                                    </scrollbox>
                                  </box>
                                </Show>

                                {/* Quick Refine Bar */}
                                <Show
                                  when={refiningOpen()}
                                  fallback={
                                    <box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                                      <text fg={p().textMuted}>Refine:</text>
                                      <PillChip
                                        label="Shorter"
                                        focused={reviewFocus() === "ref-shorter"}
                                        palette={p()}
                                        onPress={() => triggerRefine("Make it tighter and more concise without losing constraints or verification.")}
                                      />
                                      <PillChip
                                        label="More Detail"
                                        focused={reviewFocus() === "ref-detail"}
                                        palette={p()}
                                        onPress={() => triggerRefine("Expand with explicit edge cases, acceptance criteria, and clear execution steps.")}
                                      />
                                      <PillChip
                                        label="Focus Tests"
                                        focused={reviewFocus() === "ref-tests"}
                                        palette={p()}
                                        onPress={() => triggerRefine("Emphasize test coverage, failure modes, and strict verification steps.")}
                                      />
                                      <PillChip
                                        label="Re-grill [G]"
                                        color={p().warning}
                                        focused={reviewFocus() === "ref-grill"}
                                        palette={p()}
                                        onPress={() => triggerRegrill(entry())}
                                      />
                                      <PillChip
                                        label="✦ Custom… [F]"
                                        color={p().accent}
                                        focused={reviewFocus() === "ref-custom"}
                                        palette={p()}
                                        onPress={openCustomRefine}
                                      />
                                    </box>
                                  }
                                >
                                  <box
                                    flexDirection="row"
                                    gap={1}
                                    alignItems="center"
                                    flexWrap="wrap"
                                    border
                                    borderStyle="single"
                                    borderColor={reviewFocus() === "refine-input" ? p().borderActive : p().border}
                                    backgroundColor={p().bgFormField}
                                    paddingX={1}
                                    {...pressHandlers(() => {
                                      setReviewFocus("refine-input")
                                      queueMicrotask(() => refineEditor?.focus?.())
                                    })}
                                  >
                                    <textarea
                                      ref={(el: any) => { refineEditor = el }}
                                      initialValue={refineText()}
                                      placeholder="Tell the rewriter how to adjust this prompt…"
                                      placeholderColor={p().textFaint}
                                      height={2}
                                      flexGrow={1}
                                      textColor={p().textFormField}
                                      cursorColor={p().accent}
                                      wrapMode="word"
                                      onContentChange={() => setRefineText(refineEditor?.plainText ?? "")}
                                    />
                                    <ActionButton
                                      label="Apply"
                                      shortcut="Ctrl+S"
                                      variant="primary"
                                      focused={reviewFocus() === "refine-apply"}
                                      palette={p()}
                                      onPress={() => triggerRefine(refineEditor?.plainText ?? refineText())}
                                    />
                                    <ActionButton
                                      label="Cancel"
                                      shortcut="Esc"
                                      variant="ghost"
                                      focused={reviewFocus() === "refine-cancel"}
                                      palette={p()}
                                      onPress={() => {
                                        refineEditor?.blur?.()
                                        setRefiningOpen(false)
                                        setReviewFocus("ref-custom")
                                      }}
                                    />
                                  </box>
                                </Show>

                                {/* Bottom Action Bar (or in-place Model Switch Confirmation) */}
                                <Show
                                  when={confirmSwitchOpen() && targetModel()}
                                  fallback={
                                    <box flexDirection="row" justifyContent="spaceBetween" alignItems="center" flexWrap="wrap" gap={1}>
                                      <box flexDirection="row" gap={1} flexWrap="wrap">
                                        <ActionButton
                                          label={entry().applyRoute && targetModel() ? "Switch Model & Send" : "Send Rewrite"}
                                          shortcut={reviewTab() === "edit" ? undefined : "↵"}
                                          variant={entry().applyRoute && targetModel() ? "success" : "primary"}
                                          focused={reviewFocus() === "send"}
                                          palette={p()}
                                          onPress={() => triggerSendReview(entry())}
                                        />
                                        <Show when={canAppendToComposer()}>
                                          <ActionButton
                                            label="To Composer"
                                            shortcut="I"
                                            variant="secondary"
                                            focused={reviewFocus() === "composer"}
                                            palette={p()}
                                            onPress={() => void handleInsertToComposer(entry())}
                                          />
                                        </Show>
                                        <ActionButton
                                          label="Send Original"
                                          shortcut="O"
                                          variant="secondary"
                                          focused={reviewFocus() === "original"}
                                          palette={p()}
                                          onPress={() => {
                                            setConfirmOpen(false)
                                            void submitProposal(entry().targetKey, result().original, false)
                                          }}
                                        />
                                      </box>
                                      <box flexDirection="row" gap={1} flexWrap="wrap">
                                        <ActionButton
                                          label="Background"
                                          shortcut="Esc"
                                          variant="ghost"
                                          focused={reviewFocus() === "bg"}
                                          palette={p()}
                                          onPress={closeModalToBackground}
                                        />
                                        <ActionButton
                                          label="Discard"
                                          shortcut="X"
                                          variant="danger"
                                          focused={reviewFocus() === "discard"}
                                          palette={p()}
                                          onPress={() => closeAndKillWindow(entry().targetKey)}
                                        />
                                      </box>
                                    </box>
                                  }
                                >
                                  <box
                                    backgroundColor={p().bgBadgeSuccess ?? p().bgElevated ?? p().bgPanel}
                                    paddingX={1}
                                    flexDirection="row"
                                    justifyContent="spaceBetween"
                                    alignItems="center"
                                    flexWrap="wrap"
                                    gap={1}
                                  >
                                    <text fg={p().success} bold wrapMode="word">
                                      {`Switch session model -> ${modelRef(targetModel())} & submit?`}
                                    </text>
                                    <box flexDirection="row" gap={1}>
                                      <ActionButton
                                        label="Confirm & Send"
                                        shortcut="↵"
                                        variant="success"
                                        active={true}
                                        focused={reviewFocus() === "confirm-send"}
                                        palette={p()}
                                        onPress={() => triggerSendReview(entry(), true)}
                                      />
                                      <ActionButton
                                        label="Back"
                                        shortcut="N / Esc"
                                        variant="ghost"
                                        focused={reviewFocus() === "confirm-cancel"}
                                        palette={p()}
                                        onPress={() => setConfirmOpen(false)}
                                      />
                                    </box>
                                  </box>
                                </Show>
                              </box>
                            )
                          })()}
                        </Match>

                        {/* 5. ERROR VIEW */}
                        <Match when={entry().stage === "error"}>
                          <box flexDirection="column" gap={1}>
                            <box
                              border
                              borderStyle="rounded"
                              borderColor={p().error}
                              backgroundColor={p().bgPanel}
                              title=" Rewrite Error "
                              padding={1}
                              flexDirection="column"
                              gap={1}
                            >
                              <text fg={p().error} bold wrapMode="word">{entry().error || "The rewrite failed."}</text>
                              <text fg={p().textMuted}>
                                Your draft and any clarifying answers are preserved. Nothing was submitted.
                              </text>
                            </box>
                            <box flexDirection="row" justifyContent="spaceBetween" flexWrap="wrap" gap={1}>
                              <box flexDirection="row" gap={1} flexWrap="wrap">
                                <ActionButton
                                  label="Retry"
                                  variant="primary"
                                  focused={errorFocus() === "retry"}
                                  palette={p()}
                                  onPress={() => triggerRetryError(entry())}
                                />
                                <ActionButton
                                  label="Edit Draft"
                                  variant="secondary"
                                  focused={errorFocus() === "draft"}
                                  palette={p()}
                                  onPress={() => resetToDraftView(entry())}
                                />
                              </box>
                              <box flexDirection="row" gap={1} flexWrap="wrap">
                                <ActionButton
                                  label="Background"
                                  shortcut="Esc / B"
                                  variant="ghost"
                                  focused={errorFocus() === "bg"}
                                  palette={p()}
                                  onPress={closeModalToBackground}
                                />
                                <ActionButton
                                  label="Discard"
                                  shortcut="X"
                                  variant="danger"
                                  focused={errorFocus() === "discard"}
                                  palette={p()}
                                  onPress={() => closeAndKillWindow(entry().targetKey)}
                                />
                              </box>
                            </box>
                          </box>
                        </Match>
                      </Switch>
                    )}
                  </Show>
                )}
              </Show>
            </box>
          )
        },
        () => {
          if (mySeq !== dialogSeq) return
          const mode = closingMode
          closingMode = null
          setDialogOpen(false)
          if (mode === null) {
            // Preserve active/running/questions/review/error/non-empty-draft work in background on implicit close (backdrop/Esc);
            // only remove completely empty untouched windows so FooterStatus never loses active tasks.
            const key = dialogTargetKey()
            if (key) {
              const entry = store.get(key)
              const keep = entry && (
                entry.stage === "running" ||
                entry.stage === "questions" ||
                entry.stage === "review" ||
                entry.stage === "error" ||
                (entry.stage === "draft" && Boolean(entry.draftText?.trim()))
              )
              if (!keep) store.removeWindow(key)
              syncTicker()
            }
          }
        },
      )
      api.ui.dialog.set({ size: dialogSize, centered: true })
    }

    async function handleInvoke(input?: string, forceDirect = false) {
      const target = currentTarget()
      if (!target) return toast("Use /rw from the start screen or inside a session.", "warning")

      let parsed
      try {
        parsed = parseInvocation(input)
      } catch (error) {
        return toast(errMessage(error), "error")
      }
      if (parsed.help) {
        return toast("Usage: /rw [--fast] [--model provider/model#variant] [draft text]. Also: /rw-direct, /rw-last, /rw-cancel.", "info")
      }

      const mode = forceDirect ? "direct" : parsed.mode
      const existing = store.ensure(target.targetKey, { sessionID: target.sessionID ?? null, label: target.label })

      // No inline text: resume running/questions/review if present, otherwise open Draft Studio.
      if (!parsed.text) {
        if (existing.stage === "running" || existing.stage === "questions" || existing.stage === "review" || existing.stage === "error") {
          if (parsed.model) store.setDraft(target.targetKey, { rewriteModel: parsed.model })
          openStudio(target.targetKey, "main", { force: true })
          return
        }
        const preserveDraftMode = existing.stage === "draft" && Boolean(existing.draftText?.trim()) && !forceDirect && !input?.trim()
        store.setDraft(target.targetKey, {
          stage: "draft",
          flowMode: preserveDraftMode ? existing.flowMode : mode,
          ...(parsed.model ? { rewriteModel: parsed.model } : {}),
          sessionID: target.sessionID ?? null,
          label: target.label,
        })
        openStudio(target.targetKey, "main", { force: true })
        return
      }

      if (existing.stage === "running") {
        toast("A rewrite is already running for this window — reopening progress.", "info")
        openStudio(target.targetKey, "main", { force: true })
        return
      }

      const rewriteModel = parsed.model ?? existing.rewriteModel
      if (mode === "direct") {
        await startRewrite(target, { text: parsed.text, rewriteModel, openDialog: true })
      } else {
        await startGrill(target, parsed.text, rewriteModel, { openDialog: true })
      }
    }

    api.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "rewrite.open",
          title: "Improve prompt (with Grill Me & model suggestion)",
          group: "Rewrite",
          palette: true,
          slash: { name: "rewrite", aliases: ["rw"], arguments: true },
          run: (input?: string) => handleInvoke(input, false),
        },
        {
          id: "rewrite.direct",
          title: "Improve prompt directly (skip Grill Me)",
          group: "Rewrite",
          palette: true,
          slash: { name: "rw-direct", aliases: ["rwd"], arguments: true },
          run: (input?: string) => handleInvoke(input, true),
        },
        {
          id: "rewrite.last",
          title: "Reopen latest rewrite / draft / questions",
          group: "Rewrite",
          palette: true,
          slash: { name: "rw-last" },
          run: async () => {
            void refreshServerJobs()
            const target = currentTarget()
            const existing = target ? store.get(target.targetKey) : undefined
            if (existing && existing.stage !== "idle") {
              openStudio(target!.targetKey, "main", { force: true })
              return
            }
            const active = store.listActiveWindows()
            if (active.length > 0) {
              openStudio(target?.targetKey ?? active[0].targetKey, "sessions", { force: true })
              return
            }
            if (!target) {
              toast("Use /rw-last from the start screen or inside a session.", "warning")
              return
            }
            toast("No saved rewrite or draft for this window yet.")
          },
        },
        {
          id: "rewrite.cancel",
          title: "Cancel active rewrite request",
          group: "Rewrite",
          palette: true,
          slash: { name: "rw-cancel" },
          run: async () => {
            const target = currentTarget()
            if (target && store.get(target.targetKey)?.stage === "running") {
              const ok = await cancelWindow(target.targetKey)
              if (ok) toast("Rewrite cancelled.", "info")
              return
            }
            const runningOther = store.listActiveWindows().find((w) => w.stage === "running")
            if (runningOther) {
              const ok = await cancelWindow(runningOther.targetKey)
              if (ok) toast(`Cancelled rewrite for ${runningOther.label}.`, "info")
              return
            }
            toast("No rewrite request is currently running.")
          },
        },
      ],
    }))

    const FooterStatus = () => {
      const [hovered, setHovered] = createSignal(false)
      const summary = createMemo(() => {
        storeTick()
        const now = nowMs()
        const target = currentTarget()
        return store.getFooterSummary(target?.targetKey, now)
      })
      const fg = () => {
        const p = palette()
        if (hovered()) return p.accent
        const tone = summary().tone
        if (tone === "info") return p.info
        if (tone === "success") return p.success
        if (tone === "warning") return p.warning
        if (tone === "error") return p.error
        if (tone === "accent") return p.accent
        return p.textMuted
      }
      return (
        <Show when={summary().visible}>
          <box
            flexDirection="row"
            backgroundColor={hovered() ? palette().bgHover ?? palette().bgElevated ?? palette().bgPanel : undefined}
            {...pressHandlers(openFromFooter, { isDisposed: () => disposed, onHover: setHovered })}
          >
            <text fg={hovered() || summary().tone !== "muted" ? palette().accent : palette().textMuted} bold={hovered()}>
              {" ✦ rw"}
            </text>
            <Show when={summary().statusLabel}>
              <text fg={fg()} bold>
                {` ${summary().statusLabel}`}
              </text>
            </Show>
            <Show when={(summary().extraCount ?? 0) > 0}>
              <text fg={palette().textMuted}>{` (+${summary().extraCount})`}</text>
            </Show>
            <text fg={palette().textMuted}>{" "}</text>
          </box>
        </Show>
      )
    }

    api.ui.slot({ append: "prompt.footer.status", render: () => <FooterStatus /> })
    api.ui.slot({ append: "home.footer.status", render: () => <FooterStatus /> })

    return () => {
      disposed = true
      if (ticker) clearInterval(ticker)
      try { unsubProgress?.() } catch {}
      for (const w of store.listWindows()) {
        if (w.stage === "running" && w.requestID) {
          void rpc.cancel({ requestID: w.requestID, targetKey: w.targetKey }, requestOptions(w.sessionID ?? undefined)).catch(() => {})
        }
      }
    }
  },
}
