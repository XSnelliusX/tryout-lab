// Runtime access to the sibling ai-gateway module's on-disk data contract.
//
// Nothing gateway-specific is hardcoded here: the catalog location, the provider
// prefix and the benchmark file all come from the environment, the ai-gateway env
// file, or the files the ai-gateway module writes (see ../ai-gateway/README.md).
//
//   $GATEWAY_COST_DIR/models.json                          gateway model catalog
//   $GATEWAY_COST_DIR/model-comparison/data/models.json    benchmark comparison (via /model-comparison)
//   $GATEWAY_COST_DIR/model-comparison/data/recommendations.json   the comparison engine's picks per task tier

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function expandHome(p) {
  if (!p) return ""
  const s = String(p).trim()
  if (s === "~") return homedir()
  if (s.startsWith("~/")) return join(homedir(), s.slice(2))
  return s
}

const envFileCache = new Map()

export function parseEnvFile(filePath) {
  const vars = {}
  if (!filePath) return vars
  let mtime = -1
  try {
    mtime = statSync(filePath).mtimeMs
  } catch {
    envFileCache.delete(filePath)
    return vars // Env file is optional
  }
  const hit = envFileCache.get(filePath)
  if (hit && hit.mtime === mtime) return hit.vars
  try {
    const raw = readFileSync(filePath, "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
      if (!match) continue
      let val = match[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      vars[match[1]] = val
    }
  } catch {
    return {}
  }
  envFileCache.set(filePath, { mtime, vars })
  return vars
}

/**
 * Resolve gateway settings from the environment, then the ai-gateway env file.
 * `providerPrefix` is empty unless GATEWAY_PROVIDER_PREFIX is configured. Gateway
 * membership is normally decided by the catalog itself (see isGatewayProvider).
 */
export function resolveGatewaySettings(env = process.env) {
  const envFile = expandHome(env.GATEWAY_ENV_FILE || "~/.config/ai-gateway/env")
  const fileVars = parseEnvFile(envFile)
  const get = (name, fallback = "") => {
    const v = env[name]
    if (v !== undefined && String(v).trim() !== "") return String(v).trim()
    const fv = fileVars[name]
    if (fv !== undefined && String(fv).trim() !== "") return String(fv).trim()
    return fallback
  }

  const costDir = expandHome(get("GATEWAY_COST_DIR", "~/.gateway-cost"))
  const disabledRaw = get("GATEWAY_USAGE_DISABLED", "").toLowerCase()
  const usageDisabled = disabledRaw === "1" || disabledRaw === "true" || disabledRaw === "yes"

  return {
    envFile,
    costDir,
    usageDisabled,
    providerPrefix: get("GATEWAY_PROVIDER_PREFIX", "").replace(/-+$/, ""),
    usageLogPath: join(costDir, "usage.jsonl"),
    catalogModelsPath: join(costDir, "models.json"),
    comparisonPath: join(costDir, "model-comparison", "data", "models.json"),
    recommendationsPath: join(costDir, "model-comparison", "data", "recommendations.json"),
  }
}

const EMPTY_CATALOG = () => ({ rows: [], byKey: new Map(), byId: new Map(), providerIds: new Set() })

/** Index raw catalog rows. Pure; never reads or emits the catalog's base_url. */
export function indexCatalog(doc) {
  const out = EMPTY_CATALOG()
  for (const row of doc?.rows ?? []) {
    if (!row?.provider_id || !row?.model_id) continue
    out.rows.push(row)
    out.providerIds.add(String(row.provider_id))
    out.byKey.set(`${row.provider_id}/${row.model_id}`, row)
    const lowerId = String(row.model_id).toLowerCase()
    if (!out.byId.has(lowerId)) out.byId.set(lowerId, row)
  }
  return out
}

let cachedCatalogPath = null
let cachedCatalogMtime = -1
let cachedCatalog = null

export function loadGatewayCatalog(catalogPath) {
  if (!catalogPath) return EMPTY_CATALOG()
  try {
    const st = statSync(catalogPath)
    if (cachedCatalog && cachedCatalogPath === catalogPath && cachedCatalogMtime === st.mtimeMs) {
      return cachedCatalog
    }
    const catalog = indexCatalog(JSON.parse(readFileSync(catalogPath, "utf8")))
    cachedCatalogPath = catalogPath
    cachedCatalogMtime = st.mtimeMs
    cachedCatalog = catalog
    return catalog
  } catch {
    return EMPTY_CATALOG()
  }
}

/** A provider belongs to the gateway if the catalog lists it or it uses the configured prefix. */
export function isGatewayProvider(providerID, catalog, settings) {
  const id = String(providerID || "")
  if (!id) return false
  if (catalog?.providerIds?.has(id)) return true
  const prefix = settings?.providerPrefix
  return Boolean(prefix) && id.startsWith(`${prefix}-`)
}
