/**
 * Retell phone-number inbound webhook for +15169731973.
 *
 * Looks up the caller in HubSpot and, when exactly one contact with a usable
 * first name matches, overrides begin_message for that call only.
 * Always fails open to the saved default greeting.
 *
 * Env:
 *   RETELL_WEBHOOK_KEY (preferred) or RETELL_API_KEY — X-Retell-Signature
 *   OWNERAI_DEMO_HUBSPOT_TOKEN — read-only HubSpot private app token (optional)
 */
import crypto from 'node:crypto';
import { retellVerifyKeys } from './lib/retell-verify.mjs';
import {
  DEMO_VOICE_E164,
  buildCallInboundResponse,
  resolveCallerFirstName,
} from './lib/hubspot-caller.mjs';
import { normalizePhone } from './lib/leads.mjs';

function verifyRetellSignature(rawBody, apiKey, signature) {
  if (!apiKey || !signature || typeof signature !== 'string') return false;
  const match = /^v=(\d+),d=(.*)$/.exec(signature);
  if (!match) return false;
  const [, timestamp, digest] = match;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
  try {
    const expected = crypto
      .createHmac('sha256', apiKey)
      .update(rawBody + timestamp)
      .digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(digest, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Pure routing for inbound events (exported for tests).
 * @param {object} payload
 * @param {{ resolveFirstName?: (from: string) => Promise<string|null> }} [deps]
 */
export async function handleInboundPayload(payload, deps = {}) {
  const resolveFirstName = deps.resolveFirstName ?? resolveCallerFirstName;

  if (payload?.event === 'chat_inbound' || payload?.chat_inbound) {
    return { chat_inbound: {} };
  }

  const inbound = payload?.call_inbound || {};
  const to = normalizePhone(inbound.to_number || payload?.to_number);
  const from = inbound.from_number || payload?.from_number;

  if (to && to !== DEMO_VOICE_E164) {
    return { call_inbound: {} };
  }

  try {
    const firstName = await resolveFirstName(from);
    return buildCallInboundResponse(firstName);
  } catch (err) {
    console.error('inbound-caller: lookup failed', err?.message || err);
    return { call_inbound: {} };
  }
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-retell-signature');
  const verifyKeys = retellVerifyKeys();
  if (!verifyKeys.some((k) => verifyRetellSignature(rawBody, k, signature))) {
    return json({ error: 'Invalid signature' }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ call_inbound: {} });
  }

  const body = await handleInboundPayload(payload);
  return json(body);
}
