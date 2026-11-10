import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashPassword, verifyPassword, validEmail, validName, userCfg, canSee,
  createUser, updateUser, createSession, sessionUser, deleteSession,
} from '../lib/users.mjs';

test('password hash round-trip', () => {
  const u = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', u));
  assert.ok(!verifyPassword('wrong horse', u));
  assert.ok(!verifyPassword(undefined, u));
});

test('name and email validation', () => {
  assert.equal(validName('bob_1'), 'bob_1');
  for (const bad of ['B', '../x', 'a', 'x y']) assert.throws(() => validName(bad));
  assert.equal(validEmail(' a@b.co '), 'a@b.co');
  for (const bad of ['a@b.c\nBcc: x@y.z', 'a b@c.d', 'nope', 'a@b.c, d@e.f']) assert.throws(() => validEmail(bad));
});

test('legacy runs without a user belong to the admin', () => {
  const admin = { name: 'boss', admin: true };
  const bob = { name: 'bob', admin: false };
  assert.ok(canSee(admin, { user: 'bob' }, 'boss'));
  assert.ok(!canSee(bob, {}, 'boss'));
  assert.ok(canSee(bob, { user: 'bob' }, 'boss'));
});

test('userCfg rebases project paths for a user and keeps the admin config', () => {
  const cfg = {
    projectDir: '/p', promptFile: '/p/prompt.md', usersDir: '/u', runsDir: '/r',
    editableFiles: ['/p/cv.md', { label: 'Rules', path: 'CLAUDE.md' }, '/shared/x.md'],
    mail: { to: 'old@x.io', command: 'msmtp -t' },
  };
  const a = userCfg(cfg, { name: 'boss', admin: true, email: 'me@x.io' });
  assert.equal(a.projectDir, '/p');
  assert.equal(a.mail.to, 'me@x.io');
  const b = userCfg(cfg, { name: 'bob', email: 'bob@x.io' });
  assert.equal(b.projectDir, join('/u', 'bob', 'project'));
  assert.equal(b.promptFile, resolve('/u', 'bob', 'project', 'prompt.md'));
  assert.deepEqual(b.editableFiles, [resolve('/u', 'bob', 'project', 'cv.md'), { label: 'Rules', path: 'CLAUDE.md' }, '/shared/x.md']);
  assert.equal(b.itemsFile, join('/u', 'bob', 'items.json'));
  assert.equal(b.mail.to, 'bob@x.io');
});

test('createUser copies the template; sessions resolve and expire on logout', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-users-'));
  const tpl = join(root, 'tpl');
  mkdirSync(tpl);
  writeFileSync(join(tpl, 'cv.md'), 'blank cv');
  const cfg = { usersDir: join(root, 'users'), userTemplateDir: tpl };

  createUser(cfg, { name: 'boss', password: 'longpassword', email: 'me@x.io', admin: true });
  assert.ok(!existsSync(join(cfg.usersDir, 'boss')));
  createUser(cfg, { name: 'bob', password: 'longpassword' });
  assert.equal(readFileSync(join(cfg.usersDir, 'bob', 'project', 'cv.md'), 'utf8'), 'blank cv');
  assert.throws(() => createUser(cfg, { name: 'bob', password: 'longpassword' }), /taken/);
  assert.throws(() => createUser(cfg, { name: 'eve', password: 'short' }));

  assert.equal(updateUser(cfg, 'bob', { email: 'bob@x.io' }).email, 'bob@x.io');
  const token = createSession(cfg, 'bob');
  assert.equal(sessionUser(cfg, token).name, 'bob');
  assert.equal(sessionUser(cfg, token).hash, undefined);
  deleteSession(cfg, token);
  assert.equal(sessionUser(cfg, token), null);
});
