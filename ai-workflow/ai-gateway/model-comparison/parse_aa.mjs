#!/usr/bin/env node
/**
 * parse_aa.mjs
 * ---------------------------------------------------------------------------
 * Enrich the gateway model catalog (models.json, written by the ai-gateway
 * OpenCode plugin) with current Artificial Analysis data, without an API key
 * and without third-party dependencies.
 *
 * How it works
 *   1. Fetch public Artificial Analysis HTML pages.
 *   2. Extract the encrypted /data/<hash>.txt manifest descriptors embedded in
 *      the RSC payload.
 *   3. Decrypt with AES-256-GCM (key from the manifest, IV = SHA-256(key)[:12]),
 *      then gunzip and parse the JSON.
 *   4. Merge the full model dataset, the eval dataset, the capability-index
 *      dataset, the leaderboard provider dataset, and per-host model rows.
 *   5. Match every gateway row to an AA release and select the best effort
 *      variant, while retaining *all* variants and their scores.
 *   6. Write JSON, CSV, a match report, and run metadata.
 *
 * Usage
 *   node parse_aa.mjs                 (reads $GATEWAY_COST_DIR/models.json)
 *   node parse_aa.mjs --input models.json --out-dir out
 *   node parse_aa.mjs --refresh
 *   node parse_aa.mjs --offline
 *   node parse_aa.mjs --self-test     (synthetic data, no network, no cache)
 *
 * Node 22+ required (global fetch, crypto, zlib). No npm packages.
 *
 * Data source: Artificial Analysis, https://artificialanalysis.ai
 * Artificial Analysis' terms restrict scraping and redistribution of their
 * data. Keep the fetched data local and keep the attribution.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const AA_BASE = 'https://artificialanalysis.ai';
// AA_BASE_URL only redirects the actual HTTP request (tests point it at an
// unreachable host); cache keys and recorded URLs always use AA_BASE.
const AA_FETCH_BASE = process.env.AA_BASE_URL || AA_BASE;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const USER_AGENT = 'model-comparison-aa-enricher/1.0';

// Locations shared with compare.mjs and the ai-gateway plugin.
const GATEWAY_COST_DIR = process.env.GATEWAY_COST_DIR || path.join(os.homedir(), '.gateway-cost');
const CACHE_ROOT = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'ai-gateway',
  'model-comparison',
);
// Optional provider-id prefix used by some gateway catalogs (for example
// "<prefix>-bedrock"). It is only used to recognise a provider name inside a
// provider_id when no better field is available.
const GATEWAY_PROVIDER_PREFIX = (process.env.GATEWAY_PROVIDER_PREFIX ?? 'acc').trim();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    input: path.join(GATEWAY_COST_DIR, 'models.json'),
    outDir: path.join(CACHE_ROOT, 'out'),
    cacheDir: path.join(CACHE_ROOT, 'aa'),
    maxAgeMinutes: 24 * 60,
    refresh: false,
    offline: false,
    selfTest: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--input': opts.input = path.resolve(process.cwd(), next()); break;
      case '--out-dir': opts.outDir = path.resolve(process.cwd(), next()); break;
      case '--cache-dir': opts.cacheDir = path.resolve(process.cwd(), next()); break;
      case '--max-age-minutes': opts.maxAgeMinutes = Number(next()); break;
      case '--refresh': opts.refresh = true; break;
      case '--offline': opts.offline = true; break;
      case '--self-test': opts.selfTest = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node parse_aa.mjs [options]

Options:
  --input <file>           Gateway catalog (default: $GATEWAY_COST_DIR/models.json,
                           i.e. ~/.gateway-cost/models.json)
  --out-dir <dir>          Output directory (default: <cache>/out)
  --cache-dir <dir>        HTTP cache (default: <cache>/aa)
                           where <cache> = $XDG_CACHE_HOME (or ~/.cache)/ai-gateway/model-comparison
  --max-age-minutes <n>    Cache freshness window (default: 1440 = 24h)
  --refresh                Ignore fresh cache and refetch
  --offline                Use cache only; never touch the network
  --self-test              Run crypto and matching assertions on synthetic data
                           (no network, no cache, no catalog needed)
  --quiet                  Suppress progress messages
  -h, --help               Show this help`);
}

const opts = parseArgs(process.argv.slice(2));
const log = (...args) => { if (!opts.quiet) console.error(...args); };

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEmptyValue(v) {
  return v === null || v === undefined
    || (Array.isArray(v) && v.length === 0)
    || (isPlainObject(v) && Object.keys(v).length === 0);
}

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

/** Fill only missing/empty fields, recursively for plain objects. */
function fillMissing(target, source) {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!(key in target) || isEmptyValue(target[key])) {
      target[key] = clone(value);
    } else if (isPlainObject(target[key]) && isPlainObject(value)) {
      fillMissing(target[key], value);
    }
  }
}

function snakeCase(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (Array.isArray(value)) s = value.join('; ');
  else if (isPlainObject(value)) s = JSON.stringify(value);
  else s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// HTTP cache
// ---------------------------------------------------------------------------

function cachePaths(url) {
  const key = sha256(Buffer.from(url));
  return {
    data: path.join(opts.cacheDir, `${key}.bin`),
    meta: path.join(opts.cacheDir, `${key}.json`),
  };
}

function readCache(url) {
  const { data, meta } = cachePaths(url);
  if (!fs.existsSync(data)) return null;
  let info = {};
  if (fs.existsSync(meta)) {
    try { info = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { /* ignore */ }
  }
  const stat = fs.statSync(data);
  return {
    buf: fs.readFileSync(data),
    fetchedAt: info.fetched_at || stat.mtime.toISOString(),
    contentType: info.content_type || '',
  };
}

function writeCache(url, buf, contentType) {
  ensureDir(opts.cacheDir);
  const { data, meta } = cachePaths(url);
  fs.writeFileSync(data, buf);
  fs.writeFileSync(meta, JSON.stringify({
    url,
    fetched_at: new Date().toISOString(),
    content_type: contentType || '',
    bytes: buf.length,
    sha256: sha256(buf),
  }, null, 1));
}

// Counters reported in the run metadata so callers can tell whether the data
// came from the network, a fresh cache, or a stale cache after a failed fetch.
const fetchStats = { network: 0, fresh_cache: 0, offline_cache: 0, stale_fallback: 0, stale_fallback_oldest: null };

// Once a fetch has exhausted its retries, later URLs skip the network when a
// cached copy exists, so an offline machine does not wait on every request.
let networkFailed = false;

async function fetchBuffer(url) {
  const cached = readCache(url);
  const ageMs = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  const fresh = cached && ageMs <= opts.maxAgeMinutes * 60_000;

  if (opts.offline) {
    if (!cached) throw new Error(`Offline mode: no cache for ${url}`);
    fetchStats.offline_cache += 1;
    return { ...cached, fromCache: true };
  }
  if (!opts.refresh && fresh) {
    fetchStats.fresh_cache += 1;
    return { ...cached, fromCache: true };
  }

  let lastErr;
  for (let attempt = 1; attempt <= (networkFailed && cached ? 0 : 3); attempt++) {
    try {
      const res = await fetch(AA_FETCH_BASE + url.slice(AA_BASE.length), {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/json,text/plain,*/*',
        },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty response');
      writeCache(url, buf, res.headers.get('content-type') || '');
      fetchStats.network += 1;
      return { buf, fetchedAt: new Date().toISOString(), contentType: res.headers.get('content-type') || '', fromCache: false };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  if (lastErr) networkFailed = true;
  if (cached) {
    log(`WARN: fetch failed for ${url}; using cached copy from ${cached.fetchedAt}`);
    fetchStats.stale_fallback += 1;
    if (!fetchStats.stale_fallback_oldest || cached.fetchedAt < fetchStats.stale_fallback_oldest) {
      fetchStats.stale_fallback_oldest = cached.fetchedAt;
    }
    return { ...cached, fromCache: true };
  }
  throw new Error(`Fetch failed for ${url}: ${lastErr?.message || lastErr}`);
}

async function fetchText(url) {
  const { buf, ...rest } = await fetchBuffer(url);
  return { text: buf.toString('utf8'), ...rest };
}

// ---------------------------------------------------------------------------
// RSC manifest extraction and AES-256-GCM/gzip decryption
// ---------------------------------------------------------------------------

function extractManifests(html) {
  const unescaped = html
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&');

  const found = [];
  const seen = new Set();
  const strict = /"path"\s*:\s*"(\/data\/[a-f0-9]{8,64}\.txt)"\s*,\s*"key"\s*:\s*"([a-f0-9]{64})"/g;
  let m;
  while ((m = strict.exec(unescaped))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    found.push({ path: m[1], key: m[2] });
  }
  if (found.length) return found;

  // Fallback for reordered keys / slightly different payloads.
  const paths = [...unescaped.matchAll(/\/data\/[a-f0-9]{8,64}\.txt/g)].map((x) => x[0]);
  const keys = [...unescaped.matchAll(/"key"\s*:\s*"([a-f0-9]{64})"/g)].map((x) => x[1]);
  const n = Math.min(paths.length, keys.length);
  for (let i = 0; i < n; i++) {
    if (!seen.has(paths[i])) {
      seen.add(paths[i]);
      found.push({ path: paths[i], key: keys[i] });
    }
  }
  return found;
}

function decryptManifest(buf, keyHex) {
  // Tolerate a future unencrypted JSON endpoint.
  const asText = buf.subarray(0, 1).toString('utf8');
  if (asText === '{' || asText === '[') {
    try { return JSON.parse(buf.toString('utf8')); } catch { /* continue */ }
  }

  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Invalid manifest key length');
  const iv = crypto.createHash('sha256').update(key).digest().subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  let jsonBytes = plaintext;
  try { jsonBytes = zlib.gunzipSync(plaintext); } catch { /* maybe already raw JSON */ }
  return JSON.parse(jsonBytes.toString('utf8'));
}

function classifyDataset(json) {
  if (Array.isArray(json)) {
    const first = json[0];
    if (!first) return 'empty_array';
    if (first.host && first.model) return 'provider_rows';
    if (first.host && (first.modelSlug || first.modelId)) return 'model_long';
    // The compact leaderboard rows are keyed by id; older payloads also carried a slug.
    if ((first.slug || first.id) && (first.scores || first.paramClass)) return 'compact_models';
    return 'unknown_array';
  }
  if (json && Array.isArray(json.models)) {
    const first = json.models[0];
    if (!first) return 'empty_models';
    if (json.priceFallbackByModelId || ('math500' in first && 'mmluPro' in first)) return 'eval_models';
    if (first.capabilities && Object.values(first.capabilities).some(
      (v) => isPlainObject(v) && ('headlineValue' in v || 'subScores' in v),
    )) return 'capability_details';
    if ('hostModelCount' in first || ('capabilities' in first && 'shortName' in first && 'release' in first)) return 'full_models';
    if ('releaseSlug' in first) return 'model_index';
    return 'unknown_models';
  }
  return 'unknown';
}

function datasetSize(type, json) {
  if (Array.isArray(json)) return json.length;
  if (json?.models) return json.models.length;
  return 0;
}

async function loadDatasetPage(pagePath, { allowNoManifest = false } = {}) {
  const url = `${AA_BASE}${pagePath}`;
  log(`Fetching ${url}`);
  const { text: html, fetchedAt } = await fetchText(url);
  const manifests = extractManifests(html);
  if (manifests.length === 0) {
    if (allowNoManifest) {
      log('  no encrypted /data manifest (page used for metadata only)');
      return { url, fetchedAt, html, datasets: [] };
    }
    throw new Error(`No encrypted /data manifest found on ${url}. The AA page format may have changed.`);
  }

  const datasets = [];
  for (const manifest of manifests) {
    const dataUrl = `${AA_BASE}${manifest.path}`;
    log(`  manifest ${manifest.path}`);
    const { buf } = await fetchBuffer(dataUrl);
    let json;
    try {
      json = decryptManifest(buf, manifest.key);
    } catch (err) {
      throw new Error(`Failed to decrypt ${manifest.path}: ${err.message}`);
    }
    const type = classifyDataset(json);
    datasets.push({
      page: pagePath,
      page_url: url,
      fetched_at: fetchedAt,
      path: manifest.path,
      key: manifest.key,
      bytes: buf.length,
      sha256: sha256(buf),
      type,
      count: datasetSize(type, json),
      json,
    });
    log(`    -> ${type} (${datasetSize(type, json)})`);
  }
  return { url, fetchedAt, html, datasets };
}

// ---------------------------------------------------------------------------
// Tokenization and feature extraction for model matching
// ---------------------------------------------------------------------------

// Cloud/host/provider suffixes that are safe to drop anywhere.
const PROVIDER_TOKENS = new Set([
  'aws', 'gcp', 'azure', 'anthropic', 'openai', 'openrouter', 'gmi', 'dbs',
  'vertex', 'bedrock', 'google', 'amazon', 'microsoft', 'us', 'global', 'maas',
]);

// Extra provider words learned from the catalog itself (provider_name,
// upstream_provider, prefix-stripped provider_id). They are dropped from the
// gateway side of a comparison only, so AA model names are never altered.
let gatewayExtraTokens = new Set();
let upstreamExtraPrefixes = new Set();

function registerCatalogProviders(rows) {
  const tokens = new Set();
  const prefixes = new Set();
  for (const row of rows) {
    for (const value of [row.provider_name, row.upstream_provider, stripProviderPrefix(row.provider_id)]) {
      if (!value) continue;
      for (const t of rawTokens(value)) {
        if (t.length >= 3 && !/^\d+$/.test(t)) tokens.add(t);
      }
    }
    const up = normalizeProviderKey(row.upstream_provider);
    if (up) prefixes.add(up);
  }
  gatewayExtraTokens = tokens;
  upstreamExtraPrefixes = prefixes;
}

// Vendor prefixes that are safe to drop only at the beginning.
const VENDOR_PREFIXES = new Set([
  'nvidia', 'amazon', 'google', 'meta', 'openai', 'anthropic', 'microsoft',
  'xai', 'moonshot', 'moonshotai', 'zai', 'alibaba', 'cohere', 'mistralai',
  'stepfun', 'inclusionai', 'system',
]);

// Optional words: AA often includes one that a gateway omits. They are a
// penalty, never a hard rejection.
const OPTIONAL_TOKENS = new Set([
  'preview', 'instruct', 'it', 'next', 'chat', 'latest', 'instant',
]);

// Reasoning/effort words. They are kept in core_full so model families such as
// "Qwen3.8 Max" are not mistaken for an effort suffix, and are also available
// as core_stripped for effort-qualified gateway names.
const EFFORT_TOKENS = new Set([
  'non', 'reasoning', 'reason', 'thinking', 'think', 'low', 'medium', 'med',
  'high', 'xhigh', 'max', 'minimal', 'min', 'default', 'fallback', 'none',
]);

const TOKEN_SYNONYMS = new Map([
  ['ministral', 'mistral'],
]);

function rawTokens(s) {
  const normalized = String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ');
  const out = [];
  for (const chunk of normalized.split(/\s+/)) {
    if (!chunk) continue;
    const parts = chunk.match(/[a-z]+|[0-9]+/g) || [];
    out.push(...parts);
  }
  return out;
}

function parseTokens(tokens, extraDrop = null) {
  const core = [];
  const params = new Set();
  const dates = new Set();
  const optional = new Set();

  for (let i = 0; i < tokens.length;) {
    const t = tokens[i];

    // 8x7b / 8x22b
    if (/^\d+$/.test(t) && tokens[i + 1] === 'x' && /^\d+$/.test(tokens[i + 2] || '')
        && ['b', 'm', 'k', 't'].includes(tokens[i + 3])) {
      params.add(`${t}x${tokens[i + 2]}${tokens[i + 3]}`);
      i += 4;
      continue;
    }
    // 120b / 31b / 1t
    if (/^\d+$/.test(t) && ['b', 'm', 'k', 't'].includes(tokens[i + 1])) {
      params.add(`${t}${tokens[i + 1]}`);
      i += 2;
      continue;
    }
    // a22b / a3b / e4b / h1b
    if (['a', 'e', 'h', 'x'].includes(t) && /^\d+$/.test(tokens[i + 1] || '')
        && ['b', 'm', 'k', 't'].includes(tokens[i + 2])) {
      params.add(`${t}${tokens[i + 1]}${tokens[i + 2]}`);
      i += 3;
      continue;
    }
    // v1 / v2 version noise
    if (t === 'v' && /^\d+$/.test(tokens[i + 1] || '')) {
      i += 2;
      continue;
    }
    // 8-digit dates and 4-digit date-ish tokens (0731, 0813, 2507, 2025)
    if (/^\d+$/.test(t) && (t.length === 8 || t.length === 4)) {
      dates.add(t);
      i += 1;
      continue;
    }
    if (PROVIDER_TOKENS.has(t) || (extraDrop && extraDrop.has(t))) { i += 1; continue; }
    if (OPTIONAL_TOKENS.has(t)) { optional.add(t); i += 1; continue; }
    core.push(TOKEN_SYNONYMS.get(t) || t);
    i += 1;
  }

  while (core.length > 1 && VENDOR_PREFIXES.has(core[0])) core.shift();
  return { core, params, dates, optional };
}

function feats(name, extraDrop = null) {
  const { core, params, dates, optional } = parseTokens(rawTokens(name), extraDrop);
  const stripped = core.filter((t) => !EFFORT_TOKENS.has(t));
  return {
    core_full: core,
    core_stripped: stripped.length ? stripped : core.slice(),
    params,
    dates,
    optional,
  };
}

function multisetEqual(a, b) {
  if (a.length !== b.length) return false;
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) || 0) + 1);
  for (const x of b) {
    const n = counts.get(x);
    if (!n) return false;
    if (n === 1) counts.delete(x); else counts.set(x, n - 1);
  }
  return counts.size === 0;
}

function multisetDifference(a, b) {
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) || 0) + 1);
  for (const x of b) {
    const n = counts.get(x);
    if (!n) continue;
    if (n === 1) counts.delete(x); else counts.set(x, n - 1);
  }
  const out = [];
  for (const [x, n] of counts) for (let i = 0; i < n; i++) out.push(x);
  return out;
}

function intersectionSize(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function coreScore(q, a, qCore, aCore) {
  if (!multisetEqual(qCore, aCore)) return null;
  let s = 100;
  if (qCore.length === aCore.length && qCore.every((x, i) => x === aCore[i])) s += 6;

  if (q.params.size && a.params.size) {
    const inter = intersectionSize(q.params, a.params);
    if (!inter) return null;
    if (q.params.size === a.params.size && inter === q.params.size) s += 9;
    else s += (7 * inter) / Math.max(q.params.size, a.params.size);
  } else if (q.params.size && !a.params.size) {
    s -= 4;
  } else if (!q.params.size && a.params.size) {
    s -= 3;
  }

  if (q.dates.size && a.dates.size) {
    if (!intersectionSize(q.dates, a.dates)) return null;
    s += 8;
  } else if (q.dates.size && !a.dates.size) {
    s -= 2;
  } else if (!q.dates.size && a.dates.size) {
    s -= 2.5;
  }

  s -= 4.0 * [...a.optional].filter((x) => !q.optional.has(x)).length;
  s -= 0.6 * [...q.optional].filter((x) => !a.optional.has(x)).length;
  return s;
}

/**
 * Score a query against a candidate. Prefer an exact core match (including
 * effort words). If that fails, try the query with effort words stripped,
 * which is how "claude-sonnet-5-5-max" finds the "claude-sonnet-5-5" release.
 */
function scoreCandidate(q, a) {
  let best = null;
  const full = coreScore(q, a, q.core_full, a.core_full);
  if (full !== null) best = { score: full, mode: 'full', extraEffort: [] };

  const stripped = coreScore(q, a, q.core_stripped, a.core_full);
  if (stripped !== null) {
    const extraEffort = multisetDifference(q.core_full, a.core_full)
      .filter((t) => EFFORT_TOKENS.has(t));
    const candidate = { score: stripped - 6, mode: 'stripped', extraEffort };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Release records
// ---------------------------------------------------------------------------

function buildReleases(models) {
  const bySlug = new Map();
  for (const m of models) {
    const slug = m.release?.slug || m.slug;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(m);
  }

  const releases = [];
  for (const [slug, variants] of bySlug) {
    const release = variants[0].release || { slug, name: variants[0].name };
    const dates = variants.map((v) => v.releaseDate).filter(Boolean).sort();
    releases.push({
      slug,
      name: release.name || slug,
      // AA sometimes lists an empty placeholder (no index, eval or capability
      // score on any variant) under the same display name as the real release.
      measured: variants.some((v) => hasAnyEvalScore(v) || hasCapabilities(v)),
      deprecated: variants.every((v) => v.deprecated === true),
      deprecatedTo: release.deprecatedTo || null,
      releaseDate: dates.length ? dates[dates.length - 1] : null,
      creator: variants[0].creator || null,
      variants,
      feat_slug: feats(slug),
      feat_name: feats(release.name || slug),
    });
  }
  return releases;
}

function matchRelease(query, releases, strictParams = true) {
  const q = feats(query, gatewayExtraTokens);
  const candidates = [];

  for (const r of releases) {
    if (strictParams && q.params.size
        && !(intersectionSize(q.params, r.feat_slug.params) || intersectionSize(q.params, r.feat_name.params))) {
      continue;
    }

    let best = null;
    for (const [f, which] of [[r.feat_slug, 'slug'], [r.feat_name, 'name']]) {
      const got = scoreCandidate(q, f);
      if (got && (!best || got.score > best.score)) best = { ...got, which };
    }
    if (!best) continue;

    let score = best.score;
    if (r.deprecated) score -= 10; else score += 6;
    // A release with data always beats an empty one of the same name, even a
    // deprecated one (the 16-point deprecation swing would otherwise decide).
    if (!r.measured) score -= 20;
    candidates.push({ score, release: r, which: best.which, mode: best.mode, extraEffort: best.extraEffort });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.release.deprecated !== b.release.deprecated) return a.release.deprecated ? 1 : -1;
    if (a.release.releaseDate !== b.release.releaseDate) {
      return String(b.release.releaseDate || '').localeCompare(String(a.release.releaseDate || ''));
    }
    return a.release.slug.localeCompare(b.release.slug);
  });

  const topMode = candidates[0]?.mode;
  const alternatives = candidates.slice(1).filter((c) => (
    c.score >= candidates[0].score - 7
    && c.release.slug !== candidates[0].release.slug
    && c.mode === topMode
  ));
  return { candidates, alternatives };
}

function normalizeEffort(extraTokens) {
  const s = new Set(extraTokens.filter((t) => !['none', 'default', 'fallback'].includes(t)));
  if (s.has('non') || s.has('reasoning') || s.has('reason')) {
    return s.has('non') ? 'non-reasoning' : 'reasoning';
  }
  for (const key of ['minimal', 'low', 'medium', 'med', 'high', 'xhigh', 'max']) {
    if (!s.has(key)) continue;
    if (key === 'med') return 'medium';
    return key;
  }
  return null;
}

function effortListFromSuffix(suffix) {
  const s = String(suffix || '').toLowerCase();
  const out = [];
  if (s.includes('non-reasoning')) out.push('non-reasoning');
  else if (s.includes('reasoning')) out.push('reasoning');
  // Use token boundaries so "xhigh" does not also register as "high".
  for (const key of ['minimal', 'low', 'medium', 'xhigh', 'high', 'max']) {
    const re = new RegExp(`(^|[^a-z])${key}([^a-z]|$)`);
    if (re.test(s)) out.push(key);
  }
  if (!out.length && (s.includes('default') || s.includes('fallback'))) out.push('default');
  return [...new Set(out)];
}

const EFFORT_RANK = new Map([
  ['non-reasoning', 0], ['minimal', 1], ['low', 2], ['medium', 3], ['high', 4],
  ['xhigh', 5], ['max', 6], ['reasoning', 7], ['default', 8],
]);

function variantEffortRank(v) {
  const efforts = v.efforts || [];
  if (!efforts.length) return 9;
  return Math.min(...efforts.map((e) => EFFORT_RANK.get(e) ?? 9));
}

function variantScore(query, variant, hint) {
  const q = feats(query, gatewayExtraTokens);
  let best = null;
  for (const name of [variant.slug, variant.name]) {
    const got = scoreCandidate(q, feats(name));
    if (got && (!best || got.score > best)) best = got.score;
  }
  if (best === null) return null;

  let s = best;
  const suffix = String(variant.suffix || '').toLowerCase();
  if (hint) {
    const efforts = variant.efforts || [];
    if (hint === 'non-reasoning' && (efforts.includes('non-reasoning') || variant.isReasoning === false)) s += 12;
    else if (hint === 'reasoning' && (efforts.includes('reasoning') || variant.isReasoning === true)) s += 12;
    else if (efforts.includes(hint) || suffix.includes(hint)) s += 12;
    else s -= 8;
  }
  if (variant.chartDefaultSelected) s += 6;
  if (suffix.includes('default')) s += 1;
  if (!suffix || suffix === 'none') s += 1;
  return s;
}

function pickPrimaryVariant(query, release, hint) {
  const scored = [];
  for (const v of release.variants) {
    const s = variantScore(query, v, hint);
    if (s !== null) scored.push({ score: s, variant: v });
  }

  if (!scored.length) {
    const fallback = [...release.variants].sort((a, b) => {
      if (Boolean(a.chartDefaultSelected) !== Boolean(b.chartDefaultSelected)) return a.chartDefaultSelected ? -1 : 1;
      if (Boolean(a.deprecated) !== Boolean(b.deprecated)) return a.deprecated ? 1 : -1;
      return a.slug.localeCompare(b.slug);
    })[0];
    return { variant: fallback, score: 0, reason: 'no_variant_name_match' };
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Boolean(a.variant.deprecated) !== Boolean(b.variant.deprecated)) return a.variant.deprecated ? 1 : -1;
    return a.variant.slug.localeCompare(b.variant.slug);
  });

  const best = scored[0];
  let reason = 'best_name_match';
  const slugCore = feats(best.variant.slug).core_stripped.join(' ');
  const queryCore = feats(query, gatewayExtraTokens).core_stripped.join(' ');
  if (slugCore === queryCore) reason = 'exact_variant_name';
  if (hint && (best.variant.efforts || []).includes(hint)) reason = 'effort_hint';
  else if (best.variant.chartDefaultSelected) reason = 'chart_default';
  return { variant: best.variant, score: best.score, reason };
}

// ---------------------------------------------------------------------------
// Candidate cleanup
// ---------------------------------------------------------------------------

function upstreamTail(value) {
  if (!value) return '';
  let s = String(value).trim();
  s = s.replace(/^arn:aws:[^/]+:[^/]+:[^/]+:/, '');
  const prefixes = [
    'openrouter', 'bedrock', 'azure', 'vertex_ai', 'databricks', 'anthropic',
    'openai', 'google', '3rd_party', 'deepseek', 'qwen', 'meta',
    'mistralai', 'mistral', 'moonshotai', 'z-ai', 'zai', 'minimax', 'nvidia',
    'stepfun', 'inclusionai', 'system\\.ai',
    ...[...upstreamExtraPrefixes].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  ];
  const re = new RegExp(`^(${prefixes.join('|')})[/.]`, 'i');
  for (let i = 0; i < 5; i++) {
    const next = s.replace(re, '');
    if (next === s) break;
    s = next;
  }
  s = s.split('/').pop() || s;
  s = s.replace(/[-.]v\d+.*$/, '');
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/-v\d+:\d+$/, '');
  return s;
}

function cleanName(value) {
  if (!value) return '';
  let s = String(value).trim();
  const prefixes = [
    'openrouter/', 'azure/', 'bedrock/', 'vertex_ai/', 'databricks/',
    'anthropic/', 'openai/', 'google/', 'system.ai.',
  ];
  for (const prefix of prefixes) {
    if (s.toLowerCase().startsWith(prefix)) s = s.slice(prefix.length);
  }
  s = s.replace(/^arn:aws:[^/]+:[^/]+:[^/]+:/, '');
  return s.split('/').pop().replace(/\//g, '-');
}

function rowCandidates(row) {
  const out = [];
  const seen = new Set();
  const add = (source, value, priority) => {
    if (!value) return;
    const cleaned = source === 'upstream_model' ? upstreamTail(value) : cleanName(value);
    if (!cleaned) return;
    const key = `${source}\u0000${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, value: cleaned, priority });
  };
  add('model_id', row.model_id, 0);
  add('model_name', row.model_name, 0);
  add('upstream_model', row.upstream_model, 10);
  for (const alias of row.aliases || []) add('alias', alias, 20);
  out.sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source));
  return out;
}

function matchRow(row, releases) {
  const tiers = [];
  for (const cand of rowCandidates(row)) {
    let result = matchRelease(cand.value, releases, true);
    if (!result.candidates.length) result = matchRelease(cand.value, releases, false);
    if (result.candidates.length) {
      tiers.push({ ...cand, ...result });
    }
  }
  if (!tiers.length) return null;

  tiers.sort((a, b) => (
    a.priority - b.priority
    || b.candidates[0].score - a.candidates[0].score
    || a.source.localeCompare(b.source)
  ));

  let chosen = tiers[0];

  // A generic model_name such as "qwen3-235b" can match several dated
  // releases. If the upstream identifier resolves one of the alternatives,
  // use it to disambiguate.
  if (chosen.priority < 10 && chosen.alternatives.length) {
    const upstream = tiers.find((t) => t.source === 'upstream_model');
    if (upstream) {
      const upstreamSlug = upstream.candidates[0].release.slug;
      const relevant = new Set([
        chosen.candidates[0].release.slug,
        ...chosen.alternatives.map((a) => a.release.slug),
      ]);
      if (relevant.has(upstreamSlug) && upstream.candidates[0].score >= chosen.candidates[0].score - 15) {
        chosen = upstream;
      }
    }
  }

  const top = chosen.candidates[0];
  return {
    source: chosen.source,
    query: chosen.value,
    score: top.score,
    release: top.release,
    which: top.which,
    mode: top.mode,
    extraEffort: top.extraEffort,
    effortHint: normalizeEffort(top.extraEffort),
    alternatives: chosen.alternatives,
  };
}

function closestMatches(query, releases, limit = 3) {
  if (!query) return [];
  const result = matchRelease(query, releases, false);
  return result.candidates.slice(0, limit).map((c) => ({
    release_slug: c.release.slug,
    release_name: c.release.name,
    score: Number(c.score.toFixed(2)),
    deprecated: c.release.deprecated,
  }));
}

// ---------------------------------------------------------------------------
// Data merge
// ---------------------------------------------------------------------------

const EXCLUDED_SCALAR_FIELDS = new Set([
  'id', 'slug', 'name', 'shortName', 'suffix', 'release', 'creator', 'capabilities',
  'capability_details', 'hosts', 'openness', 'timescaleData', 'performanceByPromptType',
  'endToEndResponseTime', 'timeToFirstAnswerToken', 'outputSpeedVariance',
  'timeToFirstChunkVariance', 'intelligenceIndexEvaluations', 'scores',
  'canonicalEvalTokenCounts', 'automationBenchBreakdown', 'briefcaseBreakdown',
  'gdpvalBreakdown', 'gdpPdfBreakdown', 'omniscienceBreakdown', 'opennessBreakdown',
  'personalityBenchBreakdown', 'personalityBenchMeans', 'hleDiamondScoreByPartition',
  'globalMmluLiteScoreByLanguage', 'terminalBenchSciencePassRateByDomain',
  'enterpriseOpsGymSuccessRateByDomain', 'harveyLabBreakdown', 'code2videoBreakdown',
  'aa3dBreakdown', 'healthbenchBreakdown', 'healthbenchProfessionalBreakdown',
  'efforts',
]);

function mergeVariant(full, evalModel, compact, capDetail) {
  const out = clone(full);
  fillMissing(out, evalModel);
  fillMissing(out, compact);
  fillMissing(out, capDetail);

  // Preserve the compact leaderboard's score map (kebab-case benchmark slugs).
  if (compact?.scores) out.scores = { ...compact.scores, ...(out.scores || {}) };

  // Derive aggregate capabilities from the detailed capability record if the
  // full record did not provide them.
  if (capDetail?.capabilities) {
    out.capability_details = clone(capDetail.capabilities);
    if (!out.capabilities || !Object.keys(out.capabilities).length) {
      const aggregate = {};
      for (const [k, v] of Object.entries(capDetail.capabilities)) {
        if (isPlainObject(v) && typeof v.headlineValue === 'number') aggregate[k] = v.headlineValue;
      }
      if (Object.keys(aggregate).length) out.capabilities = aggregate;
    }
  }

  out.efforts = effortListFromSuffix(out.suffix);
  out.effort = out.efforts[0] || null;
  return out;
}

function mergeDatasets(fullModels, evalModels, compactModels, capDetails) {
  const evalBySlug = new Map(evalModels.map((m) => [m.slug, m]));
  // Compact rows join on slug (older payloads) or on id (current payloads).
  const compactByKey = new Map();
  for (const m of compactModels) {
    if (m.slug) compactByKey.set(m.slug, m);
    if (m.id) compactByKey.set(m.id, m);
  }
  const compactFor = (m) => compactByKey.get(m.slug) || compactByKey.get(m.id);
  const capBySlug = new Map(capDetails.map((m) => [m.slug, m]));

  const merged = fullModels.map((m) => mergeVariant(
    m,
    evalBySlug.get(m.slug),
    compactFor(m),
    capBySlug.get(m.slug),
  ));

  // If the full dataset unexpectedly lacks a model that exists in the eval
  // dataset, keep it so scores are not silently dropped.
  const seen = new Set(merged.map((m) => m.slug));
  for (const e of evalModels) {
    if (seen.has(e.slug)) continue;
    merged.push(mergeVariant(e, e, compactFor(e), capBySlug.get(e.slug)));
    seen.add(e.slug);
  }
  return merged;
}

const HOST_NAME_TO_SLUG = new Map([
  ['anthropic', 'anthropic'],
  ['openai', 'openai'],
  ['google', 'google'],
  ['amazon bedrock', 'amazon_bedrock'],
  ['microsoft azure', 'azure'],
  ['databricks', 'databricks'],
  ['gmi', 'gmi'],
  ['spacexai', 'xai'],
  ['xai', 'xai'],
  ['alibaba cloud', 'alibaba_cloud'],
  ['deepseek', 'deepseek'],
  ['kimi', 'kimi'],
  ['meta', 'meta'],
  ['minimax', 'minimax'],
  ['mistral', 'mistral'],
  ['zai', 'zai'],
  ['z.ai', 'zai'],
  ['stepfun', 'stepfun'],
  ['inclusionai', 'inclusionai'],
  ['xiaomi', 'xiaomi'],
]);

function hostSlug(name) {
  const key = String(name || '').toLowerCase();
  return HOST_NAME_TO_SLUG.get(key) || key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function attachHosts(mergedModels, providerRows, modelLongRows) {
  const providersByKey = new Map();
  for (const row of providerRows) {
    const key = `${row.model?.slug}\u0000${row.host?.slug}`;
    if (!providersByKey.has(key)) providersByKey.set(key, []);
    providersByKey.get(key).push(row);
  }

  const longBySlug = new Map();
  for (const row of modelLongRows) {
    if (!longBySlug.has(row.modelSlug)) longBySlug.set(row.modelSlug, []);
    longBySlug.get(row.modelSlug).push(row);
  }

  for (const model of mergedModels) {
    const hosts = [];
    const seen = new Set();

    for (const row of longBySlug.get(model.slug) || []) {
      const slug = hostSlug(row.host?.name);
      const key = `${slug}\u0000${row.host?.name}\u0000long`;
      if (seen.has(key)) continue;
      seen.add(key);
      hosts.push({
        host: row.host?.name || slug,
        host_slug: slug,
        label: row.name || row.shortName || null,
        source: 'model_long',
        host_api_id: null,
        footnotes: null,
        context_window_tokens: row.contextWindowTokens ?? null,
        features: null,
        pricing: {
          price1mInputTokens: row.price1mInputTokens ?? null,
          price1mOutputTokens: row.price1mOutputTokens ?? null,
          cacheHitPrice: row.cacheHitPrice ?? null,
          cacheWritePrice: row.cacheWritePrice ?? null,
          pricePer1k1mpImages: row.pricePer1k1mpImages ?? null,
          price1mBlended0To3To1: row.price1mBlended0To3To1 ?? null,
          price1mBlended7To2To1: row.price1mBlended7To2To1 ?? null,
          price1mBlended0To1To1: row.price1mBlended0To1To1 ?? null,
          price1mBlended100To1To1: row.price1mBlended100To1To1 ?? null,
          price1mBlended0To100To1: row.price1mBlended0To100To1 ?? null,
          costPerTask: row.intelligenceIndexCostPerTask?.cost?.total ?? null,
        },
        performance: {
          medianOutputTokensPerSecond: row.timescaleData?.medianOutputSpeed ?? null,
          medianTimeToFirstTokenSeconds: row.timescaleData?.medianTimeToFirstChunk ?? null,
          medianEndToEndResponseTimeSeconds: row.endToEndResponseTime?.total ?? null,
          medianTimeToFirstAnswerTokenSeconds: row.timeToFirstAnswerToken?.total ?? null,
        },
        model_scores: null,
        intelligence_index_cost: row.intelligenceIndexCost || null,
      });
    }

    for (const [key, rows] of providersByKey) {
      const [modelSlug, slug] = key.split('\u0000');
      if (modelSlug !== model.slug) continue;
      for (const row of rows) {
        const dedup = `${row.host?.slug}\u0000${row.label}\u0000${row.hostApiId}`;
        const existing = hosts.find((h) => h.host_slug === row.host?.slug
          && h.label === row.label && h.host_api_id === row.hostApiId);
        if (existing) {
          existing.source = 'model_long+provider';
          existing.features = row.features || existing.features;
          existing.model_scores = row.model?.scores || existing.model_scores;
          existing.pricing = { ...row.pricing, ...existing.pricing };
          existing.performance = { ...row.performance, ...existing.performance };
          existing.footnotes = row.footnotes || existing.footnotes;
          continue;
        }
        if (hosts.some((h) => `${h.host_slug}\u0000${h.label}\u0000${h.host_api_id}` === dedup)) continue;
        hosts.push({
          host: row.host?.name || slug,
          host_slug: row.host?.slug || slug,
          label: row.label || null,
          source: 'provider_manifest',
          host_api_id: row.hostApiId || null,
          footnotes: row.footnotes || null,
          context_window_tokens: row.features?.contextWindowTokens ?? null,
          features: row.features || null,
          pricing: row.pricing || null,
          performance: row.performance || null,
          model_scores: row.model?.scores || null,
          intelligence_index_cost: null,
        });
      }
    }

    hosts.sort((a, b) => a.host_slug.localeCompare(b.host_slug) || String(a.label || '').localeCompare(String(b.label || '')));
    model.hosts = hosts;
  }
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

// Upstream provider names (as found in a catalog row's upstream_provider,
// provider_name, or the first segment of upstream_model) -> AA host slug.
// Keys are normalized with normalizeProviderKey().
const UPSTREAM_TO_AA_HOST = new Map([
  ['anthropic', 'anthropic'],
  ['openai', 'openai'],
  ['azure', 'azure'], ['azure_ai', 'azure'], ['azure_openai', 'azure'],
  ['azure_foundry', 'azure'], ['microsoft_azure', 'azure'],
  ['bedrock', 'amazon_bedrock'], ['aws_bedrock', 'amazon_bedrock'],
  ['amazon_bedrock', 'amazon_bedrock'], ['bedrock_converse', 'amazon_bedrock'],
  ['vertex', 'google'], ['vertex_ai', 'google'], ['google_vertex_ai', 'google'],
  ['google', 'google'], ['gemini', 'google'],
  ['databricks', 'databricks'],
  ['gmi', 'gmi'],
  ['xai', 'xai'],
  ['mistral', 'mistral'],
  ['deepseek', 'deepseek'],
]);

// Routers/aggregators: they front many hosts and are not AA hosts themselves.
const AGGREGATOR_UPSTREAMS = new Set([
  'openrouter', '3rd_party', 'third_party', 'router', 'proxy', 'litellm',
]);

function normalizeProviderKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stripProviderPrefix(providerId) {
  const id = String(providerId ?? '');
  if (!GATEWAY_PROVIDER_PREFIX) return id;
  const re = new RegExp(`^${GATEWAY_PROVIDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-_]`, 'i');
  return id.replace(re, '');
}

/**
 * Decide which AA host a catalog row is served from, using only row fields.
 *
 * provider_name is the display name of the serving provider ("AWS Bedrock"),
 * so it decides first. upstream_provider is the API flavour and can name the
 * model vendor rather than the host (an OpenAI model served by Bedrock still
 * has upstream_provider "openai"), so it is used only when provider_name is
 * absent, followed by the provider part of upstream_model and finally
 * provider_id without GATEWAY_PROVIDER_PREFIX. A provider_name that is present
 * but unknown yields "unknown" rather than a guess.
 *
 * Returns { kind: 'host', slug } | { kind: 'aggregator', key } | { kind: 'unknown', key }.
 */
function resolveAaHost(row) {
  const lookup = (key) => {
    if (UPSTREAM_TO_AA_HOST.has(key)) return { kind: 'host', slug: UPSTREAM_TO_AA_HOST.get(key), key };
    if (AGGREGATOR_UPSTREAMS.has(key)) return { kind: 'aggregator', key };
    return null;
  };

  const name = normalizeProviderKey(row.provider_name);
  if (name) {
    const whole = lookup(name);
    if (whole) return whole;
    for (const token of name.split('_')) {
      const hit = token.length >= 3 ? lookup(token) : null;
      if (hit) return hit;
    }
    return { kind: 'unknown', key: name };
  }

  const fallbacks = [
    row.upstream_provider,
    String(row.upstream_model ?? '').split('/')[0],
    stripProviderPrefix(row.provider_id),
  ].map(normalizeProviderKey).filter(Boolean);
  for (const key of fallbacks) {
    const hit = lookup(key);
    if (hit) return hit;
  }
  return { kind: 'unknown', key: fallbacks[0] || '' };
}

function summarizeVariant(v) {
  return {
    slug: v.slug,
    name: v.name,
    suffix: v.suffix ?? null,
    effort: v.effort ?? null,
    efforts: v.efforts || [],
    is_reasoning: v.isReasoning ?? null,
    deprecated: v.deprecated ?? null,
    chart_default_selected: v.chartDefaultSelected ?? null,
    intelligence_index: v.intelligenceIndex ?? null,
    intelligence_index_is_estimated: v.intelligenceIndexIsEstimated ?? null,
    capabilities: v.capabilities || null,
    pricing: {
      input_per_1m: v.price1mInputTokens ?? null,
      output_per_1m: v.price1mOutputTokens ?? null,
      cache_hit: v.cacheHitPrice ?? null,
      cache_write: v.cacheWritePrice ?? null,
      blended_3_1: v.price1mBlended0To3To1 ?? null,
    },
    host_count: Array.isArray(v.hosts) ? v.hosts.length : 0,
  };
}

function hasAnyEvalScore(v) {
  if (typeof v.intelligenceIndex === 'number' && Number.isFinite(v.intelligenceIndex)) return true;
  if (isPlainObject(v.scores)) {
    for (const value of Object.values(v.scores)) {
      if (typeof value === 'number' && Number.isFinite(value)) return true;
    }
  }
  return false;
}

function hasCapabilities(v) {
  return isPlainObject(v.capabilities) && Object.keys(v.capabilities).length > 0;
}

function unmatchedReason(row) {
  const s = `${row.model_id || ''} ${row.model_name || ''}`.toLowerCase();
  const mode = String(row.mode || '').toLowerCase();
  if (s.includes('image') || mode.includes('image')) return 'AA text-model leaderboard has no image-generation entries; image models are out of scope for this dataset.';
  if (s.includes('audio') || mode.includes('audio')) return 'AA text-model leaderboard has no audio-model entries.';
  if (s.includes('embed') || mode.includes('embed')) return 'Embedding model; not covered by the AA text-model leaderboard.';
  if (/(^|[^a-z])(mock|test)([^a-z]|$)/.test(s)) return 'Mock or test model; not evaluated by Artificial Analysis.';
  if (/(^|[^a-z])(auto|router)([^a-z]|$)/.test(s)) return 'Router/auto model; not a distinct AA-evaluated model.';
  return 'No AA release matched after normalized name, parameter, and date comparison. It may be a vendor-specific model that AA does not cover.';
}

function providerHostInfo(row, variant) {
  const resolved = resolveAaHost(row);
  const expected = resolved.kind === 'host' ? resolved.slug : null;
  if (!expected) {
    return {
      gateway_provider: row.provider_id,
      aa_host: null,
      aa_host_name: null,
      found: false,
      rows: [],
      note: resolved.kind === 'aggregator'
        ? 'Routers and aggregators such as OpenRouter are not AA hosts. Model-level scores are attached; per-host availability is listed in aa.variants[].hosts.'
        : 'No AA host mapping for this provider. Model-level scores are attached.',
    };
  }

  const rows = (variant.hosts || []).filter((h) => h.host_slug === expected);
  const hostName = rows[0]?.host || expected;
  return {
    gateway_provider: row.provider_id,
    aa_host: expected,
    aa_host_name: hostName,
    found: rows.length > 0,
    rows,
    note: rows.length
      ? null
      : `AA has no provider row for host "${expected}" on this variant; model-level scores are still attached.`,
  };
}

function enrichRow(row, match, releases) {
  const out = { ...row };

  if (!match) {
    const closest = closestMatches(row.model_name, releases);
    out.aa = {
      matched: false,
      reason: unmatchedReason(row),
      searched_names: rowCandidates(row).map((c) => ({ source: c.source, value: c.value })),
      closest_matches: closest,
    };
    return out;
  }

  const release = match.release;
  const hint = match.effortHint;
  const primary = pickPrimaryVariant(match.query, release, hint);
  const variants = [...release.variants].sort((a, b) => (
    variantEffortRank(a) - variantEffortRank(b)
    || a.slug.localeCompare(b.slug)
  ));

  const warnings = [];
  if (release.deprecated) warnings.push('deprecated_release');
  if (match.mode === 'stripped') warnings.push('effort_suffix_stripped_for_release_match');
  if (match.alternatives.length) warnings.push(`ambiguous_release:${match.alternatives.map((a) => a.release.slug).join('|')}`);
  if (hint && !(primary.variant.efforts || []).includes(hint)) warnings.push(`effort_unavailable:${hint}`);
  if (primary.variant.intelligenceIndex === null || primary.variant.intelligenceIndex === undefined) warnings.push('primary_variant_has_no_intelligence_index');
  if (!hasAnyEvalScore(primary.variant)) warnings.push('primary_variant_has_no_eval_scores');
  if (!hasCapabilities(primary.variant)) warnings.push('primary_variant_has_no_capability_scores');
  if (match.source === 'alias' || match.source === 'upstream_model') warnings.push(`matched_via_${match.source}`);

  const provider = providerHostInfo(row, primary.variant);
  const hostKind = resolveAaHost(row).kind;
  if (hostKind === 'host' && !provider.found) warnings.push('provider_host_row_missing');
  if (hostKind === 'aggregator') warnings.push('aggregator_not_an_aa_host');

  const effortLevels = [...new Set(variants.flatMap((v) => v.efforts || []))]
    .sort((a, b) => (EFFORT_RANK.get(a) ?? 9) - (EFFORT_RANK.get(b) ?? 9) || a.localeCompare(b));

  const scoredVariants = variants.filter((v) => typeof v.intelligenceIndex === 'number');
  const evalVariants = variants.filter(hasAnyEvalScore);
  const capabilityVariants = variants.filter(hasCapabilities);
  const positiveScored = scoredVariants.length
    ? scoredVariants
    : variants.filter((v) => typeof v.intelligenceIndex === 'number');

  let maxIntelligence = null;
  let maxIntelligenceVariant = null;
  for (const v of positiveScored) {
    if (maxIntelligence === null || v.intelligenceIndex > maxIntelligence) {
      maxIntelligence = v.intelligenceIndex;
      maxIntelligenceVariant = v.slug;
    }
  }

  const hostSlugs = [...new Set(variants.flatMap((v) => (v.hosts || []).map((h) => h.host_slug)))]
    .sort();

  out.aa = {
    matched: true,
    release: {
      slug: release.slug,
      name: release.name,
      deprecated: release.deprecated,
      deprecated_to: release.deprecatedTo,
      release_date: release.releaseDate,
      creator: release.creator,
      variant_count: variants.length,
    },
    match: {
      source: match.source,
      query: match.query,
      score: Number(match.score.toFixed(2)),
      mode: match.mode,
      matched_on: match.which,
      effort_hint: hint,
      alternatives: match.alternatives.map((a) => ({
        release_slug: a.release.slug,
        release_name: a.release.name,
        score: Number(a.score.toFixed(2)),
        deprecated: a.release.deprecated,
      })),
    },
    primary_variant: summarizeVariant(primary.variant),
    primary_variant_slug: primary.variant.slug,
    primary_selection_reason: primary.reason,
    effort_levels: effortLevels,
    provider_match: provider,
    summary: {
      variant_count: variants.length,
      scored_variant_count: scoredVariants.length,
      eval_variant_count: evalVariants.length,
      capability_variant_count: capabilityVariants.length,
      max_intelligence_index: maxIntelligence,
      max_intelligence_variant: maxIntelligenceVariant,
      available_hosts: hostSlugs,
      primary_has_evals: hasAnyEvalScore(primary.variant),
      primary_has_capabilities: hasCapabilities(primary.variant),
    },
    warnings,
    variants,
  };
  return out;
}

// ---------------------------------------------------------------------------
// CSV flattening
// ---------------------------------------------------------------------------

function flattenVariant(v, prefix = 'aa_') {
  const out = {};

  for (const [key, value] of Object.entries(v)) {
    if (EXCLUDED_SCALAR_FIELDS.has(key)) continue;
    if (value === null || value === undefined) {
      out[`${prefix}${snakeCase(key)}`] = '';
    } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      out[`${prefix}${snakeCase(key)}`] = value;
    }
  }

  for (const [key, value] of Object.entries(v.capabilities || {})) {
    out[`${prefix}cap_${snakeCase(key)}`] = value ?? '';
  }
  out[`${prefix}openness_index`] = v.openness?.opennessIndex ?? '';
  out[`${prefix}median_output_speed`] = v.timescaleData?.medianOutputSpeed ?? '';
  out[`${prefix}median_time_to_first_chunk`] = v.timescaleData?.medianTimeToFirstChunk ?? '';
  out[`${prefix}end_to_end_total_seconds`] = v.endToEndResponseTime?.total ?? '';
  out[`${prefix}time_to_first_answer_token_total`] = v.timeToFirstAnswerToken?.total ?? '';
  out[`${prefix}intelligence_index_eval_count`] = Array.isArray(v.intelligenceIndexEvaluations)
    ? v.intelligenceIndexEvaluations.length : '';
  out[`${prefix}scores_json`] = isPlainObject(v.scores) && Object.keys(v.scores).length
    ? JSON.stringify(v.scores) : '';
  out[`${prefix}efforts`] = (v.efforts || []).join('; ');
  out[`${prefix}host_count`] = Array.isArray(v.hosts) ? v.hosts.length : 0;
  return out;
}

function primaryRow(row, aaRow) {
  const base = {
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    model_id: row.model_id,
    model_name: row.model_name,
    upstream_provider: row.upstream_provider ?? '',
    upstream_model: row.upstream_model ?? '',
    aa_data_source: 'Artificial Analysis',
    aa_matched: aaRow.aa.matched ? 'true' : 'false',
  };
  if (!aaRow.aa.matched) {
    return {
      ...base,
      aa_match_reason: aaRow.aa.reason,
      aa_closest_matches: aaRow.aa.closest_matches.map((m) => m.release_slug).join('; '),
    };
  }

  const aa = aaRow.aa;
  const pv = aa.primary_variant;
  const host = aa.provider_match.rows[0] || null;
  // Flatten the full variant record so the primary CSV carries the raw
  // benchmark scores as well as the summarized fields.
  const fullPrimary = aa.variants.find((v) => v.slug === aa.primary_variant_slug) || pv;
  const flat = flattenVariant(fullPrimary);
  return {
    ...base,
    aa_match_source: aa.match.source,
    aa_match_query: aa.match.query,
    aa_match_score: aa.match.score,
    aa_match_mode: aa.match.mode,
    aa_effort_hint: aa.match.effort_hint ?? '',
    aa_release_slug: aa.release.slug,
    aa_release_name: aa.release.name,
    aa_release_deprecated: aa.release.deprecated,
    aa_release_date: aa.release.release_date ?? '',
    aa_variant_slug: pv.slug,
    aa_variant_name: pv.name,
    aa_primary_selection_reason: aa.primary_selection_reason,
    aa_variant_count: aa.summary.variant_count,
    aa_scored_variant_count: aa.summary.scored_variant_count,
    aa_max_intelligence_index: aa.summary.max_intelligence_index ?? '',
    aa_effort_levels: aa.effort_levels.join('; '),
    aa_provider_host: aa.provider_match.aa_host ?? '',
    aa_provider_host_found: aa.provider_match.found,
    aa_provider_host_name: aa.provider_match.aa_host_name ?? '',
    aa_provider_input_per_1m: host?.pricing?.price1mInputTokens ?? '',
    aa_provider_output_per_1m: host?.pricing?.price1mOutputTokens ?? '',
    aa_provider_cache_hit: host?.pricing?.cacheHitPrice ?? '',
    aa_provider_cache_write: host?.pricing?.cacheWritePrice ?? '',
    aa_provider_context: host?.context_window_tokens ?? '',
    aa_provider_labels: aa.provider_match.rows.map((h) => h.label).filter(Boolean).join('; '),
    aa_warnings: aa.warnings.join('; '),
    ...flat,
  };
}

function variantRow(row, aaRow, variant, isPrimary) {
  const base = {
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    model_id: row.model_id,
    model_name: row.model_name,
    upstream_provider: row.upstream_provider ?? '',
    upstream_model: row.upstream_model ?? '',
    aa_data_source: 'Artificial Analysis',
    aa_matched: 'true',
    aa_match_source: aaRow.aa.match.source,
    aa_match_score: aaRow.aa.match.score,
    aa_release_slug: aaRow.aa.release.slug,
    aa_release_name: aaRow.aa.release.name,
    aa_release_deprecated: aaRow.aa.release.deprecated,
    aa_variant_slug: variant.slug,
    aa_variant_name: variant.name,
    aa_is_primary: isPrimary,
    aa_effort_levels: aaRow.aa.effort_levels.join('; '),
    aa_warnings: isPrimary ? aaRow.aa.warnings.join('; ') : '',
  };
  return { ...base, ...flattenVariant(variant) };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function buildReport(enriched, meta) {
  const rows = enriched.rows;
  const matched = rows.filter((r) => r.aa.matched);
  const unmatched = rows.filter((r) => !r.aa.matched);
  const providers = [...new Set(rows.map((r) => r.provider_id))].sort();

  const byProvider = providers.map((p) => {
    const pr = rows.filter((r) => r.provider_id === p);
    const m = pr.filter((r) => r.aa.matched);
    return {
      provider: p,
      total: pr.length,
      matched: m.length,
      primaryIntel: m.filter((r) => typeof r.aa.primary_variant.intelligence_index === 'number').length,
      primaryCaps: m.filter((r) => r.aa.summary.primary_has_capabilities).length,
      deprecatedRelease: m.filter((r) => r.aa.release.deprecated).length,
      providerHost: m.filter((r) => r.aa.provider_match.found).length,
    };
  });

  const warnings = new Map();
  for (const r of matched) {
    for (const w of r.aa.warnings) {
      const key = w.split(':')[0];
      warnings.set(key, (warnings.get(key) || 0) + 1);
    }
  }

  const lines = [];
  lines.push('# Artificial Analysis enrichment report');
  lines.push('');
  lines.push(`Generated: ${meta.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Gateway rows: **${rows.length}**`);
  lines.push(`- Matched to an AA release: **${matched.length}**`);
  lines.push(`- Unmatched: **${unmatched.length}**`);
  lines.push(`- AA variants attached: **${matched.reduce((n, r) => n + r.aa.variants.length, 0)}**`);
  lines.push(`- Primary variant with an Intelligence Index: **${matched.filter((r) => typeof r.aa.primary_variant.intelligence_index === 'number').length}**`);
  lines.push(`- Primary variant with raw benchmark scores: **${matched.filter((r) => r.aa.summary.primary_has_evals).length}**`);
  lines.push(`- Primary variant with capability scores: **${matched.filter((r) => r.aa.summary.primary_has_capabilities).length}**`);
  lines.push(`- Matched release marked deprecated by AA: **${matched.filter((r) => r.aa.release.deprecated).length}**`);
  lines.push('');
  lines.push(`AA index version: ${meta.source.intelligence_index_version || 'unknown'}`);
  lines.push('');
  lines.push('## Coverage by gateway provider');
  lines.push('');
  lines.push('| Provider | Models | Matched | Primary w/ Intelligence | Primary w/ Capabilities | AA release deprecated | Host row found |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const p of byProvider) {
    lines.push(`| ${p.provider} | ${p.total} | ${p.matched} | ${p.primaryIntel} | ${p.primaryCaps} | ${p.deprecatedRelease} | ${p.providerHost} |`);
  }
  lines.push('');
  lines.push('## Unmatched models');
  lines.push('');
  if (!unmatched.length) {
    lines.push('None.');
  } else {
    lines.push('| Provider | Model | Reason | Closest AA releases |');
    lines.push('|---|---|---|---|');
    for (const r of unmatched) {
      const closest = (r.aa.closest_matches || []).map((m) => `${m.release_slug} (${m.score})`).join('; ');
      lines.push(`| ${r.provider_id} | ${r.model_id} | ${r.aa.reason} | ${closest} |`);
    }
  }
  lines.push('');
  lines.push('## Warning counts (matched rows)');
  lines.push('');
  if (!warnings.size) lines.push('None.');
  else {
    lines.push('| Warning | Rows |');
    lines.push('|---|---:|');
    for (const [w, n] of [...warnings.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${w} | ${n} |`);
    }
  }
  lines.push('');
  lines.push('## Ambiguous matches');
  lines.push('');
  const amb = matched.filter((r) => r.aa.match.alternatives.length);
  if (!amb.length) lines.push('None.');
  else {
    lines.push('| Provider | Model | Chosen release | Alternatives |');
    lines.push('|---|---|---|---|');
    for (const r of amb) {
      const alts = r.aa.match.alternatives.map((a) => `${a.release_slug} (${a.score})`).join('; ');
      lines.push(`| ${r.provider_id} | ${r.model_id} | ${r.aa.release.slug} | ${alts} |`);
    }
  }
  lines.push('');
  lines.push('## Effort hints not available in AA');
  lines.push('');
  const effortMissing = matched.filter((r) => r.aa.warnings.some((w) => w.startsWith('effort_unavailable:')));
  if (!effortMissing.length) lines.push('None.');
  else {
    lines.push('| Provider | Model | Requested effort | AA primary variant |');
    lines.push('|---|---|---|---|');
    for (const r of effortMissing) {
      const hint = r.aa.warnings.find((w) => w.startsWith('effort_unavailable:')).split(':')[1];
      lines.push(`| ${r.provider_id} | ${r.model_id} | ${hint} | ${r.aa.primary_variant.slug} (${r.aa.primary_variant.suffix || 'no suffix'}) |`);
    }
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- AA marks many older releases as deprecated and reports `null` for their current Intelligence Index; all retained raw eval scores are still emitted per variant.');
  lines.push('- A primary variant is selected by explicit effort hint, then exact variant name, then AA chart default, then a deterministic fallback. All variants are always listed in `aa.variants`.');
  lines.push('- Image-generation, audio, router/auto, and mock/test gateway entries have no equivalent AA text-model release.');
  lines.push('- Routers and aggregators (for example OpenRouter) are not AA hosts, so such rows receive no provider-specific host pricing; model-level scores are still attached.');
  lines.push('- Data is fetched from public Artificial Analysis pages. Artificial Analysis terms restrict scraping and redistribution; keep this report local.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function assertMatch(enriched, modelId, expectedRelease, opts = {}) {
  const row = enriched.rows.find((r) => r.model_id === modelId);
  assert(row, `Row not found: ${modelId}`);
  assert(row.aa.matched, `Expected match for ${modelId}`);
  assert.equal(row.aa.release.slug, expectedRelease, `${modelId}: wrong release`);
  if (opts.variantSuffix) {
    assert(
      String(row.aa.primary_variant.suffix || '').toLowerCase().includes(opts.variantSuffix.toLowerCase()),
      `${modelId}: expected variant suffix ${opts.variantSuffix}, got ${row.aa.primary_variant.suffix}`,
    );
  }
  if (opts.warning) {
    assert(row.aa.warnings.includes(opts.warning), `${modelId}: missing warning ${opts.warning}`);
  }
  if (opts.noWarning) {
    assert(!row.aa.warnings.includes(opts.noWarning), `${modelId}: unexpected warning ${opts.noWarning}`);
  }
  if (opts.host !== undefined) {
    assert.equal(row.aa.provider_match.aa_host, opts.host, `${modelId}: wrong AA host`);
  }
}

function assertUnmatched(enriched, modelId) {
  const row = enriched.rows.find((r) => r.model_id === modelId);
  assert(row, `Row not found: ${modelId}`);
  assert.equal(row.aa.matched, false, `Expected no match for ${modelId}`);
}

/**
 * Self-test on synthetic data only: no network, no cache, no real catalog.
 * Fixtures live in test/synthetic.mjs (source tree only).
 */
async function selfTest() {
  let synthetic;
  try {
    synthetic = await import('./test/synthetic.mjs');
  } catch (err) {
    throw new Error(`self-test fixtures (test/synthetic.mjs) are only available in the source tree: ${err.message}`);
  }

  // Crypto round-trip.
  const key = crypto.randomBytes(32);
  const iv = crypto.createHash('sha256').update(key).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({ hello: 'aa', n: 42 }));
  const gz = zlib.gzipSync(plaintext);
  const ct = Buffer.concat([cipher.update(gz), cipher.final(), cipher.getAuthTag()]);
  assert.deepEqual(decryptManifest(ct, key.toString('hex')), { hello: 'aa', n: 42 });

  // Manifest extraction from escaped RSC-like HTML.
  const html = 'x\\"manifest\\":{\\"path\\":\\"/data/0123456789abcdef.txt\\",\\"key\\":\\"' + 'a'.repeat(64) + '\\"}';
  const manifests = extractManifests(html);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].path, '/data/0123456789abcdef.txt');

  // Provider -> AA host resolution is derived from row fields, not ids.
  assert.equal(resolveAaHost({ provider_name: 'AWS Bedrock', upstream_provider: 'openai' }).slug, 'amazon_bedrock');
  assert.equal(resolveAaHost({ provider_name: 'Vertex AI' }).slug, 'google');
  assert.equal(resolveAaHost({ provider_name: 'Azure Foundry' }).slug, 'azure');
  assert.equal(resolveAaHost({ provider_name: 'Production Bedrock' }).slug, 'amazon_bedrock');
  assert.equal(resolveAaHost({ provider_name: '3rd Party' }).kind, 'aggregator');
  assert.equal(resolveAaHost({ provider_name: 'Some Gateway', upstream_provider: 'anthropic' }).kind, 'unknown');
  assert.equal(resolveAaHost({ upstream_provider: 'bedrock' }).slug, 'amazon_bedrock');
  assert.equal(resolveAaHost({ upstream_provider: 'vertex_ai' }).slug, 'google');
  assert.equal(resolveAaHost({ upstream_model: 'openrouter/vendor/model' }).kind, 'aggregator');
  assert.equal(resolveAaHost({ provider_id: `${GATEWAY_PROVIDER_PREFIX}-databricks` }).slug, 'databricks');
  assert.equal(resolveAaHost({ provider_id: 'zz-databricks' }).kind, 'unknown');
  assert.equal(resolveAaHost({ upstream_provider: 'mystery_cloud' }).kind, 'unknown');

  // Matching on synthetic AA data and a synthetic catalog.
  const { aaDatasets, catalogRows } = synthetic;
  registerCatalogProviders(catalogRows);
  const merged = mergeDatasets(
    aaDatasets.full.models, aaDatasets.eval.models, aaDatasets.compact, aaDatasets.capabilities.models,
  );
  attachHosts(merged, aaDatasets.providers, aaDatasets.modelLong);
  const releases = buildReleases(merged);
  const rows = catalogRows.map((row) => enrichRow(row, matchRow(row, releases), releases));
  const enriched = { rows };

  assertMatch(enriched, 'kestrel-4.6-pro-aws', 'kestrel-pro-4-6', { host: 'amazon_bedrock', variantSuffix: 'max' });
  assertMatch(enriched, 'nimbus-3-235b', 'nimbus-3-235b-a22b-instruct-2507', { warning: 'matched_via_upstream_model' });
  assertMatch(enriched, 'nimbus-coder-480b', 'nimbus-coder-480b-a35b-instruct');
  assertMatch(enriched, 'zephyr-3.8-max', 'zephyr-3-8-max-0902', { warning: 'aggregator_not_an_aa_host', host: null });
  assertMatch(enriched, 'mistral-3-14b-aws', 'ministral-3-14b');
  assertMatch(enriched, 'kestrel-code-max', 'kestrel-code', { warning: 'effort_unavailable:max' });
  assertMatch(enriched, 'halo-2-reasoning', 'halo-2', { variantSuffix: 'reasoning' });
  assertMatch(enriched, 'halo-2-non-reasoning', 'halo-2', { variantSuffix: 'non-reasoning' });
  assertMatch(enriched, 'lumen-small-latest', 'lumen-small', { host: 'openai' });
  assertMatch(enriched, 'orbit-flash-acme', 'orbit-flash', { host: null, noWarning: 'provider_host_row_missing' });
  assertMatch(enriched, 'tiny-chat', 'tiny-model-9b', { warning: 'matched_via_alias' });
  assertMatch(enriched, 'legacy-chat-1', 'legacy-chat-1', { warning: 'deprecated_release' });
  // Same display name: the measured (deprecated) release wins over an empty placeholder.
  assertMatch(enriched, 'vega-6-demo', 'vega-6', { warning: 'deprecated_release' });
  assertUnmatched(enriched, 'synth-image-gen');
  assertUnmatched(enriched, 'synth-audio-1');
  assert.match(enriched.rows.find((r) => r.model_id === 'synth-image-gen').aa.reason, /image/);

  // The report renders without throwing and carries the attribution note.
  const report = buildReport({ rows }, { generated_at: 'now', source: { intelligence_index_version: '5.0' } });
  assert.match(report, /Artificial Analysis/);

  log('Self-test passed.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (opts.selfTest) {
    await selfTest();
    return;
  }
  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input file not found: ${opts.input}${opts.input.endsWith('models.json') ? ' (run /gateway-refresh to create the gateway catalog)' : ''}`);
  }
  const inputRaw = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
  const inputRows = inputRaw.rows || inputRaw;
  if (!Array.isArray(inputRows)) throw new Error('Input must be an array or an object with a "rows" array');
  log(`Loaded ${inputRows.length} gateway rows from ${opts.input}`);
  registerCatalogProviders(inputRows);

  ensureDir(opts.outDir);

  // 1. Leaderboard models page: compact dataset + candidate model slugs.
  const modelsPage = await loadDatasetPage('/leaderboards/models');
  const compactDataset = modelsPage.datasets
    .filter((d) => d.type === 'compact_models')
    .sort((a, b) => b.count - a.count)[0];

  let candidateSlugs = [];
  if (compactDataset) {
    candidateSlugs = compactDataset.json
      .filter((m) => m.slug || m.release?.slug)
      .sort((a, b) => {
        if (Boolean(a.deprecated) !== Boolean(b.deprecated)) return a.deprecated ? 1 : -1;
        const ai = typeof a.intelligenceIndex === 'number' ? 0 : 1;
        const bi = typeof b.intelligenceIndex === 'number' ? 0 : 1;
        return ai - bi || String(a.slug || a.release.slug).localeCompare(String(b.slug || b.release.slug));
      })
      .map((m) => m.slug || m.release.slug)
      .filter((slug, i, arr) => arr.indexOf(slug) === i);
  }
  if (!candidateSlugs.length) {
    // Last-resort fallback: links on the leaderboard page.
    candidateSlugs = [...modelsPage.html.matchAll(/\/models\/([a-z0-9][a-z0-9-]+)/g)]
      .map((m) => m[1])
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 10);
  }
  if (!candidateSlugs.length) throw new Error('Could not discover a model page slug from the AA leaderboard');

  // 2. Fetch a model page (full model metadata + per-host rows), the eval
  //    dataset, the capability detail dataset, and provider rows.
  let modelPage = null;
  for (const slug of candidateSlugs.slice(0, 6)) {
    try {
      const page = await loadDatasetPage(`/models/${slug}`);
      if (page.datasets.some((d) => d.type === 'full_models')) {
        modelPage = page;
        break;
      }
    } catch (err) {
      log(`WARN: model page ${slug} failed: ${err.message}`);
    }
  }
  if (!modelPage) throw new Error('Could not load a model page containing the full AA dataset');

  const optionalPages = await Promise.allSettled([
    loadDatasetPage('/evaluations/scicode'),
    loadDatasetPage('/indexes/engineering'),
    loadDatasetPage('/leaderboards/providers'),
    loadDatasetPage('/evaluations', { allowNoManifest: true }),
  ]);
  for (const [i, result] of optionalPages.entries()) {
    if (result.status === 'rejected') {
      const names = ['/evaluations/scicode', '/indexes/engineering', '/leaderboards/providers', '/evaluations'];
      log(`WARN: ${names[i]} failed: ${result.reason?.message || result.reason}`);
    }
  }
  const optional = optionalPages.filter((r) => r.status === 'fulfilled').map((r) => r.value);

  const allDatasets = [modelsPage, modelPage, ...optional].flatMap((p) => p.datasets);
  const pick = (type) => allDatasets.filter((d) => d.type === type).sort((a, b) => b.count - a.count)[0] || null;

  const fullDataset = pick('full_models');
  const evalDataset = pick('eval_models');
  const capDataset = pick('capability_details');
  const providerDataset = pick('provider_rows');
  const longDataset = pick('model_long');

  if (!fullDataset) throw new Error('Full AA model dataset not found (model page format may have changed)');
  if (!evalDataset) throw new Error('AA eval dataset not found (/evaluations/scicode format may have changed)');
  if (!compactDataset) log('WARN: compact leaderboard dataset not found; continuing without it');
  if (!capDataset) log('WARN: capability detail dataset not found; aggregate capabilities only');
  if (!providerDataset) log('WARN: provider row dataset not found; host pricing unavailable');
  if (!longDataset) log('WARN: per-host model_long dataset not found');

  const merged = mergeDatasets(
    fullDataset.json.models,
    evalDataset.json.models,
    compactDataset?.json || [],
    capDataset?.json.models || [],
  );
  attachHosts(merged, providerDataset?.json || [], longDataset?.json || []);
  log(`Merged ${merged.length} AA variant records; ${merged.filter((m) => m.hosts?.length).length} have host rows`);

  // 3. Match and enrich.
  const releases = buildReleases(merged);
  log(`Built ${releases.length} AA release groups`);

  const enrichedRows = inputRows.map((row) => {
    const match = matchRow(row, releases);
    return enrichRow(row, match, releases);
  });

  const matched = enrichedRows.filter((r) => r.aa.matched);
  const unmatched = enrichedRows.filter((r) => !r.aa.matched);

  // 4. Metadata.
  const indexVersion = (() => {
    const evalsPage = optional.find((p) => p.url.endsWith('/evaluations'));
    if (!evalsPage) return null;
    const m = evalsPage.html.match(/Intelligence Index v(\d+(?:\.\d+)?)/i);
    return m ? m[1] : null;
  })();

  const generatedAt = new Date().toISOString();
  const fetchedAt = allDatasets
    .map((d) => d.fetched_at)
    .filter(Boolean)
    .sort()[0] || generatedAt;
  const manifests = allDatasets.map((d) => ({
    page: d.page,
    page_url: d.page_url,
    path: d.path,
    bytes: d.bytes,
    sha256: d.sha256,
    dataset_type: d.type,
    count: d.count,
  }));

  const source = {
    provider: 'Artificial Analysis',
    homepage: AA_BASE,
    attribution: 'Data from Artificial Analysis (https://artificialanalysis.ai). Artificial Analysis terms restrict scraping and redistribution of this data.',
    intelligence_index_version: indexVersion || 'unknown',
    fetched_at: fetchedAt,
    methodology: 'Public HTML/RSC pages -> encrypted /data manifests -> AES-256-GCM + gzip -> JSON. No API key used.',
    pages: [...new Set(allDatasets.map((d) => d.page))],
    manifests,
    fetch: { ...fetchStats },
  };

  const summary = {
    gateway_rows: inputRows.length,
    matched_rows: matched.length,
    unmatched_rows: unmatched.length,
    aa_variants_attached: matched.reduce((n, r) => n + r.aa.variants.length, 0),
    primary_with_intelligence_index: matched.filter((r) => typeof r.aa.primary_variant.intelligence_index === 'number').length,
    primary_with_capabilities: matched.filter((r) => r.aa.summary.primary_has_capabilities).length,
    primary_with_evals: matched.filter((r) => r.aa.summary.primary_has_evals).length,
    deprecated_release_matches: matched.filter((r) => r.aa.release.deprecated).length,
    provider_host_found: matched.filter((r) => r.aa.provider_match.found).length,
    ambiguous_matches: matched.filter((r) => r.aa.match.alternatives.length).length,
    effort_unavailable: matched.filter((r) => r.aa.warnings.some((w) => w.startsWith('effort_unavailable:'))).length,
    aa_release_groups: releases.length,
    aa_variants_total: merged.length,
    aa_variants_with_hosts: merged.filter((m) => m.hosts?.length).length,
  };

  const output = {
    generated_at: generatedAt,
    source,
    input: {
      path: opts.input,
      generated_at: inputRaw.generated_at || null,
      fingerprint: inputRaw.fingerprint || null,
      declared_count: inputRaw.count ?? null,
      rows: inputRows.length,
    },
    summary,
    rows: enrichedRows,
  };

  const metadata = {
    generated_at: generatedAt,
    source,
    input: output.input,
    summary,
    outputs: {
      enriched_json: path.join(opts.outDir, 'models_aa_enriched.json'),
      primary_csv: path.join(opts.outDir, 'models_aa_primary.csv'),
      variants_csv: path.join(opts.outDir, 'models_aa_variants.csv'),
      report_md: path.join(opts.outDir, 'aa_match_report.md'),
    },
  };

  // 5. Write JSON outputs.
  fs.writeFileSync(path.join(opts.outDir, 'models_aa_enriched.json'), `${JSON.stringify(output, null, 1)}\n`);
  fs.writeFileSync(path.join(opts.outDir, 'aa_run_metadata.json'), `${JSON.stringify(metadata, null, 1)}\n`);

  // 6. CSV outputs.
  const primaryRows = enrichedRows.map((r) => primaryRow(r, r));
  const variantRows = [];
  for (const r of enrichedRows) {
    if (!r.aa.matched) continue;
    for (const v of r.aa.variants) {
      variantRows.push(variantRow(r, r, v, v.slug === r.aa.primary_variant_slug));
    }
  }

  const primaryColumns = [];
  const variantColumns = [];
  const addCols = (arr, obj) => {
    for (const key of Object.keys(obj)) if (!arr.includes(key)) arr.push(key);
  };
  for (const r of primaryRows) addCols(primaryColumns, r);
  for (const r of variantRows) addCols(variantColumns, r);

  writeCsv(path.join(opts.outDir, 'models_aa_primary.csv'), primaryColumns, primaryRows);
  writeCsv(path.join(opts.outDir, 'models_aa_variants.csv'), variantColumns, variantRows);

  // 7. Report.
  const report = buildReport(output, metadata);
  fs.writeFileSync(path.join(opts.outDir, 'aa_match_report.md'), report);

  log('');
  log('Done.');
  log(`  ${path.join(opts.outDir, 'models_aa_enriched.json')}`);
  log(`  ${path.join(opts.outDir, 'models_aa_primary.csv')} (${primaryRows.length} rows)`);
  log(`  ${path.join(opts.outDir, 'models_aa_variants.csv')} (${variantRows.length} rows)`);
  log(`  ${path.join(opts.outDir, 'aa_run_metadata.json')}`);
  log(`  ${path.join(opts.outDir, 'aa_match_report.md')}`);
  log('');
  log(`Matched ${matched.length}/${inputRows.length}; ${unmatched.length} unmatched; ${summary.aa_variants_attached} variants attached.`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.stack || err.message || err}`);
  process.exit(1);
});
