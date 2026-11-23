// Synthetic fixtures for the self-test and the end-to-end test.
//
// Everything here is made up: fictional model families, fictional gateway
// catalog rows, and AA-shaped records. Nothing comes from a real catalog or
// from Artificial Analysis.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Synthetic gateway catalog (same shape the ai-gateway plugin writes)
// ---------------------------------------------------------------------------

function catalogRow(over) {
  return {
    provider_id: 'gw-demo',
    provider_name: 'Demo',
    model_id: 'model',
    model_name: over.model_id || 'model',
    aliases: [],
    mode: 'chat',
    enriched: true,
    max_input_tokens: 200000,
    max_output_tokens: 8192,
    input_per_1M: 1,
    output_per_1M: 4,
    cache_write_per_1M: 0,
    cache_read_per_1M: 0,
    input_per_1k: 0.001,
    output_per_1k: 0.004,
    tiers: [],
    tools: true,
    vision: false,
    pdf: false,
    audio: false,
    video: false,
    responses_only: false,
    effort_levels: [],
    upstream_provider: '',
    upstream_model: '',
    ...over,
  };
}

export const catalogRows = [
  catalogRow({
    provider_id: 'gw-bedrock', provider_name: 'AWS Bedrock', model_id: 'kestrel-4.6-pro-aws',
    input_per_1M: 3, output_per_1M: 15, upstream_provider: 'bedrock', upstream_model: 'bedrock/us.kestrel-4-6-pro-v1:0',
  }),
  catalogRow({
    provider_id: 'gw-azure', provider_name: 'Azure Foundry', model_id: 'nimbus-3-235b',
    upstream_provider: 'azure', upstream_model: 'azure/nimbus-3-235b-a22b-instruct-2507',
  }),
  catalogRow({
    provider_id: 'gw-vertex', provider_name: 'Vertex AI', model_id: 'nimbus-coder-480b',
    upstream_provider: 'vertex_ai', upstream_model: 'vertex_ai/nimbus-coder-480b-a35b-instruct-maas',
  }),
  catalogRow({
    provider_id: 'gw-3rd-party', provider_name: '3rd Party', model_id: 'zephyr-3.8-max',
    input_per_1M: 0.5, output_per_1M: 2, upstream_provider: '3rd_party', upstream_model: 'openrouter/zephyr/zephyr-3.8-max',
  }),
  catalogRow({
    provider_id: 'gw-bedrock', provider_name: 'AWS Bedrock', model_id: 'mistral-3-14b-aws',
    upstream_provider: 'bedrock', upstream_model: 'bedrock/mistral.ministral-3-14b-instruct',
  }),
  catalogRow({
    provider_id: 'gw-azure', provider_name: 'Azure Foundry', model_id: 'kestrel-code-max',
    upstream_provider: 'azure', upstream_model: 'azure/kestrel-code',
  }),
  catalogRow({ provider_id: 'gw-azure', provider_name: 'Azure Foundry', model_id: 'halo-2-reasoning', upstream_provider: 'azure', upstream_model: 'azure/halo-2' }),
  catalogRow({ provider_id: 'gw-azure', provider_name: 'Azure Foundry', model_id: 'halo-2-non-reasoning', upstream_provider: 'azure', upstream_model: 'azure/halo-2' }),
  catalogRow({
    provider_id: 'gw-openai', provider_name: 'OpenAI', model_id: 'lumen-small-latest',
    input_per_1M: 0, output_per_1M: 0, upstream_provider: 'openai', upstream_model: 'openai/lumen-small',
  }),
  catalogRow({
    provider_id: 'gw-acme', provider_name: 'Acme Cloud', model_id: 'orbit-flash-acme',
    upstream_provider: 'acme_cloud', upstream_model: 'acme_cloud/orbit-flash',
  }),
  catalogRow({ provider_id: 'gw-demo', provider_name: 'Demo', model_id: 'tiny-chat', aliases: ['tiny-model-9b'] }),
  catalogRow({ provider_id: 'gw-demo', provider_name: 'Demo', model_id: 'legacy-chat-1', upstream_provider: 'demo' }),
  catalogRow({ provider_id: 'gw-demo', provider_name: 'Demo', model_id: 'vega-6-demo', upstream_provider: 'demo' }),
  catalogRow({ provider_id: 'gw-demo', provider_name: 'Demo', model_id: 'synth-image-gen', mode: 'image_generation', input_per_1M: null, output_per_1M: null }),
  catalogRow({ provider_id: 'gw-demo', provider_name: 'Demo', model_id: 'synth-audio-1', mode: 'audio_speech', input_per_1M: null, output_per_1M: null }),
];

export function catalogFile(rows = catalogRows) {
  return {
    generated_at: '2026-01-01T00:00:00.000Z',
    fingerprint: '0:synthetic',
    // Deliberately present: no output of this tool may ever contain it.
    base_url: 'https://gateway.example.invalid/prod',
    count: rows.length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Synthetic AA datasets (AA-shaped; values are invented)
// ---------------------------------------------------------------------------

function variant(slug, name, release, over = {}) {
  return {
    id: `id-${slug}`,
    slug,
    name,
    shortName: name,
    suffix: over.suffix ?? null,
    release: { slug: release.slug, name: release.name, deprecatedTo: release.deprecatedTo ?? null },
    creator: { id: 'c1', slug: release.creator.toLowerCase(), name: release.creator },
    releaseDate: release.date,
    deprecated: release.deprecated ?? false,
    chartDefaultSelected: false,
    isReasoning: true,
    hostModelCount: 1,
    contextWindowTokens: 200000,
    price1mInputTokens: 2,
    price1mOutputTokens: 8,
    capabilities: { engineering: 50 },
    intelligenceIndex: 40,
    ...over,
  };
}

const kestrel = { slug: 'kestrel-pro-4-6', name: 'Kestrel Pro 4.6', creator: 'Kestrel Labs', date: '2026-02-01' };
const nimbusNew = { slug: 'nimbus-3-235b-a22b-instruct-2507', name: 'Nimbus 3 235B A22B Instruct 2507', creator: 'Nimbus AI', date: '2025-07-20' };
const nimbusOld = { slug: 'nimbus-3-235b-a22b-instruct-2410', name: 'Nimbus 3 235B A22B Instruct 2410', creator: 'Nimbus AI', date: '2024-10-20' };
const coder = { slug: 'nimbus-coder-480b-a35b-instruct', name: 'Nimbus Coder 480B A35B Instruct', creator: 'Nimbus AI', date: '2025-08-01' };
const coderNext = { slug: 'nimbus-coder-next', name: 'Nimbus Coder Next', creator: 'Nimbus AI', date: '2025-12-01' };
const zephyr = { slug: 'zephyr-3-8-max-0902', name: 'Zephyr 3.8 Max (0902)', creator: 'Zephyr Group', date: '2025-09-02' };
const zephyrOld = { slug: 'zephyr-3-8-max-0415', name: 'Zephyr 3.8 Max (0415)', creator: 'Zephyr Group', date: '2025-04-15', deprecated: true };
const ministral = { slug: 'ministral-3-14b', name: 'Ministral 3 14B', creator: 'Mistral AI', date: '2025-11-01' };
const kcode = { slug: 'kestrel-code', name: 'Kestrel Code', creator: 'Kestrel Labs', date: '2026-01-10' };
const halo = { slug: 'halo-2', name: 'Halo 2', creator: 'Halo Research', date: '2026-03-01' };
const lumen = { slug: 'lumen-small', name: 'Lumen Small', creator: 'Lumen', date: '2026-01-20' };
const orbit = { slug: 'orbit-flash', name: 'Orbit Flash', creator: 'Orbit Labs', date: '2026-02-20' };
const tiny = { slug: 'tiny-model-9b', name: 'Tiny Model 9B', creator: 'Tiny Co', date: '2025-06-01' };
const legacy = { slug: 'legacy-chat-1', name: 'Legacy Chat 1', creator: 'Legacy Inc', date: '2023-05-01', deprecated: true };
const vega = { slug: 'vega-6', name: 'Vega 6', creator: 'Vega Labs', date: '2026-01-05', deprecated: true, deprecatedTo: 'vega-6-1' };
// AA placeholder: same display name, another slug, no scores of any kind.
const vegaPlaceholder = { slug: 'vega-6-codename-blue', name: 'Vega 6', creator: 'Vega Labs', date: '2026-02-01' };
const UNMEASURED = new Set(['vega-6-codename-blue']);

const fullModels = [
  variant('kestrel-pro-4-6', 'Kestrel Pro 4.6 (Max)', kestrel, { suffix: 'Max', chartDefaultSelected: true, intelligenceIndex: 60 }),
  variant('kestrel-pro-4-6-low', 'Kestrel Pro 4.6 (Low)', kestrel, { suffix: 'Low', intelligenceIndex: 40 }),
  variant('kestrel-pro-4-6-non-reasoning', 'Kestrel Pro 4.6 (Non-reasoning)', kestrel, { suffix: 'Non-reasoning', isReasoning: false, intelligenceIndex: 30 }),
  variant(nimbusNew.slug, nimbusNew.name, nimbusNew, { chartDefaultSelected: true, intelligenceIndex: 33 }),
  variant(nimbusOld.slug, nimbusOld.name, nimbusOld, { chartDefaultSelected: true, intelligenceIndex: 25 }),
  variant(coder.slug, coder.name, coder, { chartDefaultSelected: true, intelligenceIndex: 38 }),
  variant(coderNext.slug, coderNext.name, coderNext, { chartDefaultSelected: true, intelligenceIndex: 41 }),
  variant(zephyr.slug, zephyr.name, zephyr, { chartDefaultSelected: true, intelligenceIndex: 45 }),
  variant(zephyrOld.slug, zephyrOld.name, zephyrOld, { chartDefaultSelected: true, deprecated: true, intelligenceIndex: null }),
  variant(ministral.slug, ministral.name, ministral, { chartDefaultSelected: true, intelligenceIndex: 20 }),
  variant('kestrel-code', 'Kestrel Code (High)', kcode, { suffix: 'High', chartDefaultSelected: true, intelligenceIndex: 52 }),
  variant('kestrel-code-medium', 'Kestrel Code (Medium)', kcode, { suffix: 'Medium', intelligenceIndex: 44 }),
  variant('halo-2', 'Halo 2 (Reasoning)', halo, { suffix: 'Reasoning', chartDefaultSelected: true, intelligenceIndex: 55 }),
  variant('halo-2-non-reasoning', 'Halo 2 (Non-reasoning)', halo, { suffix: 'Non-reasoning', isReasoning: false, intelligenceIndex: 35 }),
  variant(lumen.slug, lumen.name, lumen, { chartDefaultSelected: true, intelligenceIndex: 28 }),
  variant(orbit.slug, orbit.name, orbit, { chartDefaultSelected: true, intelligenceIndex: 31 }),
  variant(tiny.slug, tiny.name, tiny, { chartDefaultSelected: true, intelligenceIndex: 12 }),
  variant(legacy.slug, legacy.name, legacy, { chartDefaultSelected: true, deprecated: true, intelligenceIndex: null }),
  variant(vega.slug, vega.name, vega, { chartDefaultSelected: true, deprecated: true, intelligenceIndex: 42 }),
  variant(vegaPlaceholder.slug, vegaPlaceholder.name, vegaPlaceholder, { chartDefaultSelected: true, intelligenceIndex: null, capabilities: {} }),
];
const measuredModels = fullModels.filter((m) => !UNMEASURED.has(m.slug));

const evalModels = measuredModels.map((m, i) => ({
  slug: m.slug,
  math500: 0.5,
  mmluPro: 0.5,
  scicode: 0.2 + (i % 5) / 10,
  hle: 0.05 + (i % 4) / 20,
}));

// Current AA payloads key compact rows by id (no slug); the pages link to /models/<slug>.
const compact = fullModels.map((m) => ({
  id: m.id,
  release: { slug: m.release.slug, name: m.release.name },
  name: m.name,
  deprecated: m.deprecated,
  intelligenceIndex: m.intelligenceIndex,
  paramClass: 'unknown',
  scores: UNMEASURED.has(m.slug) ? {} : { 'scicode': 0.3, 'hle': 0.1 },
}));

const capabilityModels = measuredModels.map((m) => ({
  slug: m.slug,
  capabilities: { engineering: { headlineValue: 50, subScores: {} } },
}));

const providers = [
  {
    host: { slug: 'amazon_bedrock', name: 'Amazon Bedrock' },
    model: { slug: 'kestrel-pro-4-6', scores: {} },
    label: 'Kestrel Pro 4.6',
    hostApiId: 'kestrel-pro-4-6-v1',
    features: { contextWindowTokens: 200000 },
    pricing: { price1mInputTokens: 3, price1mOutputTokens: 15, costPerTask: 12 },
    performance: { medianOutputTokensPerSecond: 80, medianTimeToFirstTokenSeconds: 0.8 },
  },
];

const modelLong = [
  {
    host: { name: 'OpenAI' }, modelSlug: 'lumen-small', name: 'Lumen Small',
    contextWindowTokens: 128000, price1mInputTokens: 0.2, price1mOutputTokens: 0.8,
  },
];

export const aaDatasets = {
  full: { models: fullModels },
  eval: { models: evalModels, priceFallbackByModelId: {} },
  compact,
  capabilities: { models: capabilityModels },
  providers,
  modelLong,
};

// ---------------------------------------------------------------------------
// Fake AA site: write an HTTP cache that parse_aa.mjs reads with --offline
// ---------------------------------------------------------------------------

const AA_BASE = 'https://artificialanalysis.ai';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encrypt(json) {
  const key = crypto.randomBytes(32);
  const iv = crypto.createHash('sha256').update(key).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(json)));
  const buf = Buffer.concat([cipher.update(gz), cipher.final(), cipher.getAuthTag()]);
  return { key: key.toString('hex'), buf };
}

function cachePut(cacheDir, url, buf, fetchedAt, contentType) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const k = sha256(Buffer.from(url));
  fs.writeFileSync(path.join(cacheDir, `${k}.bin`), buf);
  fs.writeFileSync(path.join(cacheDir, `${k}.json`), JSON.stringify({
    url, fetched_at: fetchedAt, content_type: contentType, bytes: buf.length, sha256: sha256(buf),
  }));
}

/**
 * Populate `cacheDir` with encrypted, AA-shaped pages for the synthetic data.
 * `fetchedAt` is an ISO timestamp (use an old one to simulate a stale cache).
 */
export function writeFakeAaCache(cacheDir, fetchedAt = new Date().toISOString()) {
  const datasetPath = (name) => `/data/${sha256(name).slice(0, 16)}.txt`;
  const pages = new Map();
  const encrypted = new Map(); // one key per dataset, shared by every page that embeds it

  const put = (pagePath, datasets, extraHtml = '') => {
    const descriptors = [];
    for (const [name, json] of datasets) {
      const dataPath = datasetPath(name);
      if (!encrypted.has(name)) {
        const enc = encrypt(json);
        encrypted.set(name, enc.key);
        cachePut(cacheDir, `${AA_BASE}${dataPath}`, enc.buf, fetchedAt, 'text/plain');
      }
      const key = encrypted.get(name);
      descriptors.push(`\\"manifest\\":{\\"path\\":\\"${dataPath}\\",\\"key\\":\\"${key}\\"}`);
    }
    const html = `<html><body>${extraHtml}<script>self.__next_f.push([1,"${descriptors.join(',')}"])</script></body></html>`;
    pages.set(pagePath, html);
  };

  const links = aaDatasets.full.models.map((m) => `<a href="/models/${m.slug}">${m.name}</a>`).join('');
  put('/leaderboards/models', [['compact', aaDatasets.compact]], links);
  for (const m of aaDatasets.full.models) put(`/models/${m.slug}`, [['full', aaDatasets.full]]);
  put('/evaluations/scicode', [['eval', aaDatasets.eval]]);
  put('/indexes/engineering', [['cap', aaDatasets.capabilities]]);
  put('/leaderboards/providers', [['providers', aaDatasets.providers], ['long', aaDatasets.modelLong]]);
  pages.set('/evaluations', '<html><body>Artificial Analysis Intelligence Index v5.0</body></html>');

  for (const [pagePath, html] of pages) {
    cachePut(cacheDir, `${AA_BASE}${pagePath}`, Buffer.from(html), fetchedAt, 'text/html');
  }
}
