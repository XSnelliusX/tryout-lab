// =============================================================================
// AI gateway model discovery plugin for OpenCode (V2)
// -----------------------------------------------------------------------------
// Loaded as-is, no build step: this folder is a plugin package (package.json ->
// index.ts). Only TYPES come from `@opencode/plugin` (`import type`, erased at
// load time), because the server cannot resolve that package from local plugin
// files (anomalyco/opencode #49608 / #50434). Keep it that way: no value imports.
//
// Behaviors:
//   * Fast startup  - cached catalog (ctx.storage) is registered first.
//   * Change-driven  - the cheap /models endpoint is polled; the slow
//     /model/info endpoint is called only when the model set fingerprint
//     changes (or the cache is older than INFO_STALE_MS).
//   * Live updates   - after a slow refresh, ctx.provider.reload() re-applies
//     the transform; /models updates without restart.
//   * Provider split - models are grouped into one OpenCode provider per
//     upstream provider (acc-bedrock, acc-azure, ...), all bound to a single
//     "AI Gateway" integration. The connected integration is what makes
//     the /models picker group by provider (it only groups when at least one
//     integration has a connection).
//   * Alias dedupe   - the gateway exposes several ids for the same deployment
//     (e.g. claude-opus-5 and claude-5-opus-aws). One canonical id is
//     registered, the others are kept as aliases for cost lookup.
//   * Usage + cost   - every finished model step is appended to usage.jsonl and
//     aggregated into usage-summary.json (+ usage-data.js for file:// pages),
//     with cost calculated from the gateway price list. Lines other tools append
//     to the same log (e.g. Neovim inline prediction) are picked up as well.
//   * Secrets from file - API key read via "{file:path}" template; it is never
//     written into the plugin cache. The key file is watched, so creating or
//     fixing it applies without a restart.
//   * Health          - every failure (missing key, rejected key, gateway
//     unreachable, ...) is written to status.json and gateway-models.log;
//     tui.ts turns it into OpenCode toasts and /gateway-status. While anything
//     is broken, refresh retries within a minute instead of every 12h.
// =============================================================================

import type { Model, Plugin, Provider } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { spawn } from "node:child_process"
import { type FSWatcher, readFileSync, watch } from "node:fs"
import { appendFile, copyFile, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// =============================================================================
// 1) CONFIGURATION — environment variables, or the env file (see setting()).
// =============================================================================

// Settings come from the process environment first, then from the env file
// (GATEWAY_ENV_FILE, default ~/.config/ai-gateway/env), then the default given at the
// call. The env file matters because OpenCode started from a GUI app never sources
// ~/.zshrc. Format: shell-style `export NAME=value` or `NAME=value`, # comments,
// optional single or double quotes.
function envFile(): Record<string, string> {
  const values: Record<string, string> = {}
  try {
    for (const line of readFileSync(expandHome(process.env.GATEWAY_ENV_FILE ?? "~/.config/ai-gateway/env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const quoted = m[2].match(/^(["'])(.*)\1$/)
      values[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, "")
    }
  } catch {} // no env file: the defaults apply
  return values
}
function setting(name: string, fallback: string): string {
  return process.env[name] ?? envFile()[name] ?? fallback
}

const DEFAULT_KEY_SPEC = "{file:~/.keys/ai-gateway.key}" // {file:...}, plain path, or "" for no auth
// Catalog + usage output, shared with the other tools that log AI usage here (the
// Neovim config, claude_usage.py for Claude Code). NOT inside the plugin folder:
// OpenCode watches the plugins tree and reloads its whole config on any write there
// (measured: 2 reloads per write). dashboard.html in the plugin folder finds this
// folder as ../../../../.gateway-cost.
const DEFAULT_COST_DIR = "~/.gateway-cost"
// Where versions before 2026-10-19 wrote; moved to DEFAULT_COST_DIR on the first start.
const LEGACY_COST_DIR = "~/.config/opencode/gateway-costs"
const DASHBOARD_SRC = join(dirname(fileURLToPath(import.meta.url)), "dashboard.html")

// GATEWAY_BASE_URL has no default. Empty means not configured: setup() then registers nothing.
const BASE_URL = setting("GATEWAY_BASE_URL", "").trim().replace(/\/+$/, "")
const NOT_CONFIGURED = "GATEWAY_BASE_URL is not set. Run mac-setup/setup.sh --only gateway, or add it to the env file (~/.config/ai-gateway/env, or $GATEWAY_ENV_FILE)."
const COMPLETIONS_BASE = `${BASE_URL}/aiendpoint/v1`
const FAST_URL = `${BASE_URL}/aiendpoint/v1/models`
const INFO_URL = `${BASE_URL}/aiendpoint/v1/model/info`

const AUTH_HEADER = process.env.GATEWAY_AUTH_HEADER ?? "authorization" // "authorization" | "x-api-key"
// The gateway expects `Authorization: Bearer <key>`, so prefix the value when
// using the standard authorization header.
const AUTH_PREFIX = AUTH_HEADER === "authorization" ? "Bearer " : ""
const COST_DIR = expandHome(setting("GATEWAY_COST_DIR", DEFAULT_COST_DIR))
const COST_DISABLED = process.env.GATEWAY_COST_DISABLED === "1"
const USAGE_DISABLED = process.env.GATEWAY_USAGE_DISABLED === "1"
const PROVIDER_PREFIX = process.env.GATEWAY_PROVIDER_PREFIX ?? "acc" // model ids look like acc-bedrock/...

// One integration owns every gateway provider. Connecting it (with the key from
// the key file) is what turns on provider grouping in the /models picker.
const INTEGRATION_ID = setting("GATEWAY_INTEGRATION_ID", "ai-gateway")
const INTEGRATION_NAME = "AI Gateway"
const CONNECT_INTEGRATION = process.env.GATEWAY_CONNECT_INTEGRATION !== "0"

const FAST_POLL_MS = 12 * 60 * 60_000 // cheap list re-check interval (12h)
// While something is broken (no key, gateway unreachable, /model/info failed),
// retry after RETRY_MS, doubling per failed network attempt up to RETRY_MAX_MS.
const RETRY_MS = Number(process.env.GATEWAY_RETRY_MS) || 60_000
const RETRY_MAX_MS = 5 * 60_000
const INFO_STALE_MS = 24 * 60 * 60_000 // re-fetch details at most every 24h
const FAST_TIMEOUT_MS = 20_000
const INFO_TIMEOUT_MS = 150_000
const SKIP_MODES = new Set(["evaluation", "embedding", "audio_transcription", "audio_speech", "realtime"])
const IMAGE_MODES = new Set(["image_generation", "image_edit"]) // kept only if they also serve chat

// v3: catalog entries instead of provider records (no API key in the cache,
// aliases deduplicated). v4: effort_levels. v5: generic price tiers,
// video, responses package. Older caches are ignored.
const CACHE_KEY = "gateway.models.v5"

// Canonical upstream keys -> stable provider ids and display names. The gateway
// reports the same upstream under several spellings ("bedrock", "AWS Bedrock").
const PROVIDER_ALIASES: Record<string, string> = {
  bedrock: "bedrock",
  awsbedrock: "bedrock",
  amazonbedrock: "bedrock",
  azure: "azure",
  azureai: "azure",
  azurefoundry: "azure",
  vertex: "vertex-ai",
  vertexai: "vertex-ai",
  googlevertexai: "vertex-ai",
}
const PROVIDER_NAMES: Record<string, string> = {
  bedrock: "AWS Bedrock",
  azure: "Azure Foundry",
  "vertex-ai": "Vertex AI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  databricks: "Databricks",
  "3rd-party": "3rd Party",
  gateway: "Gateway",
}

// =============================================================================
// 2) SMALL HELPERS
// =============================================================================

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2))
  return p
}

// For messages: "~/.keys/x.key" instead of the full home path.
function displayPath(p: string): string {
  const home = homedir()
  return p === home || p.startsWith(home + "/") || p.startsWith(home + "\\") ? "~" + p.slice(home.length) : p
}

function errText(err: unknown): string {
  const msg = (err as any)?.message ?? String(err)
  return String(msg).replace(/\s+/g, " ").trim() || "unknown error"
}

// Ends a message part with exactly one full stop (gateway texts often bring their own).
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : s + ".")

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  )
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

const titleCase = (s: string) =>
  s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

function fmtJSON(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

const perMillion = (perToken: number | null | undefined) => (perToken ?? 0) * 1_000_000
// Provider metadata can be slightly above the real limit (e.g. 131100 vs the actual 131072), so round down to a 1024 multiple.
const floorToKiB = (n: number): number => (Number.isFinite(n) && n >= 1024 ? Math.floor(n / 1024) * 1024 : n)

function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Write to a temp file and rename, so a dashboard never reads a half-written file.
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content)
  // Windows refuses to replace a file another process holds open (Excel, antivirus): retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(tmp, path)
    } catch (err: any) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err?.code)) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
  }
}

// =============================================================================
// 3) API KEY FROM FILE — supports "{file:...}" and plain paths.
// =============================================================================

const ENV_KEY = process.env.GATEWAY_API_KEY?.trim() || undefined

// Absolute key file path, or undefined when the key comes from GATEWAY_API_KEY
// or auth is disabled on purpose (GATEWAY_API_KEY_FILE="").
const KEY_PATH = ((): string | undefined => {
  if (ENV_KEY) return undefined
  const spec = setting("GATEWAY_API_KEY_FILE", DEFAULT_KEY_SPEC)
  const path = (spec.match(/^\{file:(.*)\}$/)?.[1] ?? spec).trim()
  return path ? expandHome(path) : undefined
})()

const KEY_SOURCE = ENV_KEY ? "GATEWAY_API_KEY" : KEY_PATH ? displayPath(KEY_PATH) : "none (auth disabled)"

type KeyResult = { key?: string; problem?: string }

async function resolveApiKey(): Promise<KeyResult> {
  if (ENV_KEY) return { key: ENV_KEY }
  if (!KEY_PATH) return {}
  const shown = displayPath(KEY_PATH)
  try {
    const key = (await readFile(KEY_PATH, "utf8")).trim()
    return key ? { key } : { problem: `${shown} is empty` }
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { problem: `${shown} does not exist` }
    return { problem: `${shown} could not be read (${err?.code ?? errText(err)})` }
  }
}

// Turns a key read into the key to use, and reports a problem with it. A key
// loaded earlier is kept when the file disappears (e.g. a cloud-only file in a
// synced folder), because the gateway still accepts it.
function applyKeyResult(r: KeyResult, previous: string | undefined): string | undefined {
  if (!r.problem) {
    clearIssue("key")
    return r.key
  }
  if (previous) {
    setIssue("key", "warning", "API key file unavailable", `${r.problem}. Still using the key loaded earlier.`)
    return previous
  }
  setIssue(
    "key",
    "error",
    "No API key",
    `${r.problem}. Put your gateway API key into that file (or set GATEWAY_API_KEY_FILE). ` +
      "It is picked up automatically, no restart needed.",
  )
  return undefined
}

// =============================================================================
// 4) TYPES
// =============================================================================

type FastModel = {
  id: string
  mode?: string
  max_input_tokens?: number
  max_output_tokens?: number
  owned_by?: string
}

type InfoEntry = {
  model_name: string
  litellm_params?: { model?: string; [k: string]: unknown }
  model_info?: {
    litellm_provider?: string
    mode?: string
    max_tokens?: number
    max_input_tokens?: number
    max_output_tokens?: number
    input_cost_per_token?: number | null
    output_cost_per_token?: number | null
    cache_creation_input_token_cost?: number | null
    cache_read_input_token_cost?: number | null
    supports_function_calling?: boolean | null
    supports_vision?: boolean | null
    supports_pdf_input?: boolean | null
    supports_audio_input?: boolean | null
    supports_reasoning?: boolean | null
    supported_openai_params?: string[] | null
    supported_endpoints?: string[] | null
    reasoning_effort_levels?: string[] | null
    bedrock_output_config_effort_ceiling?: string | null
    page_display_data?: { name?: string; provider?: string; [k: string]: unknown }
    [k: string]: unknown
  }
}

// One registered model. Also the row of the reviewable models.json / models.csv
// and the price table used for usage cost calculation.
type CatalogEntry = {
  provider_id: string
  provider_name: string
  model_id: string // sendable id
  model_name: string
  aliases: string[] // other gateway ids for the same deployment
  mode: string
  enriched: boolean // false => fast-only, costs/limits are fallbacks
  max_input_tokens: number
  max_output_tokens: number
  input_per_1M: number
  output_per_1M: number
  cache_write_per_1M: number
  cache_read_per_1M: number
  input_per_1k: number
  output_per_1k: number
  tiers: PriceTier[] // context-size price tiers, ascending, gaps filled from base prices
  tools: boolean
  vision: boolean
  pdf: boolean
  audio: boolean
  video: boolean
  responses_only: boolean // gateway serves it on /v1/responses, not /v1/chat/completions
  effort_levels: string[] // reasoning_effort values offered as OpenCode variants
  upstream_provider: string | null
  upstream_model: string | null
}

type PriceTier = { size: number; input_per_1M: number; output_per_1M: number; cache_write_per_1M: number; cache_read_per_1M: number }

type Cache = { fingerprint: string; fetchedAt: number; catalog: CatalogEntry[] }

// One finished model step, as appended to usage.jsonl. Other tools write the same
// shape: `tool` says who made the call, `billing` how it is paid.
type UsageRecord = {
  ts: string
  event_id: string
  session_id: string
  message_id: string
  tool?: string // "opencode" | "nvim" | "claude-code" | "claude-desktop" | ...; missing in old lines
  billing?: "gateway" | "subscription" | "other" // subscription = Claude seat, cost is the API equivalent
  agent: string | null
  provider_id: string
  model_id: string
  model_name: string
  gateway: boolean // true => priced from the gateway catalog
  upstream_provider: string | null
  finish: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  input_per_1M: number
  output_per_1M: number
  cache_read_per_1M: number
  cache_write_per_1M: number
  cost: number // USD, calculated from the prices above
  reported_cost: number // USD, as computed by OpenCode (cross-check)
}

// =============================================================================
// 5) STATE
// =============================================================================

const source: { catalog: CatalogEntry[]; apiKey?: string } = { catalog: [] }
let priceIndex = new Map<string, CatalogEntry>() // "provider/model", "model", aliases

function setCatalog(catalog: CatalogEntry[]): void {
  source.catalog = catalog
  const index = new Map<string, CatalogEntry>()
  for (const e of catalog) {
    for (const id of [e.model_id, ...e.aliases]) {
      index.set(`${e.provider_id}/${id}`, e)
      if (!index.has(id)) index.set(id, e)
    }
  }
  priceIndex = index
}

// =============================================================================
// 6) HTTP
// =============================================================================

// What went wrong, so the message can say what to do about it.
type GatewayErrorKind = "auth" | "http" | "timeout" | "network" | "response"

class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  constructor(kind: GatewayErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

// The gateway's own explanation from an error body, e.g. LiteLLM's
// {"error": {"message": "Authentication Error, ..."}}, shortened for a toast.
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "")
  let msg: unknown = text
  try {
    const j = JSON.parse(text)
    msg = (typeof j?.error === "string" ? j.error : j?.error?.message) ?? j?.detail ?? j?.message ?? text
  } catch {
    // not JSON: use the text
  }
  const s = (typeof msg === "string" ? msg : JSON.stringify(msg)).replace(/\s+/g, " ").trim()
  return s ? `: ${s.length > 160 ? s.slice(0, 157) + "..." : s}` : ""
}

async function fetchJSON(url: string, timeoutMs: number, apiKey?: string): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const timedOut = () => new GatewayError("timeout", `no response within ${Math.round(timeoutMs / 1000)}s`)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers[AUTH_HEADER] = `${AUTH_PREFIX}${apiKey}`
    let res: Response
    try {
      res = await fetch(url, { headers, signal: controller.signal })
    } catch (err: any) {
      if (controller.signal.aborted) throw timedOut()
      const code = err?.code ?? err?.cause?.code
      throw new GatewayError("network", code ? `${errText(err)} (${code})` : errText(err))
    }
    if (res.status === 401 || res.status === 403) throw new GatewayError("auth", `HTTP ${res.status}${await errorDetail(res)}`)
    if (!res.ok) throw new GatewayError("http", `HTTP ${res.status}${await errorDetail(res)}`)
    try {
      return await res.json()
    } catch {
      if (controller.signal.aborted) throw timedOut()
      throw new GatewayError("response", "the response is not JSON (proxy or login page in between?)")
    }
  } finally {
    clearTimeout(timer)
  }
}

// A body without a data array is an error, not "zero models": treating it as
// empty would replace a good catalog with nothing.
function dataArray(body: any): any[] {
  if (!Array.isArray(body?.data)) throw new GatewayError("response", "the response has no data list")
  return body.data
}

async function loadFast(apiKey?: string): Promise<FastModel[]> {
  return dataArray(await fetchJSON(FAST_URL, FAST_TIMEOUT_MS, apiKey))
}

async function loadInfo(apiKey?: string): Promise<InfoEntry[]> {
  return dataArray(await fetchJSON(INFO_URL, INFO_TIMEOUT_MS, apiKey))
}

// =============================================================================
// 7) CHANGE DETECTION (cheap list only)
// =============================================================================

function fingerprintOf(models: FastModel[]): string {
  const lines = [
    ...new Set(
      models
        .filter((m) => !SKIP_MODES.has(m.mode ?? ""))
        .map((m) => [m.id, m.mode ?? "", m.max_input_tokens ?? 0, m.max_output_tokens ?? 0].join("|")),
    ),
  ].sort()
  let h = 0
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) h = ((h << 5) - h + line.charCodeAt(i)) | 0
  }
  return `${lines.length}:${h.toString(36)}`
}

// =============================================================================
// 8) MAPPING fast ids -> slow info -> catalog
// =============================================================================

function matchByParamsTail(info: InfoEntry[], id: string): InfoEntry | undefined {
  const target = norm(id)
  return info.find((e) => {
    const tail = String(e.litellm_params?.model ?? "").split("/").pop() ?? ""
    return tail.length > 0 && norm(tail) === target
  })
}

// Prefer the gateway's display provider (what its UI shows), then the litellm
// provider, then the litellm model prefix. Spellings are folded via
// PROVIDER_ALIASES so e.g. "AWS Bedrock" and "bedrock" land in one group.
function upstreamKey(entry: InfoEntry | undefined): { key: string; name: string } {
  const raw =
    entry?.model_info?.page_display_data?.provider ||
    entry?.model_info?.litellm_provider ||
    String(entry?.litellm_params?.model ?? "").split("/")[0] ||
    "gateway"
  const key = PROVIDER_ALIASES[norm(raw)] ?? slug(raw)
  return { key, name: PROVIDER_NAMES[key] ?? titleCase(raw) }
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

// low/medium/high for any reasoning model; the gateway flags the optional extra
// levels as supports_<level>_reasoning_effort (null = undeclared, false = unsupported).
// An explicit reasoning_effort_levels list wins; Bedrock's effort ceiling caps the rest.
function effortLevels(info: NonNullable<InfoEntry["model_info"]>): string[] {
  const params = info.supported_openai_params
  if (info.supports_reasoning === false || (params && !params.includes("reasoning_effort"))) return []
  if (info.supports_reasoning !== true && !params) return []
  if (info.reasoning_effort_levels?.length) return info.reasoning_effort_levels
  const ceiling = EFFORTS.indexOf(info.bedrock_output_config_effort_ceiling ?? "max")
  const flag = (l: string) => info[`supports_${l}_reasoning_effort`]
  return EFFORTS.filter(
    (l, i) => (ceiling < 0 || i <= ceiling) && (["low", "medium", "high"].includes(l) ? flag(l) !== false : flag(l) === true),
  )
}

// litellm "<kind>_above_<N>k_tokens" keys -> one tier per N, missing prices fall back to base.
function priceTiers(info: NonNullable<InfoEntry["model_info"]>): PriceTier[] {
  const sizes = new Set<number>()
  for (const k of Object.keys(info)) {
    const m = /^(?:input|output)_cost_per_token_above_(\d+)k_tokens$/.exec(k)
    if (m && info[k] != null) sizes.add(Number(m[1]))
  }
  const price = (key: string, base: unknown) => perMillion(((info[key] as number | null) ?? base) as number | null)
  return [...sizes].sort((a, b) => a - b).map((n) => ({
    size: n * 1_000,
    input_per_1M: price(`input_cost_per_token_above_${n}k_tokens`, info.input_cost_per_token),
    output_per_1M: price(`output_cost_per_token_above_${n}k_tokens`, info.output_cost_per_token),
    cache_write_per_1M: price(`cache_creation_input_token_cost_above_${n}k_tokens`, info.cache_creation_input_token_cost),
    cache_read_per_1M: price(`cache_read_input_token_cost_above_${n}k_tokens`, info.cache_read_input_token_cost),
  }))
}

function toEntry(providerID: string, providerName: string, fm: FastModel, entry: InfoEntry | undefined): CatalogEntry {
  const info = entry?.model_info ?? {}
  const context = floorToKiB(info.max_input_tokens ?? fm.max_input_tokens ?? info.max_tokens ?? 200_000)
  const output = floorToKiB(info.max_output_tokens ?? fm.max_output_tokens ?? info.max_tokens ?? 32_000)
  const modality = (info.page_display_data?.modality as string[] | undefined) ?? []
  const endpoints = info.supported_endpoints
  return {
    provider_id: providerID,
    provider_name: providerName,
    model_id: fm.id,
    model_name: info.page_display_data?.name ?? fm.id,
    aliases: [],
    mode: info.mode ?? fm.mode ?? "chat",
    enriched: !!entry,
    max_input_tokens: context,
    max_output_tokens: output,
    input_per_1M: perMillion(info.input_cost_per_token),
    output_per_1M: perMillion(info.output_cost_per_token),
    cache_write_per_1M: perMillion(info.cache_creation_input_token_cost),
    cache_read_per_1M: perMillion(info.cache_read_input_token_cost),
    input_per_1k: (info.input_cost_per_token ?? 0) * 1_000,
    output_per_1k: (info.output_cost_per_token ?? 0) * 1_000,
    tiers: priceTiers(info),
    tools: info.supports_function_calling !== false,
    vision: info.supports_vision ?? modality.includes("Vision"),
    pdf: !!info.supports_pdf_input,
    audio: !!info.supports_audio_input,
    video: modality.includes("Video"),
    responses_only: !!endpoints?.includes("/v1/responses") && !endpoints.includes("/v1/chat/completions"),
    effort_levels: effortLevels(info),
    upstream_provider: info.litellm_provider ?? null,
    upstream_model: entry?.litellm_params?.model ?? null,
  }
}

// Two gateway ids are aliases when they point at the same deployment with the
// same display name and prices.
function aliasKey(e: CatalogEntry): string {
  if (!e.enriched || !e.upstream_model) return `id:${e.model_id}`
  return [e.provider_id, e.upstream_model, e.model_name, e.input_per_1M, e.output_per_1M].join("|")
}

// The canonical id is the one matching the gateway's display name; otherwise
// the first one listed.
function pickCanonical(group: CatalogEntry[]): CatalogEntry {
  return group.find((e) => norm(e.model_id) === norm(e.model_name)) ?? group[0]
}

function sortCatalog(catalog: CatalogEntry[]): CatalogEntry[] {
  return catalog.toSorted(
    (a, b) => a.provider_name.localeCompare(b.provider_name) || a.model_name.localeCompare(b.model_name),
  )
}

function buildCatalog(fast: FastModel[], info: InfoEntry[]): CatalogEntry[] {
  const infoByNorm = new Map<string, InfoEntry>()
  for (const e of info) {
    const k = norm(e.model_name)
    if (!infoByNorm.has(k)) infoByNorm.set(k, e) // first deployment wins (deterministic)
  }

  const groups = new Map<string, CatalogEntry[]>()
  const seen = new Set<string>()
  for (const fm of fast) {
    if (SKIP_MODES.has(fm.mode ?? "")) continue
    if (seen.has(fm.id)) continue
    seen.add(fm.id)

    const entry = infoByNorm.get(norm(fm.id)) ?? matchByParamsTail(info, fm.id)
    const mode = entry?.model_info?.mode ?? fm.mode ?? ""
    const endpoints = entry?.model_info?.supported_endpoints
    if (SKIP_MODES.has(mode) || (IMAGE_MODES.has(mode) && !endpoints?.includes("/v1/chat/completions"))) continue
    const { key, name } = upstreamKey(entry)
    const row = toEntry(`${PROVIDER_PREFIX}-${key}`, name, fm, entry)
    const k = aliasKey(row)
    const group = groups.get(k)
    if (group) group.push(row)
    else groups.set(k, [row])
  }

  const catalog: CatalogEntry[] = []
  for (const group of groups.values()) {
    const canonical = pickCanonical(group)
    canonical.aliases = group.filter((e) => e !== canonical).map((e) => e.model_id)
    catalog.push(canonical)
  }

  // Display names must be unique per provider, or the picker shows look-alikes.
  const nameCount = new Map<string, number>()
  for (const e of catalog) nameCount.set(`${e.provider_id}|${e.model_name}`, (nameCount.get(`${e.provider_id}|${e.model_name}`) ?? 0) + 1)
  for (const e of catalog) if ((nameCount.get(`${e.provider_id}|${e.model_name}`) ?? 0) > 1) e.model_name = e.model_id

  return sortCatalog(catalog)
}

// =============================================================================
// 9) CATALOG -> OPENCODE PROVIDERS / MODELS
// =============================================================================

function toModel(e: CatalogEntry): Model.Info {
  const input = ["text"]
  if (e.vision) input.push("image")
  if (e.pdf) input.push("pdf")
  if (e.audio) input.push("audio")
  if (e.video) input.push("video")

  const cost: any[] = [
    { input: e.input_per_1M, output: e.output_per_1M, cache: { read: e.cache_read_per_1M, write: e.cache_write_per_1M } },
  ]
  for (const t of e.tiers) {
    cost.push({
      tier: { type: "context", size: t.size },
      input: t.input_per_1M,
      output: t.output_per_1M,
      cache: { read: t.cache_read_per_1M, write: t.cache_write_per_1M },
    })
  }

  // Fields of Model.Info.default(), inlined so the plugin needs no runtime SDK.
  return {
    id: e.model_id,
    providerID: e.provider_id,
    time: { released: 0 },
    status: "active",
    enabled: true,
    modelID: e.model_id, // ID the gateway expects us to send
    name: e.model_name,
    limit: { context: e.max_input_tokens, output: e.max_output_tokens },
    ...(e.responses_only ? { package: "@opencode/ai/providers/openai-compatible/responses" } : {}),
    capabilities: { tools: e.tools, input, output: ["text"] },
    variants: (e.effort_levels ?? []).map((l) => ({ id: l, settings: { reasoningEffort: l } })),
    cost,
  } as unknown as Model.Info
}

function toProviders(catalog: CatalogEntry[], apiKey?: string): { info: Provider.Info; models: Model.Info[] }[] {
  const groups = new Map<string, { info: Provider.Info; models: Model.Info[] }>()
  for (const e of sortCatalog(catalog)) {
    let rec = groups.get(e.provider_id)
    if (!rec) {
      rec = {
        info: {
          id: e.provider_id,
          name: e.provider_name,
          integrationID: INTEGRATION_ID,
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: COMPLETIONS_BASE,
            // Fallback when the integration connection is unavailable.
            ...(apiKey ? { apiKey } : {}),
          },
        } as unknown as Provider.Info,
        models: [],
      }
      groups.set(e.provider_id, rec)
    }
    rec.models.push(toModel(e))
  }
  return [...groups.values()]
}

// =============================================================================
// 10) INTEGRATION — one connected "AI Gateway" integration.
// =============================================================================

async function ensureConnection(ctx: any, apiKey: string | undefined): Promise<void> {
  if (!CONNECT_INTEGRATION || !apiKey) return
  try {
    const active = await ctx.integration.connection.active(INTEGRATION_ID)
    if (active) {
      const cred = await ctx.integration.connection.resolve(active).catch(() => undefined)
      if (cred?.type === "key" && cred.key === apiKey) return clearIssue("integration")
    }
    await ctx.integration.connect.key({ integrationID: INTEGRATION_ID, key: apiKey, label: "key file" })
    log("info", `connected integration ${INTEGRATION_ID}`)
    clearIssue("integration")
  } catch (err) {
    setIssue(
      "integration",
      "warning",
      "Integration not connected",
      `Could not connect "${INTEGRATION_NAME}": ${errText(err)}. Models still work, but /models may not group them by provider.`,
    )
  }
}

// =============================================================================
// 11) REVIEWABLE CATALOG OUTPUT — models.json + models.csv
// =============================================================================

const CATALOG_COLUMNS: (keyof CatalogEntry)[] = [
  "provider_id",
  "provider_name",
  "model_id",
  "model_name",
  "aliases",
  "mode",
  "enriched",
  "max_input_tokens",
  "max_output_tokens",
  "input_per_1M",
  "output_per_1M",
  "cache_write_per_1M",
  "cache_read_per_1M",
  "input_per_1k",
  "output_per_1k",
  "tiers",
  "tools",
  "vision",
  "pdf",
  "audio",
  "video",
  "responses_only",
  "effort_levels",
  "upstream_provider",
  "upstream_model",
]

function csvEscape(v: unknown): string {
  const s = v == null ? "" : Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(";") : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function writeCatalogReport(catalog: CatalogEntry[], fingerprint: string): Promise<void> {
  if (COST_DISABLED) return
  try {
    await mkdir(COST_DIR, { recursive: true })
    const doc = {
      generated_at: new Date().toISOString(),
      fingerprint,
      base_url: BASE_URL,
      count: catalog.length,
      rows: catalog,
    }
    await writeAtomic(join(COST_DIR, "models.json"), fmtJSON(doc))

    const lines = [CATALOG_COLUMNS.join(",")]
    for (const r of catalog) lines.push(CATALOG_COLUMNS.map((h) => csvEscape(r[h])).join(","))
    await writeAtomic(join(COST_DIR, "models.csv"), lines.join("\n") + "\n")

    console.log(`[gateway-models] wrote catalog -> ${COST_DIR} (${catalog.length} models)`)
    clearIssue("report")
  } catch (err) {
    setIssue("report", "warning", "Catalog report not written", `${displayPath(COST_DIR)}: ${errText(err)}`)
  }
}

// Versions before 2026-10-19 wrote to ~/.config/opencode/gateway-costs. Move it once,
// before anything writes to the new folder. If both exist (another tool already logged
// to the new one), usage.jsonl is merged by event id, regenerated files are dropped and
// anything else stays in the old folder. Skipped when GATEWAY_COST_DIR picks the folder.
const REGENERATED = ["models.json", "models.csv", "usage-summary.json", "usage-data.js", "usage-log.js", "dashboard.html", "status.json"]

async function mergeUsageLog(from: string, to: string): Promise<void> {
  const lines = new Map<string, string>()
  for (const file of [from, to]) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue
      let id = line
      try {
        id = JSON.parse(line).event_id ?? line
      } catch {}
      if (!lines.has(id)) lines.set(id, line)
    }
  }
  await writeAtomic(to, [...lines.values()].join("\n") + "\n")
  await unlink(from)
}

async function migrateCostDir(): Promise<string | undefined> {
  if (setting("GATEWAY_COST_DIR", "")) return
  const legacy = expandHome(LEGACY_COST_DIR)
  const files = await readdir(legacy).catch(() => undefined)
  if (!files) return
  const exists = (p: string) => stat(p).then(() => true, () => false)
  try {
    await mkdir(dirname(COST_DIR), { recursive: true })
    if (!(await exists(COST_DIR))) {
      await rename(legacy, COST_DIR)
      return `moved ${displayPath(legacy)} to ${displayPath(COST_DIR)}`
    }
    const kept: string[] = []
    for (const f of files) {
      const from = join(legacy, f)
      const to = join(COST_DIR, f)
      if (!(await exists(to))) await rename(from, to)
      else if (f === "usage.jsonl") await mergeUsageLog(from, to)
      else if (REGENERATED.includes(f)) await unlink(from)
      else kept.push(f)
    }
    if (!kept.length) await rmdir(legacy).catch(() => {})
    return `merged ${displayPath(legacy)} into ${displayPath(COST_DIR)}${kept.length ? ` (left there: ${kept.join(", ")})` : ""}`
  } catch (err) {
    return `could not move ${displayPath(legacy)} to ${displayPath(COST_DIR)}: ${errText(err)}`
  }
}

// =============================================================================
// 12) USAGE TRACKING — usage.jsonl (raw) + usage-summary.json (aggregated)
// =============================================================================

const USAGE_LOG = join(COST_DIR, "usage.jsonl")
const USAGE_SUMMARY = join(COST_DIR, "usage-summary.json")
const USAGE_DATA_JS = join(COST_DIR, "usage-data.js")
const USAGE_LOG_JS = join(COST_DIR, "usage-log.js")

type Totals = {
  steps: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost: number
  reported_cost: number
}

const emptyTotals = (): Totals => ({
  steps: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost: 0,
  reported_cost: 0,
})

function addTotals(t: Totals, r: UsageRecord): void {
  t.steps += 1
  t.input_tokens += r.input_tokens
  t.output_tokens += r.output_tokens
  t.reasoning_tokens += r.reasoning_tokens
  t.cache_read_tokens += r.cache_read_tokens
  t.cache_write_tokens += r.cache_write_tokens
  t.cost += r.cost
  t.reported_cost += r.reported_cost
}

type ModelUsage = Totals & {
  provider_id: string
  model_id: string
  model_name: string
  upstream_provider: string | null
  gateway: boolean
  first_used: string
  last_used: string
  sessions: Set<string>
}

const createUsageState = () => ({
  loaded: undefined as Promise<void> | undefined,
  offset: 0, // bytes of usage.jsonl already aggregated (complete lines only)
  seen: new Set<string>(), // event ids already recorded (dedupe across subscriptions)
  first: undefined as string | undefined,
  totals: emptyTotals(),
  models: new Map<string, ModelUsage>(),
  providers: new Map<string, Totals & { provider_id: string; provider_name: string }>(),
  tools: new Map<string, Totals & { tool: string }>(),
  billing: new Map<string, Totals & { billing: string }>(),
  agents: new Map<string, Totals & { tool: string; agent: string }>(),
  daily: new Map<string, Totals & { date: string; provider_id: string; model_id: string }>(),
  sessions: new Set<string>(),
  pending: new Map<string, { providerID: string; modelID: string; agent: string | null }>(),
  flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  writeChain: Promise.resolve(),
})

// OpenCode loads the plugin once per location (and again on hot reload), each
// copy with its own module scope, and every copy sees the same events. Keep the
// usage state process-wide so each step is recorded exactly once. Keyed by the log
// path: a copy writing elsewhere (e.g. after moving the data folder) needs its own load.
const USAGE_STATE = Symbol.for(`gateway-models.usage.v3:${USAGE_LOG}`)
const usage: ReturnType<typeof createUsageState> = ((globalThis as any)[USAGE_STATE] ??= createUsageState())

// Lines from before `tool`/`billing` existed: Neovim logged agent "nvim", the rest is OpenCode.
const toolOf = (r: UsageRecord) => r.tool ?? (r.agent === "nvim" ? "nvim" : "opencode")
const billingOf = (r: UsageRecord) => r.billing ?? (r.gateway ? "gateway" : "other")

function addTo<T extends object>(map: Map<string, Totals & T>, key: string, init: T, r: UsageRecord): void {
  let t = map.get(key)
  if (!t) map.set(key, (t = { ...emptyTotals(), ...init }))
  addTotals(t, r)
}

function aggregate(r: UsageRecord): void {
  usage.seen.add(r.event_id)
  usage.sessions.add(r.session_id)
  if (!usage.first || r.ts < usage.first) usage.first = r.ts
  addTotals(usage.totals, r)

  const mk = `${r.provider_id}/${r.model_id}`
  let m = usage.models.get(mk)
  if (!m) {
    m = {
      ...emptyTotals(),
      provider_id: r.provider_id,
      model_id: r.model_id,
      model_name: r.model_name,
      upstream_provider: r.upstream_provider,
      gateway: r.gateway,
      first_used: r.ts,
      last_used: r.ts,
      sessions: new Set(),
    }
    usage.models.set(mk, m)
  }
  addTotals(m, r)
  m.sessions.add(r.session_id)
  if (r.ts < m.first_used) m.first_used = r.ts
  if (r.ts > m.last_used) m.last_used = r.ts

  let p = usage.providers.get(r.provider_id)
  if (!p) {
    const name = priceIndex.get(`${r.provider_id}/${r.model_id}`)?.provider_name ?? r.provider_id
    p = { ...emptyTotals(), provider_id: r.provider_id, provider_name: name }
    usage.providers.set(r.provider_id, p)
  }
  addTotals(p, r)

  const tool = toolOf(r)
  addTo(usage.tools, tool, { tool }, r)
  addTo(usage.billing, billingOf(r), { billing: billingOf(r) }, r)
  const agent = tool === "nvim" && r.agent === "nvim" ? "prediction" : (r.agent ?? "") // old Neovim lines
  addTo(usage.agents, `${tool}/${agent}`, { tool, agent }, r)

  const date = localDate(Date.parse(r.ts))
  const dk = `${date}|${mk}`
  let d = usage.daily.get(dk)
  if (!d) {
    d = { ...emptyTotals(), date, provider_id: r.provider_id, model_id: r.model_id }
    usage.daily.set(dk, d)
  }
  addTotals(d, r)
}

function aggregateLines(text: string): void {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as UsageRecord
      if (r.event_id && !usage.seen.has(r.event_id)) aggregate(r)
    } catch {
      // skip a corrupt line
    }
  }
}

// Only complete lines count; a line still being written is read on the next pass.
function completeLines(buf: Buffer): Buffer {
  return buf.subarray(0, buf.lastIndexOf(0x0a) + 1)
}

// Rebuild the in-memory aggregate from the append-only log (source of truth).
function loadUsage(): Promise<void> {
  usage.loaded ??= (async () => {
    let buf: Buffer
    try {
      buf = completeLines(await readFile(USAGE_LOG))
    } catch {
      return // no log yet
    }
    usage.offset = buf.length
    aggregateLines(buf.toString("utf8"))
  })()
  return usage.loaded
}

// Other tools append to the same log (the Neovim config logs its inline
// predictions here). Aggregate what was added since the last pass; this
// plugin's own lines are already in `seen` and are skipped.
async function ingestLog(): Promise<void> {
  await loadUsage()
  let size: number
  try {
    size = (await stat(USAGE_LOG)).size
  } catch {
    return
  }
  // State kept from a copy loaded before `offset` existed, or the log was replaced
  // or truncated: rescan from the start, event ids dedupe.
  if (!Number.isFinite(usage.offset) || size < usage.offset) usage.offset = 0
  if (size === usage.offset) return
  const fh = await open(USAGE_LOG, "r")
  try {
    const buf = Buffer.alloc(size - usage.offset)
    const { bytesRead } = await fh.read(buf, 0, buf.length, usage.offset)
    const lines = completeLines(buf.subarray(0, bytesRead))
    usage.offset += lines.length
    aggregateLines(lines.toString("utf8"))
  } finally {
    await fh.close()
  }
}

// Appends by other tools refresh the summary and dashboard data within seconds.
function watchUsageLog(): () => void {
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(COST_DIR, (_event, file) => {
      if (file && file.toString() === basename(USAGE_LOG)) scheduleSummaryWrite()
    })
    watcher.on("error", () => watcher?.close())
  } catch {
    // no cost folder yet: the summary still catches up on the next own step
  }
  return () => watcher?.close()
}

function round(n: number, digits = 6): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function roundTotals<T extends Totals>(t: T): T {
  return { ...t, cost: round(t.cost), reported_cost: round(t.reported_cost) }
}

function summaryDoc() {
  return {
    generated_at: new Date().toISOString(),
    since: usage.first ?? null,
    currency: "USD",
    totals: { ...roundTotals(usage.totals), sessions: usage.sessions.size },
    providers: [...usage.providers.values()].map(roundTotals).toSorted((a, b) => b.cost - a.cost),
    tools: [...usage.tools.values()].map(roundTotals).toSorted((a, b) => b.cost - a.cost),
    billing: [...usage.billing.values()].map(roundTotals).toSorted((a, b) => b.cost - a.cost),
    agents: [...usage.agents.values()].map(roundTotals).toSorted((a, b) => b.cost - a.cost),
    models: [...usage.models.values()]
      .map(({ sessions, ...m }) => ({ ...roundTotals(m), sessions: sessions.size }))
      .toSorted((a, b) => b.cost - a.cost || b.steps - a.steps),
    daily: [...usage.daily.values()]
      .map(roundTotals)
      .toSorted((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost),
  }
}

function scheduleSummaryWrite(): void {
  if (usage.flushTimer) return
  usage.flushTimer = setTimeout(() => {
    usage.flushTimer = undefined
    void flushSummary()
  }, 2_000)
}

function flushSummary(): Promise<void> {
  usage.writeChain = usage.writeChain
    .then(async () => {
      await ingestLog()
      const doc = summaryDoc()
      await mkdir(COST_DIR, { recursive: true })
      await writeAtomic(USAGE_SUMMARY, fmtJSON(doc))
      // Same data as a script, so a static page opened via file:// can use it
      // with <script src="usage-data.js"> (fetch() is blocked on file://).
      await writeAtomic(USAGE_DATA_JS, `window.GATEWAY_USAGE = ${JSON.stringify(doc)};\n`)
      // Raw per-step log for dashboard.html, which filters it client-side.
      const log = await readFile(USAGE_LOG, "utf8").catch(() => "")
      await writeAtomic(USAGE_LOG_JS, `window.GATEWAY_USAGE_LOG = ${JSON.stringify(log)};\n`)
      clearIssue("usage.summary")
    })
    .catch((err) =>
      setIssue("usage.summary", "warning", "Usage summary not written", `${displayPath(COST_DIR)}: ${errText(err)}. The dashboard shows older data.`),
    )
  return usage.writeChain
}

function priceCost(entry: CatalogEntry | undefined, t: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }) {
  if (!entry) return undefined
  const prompt = t.input + t.cacheRead + t.cacheWrite
  const tier = entry.tiers.findLast((x) => prompt > x.size) // largest tier the prompt exceeds
  const inP = tier?.input_per_1M ?? entry.input_per_1M
  const outP = tier?.output_per_1M ?? entry.output_per_1M
  const crP = tier?.cache_read_per_1M ?? entry.cache_read_per_1M
  const cwP = tier?.cache_write_per_1M ?? entry.cache_write_per_1M
  const cost = (t.input * inP + (t.output + t.reasoning) * outP + t.cacheRead * crP + t.cacheWrite * cwP) / 1_000_000
  return { cost, inP, outP, crP, cwP }
}

async function modelForStep(ctx: any, data: any): Promise<{ providerID: string; modelID: string; agent: string | null }> {
  const pending = usage.pending.get(data.assistantMessageID)
  if (pending) return pending
  // Step started before the plugin was (re)loaded: fall back to the session's model.
  try {
    const session = await ctx.session.get({ sessionID: data.sessionID })
    const model = session?.model ?? session?.data?.model
    if (model?.id) return { providerID: model.providerID, modelID: model.id, agent: session?.agent ?? null }
  } catch {
    // ignore
  }
  return { providerID: "unknown", modelID: "unknown", agent: null }
}

async function recordStep(ctx: any, event: any): Promise<void> {
  const data = event?.data
  const tokens = data?.tokens
  if (!data || !tokens || !event.id) return
  await loadUsage()
  if (usage.seen.has(event.id)) return
  usage.seen.add(event.id)

  const { providerID, modelID, agent } = await modelForStep(ctx, data)
  usage.pending.delete(data.assistantMessageID)

  const t = {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
  }
  if (t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite === 0) return

  const entry = priceIndex.get(`${providerID}/${modelID}`) ?? (providerID.startsWith(`${PROVIDER_PREFIX}-`) ? priceIndex.get(modelID) : undefined)
  const priced = priceCost(entry, t)
  const reported = Number(data.cost ?? 0)

  const record: UsageRecord = {
    ts: new Date(event.created ?? Date.now()).toISOString(),
    event_id: event.id,
    session_id: data.sessionID,
    message_id: data.assistantMessageID,
    tool: "opencode",
    billing: entry ? "gateway" : "other",
    agent,
    provider_id: providerID,
    model_id: entry?.model_id ?? modelID, // aliases are folded into the canonical id
    model_name: entry?.model_name ?? modelID,
    gateway: !!entry,
    upstream_provider: entry?.upstream_provider ?? null,
    finish: event.type === "session.step.failed" ? "failed" : (data.finish ?? "unknown"),
    input_tokens: t.input,
    output_tokens: t.output,
    reasoning_tokens: t.reasoning,
    cache_read_tokens: t.cacheRead,
    cache_write_tokens: t.cacheWrite,
    input_per_1M: priced?.inP ?? 0,
    output_per_1M: priced?.outP ?? 0,
    cache_read_per_1M: priced?.crP ?? 0,
    cache_write_per_1M: priced?.cwP ?? 0,
    cost: round(priced?.cost ?? reported, 8), // non-gateway models: trust OpenCode's figure
    reported_cost: round(reported, 8),
  }

  aggregate(record)
  usage.writeChain = usage.writeChain
    .then(async () => {
      await mkdir(COST_DIR, { recursive: true })
      await appendFile(USAGE_LOG, JSON.stringify(record) + "\n")
      clearIssue("usage.write")
    })
    .catch((err) =>
      setIssue("usage.write", "warning", "Usage not recorded", `Could not append to ${displayPath(USAGE_LOG)}: ${errText(err)}`),
    )
  scheduleSummaryWrite()
}

async function handleEvent(ctx: any, event: any): Promise<void> {
  switch (event?.type) {
    case "session.step.started": {
      const d = event.data
      if (d?.assistantMessageID && d.model?.id) {
        usage.pending.set(d.assistantMessageID, { providerID: d.model.providerID, modelID: d.model.id, agent: d.agent ?? null })
        if (usage.pending.size > 500) usage.pending.delete(usage.pending.keys().next().value!)
      }
      return
    }
    case "session.step.ended":
    case "session.step.failed":
      return recordStep(ctx, event)
  }
}

// Subscribe to the event stream until disposed; reconnect with backoff.
function trackUsage(ctx: any): () => void {
  const controller = new AbortController()
  const stopWatch = watchUsageLog()
  controller.signal.addEventListener("abort", stopWatch)
  void (async () => {
    await loadUsage()
    await copyDashboard()
    void flushSummary() // so usage-log.js exists before the next step
    let delay = 1_000
    let failures = 0
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          delay = 1_000
          if (failures) {
            failures = 0
            clearIssue("usage.stream")
          }
          await handleEvent(ctx, event).catch((err) => console.error("[gateway-models] usage event:", err))
        }
      } catch (err) {
        if (controller.signal.aborted) break
        console.error("[gateway-models] event stream error, reconnecting:", err)
        // One drop is normal (server restart); a few in a row means steps go unrecorded.
        if (++failures >= 3) {
          setIssue("usage.stream", "warning", "Usage tracking interrupted", `Event stream failed: ${errText(err)}. Reconnecting.`)
        }
      }
      if (controller.signal.aborted) break
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 60_000)
    }
  })()
  return () => controller.abort()
}

// A copy next to the data always finds usage-log.js, wherever the plugin is installed.
async function copyDashboard(): Promise<string> {
  const target = join(COST_DIR, "dashboard.html")
  await mkdir(COST_DIR, { recursive: true }).catch(() => {})
  await copyFile(DASHBOARD_SRC, target).then(
    () => clearIssue("dashboard"),
    (err) => setIssue("dashboard", "warning", "Dashboard not updated", `Could not copy dashboard.html to ${displayPath(COST_DIR)}: ${errText(err)}`),
  )
  // The dashboard's own settings; created once, then it is yours to edit ("wx": never overwrite).
  await writeFile(join(COST_DIR, "config.js"), DASHBOARD_CONFIG, { flag: "wx" }).catch(() => {})
  return target
}

const DASHBOARD_CONFIG = `// Settings for dashboard.html in this folder. Edit, then reload the page.
window.GATEWAY_CONFIG = {
  // Monthly budget in USD (e.g. 250). The "This month" tile shows the spend of the
  // current calendar month against it, for the selected tool/billing filters.
  monthlyLimitUSD: null,
}
`

// Default browser on every OS. explorer.exe takes a path with spaces as one argument,
// which `cmd /c start` does not.
function openInBrowser(target: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["explorer.exe", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]]
  const failed = (err: unknown) =>
    setIssue("browser", "warning", "Dashboard not opened", `${cmd} failed: ${errText(err)}. Open ${displayPath(target)} manually.`)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.on("error", failed)
    child.on("spawn", () => clearIssue("browser"))
    child.unref()
  } catch (err) {
    failed(err)
  }
}

// =============================================================================
// 13) HEALTH — issues -> status.json + gateway-models.log (tui.ts shows them)
// -----------------------------------------------------------------------------
// The server half of a plugin cannot raise TUI notifications, and console output
// does not reach opencode.log. So every problem is an "issue" here: logged to
// gateway-models.log and written to status.json, which tui.ts watches and turns
// into toasts (and the /gateway-status dialog). Issues clear themselves when the
// next attempt succeeds.
// =============================================================================

const STATUS_FILE = join(COST_DIR, "status.json")
const PLUGIN_LOG = join(COST_DIR, "gateway-models.log")
const PLUGIN_LOG_MAX_BYTES = 512 * 1024

type Issue = { id: string; level: "error" | "warning"; title: string; message: string; since: string }

const createHealth = () => ({
  issues: new Map<string, Issue>(),
  models: 0,
  lastSuccess: undefined as string | undefined,
  nextRetry: undefined as string | undefined,
  writeTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  writeChain: Promise.resolve(),
  logChain: Promise.resolve(),
})

// Process-wide like the usage state: every plugin copy reports the same key file
// and gateway, so they share one set of issues and one status.json writer.
const HEALTH_STATE = Symbol.for(`gateway-models.health.v1:${STATUS_FILE}`)
const health: ReturnType<typeof createHealth> = ((globalThis as any)[HEALTH_STATE] ??= createHealth())

function log(level: "info" | "warn" | "error", msg: string): void {
  ;(level === "info" ? console.log : console.error)(`[gateway-models] ${msg}`)
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`
  health.logChain = health.logChain
    .then(async () => {
      await mkdir(COST_DIR, { recursive: true })
      const size = await stat(PLUGIN_LOG).then((s) => s.size, () => 0)
      if (size > PLUGIN_LOG_MAX_BYTES) await rename(PLUGIN_LOG, `${PLUGIN_LOG}.1`).catch(() => {})
      await appendFile(PLUGIN_LOG, line)
    })
    .catch(() => {})
}

function setIssue(id: string, level: Issue["level"], title: string, message: string): void {
  const prev = health.issues.get(id)
  if (prev && prev.level === level && prev.title === title && prev.message === message) return
  const since = prev && prev.title === title ? prev.since : new Date().toISOString()
  health.issues.set(id, { id, level, title, message, since })
  log(level === "error" ? "error" : "warn", `${title}: ${message}`)
  scheduleStatusWrite()
}

function clearIssue(id: string): void {
  const prev = health.issues.get(id)
  if (!prev) return
  health.issues.delete(id)
  log("info", `resolved: ${prev.title}`)
  scheduleStatusWrite()
}

function statusDoc() {
  return {
    generated_at: new Date().toISOString(),
    pid: process.pid, // tui.ts ignores a status file whose writer is gone
    base_url: BASE_URL,
    key_source: KEY_SOURCE,
    models: health.models,
    last_success: health.lastSuccess ?? null,
    next_retry: health.nextRetry ?? null,
    log_file: PLUGIN_LOG,
    issues: [...health.issues.values()],
  }
}

function scheduleStatusWrite(): void {
  if (health.writeTimer) return
  health.writeTimer = setTimeout(() => {
    health.writeTimer = undefined
    void writeStatus()
  }, 100)
}

function writeStatus(): Promise<void> {
  health.writeChain = health.writeChain
    .then(async () => {
      await mkdir(COST_DIR, { recursive: true })
      await writeAtomic(STATUS_FILE, fmtJSON(statusDoc()))
    })
    .catch((err) => console.error("[gateway-models] failed to write status:", err))
  return health.writeChain
}

function reportGatewayError(err: unknown, endpoint: string): void {
  const e = err instanceof GatewayError ? err : new GatewayError("network", errText(err))
  const n = source.catalog.length
  const fallback = n
    ? `Using ${n} cached models meanwhile; retrying automatically.`
    : "No gateway models are available until this works; retrying automatically."
  const where = sentence(`GET ${endpoint}: ${e.message}`)
  switch (e.kind) {
    case "auth":
      return setIssue("gateway", "error", "API key rejected", `${where} Check the key in ${KEY_SOURCE}. ${fallback}`)
    case "timeout":
    case "network":
      return setIssue(
        "gateway",
        n ? "warning" : "error",
        "Gateway unreachable",
        `${where} Check the network / VPN connection to ${BASE_URL}. ${fallback}`,
      )
    case "http":
      return setIssue("gateway", n ? "warning" : "error", "Gateway error", `${where} ${fallback}`)
    case "response":
      return setIssue("gateway", n ? "warning" : "error", "Unexpected gateway response", `${where} ${fallback}`)
  }
}

async function readCache(ctx: any): Promise<Cache | undefined> {
  try {
    const cached = (await ctx.storage.get(CACHE_KEY)) as Cache | undefined
    clearIssue("cache")
    return cached
  } catch (err) {
    setIssue("cache", "warning", "Model cache unavailable", `Reading the cached catalog failed: ${errText(err)}. Startup needs the gateway.`)
    return undefined
  }
}

async function writeCache(ctx: any, cache: Cache): Promise<void> {
  try {
    await ctx.storage.set(CACHE_KEY, cache)
    clearIssue("cache")
  } catch (err) {
    setIssue("cache", "warning", "Model cache not saved", `${errText(err)}. The next startup needs the gateway.`)
  }
}

async function reloadProviders(ctx: any): Promise<void> {
  try {
    await ctx.provider.reload() // re-applies our transform -> /models updates live
    clearIssue("reload")
  } catch (err) {
    setIssue("reload", "warning", "Model list not updated", `Provider reload failed: ${errText(err)}. Restart OpenCode to see the current models.`)
  }
}

// =============================================================================
// 14) BACKGROUND REFRESH
// =============================================================================

// "no-key": nothing to try until the key file exists (cheap to re-check).
// "failed": the gateway or /model/info failed (retry with backoff).
type RefreshResult = "ok" | "no-key" | "failed"

async function refresh(ctx: any): Promise<RefreshResult> {
  const apiKey = applyKeyResult(await resolveApiKey(), source.apiKey)
  const keyChanged = apiKey !== source.apiKey
  source.apiKey = apiKey
  if (!apiKey && KEY_PATH) return "no-key" // a request without the key only earns a 401
  if (keyChanged) await ensureConnection(ctx, apiKey)
  let reloaded = false

  let fast: FastModel[]
  try {
    fast = await loadFast(apiKey)
    if (!fast.length) throw new GatewayError("response", "the model list is empty")
  } catch (err) {
    // Keep the cached catalog; the scheduler tries again soon.
    reportGatewayError(err, "/models")
    if (keyChanged) await reloadProviders(ctx)
    return "failed"
  }
  clearIssue("gateway")

  // Nothing registered yet (first run without cache, or the key arrived late):
  // show the fast list now, prices follow from /model/info.
  if (!source.catalog.length) {
    setCatalog(buildCatalog(fast, []))
    await reloadProviders(ctx)
    reloaded = true
  }

  const fp = fingerprintOf(fast)
  const cached = await readCache(ctx)
  const now = Date.now()
  const changed = !cached || cached.fingerprint !== fp
  const stale = !cached || now - (cached.fetchedAt ?? 0) > INFO_STALE_MS

  if (changed || stale) {
    let info: InfoEntry[]
    try {
      info = await loadInfo(apiKey) // the ~1-minute call, always in the background
    } catch (err) {
      const e = err instanceof GatewayError ? err : new GatewayError("network", errText(err))
      const kept = source.catalog.some((x) => x.enriched)
        ? "Keeping the previous prices and limits."
        : "Models are listed without prices until then (cost shows $0)."
      setIssue("info", "warning", "Model details unavailable", `${sentence(`GET /model/info: ${e.message}`)} ${kept} Retrying automatically.`)
      if (keyChanged && !reloaded) await reloadProviders(ctx)
      health.models = source.catalog.length
      return "failed"
    }
    clearIssue("info")
    setCatalog(buildCatalog(fast, info))
    await reloadProviders(ctx)
    await writeCache(ctx, { fingerprint: fp, fetchedAt: now, catalog: source.catalog })
  } else {
    clearIssue("info")
    if (keyChanged && !reloaded) await reloadProviders(ctx)
  }

  await writeCatalogReport(source.catalog, fp)
  health.models = source.catalog.length
  health.lastSuccess = new Date().toISOString()
  scheduleStatusWrite()
  return "ok"
}

// Runs refresh() now and schedules the next run: FAST_POLL_MS when healthy,
// RETRY_MS (with backoff for network failures) while something is broken.
function createRefreshLoop(ctx: any, beforeRun: () => void) {
  const loop = {
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    running: undefined as Promise<void> | undefined,
    again: false,
    failures: 0,
    disposed: false,
  }

  const once = async (): Promise<void> => {
    let result: RefreshResult = "failed"
    try {
      beforeRun()
      result = await refresh(ctx)
      clearIssue("refresh")
    } catch (err) {
      setIssue("refresh", "error", "Model refresh failed", `${sentence(errText(err))} Retrying automatically.`)
    }
    if (loop.disposed) return
    const delay =
      result === "ok" ? FAST_POLL_MS : result === "no-key" ? RETRY_MS : Math.min(RETRY_MS * 2 ** loop.failures, RETRY_MAX_MS)
    loop.failures = result === "failed" ? loop.failures + 1 : 0
    health.nextRetry = result === "ok" ? undefined : new Date(Date.now() + delay).toISOString()
    scheduleStatusWrite()
    clearTimeout(loop.timer)
    loop.timer = setTimeout(() => void run(), delay)
  }

  // A trigger during a run (key file saved while /model/info is loading) runs
  // once more right after it, so the change is never dropped.
  const run = (): Promise<void> => {
    if (loop.disposed) return Promise.resolve()
    if (loop.running) {
      loop.again = true
      return loop.running
    }
    clearTimeout(loop.timer)
    loop.running = (async () => {
      do {
        loop.again = false
        await once()
      } while (loop.again && !loop.disposed)
    })().finally(() => {
      loop.running = undefined
    })
    return loop.running
  }

  return {
    run,
    dispose() {
      loop.disposed = true
      clearTimeout(loop.timer)
    },
  }
}

// Watches the key file's folder (the file itself may not exist yet), so creating,
// fixing or rotating the key applies within a second. If the folder is missing,
// ensure() is retried on every refresh and the retry timer covers the gap.
function watchKeyFile(onChange: () => void) {
  let watcher: FSWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  const ensure = () => {
    if (watcher || !KEY_PATH) return
    const name = basename(KEY_PATH)
    try {
      watcher = watch(dirname(KEY_PATH), (_event, file) => {
        if (file && file.toString() !== name) return
        clearTimeout(debounce)
        debounce = setTimeout(onChange, 500) // editors write in several steps
      })
      watcher.on("error", () => {
        watcher?.close()
        watcher = undefined
      })
    } catch {
      watcher = undefined
    }
  }
  ensure()
  return {
    ensure,
    close() {
      clearTimeout(debounce)
      watcher?.close()
      watcher = undefined
    },
  }
}

// =============================================================================
// 15) PLUGIN DEFINITION
// =============================================================================

export default {
  id: "gateway-models",
  async setup(ctx) {
    // First: everything below writes to COST_DIR. Once per process, every plugin copy awaits the same move.
    await ((globalThis as any)[Symbol.for("gateway-models.migrate.v1")] ??= migrateCostDir().then((m) => m && log("info", m)))
    // Not configured: say so once (log + status.json, which tui.ts shows as a toast) and register nothing.
    if (!BASE_URL) {
      setIssue("config", "error", "Not configured", NOT_CONFIGURED)
      await writeStatus()
      return async () => {}
    }
    const registrations: Registration[] = []
    source.apiKey = applyKeyResult(await resolveApiKey(), source.apiKey)

    // A single integration that every gateway provider belongs to.
    registrations.push(
      await ctx.integration.transform((editor) => {
        editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "AI gateway API key" } })
        editor.update(INTEGRATION_ID, (integration) => {
          integration.name = INTEGRATION_NAME
        })
      }),
    )
    await ensureConnection(ctx, source.apiKey)

    const cached = await readCache(ctx)
    if (cached?.catalog?.length) {
      setCatalog(cached.catalog) // zero-network startup
    } else if (source.apiKey || !KEY_PATH) {
      // first run: only the cheap call, then enrich in the background
      try {
        setCatalog(buildCatalog(await loadFast(source.apiKey), []))
      } catch (err) {
        reportGatewayError(err, "/models")
      }
    }
    health.models = source.catalog.length
    await writeStatus() // fresh status.json (with this pid) before the TUI looks

    registrations.push(
      await ctx.provider.transform((editor) => {
        for (const rec of toProviders(source.catalog, source.apiKey)) editor.add(rec)
      }),
    )

    const stopUsage = USAGE_DISABLED ? () => {} : trackUsage(ctx)

    // Key file created / fixed / rotated -> refresh now (skip touches that change nothing).
    const keyWatch = watchKeyFile(async () => {
      const r = await resolveApiKey()
      if (!r.problem && r.key === source.apiKey && !health.issues.has("key")) return
      void loop.run()
    })
    const loop = createRefreshLoop(ctx, () => keyWatch.ensure())

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "usage-dashboard",
          description: "Open the gateway usage and cost dashboard in the browser",
          execute: async () => {
            await loadUsage()
            await flushSummary() // write the latest steps before the page reads them
            openInBrowser(await copyDashboard())
          },
        })
        editor.add({
          name: "gateway-refresh",
          description: "Re-read the gateway API key and reload the model list now",
          execute: () => loop.run(),
        })
      }),
    )

    // Enrich in the background immediately, then keep polling the cheap list.
    void loop.run().then(() => ensureConnection(ctx, source.apiKey))

    return async () => {
      loop.dispose()
      keyWatch.close()
      stopUsage()
      if (usage.flushTimer) {
        clearTimeout(usage.flushTimer)
        usage.flushTimer = undefined
        await flushSummary()
      }
      await Promise.all(registrations.map((r) => r.dispose()))
    }
  },
} satisfies Plugin.Plugin
