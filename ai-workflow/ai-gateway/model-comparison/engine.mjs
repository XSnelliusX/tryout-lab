/**
 * engine.mjs - the one recommendation engine of the AI workflow (pure, no I/O).
 *
 * The model comparison snapshot (data/models.json, schema >= 3) is the anchor:
 * every tool that suggests a model asks this module, so the dashboard (bundled
 * into the web app), Herdr's cc-models and the prompt rewriter (both through
 * recommend.mjs / data/recommendations.json) agree on what "the best model" is.
 *
 * How a pick is made (METHOD below carries the numbers):
 *   1. Workload score. A role or task is scored on the benchmarks that measure
 *      it, not always on the general Intelligence Index: agentic coding is
 *      60% Terminal-Bench 4.0 + 40% Intelligence Index, and so on (WORKLOADS).
 *   2. Candidates. Every gateway route (provider/model) at every effort the
 *      route offers, priced at its own cost per task (AA's token counts at the
 *      gateway price, so a verbose model is not favoured by a low token price).
 *      Superseded (deprecated) releases are never recommended.
 *   3. Floor. A candidate must reach a share of the best score in the pool
 *      (TIERS[tier].floor). Relative to what is available, so it never goes
 *      stale when Artificial Analysis re-bases its index.
 *   4. Price of quality. Among those, the pick maximises
 *        100 * score / best  -  k * log2(cost per task)  +  w * log2(tokens/s)
 *      i.e. every doubling of cost must buy at least k points (% of best);
 *      k falls from lean to max. w > 0 only for latency-bound roles.
 *
 * No imports, no globals: it runs in Node and in the browser.
 */

export const ENGINE_VERSION = 1;
export const PROFILES = ['lean', 'balanced', 'max'];

/** Workload scores: weighted parts of snapshot metric ids (all on 0-100 scales). */
export const WORKLOADS = {
  general: {
    label: 'General reasoning',
    description: 'Artificial Analysis Intelligence Index.',
    parts: [['intelligence', 1]],
  },
  coding: {
    label: 'Agentic coding',
    description: '60% Terminal-Bench 4.0 (agentic coding in a terminal, like an OpenCode worker) + 40% Intelligence Index.',
    parts: [['terminal_bench_40', 0.6], ['intelligence', 0.4]],
  },
  agentic: {
    label: 'Tool use & orchestration',
    description: '60% AutomationBench (multi-step tool use) + 40% Intelligence Index.',
    parts: [['automation_bench', 0.6], ['intelligence', 0.4]],
  },
  planning: {
    label: 'Planning & design',
    description: '60% Intelligence Index + 40% Terminal-Bench 4.0: broad reasoning that also knows code.',
    parts: [['intelligence', 0.6], ['terminal_bench_40', 0.4]],
  },
  writing: {
    label: 'Writing & knowledge work',
    description: '70% Intelligence Index + 30% GDP.pdf (real knowledge-work deliverables such as reports).',
    parts: [['intelligence', 0.7], ['gdp_pdf_all_pass', 0.3]],
  },
};

/**
 * Difficulty tiers. floor: share of the best workload score a pick must reach.
 * perDoubling: score points (% of best) one doubling of cost must buy. Across
 * the gateway, quality rises about 7 points per cost doubling on average, so
 * light work asks for more than that (cost wins) and hard work for less.
 */
export const TIERS = {
  light: { label: 'Light', description: 'Routine, well-scoped work: cost and speed first.', floor: { lean: 0.45, balanced: 0.55, max: 0.65 }, perDoubling: { lean: 16, balanced: 12, max: 8 } },
  standard: { label: 'Standard', description: 'Everyday implementation and review.', floor: { lean: 0.75, balanced: 0.82, max: 0.9 }, perDoubling: { lean: 9, balanced: 6, max: 4 } },
  hard: { label: 'Hard', description: 'Multi-file, subtle or design work.', floor: { lean: 0.85, balanced: 0.92, max: 0.96 }, perDoubling: { lean: 5, balanced: 2.5, max: 1.5 } },
  frontier: { label: 'Frontier', description: 'Last resort: the strongest model that is available.', floor: { lean: 0.9, balanced: 0.95, max: 0.99 }, perDoubling: { lean: 2, balanced: 1, max: 0.5 } },
};

/** Default workload, tier and speed weight per Herdr role (override per role with `recommend` in models.json). */
export const ROLE_PROFILES = {
  commander: { workload: 'agentic', tier: 'light', speed: 2 },
  explore: { workload: 'agentic', tier: 'light', speed: 3 },
  writer: { workload: 'writing', tier: 'light', speed: 1 },
  'verifier-fast': { workload: 'coding', tier: 'light', speed: 1 },
  implementer: { workload: 'coding', tier: 'standard', speed: 0 },
  reviewer: { workload: 'coding', tier: 'standard', speed: 0 },
  'implementer-pro': { workload: 'coding', tier: 'hard', speed: 0 },
  'verifier-deep': { workload: 'coding', tier: 'hard', speed: 0 },
  architect: { workload: 'planning', tier: 'hard', speed: 0 },
  escalation: { workload: 'planning', tier: 'frontier', speed: 0 },
};
const TIER_BY_NUMBER = ['light', 'light', 'standard', 'hard'];

/** A gateway price of $0 counts as this cost per task, so free models are cheap, not infinitely good. */
export const MIN_COST = 0.005;
/** AA effort names -> gateway variant names. */
const EFFORT_TO_VARIANT = { 'non-reasoning': 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

export const METHOD = {
  engine_version: ENGINE_VERSION,
  min_cost_per_task_usd: MIN_COST,
  objective: '100 * score / best - k * log2(cost per task) + w * log2(tokens per second), among candidates with score >= floor * best',
  workloads: WORKLOADS,
  tiers: TIERS,
  roles: ROLE_PROFILES,
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function globToRegExp(glob) {
  return new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

/** Workload spec from a name ("coding") or an ad-hoc single metric ("metric:scicode"). */
export function resolveWorkload(workload) {
  if (workload && typeof workload === 'object' && Array.isArray(workload.parts)) return workload;
  const name = String(workload || 'general');
  if (name.startsWith('metric:')) {
    const id = name.slice('metric:'.length);
    return { label: id, description: `Snapshot metric ${id}.`, parts: [[id, 1]] };
  }
  const spec = WORKLOADS[name];
  if (!spec) throw new Error(`unknown workload "${name}" (one of ${Object.keys(WORKLOADS).join(', ')}, or metric:<id>)`);
  return spec;
}

/**
 * Score of one snapshot row for a workload. Missing parts are left out and the
 * remaining weights renormalised (estimated: true); null when no part exists.
 */
export function workloadScore(row, workload) {
  const spec = resolveWorkload(workload);
  let sum = 0;
  let weight = 0;
  let missing = 0;
  for (const [id, w] of spec.parts) {
    const v = num(row?.scores?.[id]);
    if (v === null) { missing += 1; continue; }
    sum += v * w;
    weight += w;
  }
  if (weight === 0) return null;
  return { value: sum / weight, estimated: missing > 0 };
}

/**
 * The gateway routes of a row. Schema 3 snapshots list them explicitly; for
 * older snapshots only an unambiguous single provider/id pair is trusted.
 */
export function routesOf(row) {
  if (Array.isArray(row?.gateway_routes)) return row.gateway_routes;
  const providers = row?.gateway_providers ?? [];
  const ids = row?.gateway_ids ?? [];
  if (providers.length !== 1 || ids.length !== 1) return [];
  return [{
    provider_id: providers[0], model_id: ids[0],
    input_per_1m: row.pricing?.gateway_input_per_1m ?? null, output_per_1m: row.pricing?.gateway_output_per_1m ?? null,
    blended_3_to_1_per_1m: row.pricing?.gateway_blended_3_to_1_per_1m ?? null,
    cost_per_task_usd: row.pricing?.gateway_cost_per_task_usd ?? null,
    effort_levels: null, output_tokens_per_second: row.performance?.output_tokens_per_second ?? null,
  }];
}

/**
 * Which gateway variant (reasoning effort) of a route runs this AA variant, or
 * undefined when the route cannot run it. null means "the route's default".
 */
export function variantForRoute(row, route) {
  const levels = Array.isArray(route.effort_levels) ? route.effort_levels : null;
  const effort = row.effort || null;
  const wanted = effort ? EFFORT_TO_VARIANT[effort] : null;
  if (levels === null) return row.is_primary === false ? undefined : (wanted && wanted !== 'max' ? wanted : null);
  if (levels.length === 0) return row.is_primary === false ? undefined : null; // no efforts: only the default, which AA's primary variant measures
  if (wanted && levels.includes(wanted)) return wanted;
  if (!wanted && row.is_primary !== false) return null; // reasoning model measured at its default
  return undefined;
}

/**
 * Every (route, variant) that can be recommended, with its workload scores.
 * options: includeDeprecated, allowMaxEffort (default false), providers (ids),
 * exclude (glob patterns on model ids), requireTools, includeFree (default true),
 * costMode 'task' (default) or 'blended', rows (pre-filtered snapshot rows).
 */
export function buildCandidates(snapshot, options = {}) {
  const {
    includeDeprecated = false, allowMaxEffort = false, providers = null, exclude = [],
    requireTools = false, includeFree = true, costMode = 'task',
  } = options;
  const rows = options.rows ?? snapshot?.models ?? [];
  const allowed = providers && providers.length ? new Set(providers) : null;
  const excluded = (exclude || []).map(globToRegExp);
  const out = [];
  for (const row of rows) {
    if (!includeDeprecated && row.release_deprecated) continue;
    for (const route of routesOf(row)) {
      if (allowed && !allowed.has(route.provider_id)) continue;
      if (excluded.some((re) => re.test(route.model_id))) continue;
      if (requireTools && route.tools === false) continue;
      const variant = variantForRoute(row, route);
      if (variant === undefined) continue;
      if (variant === 'max' && !allowMaxEffort) continue;
      const cost = costMode === 'blended'
        ? num(route.blended_3_to_1_per_1m) ?? num(row.pricing?.blended_3_to_1_per_1m)
        : num(route.cost_per_task_usd);
      if (cost === null || cost < 0) continue;
      if (cost === 0 && !includeFree) continue;
      out.push({
        id: `${route.provider_id}/${route.model_id}${variant ? `#${variant}` : ''}`,
        provider_id: route.provider_id,
        model_id: route.model_id,
        variant,
        effort: row.effort || null,
        slug: row.slug,
        name: row.name,
        release: row.release_name || row.name,
        release_slug: row.release_slug || row.slug,
        release_date: row.release_date ?? null,
        creator: row.creator || '',
        cost,
        free: cost === 0,
        speed: num(route.output_tokens_per_second) ?? num(row.performance?.output_tokens_per_second),
        row,
      });
    }
  }
  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The pick for a workload, tier and profile. Returns null when nothing in the
 * pool has a score. options: speedWeight (w), perDoubling / floor (override the
 * tier), preferProviders (tie-break order), limit (length of `ranked`).
 */
export function recommend(candidates, { workload = 'general', tier = 'standard', profile = 'balanced', speedWeight = 0, perDoubling, floor, preferProviders = [], limit = 5 } = {}) {
  const spec = resolveWorkload(workload);
  const t = TIERS[tier];
  if (!t) throw new Error(`unknown tier "${tier}" (one of ${Object.keys(TIERS).join(', ')})`);
  if (!PROFILES.includes(profile)) throw new Error(`unknown profile "${profile}" (one of ${PROFILES.join(', ')})`);
  const k = perDoubling ?? t.perDoubling[profile];
  const share = floor ?? t.floor[profile];

  const pool = [];
  for (const c of candidates) {
    const s = workloadScore(c.row, spec);
    if (s) pool.push({ c, score: s.value, estimated: s.estimated });
  }
  if (!pool.length) return null;
  const best = pool.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.c.cost < a.c.cost) ? b : a));
  const top = best.score;
  const min = top > 0 ? share * top : top;
  const speedFallback = median(pool.map((p) => p.c.speed).filter((v) => v !== null && v > 0)) ?? 100;
  const rank = (p) => preferProviders.includes(p.c.provider_id) ? preferProviders.indexOf(p.c.provider_id) : preferProviders.length;
  const utility = (p) => (top > 0 ? (100 * p.score) / top : p.score)
    - k * Math.log2(Math.max(p.c.cost, MIN_COST))
    + (speedWeight ? speedWeight * Math.log2(Math.max(p.c.speed ?? speedFallback, 1)) : 0);
  const order = (a, b) => (b.u - a.u) || (b.score - a.score) || (a.c.cost - b.c.cost) || (rank(a) - rank(b)) || a.c.id.localeCompare(b.c.id);

  const eligible = pool.filter((p) => p.score >= min).map((p) => ({ ...p, u: utility(p) })).sort(order);
  const pick = eligible[0];
  // The strongest candidate that costs less than the pick (it may sit below the floor).
  const cheaper = pool
    .filter((p) => p.c.cost < pick.c.cost)
    .sort((a, b) => (b.score - a.score) || (a.c.cost - b.c.cost))[0] ?? null;
  // The next step up: the cheapest candidate that scores clearly higher (Pareto upgrade).
  const stronger = pool
    .filter((p) => p.score > pick.score + 0.5 && p.c.cost > pick.c.cost)
    .sort((a, b) => (a.c.cost - b.c.cost) || (b.score - a.score))[0] ?? null;

  const view = (p) => p && {
    id: p.c.id, provider_id: p.c.provider_id, model_id: p.c.model_id, variant: p.c.variant, effort: p.c.effort,
    slug: p.c.slug, name: p.c.name, release: p.c.release, creator: p.c.creator,
    score: round(p.score, 1), score_pct_of_best: top > 0 ? round((100 * p.score) / top, 1) : null, estimated: p.estimated || undefined,
    cost_per_task_usd: round(p.c.cost, 4), free: p.c.free || undefined, output_tokens_per_second: p.c.speed === null ? null : Math.round(p.c.speed),
  };
  const result = {
    workload: typeof workload === 'string' ? workload : spec.label,
    workload_label: spec.label,
    tier, profile,
    floor_share: share, per_doubling: k, speed_weight: speedWeight,
    pool: pool.length, eligible: eligible.length,
    best: view(best),
    pick: view(pick),
    cheaper: view(cheaper),
    stronger: view(stronger),
    ranked: eligible.slice(0, limit).map(view),
  };
  result.reason = explain(result);
  return result;
}

function round(v, d) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));
}

export function formatCost(v) {
  if (v === null || v === undefined) return '-';
  if (v === 0) return '$0';
  return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function label(c) {
  if (!c) return '-';
  return c.variant ? `${c.model_id}#${c.variant}` : c.model_id;
}

/** One sentence on why the pick won and what the next step up would buy. */
export function explain(r) {
  const p = r.pick;
  const parts = [];
  if (p.id === r.best.id) parts.push(`best ${r.workload_label.toLowerCase()} score available (${p.score})`);
  else parts.push(`${p.score_pct_of_best}% of the best ${r.workload_label.toLowerCase()} score (${r.best.score}, ${label(r.best)}) at ${formatCost(p.cost_per_task_usd)} per task${p.free ? ' (free at the gateway)' : ''}`);
  if (r.stronger) {
    const gain = r.stronger.score - p.score;
    const ratio = p.cost_per_task_usd > 0 ? r.stronger.cost_per_task_usd / p.cost_per_task_usd : null;
    parts.push(`next step up: ${label(r.stronger)} +${gain.toFixed(1)} points for ${ratio ? `${ratio.toFixed(1)}x` : 'more'} the cost`);
  }
  return parts.join('; ');
}

/** Workload, tier and speed weight for one role of the Command Center config. */
export function roleProfile(name, spec = {}) {
  const base = ROLE_PROFILES[name] ?? {
    workload: 'general',
    tier: TIER_BY_NUMBER[Number.isInteger(spec.tier) ? Math.max(0, Math.min(3, spec.tier)) : 2],
    speed: 0,
  };
  const over = spec.recommend && typeof spec.recommend === 'object' ? spec.recommend : {};
  return { workload: over.workload ?? base.workload, tier: over.tier ?? base.tier, speed: num(over.speed) ?? base.speed };
}

function splitModel(spec) {
  const [model, inline] = String(spec?.model ?? '').split('#', 2);
  return { model, variant: spec?.variant ?? inline ?? null };
}

/** Facts about the model a role uses today (null fields when the snapshot does not know it). */
export function describeCurrent(snapshot, model, variant, workload) {
  const out = { model, variant: variant || null, id: `${model}${variant ? `#${variant}` : ''}`, known: false, deprecated: false, score: null, cost_per_task_usd: null };
  if (!model || model.includes('<')) return { ...out, placeholder: true };
  const [providerId, modelId] = model.split('/', 2);
  for (const row of snapshot?.models ?? []) {
    for (const route of routesOf(row)) {
      if (route.provider_id !== providerId || route.model_id !== modelId) continue;
      const v = variantForRoute(row, route);
      if (v === undefined || (v ?? null) !== (variant || null)) continue;
      const s = workloadScore(row, workload);
      return {
        ...out, known: true, deprecated: Boolean(row.release_deprecated), release: row.release_name || row.name,
        score: s ? round(s.value, 1) : null, cost_per_task_usd: round(num(route.cost_per_task_usd), 4),
      };
    }
  }
  return out;
}

/**
 * Picks for every role of a Command Center config (models.json), per profile.
 * Honors model_policy.providers (default: the providers the roles use today)
 * and model_policy.exclude.
 */
export function recommendRoles(snapshot, config, { profiles = PROFILES } = {}) {
  const roles = config?.roles ?? {};
  const policy = config?.model_policy ?? {};
  const inUse = [...new Set(Object.values(roles).map((s) => splitModel(s).model).filter((m) => m.includes('/') && !m.includes('<')).map((m) => m.split('/')[0]))].sort();
  const providers = Array.isArray(policy.providers) && policy.providers.length ? policy.providers : inUse;
  const candidates = buildCandidates(snapshot, { providers, exclude: policy.exclude ?? [], requireTools: true, allowMaxEffort: Boolean(policy.allow_max_effort) });
  const rows = [];
  for (const [name, spec] of Object.entries(roles)) {
    const prof = roleProfile(name, spec);
    const { model, variant } = splitModel(spec);
    const picks = {};
    for (const profile of profiles) {
      picks[profile] = recommend(candidates, { workload: prof.workload, tier: prof.tier, profile, speedWeight: prof.speed, preferProviders: providers });
    }
    rows.push({ role: name, workload: prof.workload, tier: prof.tier, speed_weight: prof.speed, current: describeCurrent(snapshot, model, variant, prof.workload), picks });
  }
  return { providers, exclude: policy.exclude ?? [], candidates: candidates.length, roles: rows };
}

/** The workload x tier x profile grid (all gateway providers) that the dashboard and the prompt rewriter read. */
export function recommendGrid(snapshot, options = {}) {
  const candidates = buildCandidates(snapshot, { requireTools: false, ...options });
  const grid = {};
  for (const workload of Object.keys(WORKLOADS)) {
    grid[workload] = {};
    for (const tier of Object.keys(TIERS)) {
      grid[workload][tier] = {};
      for (const profile of PROFILES) grid[workload][tier][profile] = recommend(candidates, { workload, tier, profile });
    }
  }
  return grid;
}

/** The whole recommendations document (data/recommendations.json). config may be null. */
export function buildDocument(snapshot, config, { now = new Date() } = {}) {
  let roles = { available: false };
  if (config?.roles) roles = { available: true, ...recommendRoles(snapshot, config) };
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    snapshot_generated_at: snapshot?.generated_at ?? null,
    aa_fetched_at: snapshot?.aa_fetched_at ?? null,
    method: METHOD,
    grid: recommendGrid(snapshot),
    roles,
  };
}
