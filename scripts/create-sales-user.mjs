#!/usr/bin/env node
// Create a Sales Console user.
//
//   node scripts/create-sales-user.mjs email@example.com 'password' [Display Name]
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSalesUser, findSalesUserByEmail } from '../api/lib/sales-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvLocal() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();

const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/create-sales-user.mjs email password [Display Name]');
  process.exit(1);
}

const existing = await findSalesUserByEmail(email);
if (existing) {
  console.error(`User already exists: ${existing.email} (${existing.id})`);
  process.exit(1);
}

const user = await createSalesUser({
  email,
  password,
  displayName: nameParts.join(' ') || 'Sales',
});
console.log(`Created sales user ${user.email} (${user.id})`);
