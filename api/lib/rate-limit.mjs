// Durable rate limits via Supabase RPC (with in-memory fallback).
import crypto from 'node:crypto';
import { clientIp } from './client-ip.mjs';

const memory = new Map();

export { clientIp };

function memAllow(key, windowMs, max) {
  const now = Date.now();
  const rec = memory.get(key);
  if (!rec || now - rec.start >= windowMs) {
    if (memory.size > 5000) memory.clear();
    memory.set(key, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= max;
}

async function sbAllow(bucket, windowMs, max) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  try {
    const res = await fetch(`${url}/rest/v1/rpc/bump_rate_limit`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_bucket: bucket,
        p_window: windowStart,
        p_max: max,
      }),
    });
    if (!res.ok) {
      // Function/table missing — fall back to memory until migration is applied.
      return null;
    }
    const allowed = await res.json();
    return allowed === true;
  } catch {
    return null;
  }
}

/**
 * @param {string} bucket unique key (e.g. chat:ip:abc)
 * @param {{ windowMs: number, max: number }} opts
 */
export async function allowRate(bucket, { windowMs, max }) {
  const durable = await sbAllow(bucket, windowMs, max);
  if (durable === true || durable === false) return durable;
  return memAllow(bucket, windowMs, max);
}

export function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 24);
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;

/** Durable login throttle (dashboard / sales / invite). */
export async function allowLoginAttempt(scope, request) {
  const ipKey = hashIp(clientIp(request));
  return allowRate(`login:${scope}:${ipKey}`, { windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX });
}
