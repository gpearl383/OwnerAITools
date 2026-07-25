import crypto from 'node:crypto';

/** Fail-closed Bearer CRON_SECRET check (constant-time). */
export function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const provided = m[1].trim();
  const ha = crypto.createHash('sha256').update(provided).digest();
  const hb = crypto.createHash('sha256').update(secret).digest();
  try {
    return crypto.timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}
