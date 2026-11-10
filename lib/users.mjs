// Accounts: users.json + sessions.json in cfg.usersDir, and the per-user view of the config.
// The admin owns the original projectDir and every run without a "user" field.
// Other users get usersDir/<name>/project, copied from cfg.userTemplateDir.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './config.mjs';
import { httpError } from './files.mjs';

const NAME_RE = /^[a-z0-9_-]{2,32}$/;
// No whitespace or control chars: the address goes into the To: header read by `msmtp -t`.
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const SESSION_MS = 30 * 24 * 3600 * 1000;

const usersFile = (cfg) => join(cfg.usersDir, 'users.json');
const sessionsFile = (cfg) => join(cfg.usersDir, 'sessions.json');

export function validName(name) {
  if (!NAME_RE.test(String(name ?? ''))) throw httpError(400, 'name must be 2-32 characters: a-z, 0-9, _ or -');
  return name;
}

export function validEmail(email) {
  const e = String(email ?? '').trim();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw httpError(400, 'invalid email address');
  return e;
}

function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw httpError(400, 'password must be 8-200 characters');
  return pw;
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(pw, salt, 64).toString('hex') };
}

export function verifyPassword(pw, user) {
  if (typeof pw !== 'string' || !user?.salt || !user?.hash) return false;
  const a = scryptSync(pw, user.salt, 64);
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const loadUsers = (cfg) => readJson(usersFile(cfg), []);
const saveUsers = (cfg, users) => {
  mkdirSync(cfg.usersDir, { recursive: true });
  writeJsonAtomic(usersFile(cfg), users);
};
const publicUser = ({ name, admin, email, createdAt }) => ({ name, admin: Boolean(admin), email: email || null, createdAt });

export const hasUsers = (cfg) => loadUsers(cfg).length > 0;
export const findUser = (cfg, name) => loadUsers(cfg).find((u) => u.name === name) || null;
export const adminUser = (cfg) => loadUsers(cfg).find((u) => u.admin) || null;
export const listUsers = (cfg) => loadUsers(cfg).map(publicUser);

export function createUser(cfg, { name, password, email, admin = false }) {
  validName(name);
  validPassword(password);
  const users = loadUsers(cfg);
  if (users.some((u) => u.name === name)) throw httpError(409, 'that name is taken');
  const user = { name, admin: Boolean(admin), email: email ? validEmail(email) : null, ...hashPassword(password), createdAt: new Date().toISOString() };
  if (!user.admin) {
    const tpl = cfg.userTemplateDir;
    if (!tpl || !existsSync(tpl)) throw httpError(500, `userTemplateDir does not exist: ${tpl} (set it in config.json)`);
    const dest = join(cfg.usersDir, name, 'project');
    if (!existsSync(dest)) cpSync(tpl, dest, { recursive: true });
  }
  saveUsers(cfg, [...users, user]);
  return publicUser(user);
}

export function updateUser(cfg, name, { email, password }) {
  const users = loadUsers(cfg);
  const user = users.find((u) => u.name === name);
  if (!user) throw httpError(404, 'user not found');
  if (email !== undefined) user.email = email ? validEmail(email) : null;
  if (password !== undefined) Object.assign(user, hashPassword(validPassword(password)));
  saveUsers(cfg, users);
  return publicUser(user);
}

export function createSession(cfg, name) {
  const now = Date.now();
  const sessions = Object.fromEntries(Object.entries(readJson(sessionsFile(cfg), {})).filter(([, s]) => s.exp > now));
  const token = randomBytes(32).toString('hex');
  sessions[token] = { name, exp: now + SESSION_MS };
  mkdirSync(cfg.usersDir, { recursive: true });
  writeJsonAtomic(sessionsFile(cfg), sessions);
  return token;
}

export function sessionUser(cfg, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token ?? ''))) return null;
  const s = readJson(sessionsFile(cfg), {})[token];
  if (!s || s.exp < Date.now()) return null;
  const user = findUser(cfg, s.name);
  return user ? publicUser(user) : null;
}

export function deleteSession(cfg, token) {
  const sessions = readJson(sessionsFile(cfg), {});
  if (!(token in sessions)) return;
  delete sessions[token];
  writeJsonAtomic(sessionsFile(cfg), sessions);
}

// Runs without a "user" field are from before accounts existed and belong to the admin.
export const runOwner = (status, adminName) => status?.user ?? adminName ?? null;
export const canSee = (user, status, adminName) => Boolean(user?.admin) || runOwner(status, adminName) === user?.name;

// The config as seen by one user: their projectDir, files, item store and email.
export function userCfg(cfg, user) {
  if (!user) return cfg;
  const mail = cfg.mail ? { ...cfg.mail, to: user.email || null } : null;
  if (user.admin) return { ...cfg, mail };

  const projectDir = join(cfg.usersDir, user.name, 'project');
  // Paths inside the admin projectDir point to the same file in the user's copy.
  const rebase = (p) => {
    if (p == null || !isAbsolute(p)) return p;
    const rel = relative(cfg.projectDir, p);
    return rel.startsWith('..') || isAbsolute(rel) ? p : resolve(projectDir, rel);
  };
  return {
    ...cfg,
    projectDir,
    promptFile: rebase(cfg.promptFile),
    editableFiles: Array.isArray(cfg.editableFiles)
      ? cfg.editableFiles.map((e) => (typeof e === 'string' ? rebase(e) : { ...e, path: rebase(e.path) }))
      : cfg.editableFiles,
    itemsFile: join(cfg.usersDir, user.name, 'items.json'),
    versionsDir: join(cfg.usersDir, user.name, '.versions'),
    mail,
  };
}
