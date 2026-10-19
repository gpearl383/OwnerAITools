#!/usr/bin/env node
// Create a Sales Console user.
//
//   node scripts/create-sales-user.mjs email@example.com 'password' [Display Name]
//   node scripts/create-sales-user.mjs --invite email@example.com [Display Name]
//   node scripts/create-sales-user.mjs --invite --resend email@example.com
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SALES_SESSION_SECRET in .env.local
// Invite mode also needs RESEND_API_KEY (prints the link even if email fails).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSalesInviteUser,
  createSalesUser,
  findSalesUserByEmail,
} from '../api/lib/sales-auth.mjs';

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

const args = process.argv.slice(2);
const inviteMode = args.includes('--invite');
const resendMode = args.includes('--resend');
const positional = args.filter((a) => !a.startsWith('--'));

async function sendInviteEmail({ to, link, displayName }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI <info@owneraitools.com>';
  if (!apiKey) {
    console.warn('RESEND_API_KEY missing — email not sent (use the printed link).');
    return { sent: false, reason: 'missing RESEND_API_KEY' };
  }
  const name = displayName || 'there';
  const html = `
    <p>Hi ${escapeHtml(name)},</p>
    <p>You've been invited to the OwnerAI demo console. Set your password with this link (expires in 7 days):</p>
    <p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
    <p>After you set a password, sign in at <a href="https://demo.owneraitools.com/sales">demo.owneraitools.com/sales</a> using your email as the username.</p>
    <p>— OwnerAI</p>
  `;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Set your OwnerAI demo password',
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Resend failed ${res.status}: ${text}`);
    return { sent: false, reason: text.slice(0, 200) };
  }
  const data = await res.json();
  return { sent: true, id: data.id };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

if (inviteMode) {
  const [email, ...nameParts] = positional;
  if (!email) {
    console.error(
      'Usage: node scripts/create-sales-user.mjs --invite email [Display Name]\n' +
        '       node scripts/create-sales-user.mjs --invite --resend email',
    );
    process.exit(1);
  }
  const displayName = nameParts.join(' ') || 'Sales';
  try {
    const { user, token, expiresAt } = await createSalesInviteUser({
      email,
      displayName: resendMode ? undefined : displayName,
      resend: resendMode,
    });
    const base = (process.env.DEMO_BASE_URL || 'https://demo.owneraitools.com').replace(/\/$/, '');
    const link = `${base}/set-password?token=${encodeURIComponent(token)}`;
    console.log(`Invite ready for ${user.email} (${user.id})`);
    console.log(`Expires: ${expiresAt}`);
    console.log(`Link: ${link}`);
    const mail = await sendInviteEmail({
      to: user.email,
      link,
      displayName: user.display_name || displayName,
    });
    if (mail.sent) console.log(`Email sent (Resend id ${mail.id})`);
    else console.log(`Email not sent: ${mail.reason}`);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
  process.exit(0);
}

const [email, password, ...nameParts] = positional;
if (!email || !password) {
  console.error(
    'Usage: node scripts/create-sales-user.mjs email password [Display Name]\n' +
      '       node scripts/create-sales-user.mjs --invite email [Display Name]',
  );
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
