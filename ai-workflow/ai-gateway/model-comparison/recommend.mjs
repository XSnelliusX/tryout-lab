#!/usr/bin/env node
/**
 * recommend.mjs - files and command line for the recommendation engine (engine.mjs).
 *
 *   node recommend.mjs roles [--profile lean|balanced|max] [--json]   picks per Herdr role
 *   node recommend.mjs tiers [--workload coding] [--json]             picks per workload and tier
 *   node recommend.mjs write                                          (re)write data/recommendations.{json,js}
 *
 * Options: --snapshot <models.json> (default $GATEWAY_COST_DIR/model-comparison/data/models.json),
 * --config <Herdr models.json> (default $CC_CONFIG or ~/.config/command-center/models.json).
 * How picks are made: see engine.mjs. Node >= 22, no dependencies.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, TIERS, WORKLOADS, buildDocument, describeCurrent, formatCost, label, recommendGrid, recommendRoles } from './engine.mjs';

export * from './engine.mjs';

export function defaultPaths(env = process.env) {
  const costDir = env.GATEWAY_COST_DIR || path.join(os.homedir(), '.gateway-cost');
  const expand = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
  return {
    snapshot: path.join(costDir, 'model-comparison', 'data', 'models.json'),
    dataDir: path.join(costDir, 'model-comparison', 'data'),
    ccConfig: expand(env.CC_CONFIG) || path.join(os.homedir(), '.config', 'command-center', 'models.json'),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
/** Writes data/recommendations.json and the file:// twin data/recommendations.js. */
export function writeDocument(dataDir, doc) {
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(doc);
  for (const [name, text] of [['recommendations.json', `${json}\n`], ['recommendations.js', `window.__MODEL_RECOMMENDATIONS__ = ${json};\n`]]) {
    const target = path.join(dataDir, name);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  }
}

export function loadConfig(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/**
 * Writes picks into the Herdr Command Center config, as `cc-models recommend
 * --apply` does: only `model` and `variant` of the named roles change, the old
 * file is copied to ~/.setup_backup/<stamp>/ (or $SETUP_BACKUP_DIR) first, and
 * the new one replaces it atomically. Every change must name a configured role
 * and a gateway route + variant that exists in the snapshot, so nothing else can
 * be written. changes: [{ role, model: 'provider/model', variant|null }].
 * Returns { applied: [{ role, from, to }], backup }; throws with a message
 * fit for the user on invalid input.
 */
export function applyRoleChanges(configFile, snapshot, changes, { env = process.env, now = new Date() } = {}) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 64) throw new Error('No changes to apply.');
  const raw = fs.readFileSync(configFile, 'utf8');
  const config = JSON.parse(raw);
  if (!config?.roles || typeof config.roles !== 'object') throw new Error(`No roles in ${configFile}.`);
  const applied = [];
  for (const change of changes) {
    const role = typeof change?.role === 'string' ? change.role : '';
    const model = typeof change?.model === 'string' ? change.model : '';
    const variant = change?.variant === null || change?.variant === undefined || change?.variant === '' ? null : String(change.variant);
    if (!Object.prototype.hasOwnProperty.call(config.roles, role)) throw new Error(`Unknown role "${role}".`);
    if (!/^[\w.-]+\/[\w.:-]+$/.test(model) || (variant !== null && !/^[\w-]+$/.test(variant))) throw new Error(`Invalid model for ${role}.`);
    if (!describeCurrent(snapshot, model, variant, null, null).known) throw new Error(`${model}${variant ? `#${variant}` : ''} is not a gateway route in the current data.`);
    const spec = config.roles[role];
    const from = `${spec.model ?? ''}${spec.variant ? `#${spec.variant}` : ''}`;
    spec.model = model;
    if (variant) spec.variant = variant;
    else delete spec.variant;
    applied.push({ role, from, to: `${model}${variant ? `#${variant}` : ''}` });
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const home = os.homedir();
  const rel = configFile.startsWith(home + path.sep) ? path.relative(home, configFile) : path.join('_root', configFile);
  const backup = path.join(env.SETUP_BACKUP_DIR || path.join(home, '.setup_backup', stamp), rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, raw);
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configFile);
  return { applied, backup };
}

function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r, n) => {
    const line = r.map((v, i) => String(v).padEnd(w[i])).join('  ').trimEnd();
    return n === 0 ? `${line}\n${w.map((x) => '-'.repeat(x)).join('  ')}` : line;
  }).join('\n');
}

function cli(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (['--profile', '--workload', '--snapshot', '--config', '--data-dir'].includes(a)) args[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  const cmd = args._[0];
  if (args.help || !['roles', 'tiers', 'write'].includes(cmd)) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 11).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    return cmd && !args.help ? 2 : 0;
  }
  const paths = defaultPaths();
  const snapshotFile = args.snapshot || paths.snapshot;
  let snapshot;
  try {
    snapshot = readJson(snapshotFile);
  } catch (err) {
    console.error(`No model comparison data at ${snapshotFile} (${err.code || err.message}). Run /model-comparison first.`);
    return 1;
  }
  if (!(snapshot.schema_version >= 3)) console.error(`Note: ${snapshotFile} is schema ${snapshot.schema_version}; rebuild it (/model-comparison) for exact gateway routes.`);
  const configFile = args.config || paths.ccConfig;

  if (cmd === 'write') {
    writeDocument(args['data-dir'] || path.dirname(snapshotFile), buildDocument(snapshot, loadConfig(configFile)));
    return 0;
  }
  if (cmd === 'roles') {
    const config = loadConfig(configFile);
    if (!config?.roles) {
      console.error(`No Command Center config with roles at ${configFile}.`);
      return 1;
    }
    const result = recommendRoles(snapshot, config);
    if (args.json) {
      console.log(JSON.stringify({ data: snapshot.generated_at, config: configFile, ...result }, null, 2));
      return 0;
    }
    const profiles = args.profile ? [args.profile] : PROFILES;
    const head = ['role', 'workload/tier', 'current', 'score', '$/task', ...profiles.flatMap((p) => [p, 'score', '$/task'])];
    const lines = result.roles.map((r) => [
      r.role, `${r.workload}/${r.tier}`, r.current.id.split('/').pop() + (r.current.deprecated ? ' (old)' : ''), r.current.score ?? '-', formatCost(r.current.cost_per_task_usd),
      ...profiles.flatMap((p) => {
        const pick = r.picks[p]?.pick;
        return pick ? [pick.id === r.current.id ? '=' : label(pick), pick.score, formatCost(pick.cost_per_task_usd)] : ['-', '-', '-'];
      }),
    ]);
    console.log(`data ${snapshot.generated_at}   providers ${result.providers.join(', ')}\n`);
    console.log(table([head, ...lines]));
    return 0;
  }
  const grid = recommendGrid(snapshot);
  if (args.json) {
    console.log(JSON.stringify(args.workload ? grid[args.workload] : grid, null, 2));
    return 0;
  }
  for (const workload of args.workload ? [args.workload] : Object.keys(WORKLOADS)) {
    console.log(`\n${WORKLOADS[workload].label} (${workload})`);
    const lines = Object.keys(TIERS).map((tier) => [tier, ...PROFILES.map((p) => {
      const r = grid[workload][tier][p];
      return r ? `${label(r.pick)} ${r.pick.score} ${formatCost(r.pick.cost_per_task_usd)}` : '-';
    })]);
    console.log(table([['tier', ...PROFILES], ...lines]));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = cli(process.argv.slice(2));
}
