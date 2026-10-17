// Item actions: buttons on the individual results (meta.json "items") of a run.
//   type "command": run a program in projectDir with {item, note, date} as JSON on stdin.
//   type "job":     start a queued runner job (e.g. evaluate this item) linked to the item.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './config.mjs';

const COMMAND_TIMEOUT_MS = 60_000;

export function itemActions(cfg) {
  return (Array.isArray(cfg.itemActions) ? cfg.itemActions : [])
    .filter((a) => a && /^[\w-]+$/.test(a.id || '') && ['command', 'job'].includes(a.type))
    .map((a) => ({
      id: a.id,
      type: a.type,
      label: a.label || a.id,
      doneLabel: a.doneLabel || a.label || a.id,
      runningLabel: a.runningLabel || 'Running…',
      askNote: Boolean(a.askNote),
      command: a.command,
      promptFile: a.promptFile,
      request: a.request,
    }));
}

// Public view of the actions (no commands or paths).
export const publicActions = (cfg) =>
  itemActions(cfg).map(({ id, type, label, doneLabel, runningLabel, askNote }) => ({ id, type, label, doneLabel, runningLabel, askNote }));

// Stable key for an item across runs: normalized URL, else title|company.
export function itemKey(item) {
  const url = String(item?.url || '').trim();
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch {}
  }
  return `${String(item?.title || '').trim().toLowerCase()}|${String(item?.company || '').trim().toLowerCase()}`;
}

// Only short scalar fields survive; everything is a string.
export function cleanItem(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[\w-]{1,40}$/.test(k)) continue;
    if (v == null || typeof v === 'object') continue;
    out[k] = String(v).replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return out;
}

export function fillTemplate(template, item) {
  return String(template || '')
    .replace(/\{(\w+)\}/g, (_, k) => item[k] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

// ── state store: runs/items.json ───────────────────────────────────────────

const storeFile = (cfg) => join(cfg.runsDir, 'items.json');

export function readStore(cfg) {
  return readJson(storeFile(cfg), {});
}

export function updateItemState(cfg, key, actionId, state) {
  const store = readStore(cfg);
  store[key] = { ...(store[key] || {}), [actionId]: state };
  writeJsonAtomic(storeFile(cfg), store);
  return store[key];
}

// ── command actions ────────────────────────────────────────────────────────

export function runCommandAction(cfg, action, payload) {
  return new Promise((resolve) => {
    const [cmd, ...args] = Array.isArray(action.command) ? action.command : [];
    if (!cmd) return resolve({ ok: false, output: 'action has no command configured' });
    const p = spawn(cmd, args, { cwd: cfg.projectDir, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let output = '';
    const add = (d) => { output = (output + d).slice(-4000); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => p.kill('SIGTERM'), COMMAND_TIMEOUT_MS);
    p.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: output.trim() });
    });
    p.stdin.end(JSON.stringify(payload));
  });
}
