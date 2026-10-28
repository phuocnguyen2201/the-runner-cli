#!/usr/bin/env node
// Run one headless Claude Code job and record it in runs/<id>/.
//
// Usage: node bin/run-job.mjs <run-id|auto> "<request>" [web|cron|cli|action:<id>]
//
// Optional env RUNNER_JOB_OPTS (JSON, set by the server for item actions):
//   { "promptFile": "path", "queue": true, "action": "evaluate", "itemKey": "..." }
//   queue: wait for the running job to finish instead of exiting as "busy".
//
// Files written to runs/<id>/:
//   status.json   state, timings, exit code, cost   (written by this script)
//   request.txt   the user request
//   claude.log    human-readable live log of the run
//   events.jsonl  raw stream-json events from claude
//   result.md     final result (written by Claude, per the runner contract)
//   meta.json     optional sources/keywords summary (written by Claude)

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  loadConfig, parseDuration, newRunId, runDir, readJson, updateStatus,
  acquireLock, releaseLock, ROOT, RUN_ID_RE, isAlive,
} from '../lib/config.mjs';
import { readdirSync } from 'node:fs';
import { markdownToHtml, emailDocument } from '../lib/markdown.mjs';

const [, , idArg = 'auto', requestArg = '', trigger = 'cli'] = process.argv;

// cron starts with a nearly empty environment
const home = process.env.HOME || homedir();
process.env.HOME = home;
process.env.PATH = [
  process.env.PATH, `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.cargo/bin`,
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
].filter(Boolean).join(':');

const cfg = loadConfig();
if (cfg.envFile) loadEnvFile(cfg.envFile);

const id = idArg === 'auto' ? newRunId() : idArg;
const dir = runDir(cfg, id);
mkdirSync(dir, { recursive: true });

const opts = readJobOpts();
const promptFile = opts.promptFile
  ? (isAbsolute(opts.promptFile) ? opts.promptFile : resolve(cfg.projectDir, opts.promptFile))
  : cfg.promptFile;

const request = (requestArg || (cfg.presets[0] ?? 'run')).slice(0, 500);
writeFileSync(join(dir, 'request.txt'), request + '\n');
updateStatus(dir, {
  id, request, trigger, state: 'queued', pid: process.pid, waiting: Boolean(opts.queue),
  action: opts.action ?? null, itemKey: opts.itemKey ?? null, createdAt: new Date().toISOString(),
});

let cancelledWhileQueued = false;
const onQueuedSignal = () => { cancelledWhileQueued = true; };
process.on('SIGTERM', onQueuedSignal);
process.on('SIGINT', onQueuedSignal);

if (!(await waitForLock())) {
  const cancelled = cancelledWhileQueued;
  updateStatus(dir, {
    state: cancelled ? 'cancelled' : 'busy',
    finishedAt: new Date().toISOString(),
    reason: cancelled ? 'cancelled while queued' : 'another job was already running',
  });
  console.error(cancelled ? 'Cancelled while queued.' : 'Another job is running; skipped.');
  process.exit(2);
}
process.off('SIGTERM', onQueuedSignal);
process.off('SIGINT', onQueuedSignal);

const resultPath = join(dir, 'result.md');
const metaPath = join(dir, 'meta.json');
const log = createWriteStream(join(dir, 'claude.log'), { flags: 'a' });
const events = createWriteStream(join(dir, 'events.jsonl'), { flags: 'a' });
const logLine = (s) => log.write(`[${new Date().toTimeString().slice(0, 8)}] ${s}\n`);

const startedAt = new Date();
updateStatus(dir, { state: 'running', pid: process.pid, startedAt: startedAt.toISOString() });
logLine(`Job ${id} (${trigger}): ${request}`);

const args = [
  '-p', buildPrompt(),
  '--output-format', 'stream-json', '--verbose',
  '--allowedTools', cfg.allowedTools,
];
if (cfg.mcpConfig) args.push('--mcp-config', cfg.mcpConfig);
if (cfg.model) args.push('--model', cfg.model);

// Own process group so cancel/timeout also stops MCP servers and browsers it started.
const child = spawn('claude', args, { cwd: cfg.projectDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
updateStatus(dir, { claudePid: child.pid });

let finalEvent = null;
let stopReason = null;
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handleEvent(line);
  }
});
child.stderr.on('data', (chunk) => logLine(`stderr: ${String(chunk).trim()}`));
child.on('error', (err) => logLine(`Failed to start claude: ${err.message}`));

const killGroup = (signal) => {
  try { process.kill(-child.pid, signal); } catch {}
};
const stop = (reason) => {
  if (stopReason) return;
  stopReason = reason;
  logLine(`Stopping: ${reason}`);
  killGroup('SIGTERM');
  setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
};

const timer = setTimeout(() => stop('timeout'), parseDuration(cfg.timeout));
process.on('SIGTERM', () => stop('cancelled'));
process.on('SIGINT', () => stop('cancelled'));

child.on('close', async (code) => {
  clearTimeout(timer);
  if (buffer.trim()) handleEvent(buffer.trim());

  // Fall back to Claude's final message when it didn't write result.md itself.
  if (!existsSync(resultPath) && finalEvent?.result && !stopReason) {
    writeFileSync(resultPath, finalEvent.result);
    logLine('result.md missing; saved the final message instead.');
  }

  const ok = code === 0 && !stopReason && !finalEvent?.is_error && existsSync(resultPath);
  const state = stopReason || (ok ? 'done' : 'failed');
  const status = updateStatus(dir, {
    state,
    exitCode: code,
    finishedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    turns: finalEvent?.num_turns ?? null,
    costUsd: finalEvent?.total_cost_usd ?? null,
    reason: ok ? null : failureReason(code),
  });
  logLine(`Finished: ${state} (exit ${code})`);

  try {
    await sendMail(status);
  } catch (err) {
    logLine(`Email failed: ${err.message}`);
  }
  releaseLock(cfg);
  log.end();
  events.end();
  process.exitCode = ok ? 0 : 1;
});

// ── helpers ────────────────────────────────────────────────────────────────

function readJobOpts() {
  try {
    return JSON.parse(process.env.RUNNER_JOB_OPTS || '{}');
  } catch {
    return {};
  }
}

// Take the single-job lock. With opts.queue, wait first-in-first-out behind other waiting runs.
async function waitForLock() {
  if (!opts.queue) return acquireLock(cfg, id);
  for (;;) {
    if (cancelledWhileQueued) return false;
    if (!olderWaiterExists() && acquireLock(cfg, id)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function olderWaiterExists() {
  return readdirSync(cfg.runsDir).some((name) => {
    if (!RUN_ID_RE.test(name) || name >= id) return false;
    const st = readJson(join(cfg.runsDir, name, 'status.json'), {});
    return st.state === 'queued' && st.waiting && isAlive(st.pid);
  });
}

function buildPrompt() {
  const base = promptFile ? readFileSync(promptFile, 'utf8') : '';
  const inputPath = join(dir, 'input.md');
  const input = existsSync(inputPath)
    ? `\n---\n\n## PASTED INPUT (provided by the user)\n\n${readFileSync(inputPath, 'utf8').trimEnd()}\n`
    : '';
  return `${base}

---

## USER REQUEST

${request}
${input}
---

## RUNNER CONTRACT (takes precedence over output paths above)

You are running unattended from a job runner. Nobody can answer questions.
- Never ask the user anything and never wait for input. If something is ambiguous, pick the sensible default and note it in the result.
- If a step or source fails, note it and continue with the rest.
- Write the final human-readable result as Markdown to:
  RESULT_PATH: ${resultPath}
- Write a machine-readable summary as JSON to:
  META_PATH: ${metaPath}
  Shape:
  {"summary": "one line",
   "badge": "optional very short verdict, e.g. a score like 4.2/5",
   "sources": [{"platform": "name", "keywords": ["..."], "location": "...",
                "status": "ok|error|skipped", "found": 0, "kept": 0, "note": ""}],
   "items": [{"title": "...", "url": "https://...", "company": "...", "location": "...",
              "...": "any other short string fields worth showing"}]}
  - sources: one entry per platform/source you searched or used ([] if none apply).
  - items: one entry per individual result listed in the result (e.g. each job found),
    in the same order, with its direct URL. Use [] if the result has no individual items.
- Both files must exist before you finish.

TODAY: ${new Date().toISOString().slice(0, 10)}
`;
}

function handleEvent(line) {
  events.write(line + '\n');
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    logLine(line);
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'init') {
    logLine(`Claude started (model ${ev.model ?? '?'}, ${ev.tools?.length ?? 0} tools, MCP: ${(ev.mcp_servers || []).map((s) => `${s.name}:${s.status}`).join(', ') || 'none'})`);
  } else if (ev.type === 'assistant') {
    for (const block of ev.message?.content || []) {
      if (block.type === 'text' && block.text.trim()) logLine(`💬 ${clip(block.text, 600)}`);
      if (block.type === 'tool_use') logLine(`🔧 ${block.name} ${clip(describeInput(block.input), 240)}`);
    }
  } else if (ev.type === 'user') {
    for (const block of ev.message?.content || []) {
      if (block.type === 'tool_result' && block.is_error) logLine(`⚠️  tool error: ${clip(toText(block.content), 300)}`);
    }
  } else if (ev.type === 'result') {
    finalEvent = ev;
    logLine(`✅ result: ${ev.subtype}, ${ev.num_turns ?? '?'} turns${ev.total_cost_usd != null ? `, $${ev.total_cost_usd.toFixed(2)}` : ''}`);
  }
}

function describeInput(input = {}) {
  return input.command ?? input.url ?? input.file_path ?? input.pattern ?? input.query ?? JSON.stringify(input);
}

function toText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((c) => c.text ?? '').join(' ');
}

function clip(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function failureReason(code) {
  if (stopReason === 'timeout') return `timed out after ${cfg.timeout}`;
  if (stopReason === 'cancelled') return 'cancelled';
  if (finalEvent?.is_error) return `claude reported an error (${finalEvent.subtype})`;
  if (code !== 0) return `claude exited with code ${code}`;
  return 'no result.md was written';
}

function tail(file, lines) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function sendMail(status) {
  const mail = cfg.mail;
  if (!mail?.to || !mail?.command || status.state === 'cancelled') return Promise.resolve();
  const meta = readJson(metaPath, {});
  const date = new Date().toISOString().slice(0, 10);
  const ok = status.state === 'done';
  const subject = ok
    ? `[runner] ${meta.summary || request} — ${date}`
    : `[runner] ${status.state.toUpperCase()}: ${request} — ${date}`;
  const body = ok
    ? readFileSync(resultPath, 'utf8')
    : [
        `# Job ${status.state}`,
        '',
        `**Reason:** ${status.reason}`,
        '',
        `**Request:** ${request}`,
        '',
        `**Run:** ${id}`,
        '',
        '## Last 60 log lines',
        '',
        '```',
        tail(join(dir, 'claude.log'), 60),
        '```',
        '',
      ].join('\n');

  const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\n');
  const headers = [
    `To: ${mail.to}`,
    ...(mail.from ? [`From: ${mail.from}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  let message;
  if (mail.format === 'text') {
    message = [...headers, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(body)].join('\n');
  } else {
    const boundary = `runner-${id}-${Math.random().toString(36).slice(2)}`;
    const html = emailDocument(markdownToHtml(body), { title: subject, footer: `Run ${id} · ${trigger} · ${request}` });
    message = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(body),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(html),
      `--${boundary}--`,
      '',
    ].join('\n');
  }

  return new Promise((resolvePromise, reject) => {
    const p = spawn('sh', ['-c', mail.command], { cwd: ROOT, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => {
      if (c === 0) {
        logLine(`Email sent to ${mail.to}`);
        resolvePromise();
      } else {
        reject(new Error(`mail command exited ${c}: ${err.trim()}`));
      }
    });
    p.stdin.end(message);
  });
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}
