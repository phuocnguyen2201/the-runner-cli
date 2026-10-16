#!/usr/bin/env node
// claude-runner-ui — web UI for starting headless Claude Code jobs and browsing their history.
// Zero dependencies: Node >= 20 built-ins only.

import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  ROOT, RUN_ID_RE, loadConfig, newRunId, runDir, readJson, updateStatus, isAlive, activeLock,
} from './lib/config.mjs';

const cfg = loadConfig();
const host = resolveHost(cfg.host);
const INDEX = join(ROOT, 'public', 'index.html');
const MAX_REQUEST = 500;
let startingId = null; // run spawned by this server that may not hold the lock yet

recoverStaleRuns();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return send(res, 200, readFileSync(INDEX), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && path === '/api/config') {
      return json(res, 200, {
        project: basename(cfg.projectDir),
        presets: cfg.presets,
        mail: Boolean(cfg.mail?.to),
        timeout: cfg.timeout,
      });
    }
    if (req.method === 'GET' && path === '/api/runs') {
      return json(res, 200, { active: activeRunId(), runs: listRuns() });
    }
    if (req.method === 'POST' && path === '/api/runs') {
      return startRun(req, res);
    }

    const m = path.match(/^\/api\/runs\/([^/]+)(\/cancel)?$/);
    if (m && RUN_ID_RE.test(m[1])) {
      const dir = runDir(cfg, m[1]);
      if (!existsSync(dir)) return json(res, 404, { error: 'run not found' });
      if (req.method === 'GET' && !m[2]) return json(res, 200, runDetail(m[1], dir));
      if (req.method === 'POST' && m[2]) return cancelRun(res, dir);
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(cfg.port, host, () => {
  console.log(`claude-runner-ui listening on http://${host}:${cfg.port} (project: ${cfg.projectDir})`);
});

// ── handlers ───────────────────────────────────────────────────────────────

async function startRun(req, res) {
  if (activeRunId()) {
    return json(res, 409, { error: 'A job is already running.' });
  }
  const body = await readBody(req);
  const request = String(body.request ?? '').trim();
  if (!request) return json(res, 400, { error: 'request is required' });
  if (request.length > MAX_REQUEST) return json(res, 400, { error: `request is longer than ${MAX_REQUEST} characters` });

  let id = newRunId();
  while (existsSync(runDir(cfg, id))) id = newRunId(new Date(Date.now() + 1000));
  const dir = runDir(cfg, id);
  mkdirSync(dir, { recursive: true });
  updateStatus(dir, { id, request, trigger: 'web', state: 'queued', createdAt: new Date().toISOString() });

  // Detached + argv array: survives the browser and server going away, no shell parsing of the request.
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'run-job.mjs'), id, request, 'web'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  updateStatus(dir, { pid: child.pid });
  startingId = id;
  json(res, 202, { id });
}

function cancelRun(res, dir) {
  const status = readJson(join(dir, 'status.json'), {});
  if (!['queued', 'running'].includes(status.state) || !isAlive(status.pid)) {
    return json(res, 409, { error: 'run is not active' });
  }
  process.kill(status.pid, 'SIGTERM'); // run-job stops claude's process group and records "cancelled"
  json(res, 202, { ok: true });
}

// ── data ───────────────────────────────────────────────────────────────────

function activeRunId() {
  const locked = activeLock(cfg)?.id;
  if (locked) return locked;
  if (startingId) {
    const dir = runDir(cfg, startingId);
    const status = checkStale(dir, readJson(join(dir, 'status.json'), {}));
    if (status.state === 'queued') return startingId;
    startingId = null;
  }
  return null;
}

function listRuns() {
  return readdirSync(cfg.runsDir)
    .filter((name) => RUN_ID_RE.test(name))
    .sort()
    .reverse()
    .map((id) => {
      const dir = runDir(cfg, id);
      const status = checkStale(dir, readJson(join(dir, 'status.json'), { id, state: 'unknown' }));
      const meta = readJson(join(dir, 'meta.json'), null);
      return { ...status, id, summary: meta?.summary ?? null, sources: meta?.sources ?? null };
    });
}

function runDetail(id, dir) {
  const status = checkStale(dir, readJson(join(dir, 'status.json'), { id }));
  return {
    ...status,
    id,
    meta: readJson(join(dir, 'meta.json'), null),
    result: readText(join(dir, 'result.md')),
    log: tailFile(join(dir, 'claude.log'), 200),
  };
}

// A run marked active whose runner process is gone (reboot, crash) is failed.
function checkStale(dir, status) {
  const active = ['queued', 'running'].includes(status.state);
  if (!active) return status;
  const age = Date.now() - Date.parse(status.createdAt || status.startedAt || 0);
  if (isAlive(status.pid) || (status.state === 'queued' && age < 30_000)) return status;
  return updateStatus(dir, {
    state: 'failed',
    finishedAt: status.finishedAt || new Date().toISOString(),
    reason: 'runner process stopped unexpectedly (reboot or crash)',
  });
}

function recoverStaleRuns() {
  for (const name of readdirSync(cfg.runsDir)) {
    if (!RUN_ID_RE.test(name)) continue;
    const dir = runDir(cfg, name);
    checkStale(dir, readJson(join(dir, 'status.json'), {}));
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function tailFile(file, lines) {
  if (!existsSync(file)) return '';
  const size = statSync(file).size;
  const len = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  readSync(fd, buf, 0, len, size - len);
  closeSync(fd);
  return buf.toString('utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

// ── http helpers ───────────────────────────────────────────────────────────

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function json(res, code, data) {
  send(res, code, JSON.stringify(data), 'application/json; charset=utf-8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function resolveHost(value) {
  if (['0.0.0.0', '::', '*', ''].includes(String(value))) {
    throw new Error(`Refusing to listen on all interfaces ("${value}"). Use "auto" (Tailscale) or a specific IP.`);
  }
  if (value !== 'auto') return value;
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (ip) return ip;
  } catch {}
  throw new Error('host is "auto" but no Tailscale IPv4 was found (is tailscale up?). Set "host" in config.json.');
}
