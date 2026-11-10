// Presets edited in the UI: [{ request, rule }] in runs/presets.json (seeded from config.presets).
// Each preset's rule is written into a managed block of the search prompt (promptFile), so Claude
// sees it on the next run and the Rules page shows it.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readJson, writeJsonAtomic } from './config.mjs';
import { editableFiles, fileInfo, saveEditable, httpError } from './files.mjs';

const MAX_REQUEST = 500;
const MAX_RULE = 5000;
const MAX_PRESETS = 50;
const START = '<!-- presets:start — managed by the runner UI (New job ⋯ → Presets). Edits here are overwritten. -->';
const END = '<!-- presets:end -->';
const BLOCK_RE = /\n*<!-- presets:start[^\n]*-->[\s\S]*?<!-- presets:end -->\n?/;

const storeFile = (cfg) => cfg.presetsFile ?? join(cfg.runsDir, 'presets.json');

export function readPresets(cfg) {
  const saved = readJson(storeFile(cfg), null);
  if (Array.isArray(saved)) return saved.filter((p) => p && typeof p.request === 'string').map((p) => ({ request: p.request, rule: String(p.rule || '') }));
  return (cfg.presets || []).map((p) => ({ request: String(p), rule: '' }));
}

function clean(body) {
  const request = String(body?.request ?? '').replace(/\s+/g, ' ').trim();
  const rule = String(body?.rule ?? '').replace(/\r\n/g, '\n').trim();
  if (!request) throw httpError(400, 'Preset text is required.');
  if (request.length > MAX_REQUEST) throw httpError(400, `Preset text is longer than ${MAX_REQUEST} characters.`);
  if (rule.length > MAX_RULE) throw httpError(400, `Rule is longer than ${MAX_RULE} characters.`);
  if (rule.includes('<!-- presets:')) throw httpError(400, 'Rule may not contain the presets marker comments.');
  return { request, rule };
}

// op: { type: 'insert', at?, preset } | { type: 'update', index, expect, preset } | { type: 'delete', index, expect }
// `expect` is the request text the browser saw at `index`; a mismatch means someone else changed the list.
export function changePresets(cfg, op) {
  const list = readPresets(cfg);
  if (op.type !== 'insert') {
    if (!Number.isInteger(op.index) || !list[op.index] || list[op.index].request !== op.expect) {
      throw httpError(409, 'The presets changed since you opened them. Reload and try again.');
    }
  }
  if (op.type === 'delete') {
    list.splice(op.index, 1);
  } else {
    const preset = clean(op.preset);
    const dup = list.findIndex((p) => p.request.toLowerCase() === preset.request.toLowerCase());
    if (dup >= 0 && dup !== op.index) throw httpError(409, 'A preset with this text already exists.');
    if (preset.rule && !cfg.promptFile) throw httpError(400, 'No promptFile is configured, so a rule cannot be saved.');
    if (op.type === 'update') list[op.index] = preset;
    else {
      if (list.length >= MAX_PRESETS) throw httpError(400, `At most ${MAX_PRESETS} presets.`);
      const at = Number.isInteger(op.at) ? Math.max(0, Math.min(op.at, list.length)) : list.length;
      list.splice(at, 0, preset);
    }
  }
  // Prompt first: if it can't be written, the preset list stays as it was.
  syncPrompt(cfg, list);
  writeJsonAtomic(storeFile(cfg), list);
  return list;
}

export function promptBlock(list) {
  const withRules = list.filter((p) => p.rule);
  if (!withRules.length) return '';
  return [
    START,
    '## Preset rules',
    '',
    'When the request matches one of these presets (same text), follow its rule in addition to everything above.',
    '',
    ...withRules.flatMap((p) => [`### Preset: ${p.request}`, '', p.rule, '']),
    END,
  ].join('\n');
}

// Replace (or append/remove) the managed block. Saved through the Rules-page helper when the
// prompt is an editable file, so the old prompt is kept in its version history.
function syncPrompt(cfg, list) {
  if (!cfg.promptFile) return;
  const old = existsSync(cfg.promptFile) ? readFileSync(cfg.promptFile, 'utf8') : '';
  const block = promptBlock(list);
  const base = old.replace(BLOCK_RE, '\n').replace(/\s+$/, '');
  const next = block ? `${base}\n\n${block}\n` : `${base}\n`;
  if (next === old || (!block && !BLOCK_RE.test(old))) return;
  const file = editableFiles(cfg).find((f) => f.path === cfg.promptFile);
  if (file) return saveEditable(cfg, file, next, fileInfo(file).mtimeMs);
  writeFileAtomicText(cfg.promptFile, next);
}

function writeFileAtomicText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
