// Sales Console auth — separate from ops DASHBOARD_PASSWORD / oat_dash.
import crypto from 'node:crypto';

export const SALES_COOKIE = 'oat_sales';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 64).toString('hex');
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
    }),
  });
  if (!res.ok) {
    throw new Error(`createSalesUser ${res.status}: ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

export async function requireSalesUser(request) {
  const secret = salesSessionSecret();
  const session = readSalesSession(request, secret);
  if (!session?.userId) return null;
  const user = await findSalesUserById(session.userId);
  if (!user || user.active === false) return null;
  return user;
}

const attempts = new Map();
export function allowSalesLogin(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.start >= 15 * 60 * 1000) {
    attempts.set(ip, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= 10;
}

export function clientIp(request) {
  return (
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}
