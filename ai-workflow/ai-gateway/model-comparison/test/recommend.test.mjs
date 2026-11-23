// Recommendation engine tests on a small synthetic snapshot (made-up models).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCandidates, buildDocument, describeCurrent, recommend, recommendRoles, roleProfile,
  routesOf, variantForRoute, workloadScore, writeDocument, MIN_COST,
} from '../recommend.mjs';

const route = (provider_id, model_id, cost, over = {}) => ({
  provider_id, model_id, input_per_1m: 1, output_per_1m: 4, blended_3_to_1_per_1m: 1.75,
  cost_per_task_usd: cost, cost_per_task_source: 'gateway_estimate', effort_levels: ['low', 'medium', 'high', 'max'],
  tools: true, output_tokens_per_second: 100, ...over,
});

const row = (slug, effort, scores, routes, over = {}) => ({
  slug, name: slug, creator: 'Synth', release_slug: slug.replace(/-(low|medium|high|max)$/, ''), release_name: slug,
  release_deprecated: false, effort, is_primary: !effort || effort === 'max', scores, gateway_routes: routes,
  pricing: {}, performance: { output_tokens_per_second: 100 }, ...over,
});

// A cheap line, a mid line and a frontier line on two providers.
const snapshot = {
  schema_version: 3,
  generated_at: '2026-01-01T00:00:00Z',
  models: [
    row('swift-1-low', 'low', { intelligence: 30, terminal_bench_40: 20, automation_bench: 40 }, [route('gw-a', 'swift-1', 0.05)]),
    row('swift-1-high', 'high', { intelligence: 38, terminal_bench_40: 30, automation_bench: 48 }, [route('gw-a', 'swift-1', 0.12)]),
    row('mid-2-medium', 'medium', { intelligence: 50, terminal_bench_40: 52, automation_bench: 60 }, [route('gw-a', 'mid-2', 0.4), route('gw-b', 'mid-2-b', 0.5)]),
    row('mid-2-high', 'high', { intelligence: 53, terminal_bench_40: 55, automation_bench: 62 }, [route('gw-a', 'mid-2', 0.55)]),
    row('top-3-high', 'high', { intelligence: 60, terminal_bench_40: 62, automation_bench: 70 }, [route('gw-b', 'top-3', 6)]),
    row('top-3', 'max', { intelligence: 62, terminal_bench_40: 63, automation_bench: 71 }, [route('gw-b', 'top-3', 12)]),
    row('old-1', null, { intelligence: 58, terminal_bench_40: 60 }, [route('gw-a', 'old-1', 0.1, { effort_levels: [] })], { release_deprecated: true }),
    row('free-9', null, { intelligence: 20, terminal_bench_40: 10, automation_bench: 20 }, [route('gw-c', 'free-9', 0, { effort_levels: [] })]),
    row('notools-1-high', 'high', { intelligence: 59, terminal_bench_40: 61 }, [route('gw-a', 'notools-1', 0.2, { tools: false })]),
  ],
};

test('workload scores blend their parts and flag missing ones', () => {
  const coding = workloadScore(snapshot.models[2], 'coding');
  assert.equal(coding.value, 0.6 * 52 + 0.4 * 50);
  assert.equal(coding.estimated, false);
  const partial = workloadScore({ scores: { intelligence: 40 } }, 'coding');
  assert.deepEqual(partial, { value: 40, estimated: true });
  assert.equal(workloadScore({ scores: {} }, 'coding'), null);
  assert.equal(workloadScore({ scores: { scicode: 70 } }, 'metric:scicode').value, 70);
});

test('a route runs an AA variant only at an effort it offers', () => {
  const r = route('gw', 'm', 1, { effort_levels: ['none', 'low'] });
  assert.equal(variantForRoute({ effort: 'low', is_primary: false }, r), 'low');
  assert.equal(variantForRoute({ effort: 'non-reasoning', is_primary: false }, r), 'none');
  assert.equal(variantForRoute({ effort: 'high', is_primary: false }, r), undefined);
  const plain = route('gw', 'm', 1, { effort_levels: [] });
  assert.equal(variantForRoute({ effort: 'max', is_primary: true }, plain), null, 'no efforts: the default runs the primary variant');
  assert.equal(variantForRoute({ effort: 'low', is_primary: false }, plain), undefined);
});

test('legacy snapshots only trust an unambiguous provider/id pair', () => {
  assert.equal(routesOf({ gateway_providers: ['a', 'b'], gateway_ids: ['x', 'y'] }).length, 0);
  assert.equal(routesOf({ gateway_providers: ['a'], gateway_ids: ['x'], pricing: { gateway_cost_per_task_usd: 1 } })[0].model_id, 'x');
});

test('candidates skip superseded releases, max effort, tool-less routes and excluded ids', () => {
  const ids = buildCandidates(snapshot, { requireTools: true }).map((c) => c.id);
  assert.ok(!ids.some((id) => id.startsWith('gw-a/old-1')), 'deprecated');
  assert.ok(!ids.includes('gw-b/top-3#max'), 'max effort');
  assert.ok(!ids.some((id) => id.includes('notools')), 'tools: false');
  assert.ok(ids.includes('gw-b/mid-2-b#medium'), 'every route of a variant is a candidate');
  assert.ok(buildCandidates(snapshot, { allowMaxEffort: true }).some((c) => c.id === 'gw-b/top-3#max'));
  assert.ok(!buildCandidates(snapshot, { exclude: ['mid-*'] }).some((c) => c.model_id.startsWith('mid-')));
  assert.deepEqual([...new Set(buildCandidates(snapshot, { providers: ['gw-b'] }).map((c) => c.provider_id))], ['gw-b']);
  assert.ok(!buildCandidates(snapshot, { includeFree: false }).some((c) => c.free));
});

test('light work takes the cheap model, hard work pays for the frontier', () => {
  const cands = buildCandidates(snapshot, { requireTools: true });
  const light = recommend(cands, { workload: 'agentic', tier: 'light', profile: 'lean' });
  assert.equal(light.pick.model_id, 'swift-1');
  const standard = recommend(cands, { workload: 'coding', tier: 'standard', profile: 'balanced' });
  assert.equal(standard.pick.id, 'gw-a/mid-2#high', 'mid line clears the floor at a fraction of the frontier price');
  assert.equal(standard.stronger.id, 'gw-b/top-3#high');
  assert.match(standard.reason, /next step up: top-3#high/);
  const frontier = recommend(cands, { workload: 'coding', tier: 'frontier', profile: 'max' });
  assert.equal(frontier.pick.id, 'gw-b/top-3#high');
  assert.equal(frontier.pick.score_pct_of_best, 100);
});

test('the floor is relative to the best available score, and ties prefer cheaper routes', () => {
  const cands = buildCandidates(snapshot, { requireTools: true });
  const r = recommend(cands, { workload: 'coding', tier: 'hard', profile: 'balanced' });
  assert.ok(r.ranked.every((c) => c.score >= r.floor_share * r.best.score - 1e-9));
  const same = recommend(cands.filter((c) => c.slug === 'mid-2-medium'), { workload: 'coding', tier: 'light', profile: 'lean' });
  assert.equal(same.pick.id, 'gw-a/mid-2#medium', 'cheaper of two routes for the same variant');
  const preferred = recommend(cands.filter((c) => c.slug === 'mid-2-medium').map((c) => ({ ...c, cost: 0.4 })), { workload: 'coding', tier: 'light', profile: 'lean', preferProviders: ['gw-b'] });
  assert.equal(preferred.pick.provider_id, 'gw-b', 'equal cost: the preferred provider');
});

test('a free model is cheap, not infinitely good: it must clear the floor', () => {
  const cands = buildCandidates(snapshot, {});
  const r = recommend(cands, { workload: 'coding', tier: 'standard', profile: 'lean' });
  assert.notEqual(r.pick.model_id, 'free-9');
  assert.ok(MIN_COST > 0);
  const onlyWeak = recommend(cands.filter((c) => ['free-9', 'swift-1'].includes(c.model_id)), { workload: 'agentic', tier: 'light', profile: 'lean' });
  assert.equal(onlyWeak.pick.model_id, 'free-9', 'when it clears the floor, free wins light work');
  assert.ok(onlyWeak.pick.free);
});

test('roles use their workload, honour the policy and describe the current model', () => {
  const config = {
    roles: {
      commander: { model: 'gw-a/swift-1', variant: 'low' },
      implementer: { model: 'gw-a/mid-2#medium' },
      custom: { tier: 3, model: 'gw-b/top-3', variant: 'high', recommend: { workload: 'general' } },
    },
    model_policy: { providers: ['gw-a', 'gw-b'], exclude: ['notools-*'] },
  };
  const out = recommendRoles(snapshot, config);
  assert.deepEqual(out.providers, ['gw-a', 'gw-b']);
  const by = Object.fromEntries(out.roles.map((r) => [r.role, r]));
  assert.equal(by.commander.workload, 'agentic');
  assert.equal(by.implementer.current.variant, 'medium', 'inline #variant is read');
  assert.equal(by.implementer.current.known, true);
  assert.equal(by.custom.workload, 'general');
  assert.equal(by.custom.tier, 'hard', 'tier 3 maps to hard');
  for (const r of out.roles) for (const p of Object.values(r.picks)) assert.ok(['gw-a', 'gw-b'].includes(p.pick.provider_id));
  assert.equal(describeCurrent(snapshot, 'gw-a/<model>', null, 'coding').placeholder, true);
  assert.deepEqual(roleProfile('unknown', { tier: 1 }), { workload: 'general', tier: 'light', speed: 0 });
});

test('the providers default to those the roles already use', () => {
  const out = recommendRoles(snapshot, { roles: { implementer: { model: 'gw-b/mid-2-b', variant: 'medium' } } });
  assert.deepEqual(out.providers, ['gw-b']);
});

test('the document carries the grid, the roles and a file:// twin', () => {
  const doc = buildDocument(snapshot, { roles: { implementer: { model: 'gw-a/mid-2', variant: 'medium' } } }, { now: new Date('2026-01-02T00:00:00Z') });
  assert.equal(doc.roles.available, true);
  assert.ok(doc.grid.coding.standard.balanced.pick);
  assert.ok(!JSON.stringify(doc).includes('"row"'), 'no snapshot rows leak into the document');
  assert.equal(buildDocument(snapshot, null).roles.available, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  writeDocument(dir, doc);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'recommendations.json'), 'utf8')), JSON.parse(JSON.stringify(doc)));
  assert.match(fs.readFileSync(path.join(dir, 'recommendations.js'), 'utf8'), /^window\.__MODEL_RECOMMENDATIONS__ = /);
  fs.rmSync(dir, { recursive: true, force: true });
});
