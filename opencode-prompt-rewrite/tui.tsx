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
    const hoverBg = p.bgBadgeInfo ?? p.bgElevated ?? p.bgPanel ?? "#252b42"
    if (props.disabled) return { fg: p.textFaint, border: p.border, bg: undefined }
    if (props.variant === "primary") {
      return {
        fg: lit ? p.textActionPrimary : p.textActionPrimary,
        border: lit ? p.accent : p.borderActive,
        bg: lit ? p.borderActive ?? p.accent : p.bgActionPrimary,
      }
    }
    if (props.variant === "success") {
      return {
        fg: p.success,
        border: p.success,
        bg: lit || props.active ? p.bgBadgeSuccess ?? hoverBg : p.bgPanel,
      }
    }
    if (props.variant === "warning") {
      return {
        fg: p.warning,
        border: p.warning,
        bg: lit || props.active ? p.bgBadgeWarning ?? hoverBg : p.bgPanel,
      }
    }
    if (props.variant === "danger") {
      return {
        fg: p.error,
        border: p.error,
        bg: lit || props.active ? p.bgBadgeError ?? hoverBg : p.bgPanel,
      }
    }
    if (lit || props.active) {
      return { fg: p.accent, border: p.accent, bg: hoverBg }
    }
    return { fg: p.textBase, border: p.border, bg: p.bgPanel }
  }

  return (
    <box
      border={props.variant !== "ghost" || isLit()}
      borderStyle="rounded"
      borderColor={colors().border}
      backgroundColor={colors().bg}
      paddingX={1}
      onMouseOver={() => {
        if (!props.disabled) setHovered(true)
      }}
      onMouseOut={() => setHovered(false)}
      onMouseDown={() => {
        if (!props.disabled) props.onPress()
      }}
    >
      <text fg={colors().fg} bold={isLit() || props.variant === "primary" || props.active}>
        {props.focused ? "▸ " : ""}{props.shortcut ? `[${props.shortcut}] ${props.label}` : props.label}
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
  focused?: boolean
  disabled?: boolean
  palette: any
  onPress?: () => void
}) {
  const [hovered, setHovered] = createSignal(false)
  const isLit = () => !props.disabled && (hovered() || Boolean(props.focused))

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={
        props.disabled
          ? props.palette.border
          : isLit()
            ? props.palette.accent
            : props.borderColor ?? props.color ?? props.palette.border
      }
      backgroundColor={
        props.disabled
          ? undefined
          : isLit()
            ? props.bg ?? props.palette.bgElevated ?? props.palette.bgBadgeInfo ?? props.palette.bgPanel ?? "#252b42"
            : props.bg
      }
      paddingX={1}
      onMouseOver={() => {
        if (!props.disabled) setHovered(true)
      }}
      onMouseOut={() => setHovered(false)}
      onMouseDown={() => {
        if (!props.disabled && props.onPress) props.onPress()
      }}
    >
      <text
        fg={
          props.disabled
            ? props.palette.textFaint
            : isLit()
              ? (props.color && props.color !== props.palette.textMuted ? props.color : props.palette.accent)
              : props.color ?? props.palette.textBase
        }
        bold={isLit() || props.bold}
      >
        {props.focused ? "▸ " : ""}{props.label}
      </text>
    </box>
  )
}

function Stepper(props: { stage: string; flowMode: string; palette: any }) {
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
        {props.flowMode === "direct" ? "2 Analyze" : "2 Grill Me"}
      </text>
      <text fg={p().textFaint}>›</text>
      <text fg={colorFor(3)} bold={stepIndex() === 3}>3 Review & Model</text>
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
    const [cachedModels, setCachedModels] = createSignal<any[]>([])
    const [defaultRewriteModel, setDefaultRewriteModel] = createSignal<string | null>(null)

    const store = createRewriteStore(() => setStoreTick((n) => n + 1))

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

    // Subscribe to live server RPC progress events so window switches stay updated.
    const unsubProgress = rpc.events?.on?.("progress", (event: any) => {
      if (disposed) return
      const data = event?.data ?? event
      store.applyProgress(data)
      syncTicker()
    })

    // Sync any already-running server jobs on startup.
    void (async () => {
      try {
        const snap = unbox(await rpc.jobs({}, requestOptions()))
        store.hydrateServerJobs(snap)
        syncTicker()
      } catch {}
    })()

    async function startGrill(target: { targetKey: string; sessionID?: string; label: string }, text: string, rewriteModel?: string) {
      const requestID = globalThis.crypto.randomUUID()
      const options = requestOptions(target.sessionID)
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
      openStudio(target.targetKey)

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
        if (disposed) return
        if (Array.isArray(result?.availableModels)) setCachedModels(result.availableModels)
        if (result?.defaultRewriteModel) setDefaultRewriteModel(result.defaultRewriteModel)

        if (!result?.questions?.length || result.readyWithoutQuestions) {
          // Prompt is already sharp -> flow straight into generating the improved prompt.
          store.applyGrillResult(target.targetKey, result)
          syncTicker()
          await startRewrite(target, {
            text,
            rewriteModel,
            grillID: result.id,
            answers: [],
          })
          return
        }

        store.applyGrillResult(target.targetKey, result)
        syncTicker()
        if (!dialogOpen() || currentTarget()?.targetKey !== target.targetKey) {
          toast(`Clarifying questions ready for ${target.label}. Run /rw to answer.`, "info")
        }
      } catch (error: any) {
        if (disposed) return
        const msg = errMessage(error)
        if (/cancelled/i.test(msg)) {
          store.applyCancelled(target.targetKey, requestID)
        } else {
          store.applyError(target.targetKey, requestID, msg)
          toast(`${msg} Your draft is preserved in /rw-last.`, "error")
        }
        syncTicker()
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
      },
    ) {
      const requestID = globalThis.crypto.randomUUID()
      const options = requestOptions(target.sessionID)
      const isRefine = Boolean(params.refineInstruction?.trim())
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
      if (currentTarget()?.targetKey === target.targetKey) {
        openStudio(target.targetKey)
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
        if (disposed) return
        if (Array.isArray(proposal?.availableModels)) setCachedModels(proposal.availableModels)
        if (proposal?.defaultRewriteModel) setDefaultRewriteModel(proposal.defaultRewriteModel)
        store.applyProposalResult(target.targetKey, proposal)
        syncTicker()

        if (!dialogOpen() || currentTarget()?.targetKey !== target.targetKey) {
          toast(`Improved prompt ready for ${target.label}. Run /rw to review.`, "success")
        }
      } catch (error: any) {
        if (disposed) return
        const msg = errMessage(error)
        if (/cancelled/i.test(msg)) {
          store.applyCancelled(target.targetKey, requestID)
        } else {
          store.applyError(target.targetKey, requestID, msg)
          toast(`${msg} Your draft is preserved in /rw-last.`, "error")
        }
        syncTicker()
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
        toast(errMessage(error), "error")
        return false
      }
    }

    async function submitProposal(targetKey: string, textToSend: string, applyModelSwitch: boolean) {
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

      try {
        const payload: any = {
          resultID: result.id,
          text: textToSend,
          applyRoute: Boolean(applyModelSwitch && targetModel),
        }
        if (applyModelSwitch && entry.selectedModelOverride) {
          payload.selectedModel = entry.selectedModelOverride
        }
        const sent = unbox(await rpc.submit(payload, requestOptions(result.sessionID ?? undefined)))
        store.clearProposal(targetKey)
        syncTicker()
        api.ui.dialog.clear()
        setDialogOpen(false)
        if (!result.sessionID) {
          await api.data?.session?.sync?.(sent.sessionID).catch(() => {})
          api.ui.router.navigate({ type: "session", sessionID: sent.sessionID })
        }
        const msg = sent.switched
          ? (sent.queued ? "Switched model & queued prompt." : "Switched model & submitted prompt.")
          : (sent.queued ? "Prompt queued with current model." : "Prompt submitted.")
        toast(msg, "success")
      } catch (error) {
        toast(errMessage(error), "error")
        openStudio(targetKey)
      }
    }

    function openStudio(targetKey: string) {
      if (disposed) return
      setDialogTargetKey(targetKey)
      const entry = store.get(targetKey)
      void loadModelsIfNeeded(entry?.sessionID ?? undefined)

      if (dialogOpen()) return
      setDialogOpen(true)

      const width = api.renderer?.width ?? 100
      const dialogSize = width >= 106 ? "xlarge" : "large"

      api.ui.dialog.show(
        () => {
          const [subView, setSubView] = createSignal<"main" | "models">("main")
          const [modelPickerPurpose, setModelPickerPurpose] = createSignal<"rewrite" | "session">("rewrite")
          const [modelFilter, setModelFilter] = createSignal("")
          const [modelCursor, setModelCursor] = createSignal(0)
          const [modelFocusZone, setModelFocusZone] = createSignal<"filter" | "default" | "list" | "back">("filter")
          const [modelVariantIdx, setModelVariantIdx] = createSignal(-1)

          const [draftFocus, setDraftFocus] = createSignal<string>("editor")
          const [runningFocus, setRunningFocus] = createSignal<"bg" | "cancel">("bg")

          const [focusedQ, setFocusedQ] = createSignal(0)
          const [editingQId, setEditingQId] = createSignal<string | undefined>(undefined)
          const [qFocusZone, setQFocusZone] = createSignal<"list" | "actions">("list")
          const [qOptIdx, setQOptIdx] = createSignal(0)
          const [qActionFocus, setQActionFocus] = createSignal<"generate" | "skip" | "draft" | "bg">("generate")

          const [reviewTab, setReviewTab] = createSignal<"preview" | "edit" | "compare">("preview")
          const [refiningOpen, setRefiningOpen] = createSignal(false)
          const [refineText, setRefineText] = createSignal("")
          const [confirmSwitchOpen, setConfirmSwitchOpen] = createSignal(false)
          const [reviewFocus, setReviewFocus] = createSignal<string>("send")
          const [errorFocus, setErrorFocus] = createSignal<"retry" | "draft" | "close">("retry")

          let draftEditor: any
          let promptEditor: any
          let refineEditor: any
          let qEditor: any
          let filterEditor: any
          let previewScroll: any
          let grillScroll: any

          const activeEntry = createMemo(() => {
            storeTick()
            const key = dialogTargetKey()
            return key ? store.get(key) : undefined
          })

          const isTyping = createMemo(() => {
            if (subView() === "models") return modelFocusZone() === "filter"
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

          const termH = () => Math.max(22, api.renderer?.height ?? 36)
          const p = () => palette()

          const setConfirmOpen = (open: boolean) => {
            setConfirmSwitchOpen(open)
            setReviewFocus(open ? "confirm-send" : "send")
          }

          const openModels = (purpose: "rewrite" | "session") => {
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
            setDialogOpen(false)
            api.ui.dialog.clear()
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
              void startRewrite(target, { text, rewriteModel: e.rewriteModel })
            } else {
              void startGrill(target, text, e.rewriteModel)
            }
          }

          const triggerDirectFromDraft = () => {
            const e = activeEntry()
            if (!e) return
            const text = (draftEditor?.plainText ?? e.draftText ?? "").trim()
            if (!text) {
              toast("Enter a prompt first before rewriting.", "warning")
              return
            }
            store.setDraft(e.targetKey, { draftText: text, flowMode: "direct" })
            void startRewrite(
              { targetKey: e.targetKey, sessionID: e.sessionID ?? undefined, label: e.label },
              { text, rewriteModel: e.rewriteModel },
            )
          }

          const triggerGenerateFromGrill = (skipAnswers = false) => {
            const e = activeEntry()
            if (!e?.grill) return
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
              },
            )
          }

          const draftRing = (e: any): string[] => [
            "editor",
            "mode-grill",
            "mode-direct",
            "model",
            "start",
            ...(e?.flowMode === "grill" ? ["skip"] : []),
            "close",
          ]

          const moveDraftFocus = (delta: 1 | -1) => {
            const e = activeEntry()
            const next = cycleFocus(draftRing(e), draftFocus(), delta)
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
              case "skip":
                triggerDirectFromDraft()
                return
              case "close":
                closeModalToBackground()
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

          const qActionOrder = ["generate", "skip", "draft", "bg"] as const

          const resetToDraftView = (e: any) => {
            setFocusedQ(0)
            setQFocusZone("list")
            setEditingQId(undefined)
            setConfirmOpen(false)
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
              void startRewrite(target, { text, rewriteModel: e.rewriteModel })
            } else {
              void startGrill(target, text, e.rewriteModel)
            }
          }

          const startEditPrompt = () => {
            setConfirmOpen(false)
            setRefiningOpen(false)
            setReviewTab("edit")
            setReviewFocus("editor-edit")
            queueMicrotask(() => promptEditor?.focus?.())
          }

          const finishEditPrompt = (e: any) => {
            if (e && promptEditor) store.setEditedText(e.targetKey, promptEditor.plainText ?? e.editedText)
            promptEditor?.blur?.()
            setReviewTab("preview")
            setReviewFocus("send")
          }

          const openCustomRefine = () => {
            setConfirmOpen(false)
            setReviewTab("preview")
            setRefiningOpen(true)
            setReviewFocus("refine-input")
            queueMicrotask(() => refineEditor?.focus?.())
          }

          const reviewRing = (e: any): string[] => {
            const targetModel = e?.selectedModelOverride ?? e?.proposal?.route
            if (confirmSwitchOpen()) return ["confirm-send", "confirm-cancel"]
            if (reviewTab() === "edit") {
              return ["editor-edit", "send", ...(canAppendToComposer() ? ["composer"] : []), "edit-btn", "original", "close"]
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
              "edit-btn",
              "original",
              "close",
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
            setQFocusZone("list")
            setEditingQId(undefined)
            void startGrill(
              { targetKey: e.targetKey, sessionID: e.sessionID ?? undefined, label: e.label },
              e.editedText || e.proposal.original,
              e.rewriteModel,
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
                setConfirmOpen(false)
                setReviewTab("preview")
                return
              case "tab-edit":
                startEditPrompt()
                return
              case "tab-compare":
                setConfirmOpen(false)
                setReviewTab((t) => (t === "compare" ? "preview" : "compare"))
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
              case "composer": {
                const txt = ((reviewTab() === "edit" ? promptEditor?.plainText : undefined) ?? e.editedText ?? e.proposal.text).trim()
                void insertIntoComposer(txt).then((ok) => {
                  if (ok) closeModalToBackground()
                })
                return
              }
              case "edit-btn":
                if (reviewTab() === "edit") finishEditPrompt(e)
                else startEditPrompt()
                return
              case "original":
                setConfirmOpen(false)
                void submitProposal(e.targetKey, e.proposal.original, false)
                return
              case "close":
                closeModalToBackground()
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
            const inModels = subView() === "models"
            const nav = !isTyping()

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

            return {
              mode: "modal",
              priority: 20,
              commands: [
                // Model picker controls
                {
                  bind: "ctrl+d",
                  title: "Back",
                  enabled: inModels || (stage === "questions" && Boolean(editingQId())) || (stage === "review" && (reviewTab() === "edit" || refiningOpen())),
                  run: () => {
                    if (inModels) setSubView("main")
                    else if (stage === "questions") {
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
                    setModelVariantIdx(-1)
                    setModelCursor((i) => Math.max(0, i - 1))
                  },
                },
                {
                  bind: "down",
                  title: "Next model",
                  enabled: inModels,
                  run: () => {
                    setModelVariantIdx(-1)
                    setModelCursor((i) => Math.min(Math.max(0, filteredModels().length - 1), i + 1))
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

                // Draft controls (Tab moves out of/into textarea cleanly; arrows move buttons when outside editor)
                {
                  bind: "tab",
                  title: "Next control",
                  enabled: !inModels && stage === "draft",
                  run: () => moveDraftFocus(1),
                },
                {
                  bind: "shift+tab",
                  title: "Previous control",
                  enabled: !inModels && stage === "draft",
                  run: () => moveDraftFocus(-1),
                },
                {
                  bind: "right",
                  title: "Next button",
                  enabled: !inModels && stage === "draft" && nav,
                  run: () => moveDraftFocus(1),
                },
                {
                  bind: "down",
                  title: "Next button",
                  enabled: !inModels && stage === "draft" && nav,
                  run: () => moveDraftFocus(1),
                },
                {
                  bind: "left",
                  title: "Previous button",
                  enabled: !inModels && stage === "draft" && nav,
                  run: () => moveDraftFocus(-1),
                },
                {
                  bind: "up",
                  title: "Previous button",
                  enabled: !inModels && stage === "draft" && nav,
                  run: () => moveDraftFocus(-1),
                },
                {
                  bind: "return",
                  title: "Activate button",
                  enabled: !inModels && stage === "draft" && nav,
                  run: activateDraftFocus,
                },
                {
                  bind: "space",
                  title: "Activate button",
                  enabled: !inModels && stage === "draft" && nav,
                  run: activateDraftFocus,
                },
                {
                  bind: "ctrl+s",
                  title: "Continue",
                  enabled: !inModels && stage === "draft",
                  run: triggerStartFromDraft,
                },
                {
                  bind: "ctrl+g",
                  title: "Toggle Grill Me / Direct",
                  enabled: !inModels && stage === "draft" && Boolean(e),
                  run: () => e && store.setDraft(e.targetKey, { flowMode: e.flowMode === "grill" ? "direct" : "grill" }),
                },
                {
                  bind: "ctrl+m",
                  title: "Pick rewrite model",
                  enabled: !inModels && stage === "draft",
                  run: () => openModels("rewrite"),
                },

                // Running controls
                ...(["tab", "shift+tab", "left", "right", "up", "down"] as const).map((k) => ({
                  bind: k,
                  title: "Switch button",
                  enabled: !inModels && stage === "running",
                  run: () => setRunningFocus((f) => (f === "bg" ? "cancel" : "bg")),
                })),
                {
                  bind: "return",
                  title: "Activate running button",
                  enabled: !inModels && stage === "running" && Boolean(e),
                  run: () => {
                    if (runningFocus() === "cancel" && e) void cancelWindow(e.targetKey)
                    else closeModalToBackground()
                  },
                },
                {
                  bind: "space",
                  title: "Activate running button",
                  enabled: !inModels && stage === "running" && Boolean(e),
                  run: () => {
                    if (runningFocus() === "cancel" && e) void cancelWindow(e.targetKey)
                    else closeModalToBackground()
                  },
                },
                {
                  bind: "b",
                  title: "Run in background",
                  enabled: !inModels && stage === "running",
                  run: closeModalToBackground,
                },
                {
                  bind: "c",
                  title: "Cancel request",
                  enabled: !inModels && stage === "running" && Boolean(e),
                  run: () => e && void cancelWindow(e.targetKey),
                },

                // Grill Me navigation & action bar controls
                {
                  bind: "tab",
                  title: "Switch questions / buttons",
                  enabled: !inModels && stage === "questions",
                  run: () => {
                    if (editingQId()) {
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
                  enabled: !inModels && stage === "questions",
                  run: () => {
                    if (editingQId()) {
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
                      setQActionFocus("bg")
                    }
                  },
                },
                {
                  bind: "up",
                  title: "Previous question",
                  enabled: !inModels && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") {
                      setQFocusZone("list")
                      return
                    }
                    setQOptIdx(0)
                    setFocusedQ((i) => Math.max(0, i - 1))
                  },
                },
                {
                  bind: "down",
                  title: "Next question",
                  enabled: !inModels && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") return
                    const qLen = e?.grill?.questions?.length ?? 0
                    if (focusedQ() >= qLen - 1) {
                      setQFocusZone("actions")
                      return
                    }
                    setQOptIdx(0)
                    setFocusedQ((i) => Math.min(Math.max(0, qLen - 1), i + 1))
                  },
                },
                {
                  bind: "left",
                  title: "Previous option / button",
                  enabled: !inModels && stage === "questions" && nav,
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
                  enabled: !inModels && stage === "questions" && nav,
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
                  enabled: !inModels && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") {
                      if (qActionFocus() === "generate") triggerGenerateFromGrill(false)
                      else if (qActionFocus() === "skip") triggerGenerateFromGrill(true)
                      else if (qActionFocus() === "draft" && e) resetToDraftView(e)
                      else if (qActionFocus() === "bg") closeModalToBackground()
                      return
                    }
                    activateQuestionOpt()
                  },
                },
                ...[1, 2, 3, 4, 5].map((num) => ({
                  bind: String(num),
                  title: `Pick option ${num}`,
                  enabled: !inModels && stage === "questions" && nav,
                  run: () => {
                    const q = e?.grill?.questions?.[focusedQ()]
                    const opt = q?.options?.[num - 1]
                    if (e && q && opt) {
                      setQOptIdx(num - 1)
                      store.selectOption(e.targetKey, q.id, opt.id)
                    }
                  },
                })),
                {
                  bind: "e",
                  title: "Add custom answer",
                  enabled: !inModels && stage === "questions" && nav,
                  run: () => {
                    const q = e?.grill?.questions?.[focusedQ()]
                    if (q) {
                      setEditingQId(q.id)
                      queueMicrotask(() => qEditor?.focus?.())
                    }
                  },
                },
                {
                  bind: "ctrl+s",
                  title: "Generate improved prompt",
                  enabled: !inModels && stage === "questions",
                  run: () => triggerGenerateFromGrill(false),
                },
                {
                  bind: "return",
                  title: "Activate focused action",
                  enabled: !inModels && stage === "questions" && nav,
                  run: () => {
                    if (qFocusZone() === "actions") {
                      if (qActionFocus() === "skip") triggerGenerateFromGrill(true)
                      else if (qActionFocus() === "draft" && e) resetToDraftView(e)
                      else if (qActionFocus() === "bg") closeModalToBackground()
                      else triggerGenerateFromGrill(false)
                      return
                    }
                    triggerGenerateFromGrill(false)
                  },
                },
                {
                  bind: "s",
                  title: "Skip questions & rewrite",
                  enabled: !inModels && stage === "questions" && nav,
                  run: () => triggerGenerateFromGrill(true),
                },

                // Review controls (Tab/Shift+Tab and Left/Right focus every pill/button!)
                {
                  bind: "tab",
                  title: "Next control",
                  enabled: !inModels && stage === "review",
                  run: () => moveReviewFocus(1),
                },
                {
                  bind: "shift+tab",
                  title: "Previous control",
                  enabled: !inModels && stage === "review",
                  run: () => moveReviewFocus(-1),
                },
                {
                  bind: "right",
                  title: "Next button / pill",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => moveReviewFocus(1),
                },
                {
                  bind: "left",
                  title: "Previous button / pill",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => moveReviewFocus(-1),
                },
                {
                  bind: "return",
                  title: "Activate focused button",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => activateReviewFocus(reviewFocus()),
                },
                {
                  bind: "space",
                  title: "Activate focused button",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => activateReviewFocus(reviewFocus()),
                },
                {
                  bind: "n",
                  title: "Cancel switch confirmation",
                  enabled: !inModels && stage === "review" && confirmSwitchOpen(),
                  run: () => setConfirmOpen(false),
                },
                {
                  bind: "ctrl+s",
                  title: "Save edits",
                  enabled: !inModels && stage === "review" && reviewTab() === "edit",
                  run: () => finishEditPrompt(e),
                },
                {
                  bind: "ctrl+s",
                  title: "Apply refinement",
                  enabled: !inModels && stage === "review" && refiningOpen(),
                  run: () => triggerRefine(refineEditor?.plainText ?? refineText()),
                },
                {
                  bind: "e",
                  title: "Edit prompt",
                  enabled: !inModels && stage === "review" && nav,
                  run: startEditPrompt,
                },
                {
                  bind: "f",
                  title: "Refine with instruction",
                  enabled: !inModels && stage === "review" && nav,
                  run: openCustomRefine,
                },
                {
                  bind: "c",
                  title: "Compare original",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => {
                    setConfirmOpen(false)
                    setReviewTab((t) => (t === "compare" ? "preview" : "compare"))
                  },
                },
                {
                  bind: "r",
                  title: "Toggle recommended model",
                  enabled: !inModels && stage === "review" && nav && Boolean(e?.selectedModelOverride ?? e?.proposal?.route),
                  run: () => {
                    setConfirmOpen(false)
                    if (e) store.toggleApplyRoute(e.targetKey)
                  },
                },
                {
                  bind: "m",
                  title: "Choose model",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => {
                    setConfirmOpen(false)
                    openModels("session")
                  },
                },
                {
                  bind: "g",
                  title: "Re-grill",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => e && triggerRegrill(e),
                },
                {
                  bind: "o",
                  title: "Send original",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => {
                    setConfirmOpen(false)
                    if (e?.proposal) void submitProposal(e.targetKey, e.proposal.original, false)
                  },
                },
                {
                  bind: "i",
                  title: "Insert into composer",
                  enabled: !inModels && stage === "review" && nav && canAppendToComposer(),
                  run: async () => {
                    if (!e?.proposal) return
                    const ok = await insertIntoComposer(e.editedText || e.proposal.text)
                    if (ok) closeModalToBackground()
                  },
                },
                {
                  bind: "up",
                  title: "Scroll up",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => previewScroll?.scrollBy?.(-2),
                },
                {
                  bind: "down",
                  title: "Scroll down",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => previewScroll?.scrollBy?.(2),
                },
                {
                  bind: "pageup",
                  title: "Page up",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => previewScroll?.scrollBy?.(-8),
                },
                {
                  bind: "pagedown",
                  title: "Page down",
                  enabled: !inModels && stage === "review" && nav,
                  run: () => previewScroll?.scrollBy?.(8),
                },

                // Error controls
                ...(["tab", "right", "down"] as const).map((k) => ({
                  bind: k,
                  title: "Next error button",
                  enabled: !inModels && stage === "error",
                  run: () => setErrorFocus((c) => cycleFocus(["retry", "draft", "close"], c, 1)),
                })),
                ...(["shift+tab", "left", "up"] as const).map((k) => ({
                  bind: k,
                  title: "Previous error button",
                  enabled: !inModels && stage === "error",
                  run: () => setErrorFocus((c) => cycleFocus(["retry", "draft", "close"], c, -1)),
                })),
                ...(["return", "space"] as const).map((k) => ({
                  bind: k,
                  title: "Activate error button",
                  enabled: !inModels && stage === "error" && Boolean(e),
                  run: () => {
                    if (!e) return
                    if (errorFocus() === "retry") triggerRetryError(e)
                    else if (errorFocus() === "draft") resetToDraftView(e)
                    else closeModalToBackground()
                  },
                })),
              ],
            }
          })

          return (
            <box flexDirection="column" padding={1} gap={1}>
              {/* Header Bar */}
              <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                <box flexDirection="row" gap={2} alignItems="center">
                  <text fg={p().accent} bold>✦ PROMPT REWRITE</text>
                  <Show when={activeEntry()}>
                    {(entry) => (
                      <Stepper stage={entry().stage} flowMode={entry().flowMode} palette={p()} />
                    )}
                  </Show>
                </box>
                <Show when={activeEntry()}>
                  {(entry) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={p().info}>{entry().label}</text>
                      <Show when={entry().rewriteModel || effectiveBaseModel()}>
                        <text fg={p().textMuted}>
                          · {compactModelName(entry().rewriteModel || effectiveBaseModel()!)}
                        </text>
                      </Show>
                      <Show when={entry().windowCostUSD > 0}>
                        <text fg={p().success} bold>
                          · {formatCostUsd(entry().windowCostUSD, entry().windowEstimated)}
                          {entry().windowTokens > 0 ? ` (${formatTokensCompact(entry().windowTokens, entry().windowEstimated)})` : ""}
                        </text>
                      </Show>
                    </box>
                  )}
                </Show>
              </box>

              {/* Window changed notice */}
              <Show when={activeEntry() && currentTarget()?.targetKey !== activeEntry()?.targetKey}>
                <box border borderStyle="rounded" borderColor={p().warning} paddingX={1}>
                  <text fg={p().warning}>
                    Active window changed since opening this rewrite. Return to "{activeEntry()?.label}" before submitting.
                  </text>
                </box>
              </Show>

              {/* SUB-VIEW: INLINE MODEL PICKER */}
              <Show when={subView() === "models"}>
                <box flexDirection="column" gap={1}>
                  <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                    <box flexDirection="column" gap={0}>
                      <text fg={p().accent} bold>
                        {modelPickerPurpose() === "rewrite"
                          ? "Select Rewrite Model (base defaults to gpt-6.1-terra-openai#low)"
                          : "Select Session Working Model (Performance-Cost ranked below)"}
                      </text>
                      <text fg={p().textMuted}>
                        ↑↓ model · ←→ #effort variant · Tab switch zone · Enter select
                      </text>
                    </box>
                    <ActionButton
                      label="Back"
                      shortcut="Ctrl+D"
                      focused={modelFocusZone() === "back"}
                      palette={p()}
                      onPress={() => setSubView("main")}
                    />
                  </box>
                  <box
                    border
                    borderStyle="rounded"
                    borderColor={modelFocusZone() === "filter" ? p().borderActive : p().border}
                    title=" Filter models "
                    paddingX={1}
                  >
                    <textarea
                      ref={(el: any) => { filterEditor = el }}
                      initialValue={modelFilter()}
                      height={1}
                      textColor={p().textBase}
                      cursorColor={p().accent}
                      onContentChange={() => {
                        setModelFilter(filterEditor?.plainText ?? "")
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
                  <scrollbox height={Math.max(6, Math.min(16, termH() - 17))} scrollbar={true}>
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
                              border
                              borderStyle="rounded"
                              borderColor={highlighted() ? p().borderActive : rowHovered() ? p().accent : p().border}
                              backgroundColor={lit() ? p().bgElevated ?? p().bgBadgeInfo ?? p().bgPanel : undefined}
                              paddingX={1}
                              onMouseOver={() => setRowHovered(true)}
                              onMouseOut={() => setRowHovered(false)}
                              onMouseDown={() => applyModelSelection(m)}
                            >
                              <box flexDirection="row" justifyContent="spaceBetween">
                                <text fg={lit() ? p().accent : p().textBase} bold={lit()}>
                                  {highlighted() ? "▸ " : "  "}{fullRef}{isBase() ? " [base]" : ""}
                                </text>
                                <text fg={p().textMuted}>
                                  {m.name !== m.id ? m.name : ""}{ctxLabel}{flags ? ` · ${flags}` : ""}
                                </text>
                              </box>
                              <Show when={benchLine}>
                                <text fg={m.benchmark?.deprecated ? p().textFaint : highValue ? p().success : p().info}>
                                  {"  "}{benchLine}
                                </text>
                              </Show>
                              <Show when={m.variants?.length > 0}>
                                <box flexDirection="row" gap={1} paddingTop={0}>
                                  <text fg={p().textFaint}>Effort:</text>
                                  <For each={m.variants}>
                                    {(v: string, vIdx: () => number) => {
                                      const vFocused = () => highlighted() && modelVariantIdx() === vIdx()
                                      return (
                                        <PillChip
                                          label={`#${v}`}
                                          color={vFocused() ? p().accent : p().info}
                                          borderColor={vFocused() ? p().accent : p().border}
                                          focused={vFocused()}
                                          palette={p()}
                                          onPress={() => applyModelSelection(m, v)}
                                        />
                                      )
                                    }}
                                  </For>
                                </box>
                              </Show>
                            </box>
                          )
                        }}
                      </For>
                      <Show when={filteredModels().length === 0}>
                        <text fg={p().textMuted}>No enabled chat models match "{modelFilter()}".</text>
                      </Show>
                    </box>
                  </scrollbox>
                </box>
              </Show>

              {/* MAIN FLOWS */}
              <Show when={subView() === "main" && activeEntry()}>
                {(entry) => (
                  <Switch>
                    {/* 1. DRAFT STUDIO */}
                    <Match when={entry().stage === "draft"}>
                      <box flexDirection="column" gap={1}>
                        <box
                          border
                          borderStyle="rounded"
                          borderColor={draftFocus() === "editor" ? p().borderActive : p().border}
                          title=" Draft Prompt (describe goal · Tab moves to options/buttons) "
                          paddingX={1}
                          onMouseDown={() => {
                            setDraftFocus("editor")
                            queueMicrotask(() => draftEditor?.focus?.())
                          }}
                        >
                          <textarea
                            ref={(el: any) => { draftEditor = el }}
                            initialValue={entry().draftText}
                            height={Math.max(6, Math.min(18, termH() - 16))}
                            textColor={p().textBase}
                            cursorColor={p().accent}
                            wrapMode="word"
                            onContentChange={() => store.setDraft(entry().targetKey, { draftText: draftEditor?.plainText ?? "" })}
                          />
                        </box>

                        {/* Mode & Model Options Strip */}
                        <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                          <box flexDirection="row" gap={1}>
                            <PillChip
                              label={entry().flowMode === "grill" ? "● Grill Me First (asks clarifying Qs)" : "○ Grill Me First"}
                              color={entry().flowMode === "grill" ? p().accent : p().textMuted}
                              borderColor={entry().flowMode === "grill" ? p().borderActive : p().border}
                              bold={entry().flowMode === "grill"}
                              focused={draftFocus() === "mode-grill"}
                              palette={p()}
                              onPress={() => {
                                setDraftFocus("mode-grill")
                                store.setDraft(entry().targetKey, { flowMode: "grill" })
                              }}
                            />
                            <PillChip
                              label={entry().flowMode === "direct" ? "● Direct Rewrite" : "○ Direct Rewrite"}
                              color={entry().flowMode === "direct" ? p().info : p().textMuted}
                              borderColor={entry().flowMode === "direct" ? p().info : p().border}
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
                            } [Ctrl+M]`}
                            color={p().secondary}
                            borderColor={p().border}
                            focused={draftFocus() === "model"}
                            palette={p()}
                            onPress={() => openModels("rewrite")}
                          />
                        </box>

                        {/* Action Buttons */}
                        <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                          <box flexDirection="row" gap={1}>
                            <ActionButton
                              label={entry().flowMode === "grill" ? "Analyze & Grill Me" : "Improve Prompt"}
                              shortcut="Ctrl+S"
                              variant="primary"
                              focused={draftFocus() === "start"}
                              palette={p()}
                              onPress={triggerStartFromDraft}
                            />
                            <Show when={entry().flowMode === "grill"}>
                              <ActionButton
                                label="Skip Grill -> Rewrite"
                                variant="secondary"
                                focused={draftFocus() === "skip"}
                                palette={p()}
                                onPress={triggerDirectFromDraft}
                              />
                            </Show>
                          </box>
                          <ActionButton
                            label="Cancel"
                            shortcut="Esc"
                            variant="ghost"
                            focused={draftFocus() === "close"}
                            palette={p()}
                            onPress={closeModalToBackground}
                          />
                        </box>
                      </box>
                    </Match>

                    {/* 2. LIVE PROGRESS / WAITING VIEW */}
                    <Match when={entry().stage === "running"}>
                      {(() => {
                        const spin = () => SPINNER_FRAMES[Math.floor(nowMs() / 150) % SPINNER_FRAMES.length]
                        const elapsed = () => formatElapsed(nowMs() - (entry().startedAt || nowMs()))
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
                              <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                                <text fg={p().info} bold>
                                  {spin()} {entry().phaseDetail || phaseLabel(entry().phase)}
                                </text>
                                <text fg={p().accent} bold>{elapsed()}</text>
                              </box>
                              <box flexDirection="column" gap={0}>
                                <text fg={p().textBase}>
                                  Model: {entry().rewriteModel || effectiveBaseModel() || (selectedModel() ? modelRef(selectedModel()!) : "resolving…")}
                                </text>
                                <text fg={p().textMuted}>
                                  State: {phaseLabel(entry().phase)} · Target: {entry().label}
                                </text>
                                <text fg={p().textMuted}>
                                  Safe to minimize or switch windows — work continues on the server and status stays in the footer.
                                </text>
                              </box>
                            </box>
                            <box flexDirection="row" justifyContent="spaceBetween">
                              <ActionButton
                                label="Run in Background"
                                shortcut="Esc / B"
                                variant="primary"
                                focused={runningFocus() === "bg"}
                                palette={p()}
                                onPress={closeModalToBackground}
                              />
                              <ActionButton
                                label="Cancel Request"
                                shortcut="C"
                                variant="danger"
                                focused={runningFocus() === "cancel"}
                                palette={p()}
                                onPress={() => void cancelWindow(entry().targetKey)}
                              />
                            </box>
                          </box>
                        )
                      })()}
                    </Match>

                    {/* 3. GRILL ME CLARIFYING QUESTIONS */}
                    <Match when={entry().stage === "questions" && entry().grill}>
                      <box flexDirection="column" gap={1}>
                        {/* Diagnosis */}
                        <box
                          border
                          borderStyle="rounded"
                          borderColor={p().warning}
                          backgroundColor={p().bgPanel}
                          title={` Grill Me · ${entry().grill.questions.length} Q(s) · ${(entry().grill.latencyMs / 1000).toFixed(1)}s${entry().grill.usage ? ` · ${formatUsageLine(entry().grill.usage)}` : ""} `}
                          paddingX={1}
                          flexDirection="column"
                        >
                          <text fg={p().textBase} wrapMode="word">{entry().grill.diagnosis}</text>
                          <Show when={entry().grill.missingAngles?.length > 0}>
                            <text fg={p().warning} wrapMode="word">
                              Gaps: {entry().grill.missingAngles.join(" · ")}
                            </text>
                          </Show>
                        </box>

                        {/* Questions List */}
                        <scrollbox
                          ref={(el: any) => { grillScroll = el }}
                          height={Math.max(7, Math.min(20, termH() - 18))}
                          scrollbar={true}
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
                                    border
                                    borderStyle="rounded"
                                    borderColor={isFocused() ? p().borderActive : p().border}
                                    backgroundColor={isFocused() ? p().bgElevated ?? p().bgPanel : undefined}
                                    paddingX={1}
                                    flexDirection="column"
                                    gap={0}
                                    onMouseDown={() => {
                                      setQFocusZone("list")
                                      setFocusedQ(qIdx())
                                    }}
                                  >
                                    <text fg={isFocused() ? p().accent : p().textBase} bold wrapMode="word">
                                      {`${isFocused() ? "▸ " : ""}Q${qIdx() + 1}: ${q.question}`}
                                    </text>
                                    <Show when={q.why}>
                                      <text fg={p().textMuted} wrapMode="word">{`Why: ${q.why}`}</text>
                                    </Show>
                                    <box flexDirection="column" gap={0} paddingTop={0}>
                                      <For each={q.options ?? []}>
                                        {(opt: any, optIdx: () => number) => {
                                          const [optHover, setOptHover] = createSignal(false)
                                          const picked = () => (ans().selectedIds ?? []).includes(opt.id)
                                          const optLit = () => optHover() || (isFocused() && qOptIdx() === optIdx())
                                          return (
                                            <box
                                              flexDirection="row"
                                              gap={1}
                                              backgroundColor={optLit() ? p().bgBadgeInfo ?? p().bgElevated ?? p().bgPanel : undefined}
                                              onMouseOver={() => setOptHover(true)}
                                              onMouseOut={() => setOptHover(false)}
                                              onMouseDown={() => {
                                                setQFocusZone("list")
                                                setFocusedQ(qIdx())
                                                setQOptIdx(optIdx())
                                                store.selectOption(entry().targetKey, q.id, opt.id)
                                              }}
                                            >
                                              <text
                                                fg={picked() ? p().success : optLit() ? p().accent : isFocused() ? p().info : p().textMuted}
                                                bold={picked() || optLit()}
                                              >
                                                {optLit() ? "▸ " : "  "}{picked() ? `[✓ ${optIdx() + 1}]` : `[  ${optIdx() + 1}]`}
                                              </text>
                                              <text fg={picked() ? p().success : optLit() ? p().accent : p().textBase} bold={picked() || optLit()} wrapMode="word">
                                                {opt.label}{opt.detail ? ` — ${opt.detail}` : ""}
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
                                          backgroundColor={customHover() || customFocused() ? p().bgBadgeInfo ?? p().bgElevated ?? p().bgPanel : undefined}
                                          onMouseOver={() => setCustomHover(true)}
                                          onMouseOut={() => setCustomHover(false)}
                                          onMouseDown={() => {
                                            setQFocusZone("list")
                                            setFocusedQ(qIdx())
                                            setQOptIdx(q.options?.length ?? 0)
                                            setEditingQId(q.id)
                                            queueMicrotask(() => qEditor?.focus?.())
                                          }}
                                        >
                                          <text fg={customHover() || customFocused() ? p().accent : ans().customText?.trim() ? p().info : p().textFaint} bold={customHover() || customFocused()}>
                                            {customFocused() ? "▸ " : "  "}
                                            {ans().customText?.trim()
                                              ? `✎ Custom: ${ans().customText.trim()}`
                                              : "+ Click or press [E] to type custom answer/context"}
                                          </text>
                                        </box>
                                      }
                                    >
                                      <box flexDirection="column" gap={0} border borderStyle="single" borderColor={p().borderActive} paddingX={1}>
                                        <textarea
                                          ref={(el: any) => { qEditor = el }}
                                          initialValue={ans().customText ?? ""}
                                          height={2}
                                          textColor={p().textBase}
                                          cursorColor={p().accent}
                                          wrapMode="word"
                                          onContentChange={() => store.setCustomAnswer(entry().targetKey, q.id, qEditor?.plainText ?? "")}
                                        />
                                        <box flexDirection="row" justifyContent="flexEnd">
                                          <PillChip
                                            label="Done Note [Ctrl+D]"
                                            color={p().accent}
                                            palette={p()}
                                            onPress={() => setEditingQId(undefined)}
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
                        <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                          <box flexDirection="row" gap={1}>
                            <ActionButton
                              label="Generate Improved Prompt"
                              shortcut={editingQId() ? "Ctrl+S" : "↵"}
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
                          <ActionButton
                            label="Background"
                            shortcut="Esc"
                            variant="ghost"
                            focused={qFocusZone() === "actions" && qActionFocus() === "bg"}
                            palette={p()}
                            onPress={closeModalToBackground}
                          />
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
                            ? ` · session ${formatCostUsd(totUsd, entry().windowEstimated)}`
                            : ""
                          return callStr ? `${callStr}${totStr}` : "cost tracked"
                        }
                        const lineCount = () => (entry().editedText || "").split(/\r?\n/).length
                        const charCount = () => (entry().editedText || "").length
                        const edited = () => (entry().editedText || "").trim() !== (result().text || "").trim()
                        const workspaceH = () => {
                          const base = termH() - (refiningOpen() ? 26 : 23)
                          return Math.max(5, Math.min(20, base))
                        }

                        return (
                          <box flexDirection="column" gap={1}>
                            {/* Model Recommendation Card */}
                            <box
                              border
                              borderStyle="rounded"
                              borderColor={entry().applyRoute ? p().success : targetModel() ? p().borderActive : p().border}
                              backgroundColor={p().bgPanel}
                              paddingX={1}
                              flexDirection="column"
                              gap={0}
                            >
                              <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                                <box flexDirection="row" gap={1} alignItems="center">
                                  <text fg={entry().applyRoute ? p().success : targetModel() ? p().accent : p().info} bold>
                                    {entry().selectedModelOverride
                                      ? `★ CHOSEN MODEL: ${modelLabel()}`
                                      : result().route
                                        ? `★ RECOMMENDED: ${modelLabel()}`
                                        : `✓ ${modelLabel()}`}
                                  </text>
                                  <text fg={p().textMuted}>
                                    [{result().taskTier}] · {(result().latencyMs / 1000).toFixed(1)}s · {result().contextMessages} msgs · {costBadge()}
                                  </text>
                                </box>
                                <box flexDirection="row" gap={1}>
                                  <Show when={Boolean(targetModel())}>
                                    <PillChip
                                      label={entry().applyRoute ? "✓ Switch ON [R]" : "Switch OFF [R]"}
                                      color={entry().applyRoute ? p().success : p().textMuted}
                                      borderColor={entry().applyRoute ? p().success : p().border}
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
                                    borderColor={p().border}
                                    focused={reviewFocus() === "switch-model"}
                                    palette={p()}
                                    onPress={() => openModels("session")}
                                  />
                                </box>
                              </box>
                              <Show when={targetBench() || result().tradeoffSummary}>
                                <text fg={p().info} wrapMode="word">
                                  {(() => {
                                    const chip = formatBenchChip(targetBench())
                                    if (chip && result().tradeoffSummary) return `Balance: ${chip} — ${result().tradeoffSummary}`
                                    if (chip) return `Balance: ${chip}`
                                    return `Balance: ${result().tradeoffSummary}`
                                  })()}
                                </text>
                              </Show>
                              <text fg={p().textBase} wrapMode="word">{result().reason}</text>
                              <Show when={result().alternative}>
                                <text fg={p().textMuted} wrapMode="word">
                                  Alt: {modelRef(result().alternative.model)}
                                  {formatBenchChip(altBench()) ? ` (${formatBenchChip(altBench())})` : ""} — {result().alternative.reason}
                                </text>
                              </Show>
                            </box>

                            {/* Improvements & Warnings Strip */}
                            <Show when={(result().improvements?.length ?? 0) > 0 || (result().warnings?.length ?? 0) > 0}>
                              <box flexDirection="column" gap={0} paddingX={1}>
                                <Show when={result().improvements?.length > 0}>
                                  <text fg={p().info} wrapMode="word">
                                    ✦ Improved: {result().improvements.join(" · ")}
                                  </text>
                                </Show>
                                <Show when={result().warnings?.length > 0}>
                                  <text fg={p().warning} wrapMode="word">
                                    ⚠ {result().warnings.join(" · ")}
                                  </text>
                                </Show>
                              </box>
                            </Show>

                            {/* Workspace Mode Tabs */}
                            <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                              <box flexDirection="row" gap={1}>
                                <PillChip
                                  label="Improved Prompt"
                                  color={reviewTab() === "preview" ? p().accent : p().textMuted}
                                  borderColor={reviewTab() === "preview" ? p().borderActive : p().border}
                                  bold={reviewTab() === "preview"}
                                  focused={reviewFocus() === "tab-preview"}
                                  palette={p()}
                                  onPress={() => {
                                    setConfirmOpen(false)
                                    setReviewTab("preview")
                                  }}
                                />
                                <PillChip
                                  label={reviewTab() === "edit" ? "✎ Editing [Ctrl+S done]" : "✎ Edit [E]"}
                                  color={reviewTab() === "edit" ? p().accent : p().textMuted}
                                  borderColor={reviewTab() === "edit" ? p().borderActive : p().border}
                                  bold={reviewTab() === "edit"}
                                  focused={reviewFocus() === "tab-edit"}
                                  palette={p()}
                                  onPress={startEditPrompt}
                                />
                                <PillChip
                                  label="⇄ Compare Original [C]"
                                  color={reviewTab() === "compare" ? p().accent : p().textMuted}
                                  borderColor={reviewTab() === "compare" ? p().borderActive : p().border}
                                  bold={reviewTab() === "compare"}
                                  focused={reviewFocus() === "tab-compare"}
                                  palette={p()}
                                  onPress={() => {
                                    setConfirmOpen(false)
                                    setReviewTab((t) => (t === "compare" ? "preview" : "compare"))
                                  }}
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
                                  scrollbar={true}
                                >
                                  <text fg={p().textBase} wrapMode="word">{entry().editedText}</text>
                                </scrollbox>
                              </box>
                            </Show>

                            <Show when={reviewTab() === "edit"}>
                              <box border borderStyle="rounded" borderColor={reviewFocus() === "editor-edit" ? p().borderActive : p().border} title=" Edit Prompt Inline (Ctrl+S or Tab when done) " paddingX={1}>
                                <textarea
                                  ref={(el: any) => { promptEditor = el }}
                                  initialValue={entry().editedText}
                                  height={workspaceH()}
                                  textColor={p().textBase}
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
                                  scrollbar={true}
                                >
                                  <box flexDirection="column" gap={1}>
                                    <text fg={p().textMuted} bold>ORIGINAL DRAFT:</text>
                                    <text fg={p().textMuted} wrapMode="word">{result().original}</text>
                                    <text fg={p().accent} bold>IMPROVED PROMPT:</text>
                                    <text fg={p().textBase} wrapMode="word">{entry().editedText}</text>
                                  </box>
                                </scrollbox>
                              </box>
                            </Show>

                            {/* Quick Refine Bar */}
                            <Show
                              when={refiningOpen()}
                              fallback={
                                <box flexDirection="row" gap={1} alignItems="center">
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
                                    label="✦ Custom Tweak… [F]"
                                    color={p().accent}
                                    borderColor={p().borderActive}
                                    focused={reviewFocus() === "ref-custom"}
                                    palette={p()}
                                    onPress={openCustomRefine}
                                  />
                                </box>
                              }
                            >
                              <box flexDirection="row" gap={1} alignItems="center" border borderStyle="rounded" borderColor={reviewFocus() === "refine-input" ? p().borderActive : p().border} paddingX={1}>
                                <textarea
                                  ref={(el: any) => { refineEditor = el }}
                                  initialValue={refineText()}
                                  height={2}
                                  flexGrow={1}
                                  textColor={p().textBase}
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
                                  shortcut="Ctrl+D"
                                  variant="ghost"
                                  focused={reviewFocus() === "refine-cancel"}
                                  palette={p()}
                                  onPress={() => {
                                    setRefiningOpen(false)
                                    setReviewFocus("ref-custom")
                                  }}
                                />
                              </box>
                            </Show>

                            {/* Inline Model Switch Confirmation Banner */}
                            <Show when={confirmSwitchOpen() && targetModel()}>
                              <box
                                border
                                borderStyle="rounded"
                                borderColor={p().success}
                                backgroundColor={p().bgBadgeSuccess ?? p().bgElevated ?? p().bgPanel}
                                paddingX={1}
                                flexDirection="row"
                                justifyContent="spaceBetween"
                                alignItems="center"
                              >
                                <text fg={p().success} bold wrapMode="word">
                                  {`Switch session model to ${modelRef(targetModel())} and submit? (stays active for next turns)`}
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
                                    shortcut="N"
                                    variant="ghost"
                                    focused={reviewFocus() === "confirm-cancel"}
                                    palette={p()}
                                    onPress={() => setConfirmOpen(false)}
                                  />
                                </box>
                              </box>
                            </Show>

                            {/* Bottom Action Buttons */}
                            <box flexDirection="row" justifyContent="spaceBetween" alignItems="center">
                              <box flexDirection="row" gap={1}>
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
                                    onPress={async () => {
                                      const text = (reviewTab() === "edit" ? promptEditor?.plainText : undefined) ?? entry().editedText ?? result().text
                                      const ok = await insertIntoComposer(text.trim())
                                      if (ok) closeModalToBackground()
                                    }}
                                  />
                                </Show>
                                <ActionButton
                                  label={reviewTab() === "edit" ? "Done Editing" : "Edit"}
                                  shortcut={reviewTab() === "edit" ? "Ctrl+S" : "E"}
                                  variant="secondary"
                                  focused={reviewFocus() === "edit-btn"}
                                  palette={p()}
                                  onPress={() => {
                                    if (reviewTab() === "edit") finishEditPrompt(entry())
                                    else startEditPrompt()
                                  }}
                                />
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
                              <ActionButton
                                label="Close"
                                shortcut="Esc"
                                variant="ghost"
                                focused={reviewFocus() === "close"}
                                palette={p()}
                                onPress={closeModalToBackground}
                              />
                            </box>
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
                        <box flexDirection="row" justifyContent="spaceBetween">
                          <box flexDirection="row" gap={1}>
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
                          <ActionButton
                            label="Close"
                            shortcut="Esc"
                            variant="ghost"
                            focused={errorFocus() === "close"}
                            palette={p()}
                            onPress={closeModalToBackground}
                          />
                        </box>
                      </box>
                    </Match>
                  </Switch>
                )}
              </Show>
            </box>
          )
        },
        () => {
          setDialogOpen(false)
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
          openStudio(target.targetKey)
          return
        }
        store.setDraft(target.targetKey, {
          stage: "draft",
          flowMode: mode,
          ...(parsed.model ? { rewriteModel: parsed.model } : {}),
          sessionID: target.sessionID ?? null,
          label: target.label,
        })
        openStudio(target.targetKey)
        return
      }

      if (existing.stage === "running") {
        toast("A rewrite is already running for this window — reopening progress.", "info")
        openStudio(target.targetKey)
        return
      }

      const rewriteModel = parsed.model ?? existing.rewriteModel
      if (mode === "direct") {
        await startRewrite(target, { text: parsed.text, rewriteModel })
      } else {
        await startGrill(target, parsed.text, rewriteModel)
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
            const target = currentTarget()
            if (!target) return toast("Use /rw-last from the start screen or inside a session.", "warning")
            const existing = store.get(target.targetKey)
            if (existing && existing.stage !== "idle") {
              openStudio(target.targetKey)
              return
            }
            const others = store.listWindows().filter((w) => w.stage !== "idle")
            if (others.length > 0) {
              toast(`No saved rewrite here, but ${others[0].label} has an active/saved rewrite (${others[0].stage}).`, "info")
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
            const runningOther = store.listWindows().find((w) => w.stage === "running")
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
        return p.textMuted
      }
      return (
        <Show when={summary().visible}>
          <box
            backgroundColor={hovered() ? palette().bgElevated ?? palette().bgPanel : undefined}
            onMouseOver={() => setHovered(true)}
            onMouseOut={() => setHovered(false)}
            onMouseDown={() => {
              const target = currentTarget()
              if (target && store.get(target.targetKey)?.stage !== "idle") {
                openStudio(target.targetKey)
                return
              }
              const s = summary()
              const bg = s.othersReady[0] ?? s.othersQuestions[0] ?? s.othersRunning[0]
              if (bg) openStudio(bg.targetKey)
            }}
          >
            <text fg={fg()} bold={hovered() || summary().tone !== "muted"}>{summary().text}</text>
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
