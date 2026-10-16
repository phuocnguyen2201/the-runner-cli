// Shared config + run-folder helpers for server.mjs and bin/run-job.mjs.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUN_ID_RE = /^\d{8}-\d{6}$/;

const DEFAULTS = {
  host: 'auto',
  port: 8787,
  projectDir: null,
  promptFile: null,
  mcpConfig: null,
  allowedTools: 'Read,Write,Edit,Glob,Grep',
  model: null,
  timeout: '90m',
  envFile: null,
  runsDir: './runs',
  mail: null,
  presets: [],
};

const abs = (p) => (p == null || isAbsolute(p) ? p : resolve(ROOT, p));

export function loadConfig() {
  const file = process.env.RUNNER_CONFIG || join(ROOT, 'config.json');
  if (!existsSync(file)) {
    throw new Error(`Config not found: ${file} (copy config.example.json to config.json)`);
  }
  const cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
  for (const k of ['projectDir', 'promptFile', 'mcpConfig', 'envFile', 'runsDir']) cfg[k] = abs(cfg[k]);
  if (!cfg.projectDir || !existsSync(cfg.projectDir)) throw new Error(`projectDir does not exist: ${cfg.projectDir}`);
  if (cfg.promptFile && !existsSync(cfg.promptFile)) throw new Error(`promptFile does not exist: ${cfg.promptFile}`);
  mkdirSync(cfg.runsDir, { recursive: true });
  return cfg;
}

// Parse "90m", "2h", "300s", "45" (minutes) into milliseconds.
export function parseDuration(value) {
  const m = String(value).trim().match(/^(\d+)\s*([smh]?)$/i);
  if (!m) throw new Error(`Invalid duration: ${value}`);
  const n = Number(m[1]);
  return n * { s: 1e3, m: 6e4, h: 36e5, '': 6e4 }[m[2].toLowerCase()];
}

export function newRunId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function runDir(cfg, id) {
  if (!RUN_ID_RE.test(id)) throw new Error(`Invalid run id: ${id}`);
  return join(cfg.runsDir, id);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function updateStatus(dir, patch) {
  const file = join(dir, 'status.json');
  const next = { ...readJson(file, {}), ...patch };
  writeJsonAtomic(file, next);
  return next;
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Single-job lock: runs/.lock holds the pid of the active runner.
export const lockFile = (cfg) => join(cfg.runsDir, '.lock');

export function activeLock(cfg) {
  const data = readJson(lockFile(cfg));
  return data && isAlive(data.pid) ? data : null;
}

export function acquireLock(cfg, id) {
  const file = lockFile(cfg);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, id }));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (activeLock(cfg)) return false;
      try { unlinkSync(file); } catch {} // stale lock from a dead runner
    }
  }
  return false;
}

export function releaseLock(cfg) {
  const data = readJson(lockFile(cfg));
  if (data && data.pid === process.pid) {
    try { unlinkSync(lockFile(cfg)); } catch {}
  }
}
