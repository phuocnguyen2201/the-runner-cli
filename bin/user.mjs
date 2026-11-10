#!/usr/bin/env node
// Manage accounts from the shell (the admin creates other users in the UI too).
//
//   node bin/user.mjs add <name> [--email you@example.com] [--admin]
//   node bin/user.mjs passwd <name>
//   node bin/user.mjs list
//
// The password is asked for on the terminal, or read from RUNNER_PASSWORD.

import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../lib/config.mjs';
import { createUser, updateUser, listUsers, findUser } from '../lib/users.mjs';

const [, , cmd, name, ...rest] = process.argv;
const flag = (f) => rest.includes(f);
const value = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);

async function askPassword(prompt) {
  if (process.env.RUNNER_PASSWORD) return process.env.RUNNER_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.startsWith(prompt)) rl.output.write(prompt); }; // don't echo the password
  const pw = await rl.question(prompt);
  rl.close();
  process.stdout.write('\n');
  return pw;
}

try {
  const cfg = loadConfig();
  if (cmd === 'add' && name) {
    const pw = await askPassword(`Password for ${name}: `);
    // The admin takes over the existing mail.to unless another address is given.
    const email = value('--email') ?? (flag('--admin') ? cfg.mail?.to : null) ?? null;
    const user = createUser(cfg, { name, email, password: pw, admin: flag('--admin') });
    console.log(`Created ${user.admin ? 'admin ' : ''}${user.name}${user.email ? ` <${user.email}>` : ''}`);
  } else if (cmd === 'passwd' && name) {
    if (!findUser(cfg, name)) throw new Error(`no such user: ${name}`);
    updateUser(cfg, name, { password: await askPassword(`New password for ${name}: `) });
    console.log(`Password changed for ${name}`);
  } else if (cmd === 'list') {
    for (const u of listUsers(cfg)) console.log(`${u.name}${u.admin ? ' (admin)' : ''}\t${u.email ?? '-'}`);
  } else {
    console.log('Usage: node bin/user.mjs add <name> [--email x] [--admin] | passwd <name> | list');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
