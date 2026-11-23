// End-to-end test of compare.mjs against a fake Artificial Analysis cache.
// Uses only synthetic data; never touches the network (AA_BASE_URL points at
// an unreachable port for the stale-cache test) or the user's real catalog.
//
//   node --test test/

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogFile, writeFakeAaCache } from './synthetic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasGo = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;

let tmp;
let install; // simulated install dir: compare.mjs, parse_aa.mjs, aasync, web/

function env(extra = {}) {
  return {
    ...process.env,
    GATEWAY_COST_DIR: path.join(tmp, 'cost'),
    XDG_CACHE_HOME: path.join(tmp, 'cache'),
    ...extra,
  };
}

function compare(args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(install, 'compare.mjs'), ...args], {
    encoding: 'utf8', env: env(extraEnv),
  });
}

const aaCache = () => path.join(tmp, 'cache', 'ai-gateway', 'model-comparison', 'aa');
const outDir = () => path.join(tmp, 'cost', 'model-comparison');

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-e2e-'));
  install = path.join(tmp, 'install');
  fs.mkdirSync(path.join(install, 'web', 'assets'), { recursive: true });
  for (const f of ['compare.mjs', 'parse_aa.mjs']) fs.copyFileSync(path.join(ROOT, f), path.join(install, f));
  // A stand-in for the built web app: the real one is covered by `make install`.
  fs.writeFileSync(path.join(install, 'web', 'index.html'),
    '<!doctype html><script src="./data/models.js"></script><script defer src="./assets/app.js"></script>');
  fs.writeFileSync(path.join(install, 'web', 'assets', 'app.js'), '/* stub */');
  if (hasGo) {
    execFileSync('go', ['build', '-o', path.join(install, 'aasync'), './cmd/aasync'], { cwd: ROOT });
  }
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('missing catalog exits 1 with the refresh hint', () => {
  const r = compare(['--no-open']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No gateway catalog yet: run \/gateway-refresh first/);
});

test('offline without a cache exits 1 with a clear message', { skip: !hasGo }, () => {
  fs.mkdirSync(path.join(tmp, 'cost'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'cost', 'models.json'), JSON.stringify(catalogFile()));
  const r = compare(['--no-open', '--offline']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No cached Artificial Analysis data yet/);
});

test('builds a file:// dashboard from catalog + cached AA data', { skip: !hasGo }, () => {
  writeFakeAaCache(aaCache());
  const r = compare(['--no-open', '--offline', '--quiet']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Matched 13\/15 gateway models/);
  assert.match(r.stdout, /Dashboard: .*model-comparison\/index\.html/);
  assert.ok(r.stdout.trim().split('\n').length <= 3, 'summary is at most 3 lines');

  for (const f of ['index.html', 'assets/app.js', 'data/models.js']) {
    assert.ok(fs.existsSync(path.join(outDir(), f)), `${f} missing`);
  }
  const data = fs.readFileSync(path.join(outDir(), 'data', 'models.js'), 'utf8');
  assert.ok(data.startsWith('window.__MODEL_COMPARISON__ = {'));
  const snap = JSON.parse(data.slice('window.__MODEL_COMPARISON__ = '.length).replace(/;\s*$/, ''));
  assert.equal(snap.counts.catalog_rows, 15);
  assert.equal(snap.counts.unmatched, 2);
  // The same snapshot is also written as plain JSON for programmatic readers.
  const jsonSnap = JSON.parse(fs.readFileSync(path.join(outDir(), 'data', 'models.json'), 'utf8'));
  assert.deepEqual(jsonSnap, snap);
  assert.ok(!fs.readdirSync(path.join(outDir(), 'data')).some((f) => f.includes('.tmp-')), 'no tmp files left');
  const slugs = snap.models.map((m) => m.slug);
  assert.ok(slugs.includes('kestrel-pro-4-6') && slugs.includes('kestrel-pro-4-6-low'), 'all effort variants kept');
  const k = snap.models.find((m) => m.slug === 'kestrel-pro-4-6');
  assert.equal(k.pricing.price_source, 'gateway');
  assert.equal(k.pricing.gateway_input_per_1m, 3);
  assert.equal(k.pricing.provider_host, 'Amazon Bedrock');

  // The gateway base URL from the catalog must never reach any output file.
  for (const dir of [outDir(), path.join(tmp, 'cache')]) {
    for (const file of walk(dir)) {
      if (file.endsWith('.bin')) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes('example.invalid'), `${file} leaks the gateway URL`);
      assert.ok(!/"base_url"/.test(text), `${file} contains base_url`);
    }
  }
});

test('--refresh with an unreachable AA falls back to the stale cache and says so', { skip: !hasGo }, () => {
  // Make the cache look 2 days old; the network target refuses connections.
  fs.rmSync(aaCache(), { recursive: true, force: true });
  writeFakeAaCache(aaCache(), new Date(Date.now() - 48 * 3600_000).toISOString());
  const r = compare(['--no-open', '--quiet', '--refresh'], { AA_BASE_URL: 'http://127.0.0.1:1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Note: the AA fetch failed, so cached data from .* was used \(stale\)/);
});

test('unknown flags fail with usage', () => {
  const r = compare(['--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown argument: --bogus/);
});

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
