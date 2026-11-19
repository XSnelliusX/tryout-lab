#!/usr/bin/env node
// Local-only dashboard server. A capability URL and strict Origin/Host checks
// prevent other websites from reading the snapshot or triggering a sync.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COST = process.env.GATEWAY_COST_DIR || path.join(os.homedir(), '.gateway-cost');

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output.trim() || `Process exited ${code}`)));
  });
}

export async function startServer({ web = path.join(HERE, 'web'), cost = COST, gateway = path.join(HERE, '..', 'index.ts'),
  compare = path.join(HERE, 'compare.mjs'), runner = run, open = false, idleMs = 30 * 60_000 } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const prefix = `/${token}/`;
  const env = { ...process.env, GATEWAY_COST_DIR: cost };
  let state = { phase: 'gateway', message: 'Checking gateway models…', revision: 0, error: null, warning: null };
  let active = false;
  let lastActivity = Date.now();
  let origin;

  async function sync() {
    if (active) return;
    active = true;
    state = { ...state, phase: 'gateway', message: 'Checking gateway models…', error: null, warning: null };
    try {
      await runner(process.execPath, [gateway, 'refresh'], env);
      state = { ...state, phase: 'aa', message: 'Fetching Artificial Analysis data…' };
      const output = await runner(process.execPath, [compare, '--refresh', '--no-open', '--quiet'], env);
      const warning = output.split('\n').find((line) => line.startsWith('Note:')) || null;
      state = { ...state, phase: 'idle', message: 'Sync complete', revision: state.revision + 1, warning };
    } catch (err) {
      state = { ...state, phase: 'error', message: 'Sync failed', error: String(err.message || err).slice(-3000) };
    } finally { active = false; }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
    lastActivity = Date.now();
    const route = url.pathname.slice(prefix.length);
    if (route === 'api/status' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state));
      return;
    }
    if (route === 'api/sync' && req.method === 'POST') {
      if (req.headers.origin !== origin || req.headers['x-model-comparison'] !== 'sync') { res.writeHead(403).end(); return; }
      void sync();
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify(state));
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (route === 'data/models.js' || route === 'data/models.json') {
      const file = path.join(cost, 'model-comparison', 'data', path.basename(route));
      res.setHeader('Content-Type', route.endsWith('.js') ? 'application/javascript' : 'application/json');
      if (!fs.existsSync(file)) { if (route.endsWith('.js')) res.end(''); else res.writeHead(404).end(); return; }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return;
    }
    const relative = route || 'index.html';
    if (!/^(index\.html|favicon\.svg|assets\/[a-zA-Z0-9._-]+)$/.test(relative)) { res.writeHead(404).end(); return; }
    const file = path.join(web, relative);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}${prefix}`;
  // Queue the first sync before opening the page so the first status is busy.
  void sync();
  if (open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  }
  const timer = setInterval(() => { if (!active && Date.now() - lastActivity > idleMs) server.close(); }, Math.min(idleMs, 60_000));
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return { server, url, sync };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--serve')) {
    startServer({ open: true }).then(() => {
      if (process.send) process.send({ ready: true }, () => process.disconnect());
    }).catch((err) => {
      if (process.send) process.send({ error: String(err.message || err) }, () => process.disconnect());
      else console.error(err);
      process.exitCode = 1;
    });
  } else {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
    child.on('error', (err) => { console.error(`Unable to start dashboard: ${err.message}`); process.exitCode = 1; });
    let acknowledged = false;
    child.on('message', (message) => {
      acknowledged = true;
      if (message.error) { console.error(`Unable to start dashboard: ${message.error}`); process.exitCode = 1; }
      else console.log('Opening model comparison; gateway and AA sync in the background.');
      child.unref();
    });
    child.on('exit', (code) => { if (!acknowledged) { console.error(`Dashboard server exited before starting (${code}).`); process.exitCode = 1; } });
  }
}
