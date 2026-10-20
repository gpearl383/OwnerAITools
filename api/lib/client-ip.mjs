/**
 * Client IP for rate limiting.
 * Prefer Vercel's trusted header; otherwise use the last X-Forwarded-For hop
 * (platforms append the connecting IP — the first hop is client-spoofable).
 */
export function clientIp(request) {
  const vercel = (request.headers.get('x-vercel-forwarded-for') || '').split(',')[0].trim();
  if (vercel) return vercel;

  const xff = (request.headers.get('x-forwarded-for') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length) return xff[xff.length - 1];

  return request.headers.get('x-real-ip') || 'unknown';
}
