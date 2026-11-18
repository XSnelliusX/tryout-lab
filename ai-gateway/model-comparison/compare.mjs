#!/usr/bin/env node
/**
 * compare.mjs - build and open the model comparison dashboard.
 *
 *   node compare.mjs [--refresh] [--offline] [--no-open] [--quiet]
 *
 * Pipeline
 *   1. Read the gateway catalog the ai-gateway plugin writes:
 *      $GATEWAY_COST_DIR/models.json (default ~/.gateway-cost/models.json).
 *   2. Run parse_aa.mjs: fetch public Artificial Analysis (AA) pages into a
 *      cache (24h freshness), match every catalog row to an AA release.
 *   3. Run the aasync joiner: merge catalog prices/limits with AA data into
 *      data/models.js (a classic script that sets window.__MODEL_COMPARISON__).
 *   4. Assemble $GATEWAY_COST_DIR/model-comparison/ (index.html, assets, data)
 *      so the dashboard opens straight from file:// without a server.
 *   5. Open index.html (macOS `open`, Linux `xdg-open`) unless --no-open.
 *
 * Gateway information comes only from the catalog file. This script never
 * contacts a gateway, and never writes the catalog's base_url anywhere.
 *
 * Node >= 22, no npm dependencies. Data: Artificial Analysis
 * (https://artificialanalysis.ai); its terms restrict redistribution.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_AGE_MINUTES = 24 * 60;
const CACHE_PRUNE_DAYS = 14;

const HELP = `Usage: node compare.mjs [options]

Builds the model comparison dashboard from the gateway catalog and public
Artificial Analysis data, then opens it.

Options:
  --refresh    Ignore the 24h AA cache and fetch again
  --offline    Never touch the network; use the cached AA data
  --no-open    Build only; do not open the dashboard
  --quiet      Suppress progress messages (the summary is still printed)
  --verbose    Show the AA fetcher's detailed log
  -h, --help   Show this help

Environment:
  GATEWAY_COST_DIR   Catalog and output location (default ~/.gateway-cost)
  XDG_CACHE_HOME     Cache root (default ~/.cache); cache lives in
                     <root>/ai-gateway/model-comparison
  GATEWAY_PROVIDER_PREFIX  Optional provider-id prefix (default "acc")`;

class UserError extends Error {}

function parseArgs(argv) {
  const opts = { refresh: false, offline: false, open: true, quiet: false, verbose: false };
  for (const a of argv) {
    switch (a) {
      case '--refresh': opts.refresh = true; break;
      case '--offline': opts.offline = true; break;
      case '--no-open': opts.open = false; break;
      case '--quiet': opts.quiet = true; break;
      case '--verbose': opts.verbose = true; break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new UserError(`Unknown argument: ${a}\n\n${HELP}`);
    }
  }
  if (opts.refresh && opts.offline) throw new UserError('--refresh and --offline cannot be combined');
  return opts;
}

function paths() {
  const home = os.homedir();
  const costDir = process.env.GATEWAY_COST_DIR || path.join(home, '.gateway-cost');
  const cacheRoot = path.join(
    process.env.XDG_CACHE_HOME || path.join(home, '.cache'),
    'ai-gateway',
    'model-comparison',
  );
  return {
    costDir,
    catalog: path.join(costDir, 'models.json'),
    cacheRoot,
    aaCache: path.join(cacheRoot, 'aa'),
    work: path.join(cacheRoot, 'out'),
    outDir: path.join(costDir, 'model-comparison'),
  };
}

function findRuntime() {
  const parse = path.join(HERE, 'parse_aa.mjs');
  if (!fs.existsSync(parse)) throw new UserError(`parse_aa.mjs not found next to compare.mjs (${HERE})`);

  const webCandidates = [path.join(HERE, 'web'), path.join(HERE, 'web', 'dist')];
  const web = webCandidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (!web) {
    throw new UserError('Dashboard web app not found (expected web/index.html). Run `make install DEST=<dir>` to build it.');
  }

  let joiner = null;
  for (const c of [path.join(HERE, 'aasync'), path.join(HERE, 'bin', 'aasync')]) {
    if (fs.existsSync(c)) { joiner = { cmd: c, args: [], cwd: HERE }; break; }
  }
  if (!joiner && fs.existsSync(path.join(HERE, 'cmd', 'aasync', 'main.go'))
      && spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0) {
    joiner = { cmd: 'go', args: ['run', './cmd/aasync'], cwd: HERE };
  }
  if (!joiner) throw new UserError('Joiner binary (aasync) not found. Run `make install DEST=<dir>` to build it.');
  return { parse, web, joiner };
}

function readCatalog(file) {
  if (!fs.existsSync(file)) throw new UserError('No gateway catalog yet: run /gateway-refresh first');
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UserError(`Gateway catalog ${file} is not valid JSON (${err.message}). Run /gateway-refresh to rebuild it.`);
  }
  const rows = Array.isArray(json) ? json : json.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new UserError(`Gateway catalog ${file} has no model rows. Run /gateway-refresh to rebuild it.`);
  }
  return { rows, generatedAt: Array.isArray(json) ? null : json.generated_at ?? null };
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function tail(text, lines = 12) {
  return String(text || '').trim().split('\n').slice(-lines).join('\n');
}

function formatAge(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unknown age';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 120) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Remove cached AA files that have not been refreshed for a long time. */
function pruneCache(dir) {
  const cutoff = Date.now() - CACHE_PRUNE_DAYS * 86_400_000;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const meta = path.join(dir, name);
    try {
      if (fs.statSync(meta).mtimeMs >= cutoff) continue;
      fs.rmSync(meta, { force: true });
      fs.rmSync(meta.replace(/\.json$/, '.bin'), { force: true });
    } catch { /* ignore */ }
  }
}

/**
 * Also publish the dashboard data as plain JSON (for tools that read it
 * programmatically). The same object as models.js, written tmp + rename.
 */
function writeJsonCopy(dataFile, target) {
  const text = fs.readFileSync(dataFile, 'utf8');
  const start = text.indexOf('=');
  const snapshot = JSON.parse(text.slice(start + 1).replace(/;\s*$/, ''));
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
  fs.renameSync(tmp, target);
}

function assemble({ web, dataFile, outDir }) {
  const staging = `${outDir}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.cpSync(web, staging, { recursive: true });
  fs.mkdirSync(path.join(staging, 'data'), { recursive: true });
  fs.copyFileSync(dataFile, path.join(staging, 'data', 'models.js'));
  writeJsonCopy(dataFile, path.join(staging, 'data', 'models.json'));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(staging, outDir);
}

function openFile(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [file], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (Number.parseInt(process.versions.node, 10) < 22) {
    throw new UserError(`Node 22 or newer is required (found ${process.versions.node}).`);
  }
  const opts = parseArgs(process.argv.slice(2));
  const progress = (msg) => { if (!opts.quiet) console.error(msg); };
  const p = paths();

  const catalog = readCatalog(p.catalog);
  const rt = findRuntime();
  fs.mkdirSync(p.aaCache, { recursive: true });
  fs.mkdirSync(p.work, { recursive: true });

  // 1. Fetch/cache AA data and match it to the catalog.
  progress(`Matching ${catalog.rows.length} gateway models against Artificial Analysis data${opts.offline ? ' (offline)' : ''}...`);
  const parseArgsList = [
    rt.parse,
    '--input', p.catalog,
    '--out-dir', p.work,
    '--cache-dir', p.aaCache,
    '--max-age-minutes', String(MAX_AGE_MINUTES),
  ];
  if (opts.refresh) parseArgsList.push('--refresh');
  if (opts.offline) parseArgsList.push('--offline');
  if (!opts.verbose) parseArgsList.push('--quiet');
  const parsed = run(process.execPath, parseArgsList, HERE);
  if (opts.verbose && parsed.stderr) process.stderr.write(parsed.stderr);
  if (parsed.status !== 0) {
    const detail = tail(parsed.stderr);
    if (/Offline mode: no cache/.test(detail)) {
      throw new UserError('No cached Artificial Analysis data yet. Run once without --offline to fill the cache.');
    }
    throw new UserError(`Artificial Analysis step failed:\n${detail || '(no output)'}\n`
      + 'If the AA site changed its page format, see "Troubleshooting" in the README.');
  }

  const enriched = path.join(p.work, 'models_aa_enriched.json');
  const metaFile = path.join(p.work, 'aa_run_metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

  // 2. Join catalog rows with AA data into a classic-script data file.
  progress('Building dashboard data...');
  const dataFile = path.join(p.work, 'models.js');
  const joined = run(rt.joiner.cmd, [...rt.joiner.args, '--enriched', enriched, '--out', dataFile, '--format', 'js'], rt.joiner.cwd);
  if (joined.status !== 0) {
    throw new UserError(`Joiner failed:\n${tail(joined.stderr || joined.stdout) || '(no output)'}`);
  }

  // 3. Assemble the file:// dashboard.
  assemble({ web: rt.web, dataFile, outDir: p.outDir });
  if (!opts.offline) pruneCache(p.aaCache);
  const index = path.join(p.outDir, 'index.html');

  // 4. Summary.
  const s = meta.summary;
  const fetchedAt = meta.source?.fetched_at;
  const fetchInfo = meta.source?.fetch ?? {};
  const lines = [
    `Matched ${s.matched_rows}/${s.gateway_rows} gateway models to Artificial Analysis (${s.unmatched_rows} unmatched); `
      + `AA data fetched ${fetchedAt ? `${formatAge(fetchedAt)} (${formatStamp(fetchedAt)})` : 'at an unknown time'}`
      + `${catalog.generatedAt ? `, catalog from ${formatStamp(catalog.generatedAt)}` : ''}.`,
  ];
  if (fetchInfo.stale_fallback > 0) {
    lines.push(`Note: the AA fetch failed, so cached data from ${formatStamp(fetchInfo.stale_fallback_oldest)} was used (stale).`);
  } else if (opts.offline && fetchedAt && Date.now() - new Date(fetchedAt).getTime() > MAX_AGE_MINUTES * 60_000) {
    lines.push('Note: offline mode used cached AA data older than 24h; run with --refresh to update.');
  }
  lines.push(`Dashboard: ${index}`);
  console.log(lines.join('\n'));

  if (opts.open && !openFile(index)) {
    console.error(`Could not open the dashboard automatically; open ${index} in a browser.`);
  }
}

main().catch((err) => {
  if (err instanceof UserError) console.error(err.message);
  else console.error(`ERROR: ${err.stack || err.message || err}`);
  process.exit(1);
});
