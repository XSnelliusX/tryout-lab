// =============================================================================
// AI gateway plugin — TUI half: notifications
// -----------------------------------------------------------------------------
// OpenCode loads this file as the plugin's TUI entrypoint (tui.ts next to
// index.ts). The server half (index.ts) cannot show toasts, so it writes every
// problem to <cost dir>/status.json. This file watches that file and:
//   * shows a toast when a problem appears or changes (missing / rejected key,
//     gateway unreachable, model details unavailable, write failures, ...),
//   * shows a toast when the gateway works again after an error,
//   * adds /gateway-status (also in the command palette) with the full status.
// Like index.ts: no value imports from @opencode/plugin, no build step.
// =============================================================================

import { type FSWatcher, readFileSync, watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Same lookup as setting() in index.ts: process environment, then the env file
// (GATEWAY_ENV_FILE, default ~/.config/ai-gateway/env), then the default.
function setting(name: string, fallback: string): string {
  const env = process.env[name]
  if (env !== undefined) return env
  let value: string | undefined
  try {
    for (const line of readFileSync(expandHome(process.env.GATEWAY_ENV_FILE ?? "~/.config/ai-gateway/env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/)
      if (!m || m[1] !== name) continue
      const quoted = m[2].match(/^(["'])(.*?)\1(?:\s+#.*)?$/) // "v" or "v" # note
      value = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, "")
    }
  } catch {} // no env file: the default applies
  return value ?? fallback
}

// Keep in sync with DEFAULT_COST_DIR in index.ts.
const COST_DIR = expandHome(setting("GATEWAY_COST_DIR", "~/.gateway-cost"))
const STATUS_NAME = "status.json"
const POLL_MS = 15_000 // fallback when the folder watch misses an event (or the folder appears later)
const TITLE = "AI Gateway"

type Issue = { id: string; level: "error" | "warning"; title: string; message: string; since: string }
type Status = {
  generated_at: string
  pid?: number
  base_url: string
  key_source: string
  models: number
  last_success: string | null
  next_retry: string | null
  log_file?: string
  issues: Issue[]
}

function expandHome(p: string): string {
  p = p.replace(/^\$(?:HOME\b|\{HOME\})/, "~") // the env file is shell syntax: setup.sh writes "$HOME/.keys/..."
  if (p === "~") return homedir()
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2))
  return p
}

async function readStatus(): Promise<Status | undefined> {
  try {
    const doc = JSON.parse(await readFile(join(COST_DIR, STATUS_NAME), "utf8"))
    return Array.isArray(doc?.issues) ? doc : undefined
  } catch {
    return undefined // not written yet, or caught mid-rename
  }
}

// A status file left behind by a server that is gone says nothing about now.
function writerAlive(pid: unknown): boolean {
  if (typeof pid !== "number") return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

function time(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "never"
}

function statusText(s: Status | undefined): string {
  if (!s || !writerAlive(s.pid)) {
    return "No status from the gateway-models server plugin yet. Check that it is active with /plugins."
  }
  const lines = [
    `Gateway: ${s.base_url || "not configured (set GATEWAY_BASE_URL)"}`,
    `API key: ${s.key_source}`,
    `Models registered: ${s.models}`,
    `Last successful refresh: ${time(s.last_success)}`,
  ]
  if (s.next_retry) lines.push(`Next retry: ${time(s.next_retry)} (or run /gateway-refresh)`)
  lines.push("")
  if (!s.issues.length) lines.push("No problems.")
  for (const i of s.issues) lines.push(`${i.level === "error" ? "ERROR" : "WARNING"} ${i.title} (since ${time(i.since)})`, `  ${i.message}`)
  if (s.log_file) lines.push("", `Log: ${s.log_file}`)
  return lines.join("\n")
}

export default {
  id: "gateway-models",
  async setup(api: any) {
    const shown = new Map<string, string>() // issue id -> level|title already toasted
    let hadError = false
    let disposed = false

    const toast = (variant: string, title: string, message: string, duration: number) => {
      try {
        api.ui.toast.show({ variant, title, message, duration })
      } catch {
        // TUI shutting down
      }
    }

    // Toast new or changed issues only: the message may change on every retry
    // (backoff, cached model count), the title and level do not.
    const check = async () => {
      const s = await readStatus()
      if (disposed || !s || !writerAlive(s.pid)) return
      const current = new Set<string>()
      for (const issue of s.issues) {
        current.add(issue.id)
        const sig = `${issue.level}|${issue.title}`
        if (shown.get(issue.id) === sig) continue
        shown.set(issue.id, sig)
        toast(issue.level, `${TITLE}: ${issue.title}`, issue.message, issue.level === "error" ? 15_000 : 8_000)
      }
      for (const id of [...shown.keys()]) if (!current.has(id)) shown.delete(id)
      const hasError = s.issues.some((i) => i.level === "error")
      if (hadError && !hasError) toast("success", TITLE, `Working again: ${s.models} models available.`, 5_000)
      hadError = hasError
    }

    let debounce: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => void check(), 150)
    }
    let watcher: FSWatcher | undefined
    const ensureWatch = () => {
      if (watcher) return
      try {
        watcher = watch(COST_DIR, (_event, file) => {
          if (!file || file.toString() === STATUS_NAME) soon()
        })
        watcher.on("error", () => {
          watcher?.close()
          watcher = undefined
        })
      } catch {
        watcher = undefined // folder not created yet: the poll retries
      }
    }
    ensureWatch()
    const poll = setInterval(() => {
      ensureWatch()
      void check()
    }, POLL_MS)
    void check()

    try {
      api.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "gateway.status",
            title: "AI Gateway status",
            group: "Gateway",
            bind: false,
            palette: true,
            slash: { name: "gateway-status" },
            run: async () => {
              await api.ui.dialog.alert({ title: `${TITLE} status`, message: statusText(await readStatus()) })
            },
          },
        ],
      }))
    } catch (err) {
      // Notifications work without the command.
      console.error("[gateway-models] could not register /gateway-status:", err)
    }

    return () => {
      disposed = true
      clearTimeout(debounce)
      clearInterval(poll)
      watcher?.close()
    }
  },
}
