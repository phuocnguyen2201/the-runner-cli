// Editable rule/prompt files: allowlist from config, conflict-checked saves, version history.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename, isAbsolute, resolve } from 'node:path';

const MAX_SIZE = 1024 * 1024;
const KEEP_VERSIONS = 20;
const VERSION_RE = /^\d{8}-\d{6}-\d{3}$/;

// Normalize config.editableFiles → [{ id, label, path, group, groupSlug }].
// Entries may be strings or { label, path, group }. Relative paths resolve against projectDir.
// Each group gets its own tab in the UI (default group: "Rules").
// Without editableFiles, the promptFile is editable.
export function editableFiles(cfg) {
  const raw = Array.isArray(cfg.editableFiles) && cfg.editableFiles.length
    ? cfg.editableFiles
    : cfg.promptFile ? [{ label: 'Prompt', path: cfg.promptFile }] : [];
  return raw.map((entry, id) => {
    const e = typeof entry === 'string' ? { path: entry } : entry;
    const path = isAbsolute(e.path) ? e.path : resolve(cfg.projectDir, e.path);
    const group = String(e.group || 'Rules');
    return { id, label: e.label || basename(path), path, group, groupSlug: slugify(group) };
  });
}

export function fileGroups(cfg) {
  const seen = new Map();
  for (const f of editableFiles(cfg)) if (!seen.has(f.groupSlug)) seen.set(f.groupSlug, { slug: f.groupSlug, label: f.group });
  return [...seen.values()];
}

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'files';

export function fileInfo(file) {
  const exists = existsSync(file.path);
  const st = exists ? statSync(file.path) : null;
  return { id: file.id, label: file.label, group: file.group, groupSlug: file.groupSlug, name: basename(file.path), path: file.path, exists, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
}

export function readEditable(cfg, file) {
  const info = fileInfo(file);
  return { ...info, content: info.exists ? readFileSync(file.path, 'utf8') : '', versions: listVersions(cfg, file) };
}

// Save with optimistic concurrency: baseMtimeMs must match the file on disk.
export function saveEditable(cfg, file, content, baseMtimeMs) {
  if (typeof content !== 'string') throw httpError(400, 'content must be a string');
  if (Buffer.byteLength(content) > MAX_SIZE) throw httpError(413, 'file is larger than 1 MB');
  checkSyntax(file, content);
  const current = fileInfo(file);
  if (current.exists && Math.round(current.mtimeMs) !== Math.round(Number(baseMtimeMs))) {
    throw httpError(409, 'The file changed on disk since you opened it. Reload to see the latest version.');
  }
  if (current.exists) {
    const old = readFileSync(file.path, 'utf8');
    if (old === content) return readEditable(cfg, file);
    snapshot(cfg, file, old);
  }
  const tmp = `${file.path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file.path);
  return readEditable(cfg, file);
}

export function readVersion(cfg, file, version) {
  if (!VERSION_RE.test(version)) throw httpError(400, 'invalid version');
  const p = join(versionsDir(cfg, file), `${version}.txt`);
  if (!existsSync(p)) throw httpError(404, 'version not found');
  return readFileSync(p, 'utf8');
}

function versionsDir(cfg, file) {
  return join(cfg.runsDir, '.versions', `${file.id}-${basename(file.path).replace(/[^\w.-]/g, '_')}`);
}

function listVersions(cfg, file) {
  const dir = versionsDir(cfg, file);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.txt') && VERSION_RE.test(n.slice(0, -4)))
    .map((n) => n.slice(0, -4))
    .sort()
    .reverse();
}

function snapshot(cfg, file, content) {
  const dir = versionsDir(cfg, file);
  mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  writeFileSync(join(dir, `${stamp}.txt`), content);
  for (const old of listVersions(cfg, file).slice(KEEP_VERSIONS)) {
    try { unlinkSync(join(dir, `${old}.txt`)); } catch {}
  }
}

// Cheap guards against edits that would break the file for the tools that read it.
function checkSyntax(file, content) {
  if (/\.ya?ml$/i.test(file.path)) {
    const bad = content.split('\n').findIndex((l) => /^ *\t/.test(l));
    if (bad >= 0) throw httpError(422, `YAML does not allow tabs for indentation (line ${bad + 1}). Use spaces.`);
  }
  if (/\.json$/i.test(file.path)) {
    try { JSON.parse(content); } catch (err) { throw httpError(422, `Invalid JSON: ${err.message}`); }
  }
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
