import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, stopPrevious } from '../server.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for sync');
}

test('opens with old data, syncs gateway then AA, and supports a protected manual retry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-server-'));
  const web = path.join(root, 'web'), cost = path.join(root, 'cost');
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(path.join(cost, 'model-comparison', 'data'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<title>dashboard</title>');
  fs.writeFileSync(path.join(cost, 'model-comparison', 'data', 'models.json'), '{"old":true}');
  const jobs = [];
  const runner = (_cmd, args) => { const job = deferred(); jobs.push({ args, ...job }); return job.promise; };
  const { server, url } = await startServer({ web, cost, runner });
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const status = async () => (await fetch(`${url}api/status`)).json();
  assert.equal((await fetch(url)).status, 200);
  assert.deepEqual(await (await fetch(`${url}data/models.json`)).json(), { old: true });
  assert.equal((await status()).phase, 'gateway');
  assert.equal(jobs[0].args.at(-1), 'refresh');
  const origin = new URL(url).origin;
  assert.equal((await fetch(`${url}api/sync`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${url}api/sync`, { method: 'POST', headers: { origin: 'https://evil.example', 'x-model-comparison': 'sync' } })).status, 403);
  assert.equal((await fetch(`${url}api/sync`, { method: 'POST', headers: { origin, 'x-model-comparison': 'sync' } })).status, 202);
  assert.equal(jobs.length, 1, 'concurrent syncs are coalesced');
  jobs[0].resolve('gateway ok');
  await until(() => jobs.length === 2);
  assert.equal((await status()).phase, 'aa');
  assert.ok(jobs[1].args.includes('--refresh'));
  jobs[1].resolve('Note: the AA fetch failed, so cached data was used (stale).');
  await until(async () => (await status()).phase === 'idle');
  assert.equal((await status()).revision, 1);
  assert.match((await status()).warning, /stale/);
  assert.equal((await fetch(`${url}api/sync`, { method: 'POST', headers: { origin, 'x-model-comparison': 'sync' } })).status, 202);
  assert.equal(jobs.length, 3);
  jobs[2].reject(new Error('gateway unavailable'));
  await until(async () => (await status()).phase === 'error');
  assert.match((await status()).error, /gateway unavailable/);
  assert.equal(jobs.length, 3, 'AA is not run after gateway failure');
  assert.deepEqual(await (await fetch(`${url}data/models.json`)).json(), { old: true });
});

test('serves the app even before a first snapshot exists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-empty-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'hello');
  const job = deferred();
  const { server, url } = await startServer({ web: root, cost: root, runner: () => job.promise });
  t.after(() => { job.reject(new Error('stopped')); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await (await fetch(url)).text(), 'hello');
  assert.equal(await (await fetch(`${url}data/models.js`)).text(), '');
  assert.equal((await fetch(`${url}data/models.json`)).status, 404);
});

test('serves live recommendations and the usage dashboard under the same capability URL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-usage-'));
  const web = path.join(root, 'web'), cost = path.join(root, 'cost'), ccConfig = path.join(root, 'cc.json');
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(path.join(cost, 'model-comparison', 'data'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), 'app');
  const snapshot = { schema_version: 3, generated_at: 'now', models: [{
    slug: 'm-1', name: 'M 1', creator: 'Synth', effort: null, is_primary: true, scores: { intelligence: 40, terminal_bench_40: 40 },
    gateway_routes: [{ provider_id: 'gw', model_id: 'm-1', cost_per_task_usd: 0.1, effort_levels: [], tools: true, output_tokens_per_second: 50 }],
  }] };
  fs.writeFileSync(path.join(cost, 'model-comparison', 'data', 'models.json'), JSON.stringify(snapshot));
  fs.writeFileSync(ccConfig, JSON.stringify({ roles: { implementer: { model: 'gw/m-1' } } }));
  fs.writeFileSync(path.join(cost, 'dashboard.html'), '<html><script>window.ok = 1</script></html>');
  fs.writeFileSync(path.join(cost, 'usage-log.js'), 'window.GATEWAY_USAGE_LOG = ""');
  const job = deferred();
  const { server, url } = await startServer({ web, cost, ccConfig, runner: () => job.promise });
  t.after(() => { job.reject(new Error('stopped')); server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const rec = await (await fetch(`${url}data/recommendations.json`)).json();
  assert.equal(rec.roles.available, true);
  assert.equal(rec.roles.roles[0].picks.balanced.pick.id, 'gw/m-1');
  // Applying a new model in the Herdr config is visible without a rebuild.
  fs.writeFileSync(ccConfig, JSON.stringify({ roles: { reviewer: { model: 'gw/m-1' } } }));
  assert.equal((await (await fetch(`${url}data/recommendations.json`)).json()).roles.roles[0].role, 'reviewer');
  assert.match(await (await fetch(`${url}data/recommendations.js`)).text(), /^window\.__MODEL_RECOMMENDATIONS__ = /);

  const redirect = await fetch(`${url}usage`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  const page = await fetch(`${url}usage/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window\.ok = 1/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(await (await fetch(`${url}usage/usage-log.js`)).text(), /GATEWAY_USAGE_LOG/);
  assert.equal(await (await fetch(`${url}usage/config.js`)).text(), '', 'a missing config.js is an empty script');
  assert.equal((await fetch(`${url}usage/usage.jsonl`)).status, 404, 'only the two data scripts are served');
  assert.equal((await fetch(`${url.replace(/\/[0-9a-f]{64}\/$/, '/')}usage/`)).status, 404, 'the token is required');
});

test('applies role picks to the Herdr config: protected, validated, backed up, model and variant only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-apply-'));
  const web = path.join(root, 'web'), cost = path.join(root, 'cost'), ccConfig = path.join(root, 'cc.json');
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(path.join(cost, 'model-comparison', 'data'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), 'app');
  const snapshot = { schema_version: 3, generated_at: 'now', models: [
    { slug: 'm-1', name: 'M 1', creator: 'S', effort: null, is_primary: true, scores: { intelligence: 40 },
      gateway_routes: [{ provider_id: 'gw', model_id: 'm-1', cost_per_task_usd: 0.1, effort_levels: [], tools: true }] },
    { slug: 'm-2-high', name: 'M 2 (High)', creator: 'S', effort: 'high', is_primary: false, scores: { intelligence: 60 },
      gateway_routes: [{ provider_id: 'gw', model_id: 'm-2', cost_per_task_usd: 0.5, effort_levels: ['low', 'high'], tools: true }] },
  ] };
  fs.writeFileSync(path.join(cost, 'model-comparison', 'data', 'models.json'), JSON.stringify(snapshot));
  const original = { budget: { monthly_cap_usd: 1 }, roles: { implementer: { model: 'gw/m-1', prompt: 'keep me' }, reviewer: { model: 'gw/m-1', variant: 'low' } } };
  fs.writeFileSync(ccConfig, JSON.stringify(original, null, 2) + '\n');
  process.env.SETUP_BACKUP_DIR = path.join(root, 'backup');
  const job = deferred();
  const { server, url } = await startServer({ web, cost, ccConfig, runner: () => job.promise });
  t.after(() => { delete process.env.SETUP_BACKUP_DIR; job.reject(new Error('stopped')); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = new URL(url).origin;
  const post = (body, headers = { origin, 'x-model-comparison': 'apply', 'content-type': 'application/json' }) =>
    fetch(`${url}api/roles/apply`, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await post({ changes: [] }, { 'content-type': 'application/json' })).status, 403, 'needs the page origin and header');
  assert.equal((await post({ changes: [{ role: 'implementer', model: 'gw/m-2', variant: 'high' }] }, { origin: 'https://evil.example', 'x-model-comparison': 'apply', 'content-type': 'application/json' })).status, 403);
  assert.equal((await post({ changes: [{ role: 'nobody', model: 'gw/m-2', variant: 'high' }] })).status, 400, 'unknown role');
  assert.equal((await post({ changes: [{ role: 'implementer', model: 'gw/not-there', variant: null }] })).status, 400, 'only routes in the data');
  assert.deepEqual(JSON.parse(fs.readFileSync(ccConfig, 'utf8')), original, 'a rejected request writes nothing');

  const ok = await post({ changes: [{ role: 'implementer', model: 'gw/m-2', variant: 'high' }, { role: 'reviewer', model: 'gw/m-1', variant: null }] });
  assert.equal(ok.status, 200);
  const result = await ok.json();
  assert.deepEqual(result.applied.map((a) => a.to), ['gw/m-2#high', 'gw/m-1']);
  const written = JSON.parse(fs.readFileSync(ccConfig, 'utf8'));
  assert.deepEqual(written.roles.implementer, { model: 'gw/m-2', prompt: 'keep me', variant: 'high' });
  assert.deepEqual(written.roles.reviewer, { model: 'gw/m-1' }, 'a default variant drops the key');
  assert.deepEqual(written.budget, original.budget);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup, 'utf8')), original, 'the old config is backed up');
});

test('a hidden tab does not keep the server alive, a visible one does, and the lifetime is capped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-idle-'));
  const web = path.join(root, 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), 'app');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const closed = (server) => new Promise((resolve) => server.once('close', resolve));
  const poll = (url, visible, until) => (async () => { while (!until.done) { await fetch(`${url}api/status?visible=${visible}`).catch(() => {}); await new Promise((r) => setTimeout(r, 40)); } })();

  // Hidden polls only: closes after the idle time.
  const hidden = await startServer({ web, cost: root, runner: async () => 'ok', idleMs: 300 });
  const stopHidden = { done: false };
  void poll(hidden.url, 0, stopHidden);
  const t0 = Date.now();
  await closed(hidden.server);
  stopHidden.done = true;
  assert.ok(Date.now() - t0 < 3000, 'closed despite hidden polling');

  // Visible polls keep it open past the idle time, until the lifetime cap.
  const visible = await startServer({ web, cost: root, runner: async () => 'ok', idleMs: 300, maxLifetimeMs: 1500 });
  const stopVisible = { done: false };
  void poll(visible.url, 1, stopVisible);
  const t1 = Date.now();
  await closed(visible.server);
  stopVisible.done = true;
  assert.ok(Date.now() - t1 >= 1000, 'a visible page kept it open beyond the idle time');
});

test('a new start stops only a previous dashboard server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-pid-'));
  const pidFile = path.join(root, 'server.pid');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  fs.writeFileSync(pidFile, `${other.pid}\n`);
  assert.equal(stopPrevious(pidFile), false, 'an unrelated process is left alone');
  other.kill();
  const fake = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'server.mjs', '--serve']);
  fs.writeFileSync(pidFile, `${fake.pid}\n`);
  const exited = new Promise((resolve) => fake.once('exit', resolve));
  assert.equal(stopPrevious(pidFile), true);
  await exited;
  assert.equal(stopPrevious(path.join(root, 'missing.pid')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
