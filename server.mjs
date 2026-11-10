#!/usr/bin/env node
// claude-runner-ui — web UI for starting headless Claude Code jobs and browsing their history.
// Zero dependencies: Node >= 20 built-ins only.

import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { join, basename, isAbsolute, resolve } from 'node:path';
import {
  ROOT, RUN_ID_RE, loadConfig, newRunId, runDir, readJson, updateStatus, isAlive,
} from './lib/config.mjs';
import { editableFiles, fileGroups, fileInfo, readEditable, saveEditable, readVersion } from './lib/files.mjs';
import {
  itemActions, publicActions, itemKey, cleanItem, fillTemplate, readStore, updateItemState, runCommandAction,
  OUTCOMES, setItemOutcome, changeRevisions,
} from './lib/items.mjs';
import {
  hasUsers, findUser, adminUser, listUsers, createUser, updateUser, verifyPassword,
  createSession, sessionUser, deleteSession, runOwner, canSee, userCfg,
} from './lib/users.mjs';
import { readPresets, changePresets } from './lib/presets.mjs';
import { readApplications, readScanHistory, readReport, pairKey, APPLIED_STATES } from './lib/career.mjs';

const cfg = loadConfig();
const host = resolveHost(cfg.host);
const INDEX = join(ROOT, 'public', 'index.html');
const MAX_REQUEST = 500;
const MAX_PASTE = 50_000;
let lastSpawnedId = null;
const ACTIVE = ['queued', 'running'];

recoverStaleRuns();
if (!hasUsers(cfg)) console.warn('⚠️  No accounts yet. Create the admin: node bin/user.mjs add <name> --admin --email you@example.com');
for (const a of itemActions(cfg)) {
  if (a.type === 'job' && a.promptFile) {
    const p = isAbsolute(a.promptFile) ? a.promptFile : resolve(cfg.projectDir, a.promptFile);
    if (!existsSync(p)) console.warn(`⚠️  itemActions "${a.id}": promptFile not found: ${p}`);
  }
}
if (cfg.pasteAction?.promptFile) {
  const p = isAbsolute(cfg.pasteAction.promptFile) ? cfg.pasteAction.promptFile : resolve(cfg.projectDir, cfg.pasteAction.promptFile);
  if (!existsSync(p)) console.warn(`⚠️  pasteAction: promptFile not found: ${p}`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return send(res, 200, readFileSync(INDEX), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && path === '/api/login') return await login(req, res);
    if (req.method === 'POST' && path === '/api/register') return await register(req, res);
    if (!path.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    const token = req.headers['x-runner-token'];
    const user = sessionUser(cfg, token);
    if (!user) return json(res, 401, { error: 'login required' });
    const ucfg = userCfg(cfg, user);

    if (req.method === 'POST' && path === '/api/logout') {
      deleteSession(cfg, token);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/me') {
      if (req.method === 'GET') return json(res, 200, user);
      if (req.method === 'PUT') return await updateMe(req, res, user);
    }
    if (path === '/api/users' && user.admin) {
      if (req.method === 'GET') return json(res, 200, { users: listUsers(cfg) });
      if (req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 201, createUser(cfg, { name: body.name, email: body.email || null, password: body.password }));
      }
    }
    if (req.method === 'GET' && path === '/api/config') {
      return json(res, 200, {
        user,
        project: basename(ucfg.projectDir),
        presets: readPresets(ucfg).map((p) => p.request),
        promptFile: ucfg.promptFile ? basename(ucfg.promptFile) : null,
        mail: ucfg.mail?.command ? ucfg.mail.to || null : null,
        timeout: cfg.timeout,
        groups: fileGroups(ucfg),
        itemsLabel: cfg.items?.label || 'Items',
        trackerLabel: cfg.tracker?.label || 'Tracker',
        itemActions: publicActions(cfg),
        pasteAction: cfg.pasteAction ? { label: cfg.pasteAction.label || 'Evaluate pasted text' } : null,
      });
    }
    if (req.method === 'GET' && path === '/api/files') {
      return json(res, 200, { files: editableFiles(ucfg).map(fileInfo), active: activeRunId(user) });
    }
    const f = path.match(/^\/api\/files\/(\d+)(?:\/versions\/([\w-]+))?$/);
    if (f) {
      const file = editableFiles(ucfg)[Number(f[1])];
      if (!file) return json(res, 404, { error: 'file not found' });
      if (req.method === 'GET' && f[2]) return json(res, 200, { content: readVersion(ucfg, file, f[2]) });
      if (req.method === 'GET') return json(res, 200, readEditable(ucfg, file));
      if (req.method === 'PUT' && !f[2]) {
        const body = await readBody(req, 2 * 1024 * 1024);
        return json(res, 200, saveEditable(ucfg, file, body.content, body.baseMtimeMs));
      }
    }
    if (req.method === 'GET' && path === '/api/runs') {
      const limit = Number(url.searchParams.get('limit')) || Infinity;
      return json(res, 200, { active: activeRunId(user), ...listRuns(user, limit) });
    }
    if (req.method === 'GET' && path === '/api/tracker') {
      return json(res, 200, { active: activeRunId(user), items: trackedItems(ucfg, user) });
    }
    if (req.method === 'GET' && path === '/api/tracker/report') {
      const markdown = readReport(ucfg, url.searchParams.get('name'));
      return markdown == null ? json(res, 404, { error: 'report not found' }) : json(res, 200, { markdown });
    }
    if (req.method === 'POST' && path === '/api/tracker/status') {
      return await setOutcome(req, res, ucfg, user);
    }
    if (req.method === 'POST' && path === '/api/tracker/revisions') {
      return await changeRevision(req, res, ucfg, user);
    }
    if (req.method === 'GET' && path === '/api/presets') {
      return json(res, 200, { presets: readPresets(ucfg), promptFile: ucfg.promptFile ? basename(ucfg.promptFile) : null });
    }
    const pr = path.match(/^\/api\/presets(?:\/(\d+))?$/);
    if (pr && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const body = await readBody(req, 64 * 1024);
      const index = pr[1] == null ? null : Number(pr[1]);
      const op = req.method === 'POST' ? { type: 'insert', at: body.at, preset: body }
        : { type: req.method === 'PUT' ? 'update' : 'delete', index, expect: body.expect, preset: body };
      if ((op.type === 'insert') !== (index == null)) return json(res, 404, { error: 'not found' });
      return json(res, 200, { presets: changePresets(ucfg, op) });
    }
    if (req.method === 'POST' && path === '/api/runs') {
      return await startRun(req, res, user);
    }
    if (req.method === 'POST' && path === '/api/runs/paste') {
      return await startPasteRun(req, res, user);
    }

    // Other users' runs are "not found"; the admin can open every run.
    const a = path.match(/^\/api\/runs\/(\d{8}-\d{6})\/items\/(\d+)\/actions\/([\w-]+)$/);
    if (a && req.method === 'POST') {
      if (!existsSync(runDir(cfg, a[1])) || !canSee(user, runStatus(a[1]), adminName())) return json(res, 404, { error: 'run not found' });
      return await itemAction(req, res, a[1], Number(a[2]), a[3]);
    }

    const m = path.match(/^\/api\/runs\/([^/]+)(\/cancel)?$/);
    if (m && RUN_ID_RE.test(m[1])) {
      const dir = runDir(cfg, m[1]);
      if (!existsSync(dir) || !canSee(user, runStatus(m[1]), adminName())) return json(res, 404, { error: 'run not found' });
      if (req.method === 'GET' && !m[2]) return json(res, 200, runDetail(m[1], dir));
      if (req.method === 'POST' && m[2]) return cancelRun(res, dir);
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    json(res, err.status || 500, { error: err.message });
  }
});

server.listen(cfg.port, host, () => {
  console.log(`claude-runner-ui listening on http://${host}:${cfg.port} (project: ${cfg.projectDir})`);
});

// ── handlers ───────────────────────────────────────────────────────────────

async function login(req, res) {
  const body = await readBody(req);
  const u = findUser(cfg, String(body.name ?? '').trim().toLowerCase());
  if (!u || !verifyPassword(body.password, u)) return json(res, 401, { error: 'wrong name or password' });
  json(res, 200, { token: createSession(cfg, u.name), user: { name: u.name, admin: Boolean(u.admin), email: u.email || null } });
}

// Self sign-up (turn off with "signup": false). On an install with no accounts, the first one becomes the admin.
async function register(req, res) {
  if (cfg.signup === false) return json(res, 403, { error: 'Sign-up is closed. Ask the admin for an account.' });
  const body = await readBody(req);
  const admin = !hasUsers(cfg);
  const u = createUser(cfg, {
    name: String(body.name ?? '').trim().toLowerCase(),
    email: String(body.email ?? '').trim() || null,
    password: body.password,
    admin,
  });
  json(res, 201, { token: createSession(cfg, u.name), user: u });
}

async function updateMe(req, res, user) {
  const body = await readBody(req);
  const patch = {};
  if (body.email !== undefined) patch.email = String(body.email ?? '').trim();
  if (body.password !== undefined) {
    if (!verifyPassword(body.currentPassword, findUser(cfg, user.name))) return json(res, 403, { error: 'current password is wrong' });
    patch.password = body.password;
  }
  json(res, 200, updateUser(cfg, user.name, patch));
}

// Jobs from all users share one Claude lock, so web runs queue behind each other (FIFO).
async function startRun(req, res, user) {
  if (activeRunId(user)) {
    return json(res, 409, { error: 'You already have a job running.' });
  }
  const body = await readBody(req);
  const request = String(body.request ?? '').trim();
  if (!request) return json(res, 400, { error: 'request is required' });
  if (request.length > MAX_REQUEST) return json(res, 400, { error: `request is longer than ${MAX_REQUEST} characters` });

  json(res, 202, { id: spawnJob(user.name, request, 'web', { queue: true }) });
}

// Pasted text (e.g. a job description) goes to runs/<id>/input.md and runs with pasteAction.promptFile.
async function startPasteRun(req, res, user) {
  const pa = cfg.pasteAction;
  if (!pa) return json(res, 404, { error: 'pasteAction is not configured' });
  if (activeRunId(user)) {
    return json(res, 409, { error: 'You already have a job running.' });
  }
  const body = await readBody(req, 256 * 1024);
  const text = String(body.text ?? '').trim();
  if (!text) return json(res, 400, { error: 'text is required' });
  if (text.length > MAX_PASTE) return json(res, 400, { error: `text is longer than ${MAX_PASTE} characters` });

  const request = String(pa.request || pa.label || 'Evaluate the pasted text').slice(0, MAX_REQUEST);
  json(res, 202, { id: spawnJob(user.name, request, 'paste', { queue: true, promptFile: pa.promptFile || null }, text) });
}

// Detached + argv array: survives the browser and server going away, no shell parsing of the request.
function spawnJob(userName, request, trigger, opts = null, input = null) {
  let id = newRunId();
  while (existsSync(runDir(cfg, id)) || id === lastSpawnedId) id = newRunId(new Date(Date.now() + 1000));
  lastSpawnedId = id;
  const dir = runDir(cfg, id);
  mkdirSync(dir, { recursive: true });
  if (input) writeFileSync(join(dir, 'input.md'), input + '\n');
  updateStatus(dir, { id, user: userName ?? null, request, trigger, state: 'queued', waiting: Boolean(opts?.queue), createdAt: new Date().toISOString() });
  const argv = [join(ROOT, 'bin', 'run-job.mjs'), id, request, trigger, ...(userName ? [userName] : [])];
  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: opts ? { ...process.env, RUNNER_JOB_OPTS: JSON.stringify(opts) } : process.env,
  });
  child.unref();
  updateStatus(dir, { pid: child.pid });
  return id;
}

async function itemAction(req, res, runId, index, actionId) {
  const dir = runDir(cfg, runId);
  const owner = ownerOf(runStatus(runId)); // item state and follow-up jobs belong to the run's owner
  const ocfg = userCfg(cfg, owner);
  const action = itemActions(cfg).find((x) => x.id === actionId);
  const raw = readJson(join(dir, 'meta.json'), {})?.items?.[index];
  if (!existsSync(dir) || !action || !raw) return json(res, 404, { error: 'item or action not found' });

  // The item always comes from the run's meta.json on disk, never from the browser.
  const item = cleanItem(raw);
  const key = itemKey(item);
  const body = await readBody(req);
  const snapshot = { _item: item, _src: { runId, index } };

  if (action.type === 'command') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10);
    const note = String(body.note ?? '').slice(0, 2000);
    const result = await runCommandAction(ocfg, action, { item, note, date, action: action.id });
    const state = updateItemState(ocfg, key, action.id, {
      state: result.ok ? 'done' : 'failed', at: new Date().toISOString(), date, note, output: result.output,
    }, snapshot);
    return json(res, result.ok ? 200 : 500, { ...state[action.id], error: result.ok ? undefined : `Action failed: ${result.output || `exit ${result.code}`}` });
  }

  // type "job": reuse a queued/running job for this item instead of starting a duplicate
  const linked = readStore(ocfg)[key]?.[action.id];
  if (linked?.runId) {
    const st = jobState(linked.runId);
    if (['queued', 'running'].includes(st.state)) return json(res, 200, st);
  }
  const request = fillTemplate(action.request || `${action.label}: {title} {url}`, item);
  const runIdNew = spawnJob(owner?.name, request, `action:${action.id}`, {
    queue: true, action: action.id, itemKey: key, promptFile: action.promptFile || null,
  });
  updateItemState(ocfg, key, action.id, { runId: runIdNew, at: new Date().toISOString() }, snapshot);
  json(res, 202, jobState(runIdNew));
}

function jobState(runId) {
  const dir = runDir(cfg, runId);
  const status = checkStale(dir, readJson(join(dir, 'status.json'), {}));
  const meta = readJson(join(dir, 'meta.json'), null);
  return {
    runId, state: status.state || 'unknown', badge: meta?.badge ?? null, summary: meta?.summary ?? null,
    startedAt: status.startedAt || status.createdAt || null, finishedAt: status.finishedAt || null,
  };
}

// Items of a run with the state of each action.
function runItems(dir) {
  const items = readJson(join(dir, 'meta.json'), {})?.items;
  if (!Array.isArray(items)) return [];
  const store = readStore(userCfg(cfg, ownerOf(readJson(join(dir, 'status.json'), {}))));
  const actions = itemActions(cfg);
  return items.map((raw, index) => {
    const item = cleanItem(raw);
    const key = itemKey(item);
    const saved = store[key] || {};
    const states = {};
    for (const a of actions) {
      if (a.type === 'job') states[a.id] = saved[a.id]?.runId ? jobState(saved[a.id].runId) : null;
      else states[a.id] = saved[a.id] ? { state: saved[a.id].state, at: saved[a.id].at, date: saved[a.id].date, note: saved[a.id].note } : null;
    }
    return { index, item, states };
  });
}

// Tracker: every item with a finished command action (e.g. Applied) or a linked job (e.g. Evaluated),
// plus pasted-text evaluations, plus every row of the career-ops applications.md (read-only),
// with the date the item was first seen in a run or in scan-history.tsv.
const TEXT_LIMIT = 4000;

// Personal: only the user's own runs and files, also for the admin.
function trackedItems(ucfg, user) {
  const store = readStore(ucfg);
  const admin = adminName();
  const actions = itemActions(cfg);
  const pasteAction = actions.find((a) => a.type === 'job'); // pasted evaluations show in this column
  const ids = readdirSync(cfg.runsDir).filter((name) => RUN_ID_RE.test(name)).sort(); // oldest first
  const firstSeen = new Map(); // item key -> { item, runId, index, at, trigger } (every item in any run)
  const seenByPair = new Map(); // company|title -> item key
  const pastes = [];

  for (const id of ids) {
    const dir = runDir(cfg, id);
    const status = readJson(join(dir, 'status.json'), {});
    if (runOwner(status, admin) !== user.name) continue;
    const items = readJson(join(dir, 'meta.json'), null)?.items;
    if (status.trigger === 'paste') pastes.push(id);
    if (!Array.isArray(items)) continue;
    items.forEach((raw, index) => {
      const item = cleanItem(raw);
      const key = itemKey(item);
      if (!firstSeen.has(key)) {
        firstSeen.set(key, { item, runId: id, index, at: status.startedAt || status.createdAt || null, trigger: status.trigger });
        const pk = pairKey(item.company, item.title);
        if (!seenByPair.has(pk)) seenByPair.set(pk, key);
      }
    });
  }

  const out = [];
  const keys = new Set();
  for (const [key, saved] of Object.entries(store)) {
    const seen = firstSeen.get(key);
    const src = seen || (saved._item ? { item: saved._item, runId: saved._src?.runId ?? null, index: saved._src?.index ?? null, at: null } : null);
    if (!src) continue;
    const states = {};
    let tracked = false;
    for (const a of actions) {
      const s = saved[a.id];
      if (a.type === 'job') {
        let runId = s?.runId;
        if (!runId && a === pasteAction && seen?.trigger === 'paste') runId = seen.runId; // evaluated by pasting
        states[a.id] = runId && existsSync(runDir(cfg, runId)) ? jobState(runId) : null;
      } else {
        states[a.id] = s?.state === 'done' ? { state: s.state, at: s.at, date: s.date, note: s.note } : null;
      }
      if (states[a.id]) tracked = true;
    }
    if (!tracked) continue;
    keys.add(key);
    out.push(trackerEntry(key, src, states, saved._status, saved._revisions));
  }

  // Pasted evaluations whose item was never acted on.
  for (const id of pastes) {
    if (!pasteAction) break;
    const st = jobState(id);
    if (!['done', 'queued', 'running'].includes(st.state)) continue;
    const dir = runDir(cfg, id);
    const status = readJson(join(dir, 'status.json'), {});
    const raw = readJson(join(dir, 'meta.json'), null)?.items?.[0];
    const item = cleanItem(raw);
    const key = raw ? itemKey(item) : `paste:${id}`;
    if (keys.has(key)) continue;
    if (!item.title) item.title = st.summary || 'Pasted text';
    keys.add(key);
    const states = Object.fromEntries(actions.map((a) => [a.id, a === pasteAction ? st : null]));
    out.push(trackerEntry(key, { item, runId: raw ? id : null, index: raw ? 0 : null, at: status.startedAt || status.createdAt || null, pasteRunId: id }, states, store[key]?._status, store[key]?._revisions));
  }

  mergeApplications(ucfg, out, keys, store, actions, firstSeen, seenByPair);
  return out;
}

// Rows of applications.md: merged into a matching entry (same URL, or same company + title),
// otherwise added as their own entry. Runner items found in a scan keep their run link and buttons.
function mergeApplications(ucfg, out, keys, store, actions, firstSeen, seenByPair) {
  const apps = readApplications(ucfg);
  if (!apps.length) return;
  const scans = readScanHistory(ucfg);
  const cmd = actions.find((a) => a.type === 'command');
  const job = actions.find((a) => a.type === 'job');
  const byKey = new Map(out.map((e) => [e.key, e]));
  const byPair = new Map();
  for (const e of out) {
    const pk = pairKey(e.item.company, e.item.title);
    if (!byPair.has(pk)) byPair.set(pk, e);
  }

  for (const r of apps) {
    const pk = pairKey(r.company, r.role);
    const urlKey = r.url ? itemKey({ url: r.url }) : null;
    let entry = (urlKey && byKey.get(urlKey)) || byPair.get(pk);
    if (entry?.career) entry = null; // two rows for the same job: keep both
    if (!entry) {
      let key = urlKey && firstSeen.has(urlKey) ? urlKey : seenByPair.get(pk) || urlKey || `app:${pk}`;
      if (keys.has(key)) key = `app:${r.num}:${pk}`;
      const seen = firstSeen.get(key);
      const item = seen?.item || cleanItem({ title: r.role, company: r.company, url: r.url });
      const states = Object.fromEntries(actions.map((a) => [a.id, null]));
      entry = trackerEntry(key, { item, runId: seen?.runId ?? null, index: seen?.index ?? null, at: seen?.at ?? null }, states, store[key]?._status, store[key]?._revisions);
      out.push(entry);
      keys.add(key);
      byKey.set(key, entry);
      byPair.set(pk, entry);
    }

    entry.career = { num: r.num, status: r.status, statusLabel: r.statusLabel, date: r.date, score: r.score, report: r.report, notes: r.notes, rejectedDate: r.rejectedDate };
    if (cmd && !entry.states[cmd.id] && APPLIED_STATES.has(r.status)) {
      entry.states[cmd.id] = { state: 'done', date: r.appliedDate, note: `From applications.md #${r.num}`, source: 'career' };
    }
    if (job && !entry.states[job.id] && (r.score || r.report)) {
      entry.states[job.id] = { state: 'done', badge: r.score, summary: null, day: r.evaluatedDate, report: r.report, source: 'career' };
    }
    const scan = (r.url && scans.byUrl.get(r.url)) || scans.byPair.get(pk);
    if (scan) {
      const at = `${scan.firstSeen}T12:00:00Z`; // a day, not a time: noon UTC stays on that day in any zone
      if (!entry.scannedAt || Date.parse(at) < Date.parse(entry.scannedAt)) {
        entry.scannedAt = at;
        entry.scanPortal = scan.portal;
      }
    }
    const report = r.report ? readReport(ucfg, r.report)?.slice(0, TEXT_LIMIT) : '';
    entry.text = [entry.text, r.notes, report].filter(Boolean).join('\n');
  }
}

// Mark a tracked item ghosted/rejected (or clear it). Only keys the tracker lists are accepted.
async function setOutcome(req, res, ucfg, user) {
  const body = await readBody(req);
  const key = String(body.key ?? '');
  const status = body.status == null ? null : String(body.status);
  if (status && !OUTCOMES.includes(status)) return json(res, 400, { error: `status must be one of: ${OUTCOMES.join(', ')}` });
  if (!trackedItems(ucfg, user).some((x) => x.key === key)) return json(res, 404, { error: 'item not found in tracker' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10);
  const outcome = status ? { status, date, note: String(body.note ?? '').slice(0, 2000), at: new Date().toISOString() } : null;
  json(res, 200, { outcome: setItemOutcome(ucfg, key, outcome) });
}

// Add a "Revised" event ({key, date, note}) or remove one ({key, remove: index}).
async function changeRevision(req, res, ucfg, user) {
  const body = await readBody(req);
  const key = String(body.key ?? '');
  if (!trackedItems(ucfg, user).some((x) => x.key === key)) return json(res, 404, { error: 'item not found in tracker' });
  const revisions = changeRevisions(ucfg, key, (list) => {
    if (body.remove != null) {
      if (!Number.isInteger(body.remove) || !list[body.remove]) throw Object.assign(new Error('revision not found'), { status: 404 });
      list.splice(body.remove, 1);
      return list;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10);
    if (list.length >= 50) throw Object.assign(new Error('too many revisions'), { status: 400 });
    list.push({ date, note: String(body.note ?? '').slice(0, 2000), at: new Date().toISOString() });
    return list.sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  });
  json(res, 200, { revisions });
}

function trackerEntry(key, src, states, outcome = null, revisions = null) {
  const revs = (Array.isArray(revisions) ? revisions : []).map((r) => ({ date: r.date, note: r.note || '' }));
  const parts = [src.item.description, outcome?.note, ...revs.map((r) => r.note), ...Object.values(states).flatMap((s) => [s?.summary, s?.note])];
  for (const s of Object.values(states)) {
    if (s?.runId && s.state === 'done') parts.push(readText(join(runDir(cfg, s.runId), 'result.md'))?.slice(0, TEXT_LIMIT));
  }
  if (src.pasteRunId) parts.push(readText(join(runDir(cfg, src.pasteRunId), 'input.md'))?.slice(0, TEXT_LIMIT));
  return {
    key,
    item: src.item,
    runId: src.runId ?? null, // run the item was found in; null when actions can't be run from here
    index: src.index ?? null,
    scannedAt: src.at ?? null,
    states,
    outcome: outcome?.status ? { status: outcome.status, date: outcome.date, note: outcome.note || '' } : null,
    revisions: revs,
    text: parts.filter(Boolean).join('\n'),
  };
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

const adminName = () => adminUser(cfg)?.name ?? null;
const runStatus = (id) => readJson(join(runDir(cfg, id), 'status.json'), {});
const ownerOf = (status) => findUser(cfg, runOwner(status, adminName()));

// The user's own newest queued/running run (follow-up item jobs only once they run).
function activeRunId(user) {
  const admin = adminName();
  const ids = readdirSync(cfg.runsDir).filter((name) => RUN_ID_RE.test(name)).sort().reverse().slice(0, 50);
  for (const id of ids) {
    const status = runStatus(id);
    if (!ACTIVE.includes(status.state) || runOwner(status, admin) !== user.name) continue;
    if (status.state === 'queued' && String(status.trigger).startsWith('action:')) continue;
    if (ACTIVE.includes(checkStale(runDir(cfg, id), status).state)) return id;
  }
  return null;
}

// Newest first; details are read for the first `limit` runs the user can see.
function listRuns(user, limit = Infinity) {
  const admin = adminName();
  const ids = readdirSync(cfg.runsDir).filter((name) => RUN_ID_RE.test(name)).sort().reverse();
  const runs = [];
  let total = 0;
  for (const id of ids) {
    if (!user.admin && !canSee(user, runStatus(id), admin)) continue;
    total++;
    if (runs.length >= limit) continue;
    const dir = runDir(cfg, id);
    const status = checkStale(dir, readJson(join(dir, 'status.json'), { id, state: 'unknown' }));
    const meta = readJson(join(dir, 'meta.json'), null);
    runs.push({ ...status, id, user: runOwner(status, admin), summary: meta?.summary ?? null, sources: meta?.sources ?? null });
  }
  return { total, runs };
}

function runDetail(id, dir) {
  const status = checkStale(dir, readJson(join(dir, 'status.json'), { id }));
  return {
    ...status,
    id,
    user: runOwner(status, adminName()),
    meta: readJson(join(dir, 'meta.json'), null),
    items: runItems(dir),
    input: readText(join(dir, 'input.md')),
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

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) req.destroy(new Error('body too large'));
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
