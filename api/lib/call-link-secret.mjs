/**
 * HMAC key for /api/call and lead-action capability URLs.
 * Requires CALL_LINK_SECRET — no derivation from the service-role key.
 */
export function callLinkSecret() {
  const secret = process.env.CALL_LINK_SECRET;
  return secret && String(secret).length > 0 ? String(secret) : null;
}
