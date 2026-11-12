import { createSignal, onMount, Show } from "solid-js"
import { Rewrite } from "./rpc.js"
import { parseInvocation, modelRef } from "./core.js"

const unbox = (value: any) => value?.data ?? value
const message = (error: any) => error?.message ?? "The rewrite failed. Nothing was submitted."

function multiline(api: any, title: string, initialValue = ""): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      resolve(value)
      api.ui.dialog.clear()
    }
    api.ui.dialog.show(() => {
      let editor: any
      onMount(() => editor?.focus())
      api.keymap.layer(() => ({ mode: "modal", priority: 20, commands: [
        { bind: "ctrl+s", title: "Continue", run: () => finish(editor?.plainText) },
      ] }))
      return <box padding={1} gap={1}>
        <text fg={api.theme.text.base}>{title}</text>
        <textarea ref={(value: any) => { editor = value }} initialValue={initialValue} height={Math.max(4, Math.min(12, api.renderer.height - 12))}
          textColor={api.theme.text.base} cursorColor={api.theme.text.base} wrapMode="word" />
        <text fg={api.theme.text.muted}>Ctrl+S: continue · Enter: newline · Esc: cancel</text>
      </box>
    }, () => { if (!settled) { settled = true; resolve(undefined) } })
    api.ui.dialog.set({ size: "large", centered: true })
  })
}

function review(api: any, result: any): Promise<{ text: string; applyRoute: boolean } | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value?: { text: string; applyRoute: boolean }) => {
      if (settled) return
      settled = true
      resolve(value)
      api.ui.dialog.clear()
    }
    api.ui.dialog.show(() => {
      const [editing, setEditing] = createSignal(false)
      const [draft, setDraft] = createSignal(result.text)
      let editor: any
      let scroll: any
      const send = (text: string, applyRoute = false) => finish({ text, applyRoute })
      const edit = () => {
        setEditing(true)
        queueMicrotask(() => editor?.focus())
      }
      api.keymap.layer(() => ({ mode: "modal", priority: 20, commands: [
        { bind: "return", title: "Send rewrite, keep model", enabled: !editing(), run: () => send(draft()) },
        { bind: "ctrl+s", title: "Send edited rewrite", enabled: editing(), run: () => send(draft()) },
        { bind: "ctrl+r", title: "Apply model recommendation and send", enabled: !editing() && Boolean(result.route), run: () => send(draft(), true) },
        { bind: "o", title: "Send original, keep model", enabled: !editing(), run: () => finish({ text: result.original, applyRoute: false }) },
        { bind: "e", title: "Edit rewrite", enabled: !editing(), run: edit },
        { bind: "up", title: "Scroll up", enabled: !editing(), run: () => scroll?.scrollBy(-1) },
        { bind: "down", title: "Scroll down", enabled: !editing(), run: () => scroll?.scrollBy(1) },
        { bind: "pageup", title: "Page up", enabled: !editing(), run: () => scroll?.scrollBy(-8) },
        { bind: "pagedown", title: "Page down", enabled: !editing(), run: () => scroll?.scrollBy(8) },
        { bind: "end", title: "End of prompt", enabled: !editing(), run: () => scroll?.scrollTo(scroll.scrollHeight) },
      ] }))
      return <box padding={1} gap={0}>
        <text fg={api.theme.text.base}>/rewrite · {result.model}</text>
        <text fg={api.theme.text.muted}>Cost unavailable · {(result.latencyMs / 1000).toFixed(1)}s · {result.contextMessages} recent messages{result.contextTruncated ? " (truncated)" : ""}</text>
        <text fg={api.theme.text.muted}>MODEL SUGGESTION</text>
        <text fg={api.theme.text.base} wrapMode="word">{result.route ? modelRef(result.route) : "Keep current model"} — {result.reason}</text>
        <text fg={api.theme.text.muted}>REWRITTEN PROMPT · review before sending</text>
        <scrollbox ref={(value: any) => { scroll = value }} height={Math.max(3, Math.min(14, Math.floor(api.renderer.height * 0.34)))} flexShrink={0}>
          <box gap={1}>
            <text fg={api.theme.text.base} wrapMode="word">{draft()}</text>
            <Show when={result.warnings.length > 0}>
              <text fg={api.theme.text.base} wrapMode="word">{result.warnings.map((w: string) => `• ${w}`).join("\n")}</text>
            </Show>
          </box>
        </scrollbox>
        <Show when={editing()}>
          <textarea ref={(value: any) => { editor = value }} initialValue={draft()} height={5}
            textColor={api.theme.text.base} cursorColor={api.theme.text.base} wrapMode="word"
            onContentChange={() => setDraft(editor?.plainText ?? draft())} />
        </Show>
        <text fg={api.theme.text.muted} wrapMode="word">{editing()
          ? "Ctrl+S: send edited prompt, keep model · Esc: cancel"
          : `Enter: send rewrite · E: edit · O: original${result.route ? " · Ctrl+R: model + send" : ""} · Esc: cancel`}</text>
      </box>
    }, () => { if (!settled) { settled = true; resolve(undefined) } })
    api.ui.dialog.set({ size: "large", centered: true })
  })
}

export default {
  id: "prompt-rewrite.tui",
  setup(api: any) {
    const rpc = api.client.rpc(Rewrite)
    const [running, setRunning] = createSignal(false)
    let activeRequest: string | undefined
    let activeOptions: any
    let disposed = false
    const latest = new Map<string, any>()
    const originals = new Map<string, string>()
    const requestOptions = (sessionID?: string) => {
      const route = api.ui.router.current()
      const id = sessionID ?? (route.type === "session" ? route.sessionID : undefined)
      return { location: (id && api.data.session.get(id)?.location) || api.location || api.data.location.default() }
    }
    const currentKey = () => {
      const route = api.ui.router.current()
      return route.type === "session" ? route.sessionID : route.type === "home" ? `home:${requestOptions().location.directory}` : undefined
    }
    const selectedModel = () => {
      const selected = api.ui.model.current()
      return selected ? { providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) } : undefined
    }
    const toast = (text: string, variant = "info") => api.ui.toast.show({ title: "/rewrite", message: text, variant })

    async function present(result: any) {
      if (disposed) return
      const selected = await review(api, result)
      if (!selected || disposed) return
      if (currentKey() !== result.targetKey) {
        toast("The active session or start location changed. Return there and run /rw-last; nothing was submitted.", "warning")
        return
      }
      if (!result.sessionID && result.startModel && selectedModel() && modelRef(selectedModel()) !== modelRef(result.startModel)) {
        toast("The starting model changed during review. Run /rw again with the new selection; nothing was submitted.", "warning")
        return
      }
      if (selected.applyRoute) {
        const ok = await api.ui.dialog.confirm({ title: "Apply model recommendation?",
          message: `Switch this session to ${modelRef(result.route)} and submit the rewrite? The new model remains selected for subsequent turns.`,
          label: { confirm: "Switch and send", cancel: "Cancel" } })
        if (!ok) return
      }
      try {
        const sent = unbox(await rpc.submit({ resultID: result.id, ...selected }, requestOptions(result.sessionID)))
        latest.delete(result.targetKey)
        originals.delete(result.targetKey)
        if (!result.sessionID) {
          await api.data.session.sync(sent.sessionID).catch(() => {})
          api.ui.router.navigate({ type: "session", sessionID: sent.sessionID })
        }
        toast(sent.queued ? "Prompt queued with the current model." : "Prompt submitted.", "success")
      } catch (error) { toast(message(error), "error") }
    }

    async function run(input?: string) {
      const route = api.ui.router.current()
      const targetKey = currentKey()
      if (!targetKey) return toast("Use /rw from the start screen or a session.", "warning")
      if (running()) return toast("A rewrite is already running. Use /rw-cancel to cancel it.", "warning")
      const parsed = parseInvocation(input)
      const text = parsed.text || await multiline(api, "/rewrite — enter the prompt to improve")
      if (!text?.trim() || disposed) return
      if (currentKey() !== targetKey) return toast("The active session or start location changed; invoke /rw there.", "warning")
      if (originals.size >= 20 && !originals.has(targetKey)) originals.delete(originals.keys().next().value)
      originals.set(targetKey, text)
      latest.delete(targetKey)
      const requestID = globalThis.crypto.randomUUID()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const options = requestOptions(sessionID)
      activeRequest = requestID
      activeOptions = options
      setRunning(true)
      toast("Rewriting in the background; the session can continue. /rw-cancel stops the request.")
      // Don't await the model from the command handler: mirror /btw's side-call behavior.
      void rpc.propose({ ...(sessionID ? { sessionID } : { currentModel: selectedModel() }), text, ...(parsed.model ? { model: parsed.model } : {}), requestID }, options)
        .then(async (result: any) => {
          const proposal = { ...unbox(result), targetKey }
          if (disposed) return
          if (activeRequest === requestID) { activeRequest = undefined; activeOptions = undefined; setRunning(false) }
          if (latest.size >= 20 && !latest.has(targetKey)) latest.delete(latest.keys().next().value)
          latest.set(targetKey, proposal)
          // Like /btw, show a side-call result, but never jump to another session/location.
          if (currentKey() === targetKey) await present(proposal)
          else toast("Rewrite ready. Return to its session or start location and run /rw-last to review it.", "success")
        })
        .catch((error: any) => { if (!disposed) toast(`${message(error)} Your original is available via /rw-last.`, "error") })
        .finally(() => { if (activeRequest === requestID) { activeRequest = undefined; activeOptions = undefined; setRunning(false) } })
    }

    api.keymap.layer(() => ({ mode: "global", commands: [
      { id: "rewrite.open", title: "Rewrite a prompt", group: "Rewrite", palette: true,
        slash: { name: "rewrite", aliases: ["rw"], arguments: true }, run },
      { id: "rewrite.cancel", title: "Cancel rewrite request", group: "Rewrite", palette: true,
        slash: { name: "rw-cancel" }, run: async () => {
          if (!activeRequest) return toast("No rewrite request is running.")
          try { await rpc.cancel({ requestID: activeRequest }, activeOptions) }
          catch (error) { toast(message(error), "error") }
        } },
      { id: "rewrite.last", title: "Review latest rewrite", group: "Rewrite", palette: true,
        slash: { name: "rw-last" }, run: async () => {
          const key = currentKey()
          const result = key && latest.get(key)
          if (result) await present(result)
          else if (key && originals.has(key)) {
            const text = await multiline(api, "/rewrite — retained original (Ctrl+S retries the rewrite)", originals.get(key))
            if (text?.trim()) await run(text)
          }
          else toast("No saved proposal for this session or start location.")
        } },
    ] }))
    api.ui.slot({ append: "prompt.footer.status", render: () => <Show when={running()}><text fg={api.theme.text.muted}> /rw… </text></Show> })
    return () => {
      disposed = true
      if (activeRequest) void rpc.cancel({ requestID: activeRequest }, activeOptions).catch(() => {})
      latest.clear()
      originals.clear()
    }
  },
}
