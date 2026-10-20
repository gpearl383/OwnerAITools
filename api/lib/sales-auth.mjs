// Sales Console auth — separate from ops DASHBOARD_PASSWORD / oat_dash.
import crypto from 'node:crypto';
import { allowLoginAttempt, clientIp } from './rate-limit.mjs';

export const SALES_COOKIE = 'oat_sales';
export { clientIp };
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Cap before scrypt to avoid CPU DoS from huge password bodies. */
export const MAX_PASSWORD_LENGTH = 128;

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function salesSessionSecret() {
  return (
    process.env.SALES_SESSION_SECRET ||
    process.env.DASHBOARD_SESSION_SECRET ||
    null
  );
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const pw = String(password);
  if (pw.length > MAX_PASSWORD_LENGTH) throw new Error('Password too long');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  const pw = String(password);
  if (pw.length > MAX_PASSWORD_LENGTH) return false;
  const next = crypto.scryptSync(pw, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(next, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

function cookieFlags() {
  // Secure on Vercel/production; omit locally so http://localhost can hold the session.
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production';
  return `Path=/; Max-Age=86400; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function makeSalesSessionCookie(secret, userId) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const uid = String(userId);
  const payload = `${exp}.u.${uid}`;
  const token = `${payload}.${sign(payload, secret)}`;
  return `${SALES_COOKIE}=${token}; ${cookieFlags()}`;
}

export function clearSalesSessionCookie() {
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production';
  return `${SALES_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function readSalesSession(request, secret) {
  if (!secret) return null;
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SALES_COOKIE}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 4 || parts[1] !== 'u') return null;
  const [exp, , userId, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  const payload = `${exp}.u.${userId}`;
  const expected = sign(payload, secret);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return { type: 'user', userId };
}

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return {
    url,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  };
}

export async function findSalesUserByEmail(email) {
  const client = sb();
  if (!client || !email) return null;
  const normalized = String(email).trim().toLowerCase();
  const qs = new URLSearchParams({
    select: '*',
    email: `ilike.${normalized}`,
    limit: '1',
  });
  const res = await fetch(`${client.url}/rest/v1/sales_users?${qs}`, {
    headers: client.headers,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

/** True when no sales_users rows exist (bootstrap may create the first account). */
export async function salesUsersEmpty() {
  const client = sb();
  if (!client) return false;
  const qs = new URLSearchParams({ select: 'id', limit: '1' });
  const res = await fetch(`${client.url}/rest/v1/sales_users?${qs}`, {
    headers: { ...client.headers, Prefer: 'count=exact' },
  });
  if (!res.ok) return false;
  const range = res.headers.get('content-range') || '';
  // content-range: */0 or 0-0/N
  const total = Number((range.split('/')[1] || '').trim());
  if (Number.isFinite(total)) return total === 0;
  const rows = await res.json();
  return !rows?.length;
}

export async function findSalesUserById(id) {
  const client = sb();
  if (!client || !id) return null;
  const qs = new URLSearchParams({
    select: '*',
    id: `eq.${id}`,
    limit: '1',
  });
  const res = await fetch(`${client.url}/rest/v1/sales_users?${qs}`, {
    headers: client.headers,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

export async function createSalesUser({ email, password, displayName }) {
  const client = sb();
  if (!client) throw new Error('Supabase env vars missing');
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized || !password) throw new Error('email and password required');
  const { salt, hash } = hashPassword(password);
  const res = await fetch(`${client.url}/rest/v1/sales_users`, {
    method: 'POST',
    headers: { ...client.headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      email: normalized,
      password_salt: salt,
      password_hash: hash,
      display_name: displayName || null,
      active: true,
      invite_token_hash: null,
      invite_expires_at: null,
    }),
  });
  if (!res.ok) {
    throw new Error(`createSalesUser ${res.status}: ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Opaque invite: exp.userId.sig — verified with SALES_SESSION_SECRET. */
export function makeInviteToken(userId, secret = salesSessionSecret()) {
  if (!secret) throw new Error('SALES_SESSION_SECRET missing');
  const exp = String(Date.now() + INVITE_TTL_MS);
  const uid = String(userId);
  const payload = `${exp}.${uid}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function parseInviteToken(token, secret = salesSessionSecret()) {
  if (!secret || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [exp, userId, sig] = parts;
  if (!exp || !userId || !sig) return null;
  if (Number(exp) < Date.now()) return null;
  const payload = `${exp}.${userId}`;
  const expected = sign(payload, secret);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return { userId, exp: Number(exp) };
}

async function patchSalesUser(id, fields) {
  const client = sb();
  if (!client) throw new Error('Supabase env vars missing');
  const res = await fetch(`${client.url}/rest/v1/sales_users?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...client.headers, Prefer: 'return=representation' },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`patchSalesUser ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

/**
 * Create (or refresh invite for) a sales user who must set a password via link.
 * Returns { user, token }. Errors if the user already has a set password (no pending invite).
 */
export async function createSalesInviteUser({ email, displayName, resend = false }) {
  const client = sb();
  if (!client) throw new Error('Supabase env vars missing');
  const secret = salesSessionSecret();
  if (!secret) throw new Error('SALES_SESSION_SECRET missing');

  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) throw new Error('email required');

  let user = await findSalesUserByEmail(normalized);
  if (user) {
    const pending = Boolean(user.invite_token_hash);
    // Fresh invite refused if they already completed signup; --resend rotates a reset link.
    if (!pending && !resend) {
      throw new Error('User already exists with a password set — use --invite --resend to email a reset link');
    }
  } else {
    // Unusable password until they complete set-password.
    const throwaway = crypto.randomBytes(32).toString('hex');
    const { salt, hash } = hashPassword(throwaway);
    const res = await fetch(`${client.url}/rest/v1/sales_users`, {
      method: 'POST',
      headers: { ...client.headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        email: normalized,
        password_salt: salt,
        password_hash: hash,
        display_name: displayName || null,
        active: true,
      }),
    });
    if (!res.ok) throw new Error(`createSalesInviteUser ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    user = rows[0];
    if (!user) throw new Error('createSalesInviteUser returned no row');
  }

  const token = makeInviteToken(user.id, secret);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const updated = await patchSalesUser(user.id, {
    invite_token_hash: hashInviteToken(token),
    invite_expires_at: expiresAt,
    display_name: displayName || user.display_name || null,
  });
  return { user: updated || user, token, expiresAt };
}

export async function lookupSalesInvite(token) {
  const parsed = parseInviteToken(token);
  if (!parsed) return { error: 'Invalid or expired invite link' };
  const user = await findSalesUserById(parsed.userId);
  if (!user || user.active === false) return { error: 'Invalid or expired invite link' };
  if (!user.invite_token_hash) return { error: 'This invite was already used' };
  if (user.invite_expires_at && new Date(user.invite_expires_at).getTime() < Date.now()) {
    return { error: 'This invite has expired' };
  }
  const expected = hashInviteToken(token);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(user.invite_token_hash))) {
      return { error: 'Invalid or expired invite link' };
    }
  } catch {
    return { error: 'Invalid or expired invite link' };
  }
  return { user };
}

export async function setSalesPasswordFromInvite({ token, password }) {
  const pw = String(password || '');
  if (pw.length < 10) return { error: 'Password must be at least 10 characters' };
  if (pw.length > MAX_PASSWORD_LENGTH) {
    return { error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  const looked = await lookupSalesInvite(token);
  if (looked.error) return looked;
  const { salt, hash } = hashPassword(pw);
  const updated = await patchSalesUser(looked.user.id, {
    password_salt: salt,
    password_hash: hash,
    invite_token_hash: null,
    invite_expires_at: null,
  });
  return { user: updated || looked.user };
}

/** True when the user still must set a password via invite. */
export function hasPendingInvite(user) {
  return Boolean(user?.invite_token_hash);
}

export async function requireSalesUser(request) {
  const secret = salesSessionSecret();
  const session = readSalesSession(request, secret);
  if (!session?.userId) return null;
  const user = await findSalesUserById(session.userId);
  if (!user || user.active === false) return null;
  return user;
}

/** Durable sales login / invite throttle (Supabase-backed with memory fallback). */
export async function allowSalesLogin(request) {
  return allowLoginAttempt('sales', request);
}
