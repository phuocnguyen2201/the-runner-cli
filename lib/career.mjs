// Read-only view of a career-ops style tracker in projectDir:
//   data/applications.md   markdown table: # | Date | Company | Role | Score | Status | PDF | Report | Notes
//   data/scan-history.tsv  url, first_seen, portal, title, company, status
//   reports/*.md           evaluation reports linked from the Report column
// Paths come from config.tracker.{applicationsFile, scanHistoryFile, reportsDir} (relative to projectDir);
// set one to null to turn it off. Missing files are simply skipped.
import { readFileSync, existsSync } from 'node:fs';
import { basename, isAbsolute, resolve, relative, sep } from 'node:path';

const DEFAULTS = { applicationsFile: 'data/applications.md', scanHistoryFile: 'data/scan-history.tsv', reportsDir: 'reports' };

// Canonical career-ops states (templates/states.yml) + aliases.
const STATES = {
  evaluated: ['evaluated', 'evaluada'],
  applied: ['applied', 'aplicado', 'enviada', 'aplicada', 'sent'],
  responded: ['responded', 'respondido'],
  interview: ['interview', 'entrevista'],
  offer: ['offer', 'oferta'],
  rejected: ['rejected', 'rechazado', 'rechazada'],
  discarded: ['discarded', 'descartado', 'descartada', 'cerrada', 'cancelada'],
  skip: ['skip', 'no_aplicar', 'no aplicar', 'monitor'],
};
// States that mean an application was sent.
export const APPLIED_STATES = new Set(['applied', 'responded', 'interview', 'offer', 'rejected']);

const pathOf = (cfg, key) => {
  const v = cfg.tracker && key in cfg.tracker ? cfg.tracker[key] : DEFAULTS[key];
  if (!v) return null;
  return isAbsolute(v) ? v : resolve(cfg.projectDir, v);
};

const read = (file) => {
  try { return file && existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
};

export function normState(raw) {
  const s = String(raw || '').replace(/\*/g, '').trim().toLowerCase();
  for (const [id, names] of Object.entries(STATES)) if (names.includes(s)) return id;
  return s || 'unknown';
}

// Company/title matching key: lowercase, accents and punctuation stripped, legal suffixes dropped.
export function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(oy|oyj|ab|ltd|gmbh|inc|llc|as|aps|bv|plc)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
export const pairKey = (company, title) => `${normName(company)}|${normName(title)}`;

const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null);

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

// URL from the Notes column: a full URL, or "Source: host/path".
function urlFromNotes(notes) {
  const full = notes.match(/https?:\/\/[^\s)|,;]+/);
  if (full) return full[0].replace(/[.)\]]+$/, '');
  const src = notes.match(/Source:\s*([a-z0-9.-]+\.[a-z]{2,}\/[^\s)|,;]*)/i);
  return src ? `https://${src[1].replace(/[.)\]]+$/, '')}` : null;
}

export function readApplications(cfg) {
  const text = read(pathOf(cfg, 'applicationsFile'));
  if (!text) return [];
  const lines = text.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const head = splitRow(lines[0]).map((h) => h.toLowerCase());
  const col = (name) => head.indexOf(name);
  const idx = { num: col('#'), date: col('date'), company: col('company'), role: col('role'), score: col('score'), status: col('status'), report: col('report'), notes: col('notes') };
  const rows = [];
  for (const line of lines.slice(1)) {
    if (/^\|[\s:|-]+\|?$/.test(line.trim())) continue; // separator row
    const c = splitRow(line);
    const get = (k) => (idx[k] >= 0 ? c[idx[k]] ?? '' : '');
    const company = get('company'), role = get('role');
    if (!company && !role) continue;
    const notes = get('notes');
    const score = get('score').replace(/\*/g, '').trim();
    const scoreNum = parseFloat(score);
    const reportLink = get('report').match(/\]\(([^)]+\.md)\)/)?.[1] || null;
    const status = normState(get('status'));
    const date = isoDay(get('date'));
    rows.push({
      num: get('num'),
      date,
      company,
      role,
      score: Number.isFinite(scoreNum) && scoreNum > 0 ? score : null,
      status,
      statusLabel: get('status').replace(/\*/g, '').trim(),
      report: reportLink ? basename(reportLink) : null,
      notes,
      url: urlFromNotes(notes),
      // Dates hidden in the notes ("Applied 2026-09-13", "Rejected 2026-10-07"); fall back to the Date column.
      appliedDate: isoDay(notes.match(/applied\b[^.|]{0,40}?(\d{4}-\d{2}-\d{2})/i)?.[1]) || date,
      rejectedDate: isoDay(notes.match(/rejected\b[^.|]{0,20}?(\d{4}-\d{2}-\d{2})/i)?.[1]),
      evaluatedDate: isoDay(reportLink?.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1]) || date,
    });
  }
  return rows;
}

// url → { firstSeen, portal } and company|title → earliest { firstSeen, portal, url }.
export function readScanHistory(cfg) {
  const byUrl = new Map(), byPair = new Map();
  const text = read(pathOf(cfg, 'scanHistoryFile'));
  if (!text) return { byUrl, byPair };
  const [header, ...lines] = text.split('\n');
  const h = header.split('\t').map((x) => x.trim().toLowerCase());
  const i = { url: h.indexOf('url'), seen: h.indexOf('first_seen'), portal: h.indexOf('portal'), title: h.indexOf('title'), company: h.indexOf('company') };
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    const seen = isoDay(c[i.seen]);
    if (!seen) continue;
    const rec = { firstSeen: seen, portal: c[i.portal]?.trim() || null, url: c[i.url]?.trim() || null };
    if (rec.url && (!byUrl.has(rec.url) || byUrl.get(rec.url).firstSeen > seen)) byUrl.set(rec.url, rec);
    const k = pairKey(c[i.company], c[i.title]);
    if (k !== '|' && (!byPair.has(k) || byPair.get(k).firstSeen > seen)) byPair.set(k, rec);
  }
  return { byUrl, byPair };
}

// Report markdown by file name, only from inside reportsDir.
export function readReport(cfg, name) {
  const dir = pathOf(cfg, 'reportsDir');
  if (!dir || !/^[\w.-]+\.md$/.test(name || '')) return null;
  const file = resolve(dir, name);
  const rel = relative(dir, file);
  if (rel.startsWith('..') || rel.includes(sep)) return null;
  return read(file) || null;
}
