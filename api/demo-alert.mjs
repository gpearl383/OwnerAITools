// Mid-call demo lead-alert SMS for the OwnerAI Tools demo line.
//
// The demo voice agent calls this endpoint (Retell custom function
// `send_demo_alert`) right after a role-play, and we text the prospect the
// exact owner alert their business would receive — while they're still on
// the call.
//
// Required env vars:
//   RETELL_WEBHOOK_KEY / RETELL_API_KEY — verify the X-Retell-Signature header
//   RETELL_SMS_FROM                     — sending number (+15169731973)
//   RETELL_DEMO_ALERT_AGENT_ID          — chat agent with {{demo_alert_body}} template
// Optional:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — audit trail logging

import crypto from 'node:crypto';

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

function normalizePhone(v) {
  const digits = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

/* ---------- rate limiting (per warm instance) ---------- */

const perNumber = new Map();
const globalHits = { start: 0, count: 0 };

function allowSend(number) {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  if (now - globalHits.start >= HOUR) {
    globalHits.start = now;
    globalHits.count = 0;
  }
  if (globalHits.count >= 30) return false;
  const rec = perNumber.get(number);
  if (rec && now - rec.start < HOUR && rec.count >= 5) return false;
  if (!rec || now - rec.start >= HOUR) perNumber.set(number, { start: now, count: 1 });
  else rec.count += 1;
  globalHits.count += 1;
  if (perNumber.size > 2000) perNumber.clear();
  return true;
}

/* ---------- SMS + audit ---------- */

function buildDemoAlertBody(args) {
  const biz = (args.business_name || 'YOUR BUSINESS').toUpperCase().slice(0, 60);
  const lines = [
    `[DEMO] ${biz} — new lead, answered by your AI receptionist`,
    [args.customer_name, args.issue, args.urgent ? 'URGENT' : '']
      .filter(Boolean)
      .join(' — '),
    args.customer_phone ? `Callback: ${args.customer_phone}` : '',
    args.address ? `Address: ${args.address}` : '',
    args.appointment ? `Booked: ${args.appointment}` : '',
    'This is a sample owner alert from the OwnerAI Tools demo. Reply STOP to opt out.',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1200);
}

async function sendDemoSms(to, body) {
  const res = await fetch('https://api.retellai.com/create-sms-chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: process.env.RETELL_SMS_FROM,
      to_number: to,
      override_agent_id: process.env.RETELL_DEMO_ALERT_AGENT_ID,
      metadata: { source: 'demo-lead-alert' },
      retell_llm_dynamic_variables: { demo_alert_body: body },
    }),
  });
  if (!res.ok) throw new Error(`Retell SMS ${res.status}: ${await res.text()}`);
  return res.json();
}

async function logAudit(row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([row]),
    });
    if (!res.ok) console.error('demo-alert audit insert failed:', res.status);
  } catch (err) {
    console.error('demo-alert audit failed:', err.message);
  }
}

// The tool response body is read back to the LLM — keep it short and speakable.
function toolResult(text) {
  return new Response(JSON.stringify({ result: text }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-retell-signature');
  const verifyKeys = [process.env.RETELL_WEBHOOK_KEY, process.env.RETELL_API_KEY].filter(Boolean);
  if (!verifyKeys.some((k) => verifyRetellSignature(rawBody, k, signature))) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return toolResult('The text could not be sent. Continue the conversation without it.');
  }

  // Retell custom-function body: { name, call, args }. Tolerate args-only too.
  const args = payload.args || payload;
  const call = payload.call || {};
  const to = normalizePhone(args.prospect_mobile);

  if (!to) {
    return toolResult('That mobile number did not look valid. Ask the caller to repeat it.');
  }
  if (!process.env.RETELL_SMS_FROM || !process.env.RETELL_DEMO_ALERT_AGENT_ID) {
    console.error('demo-alert: SMS env vars missing');
    return toolResult('The sample text is unavailable right now. Continue without it.');
  }
  if (!allowSend(to)) {
    return toolResult('A sample alert was already sent to that number recently. Continue without sending another.');
  }

  const body = buildDemoAlertBody(args);
  try {
    await sendDemoSms(to, body);
    await logAudit({
      event_type: 'demo_alert_sms_sent',
      status: 'ok',
      call_id: call.call_id || null,
      caller_name: (args.customer_name || '').slice(0, 200) || null,
      from_number: call.from_number || null,
      detail: `sample alert for ${args.business_name || 'unknown business'}`,
      payload: {
        business_name: args.business_name,
        issue: args.issue,
        appointment: args.appointment,
        urgent: args.urgent === true,
        sms_body: body,
      },
    });
    return toolResult('Sent. Tell the caller to check their phone — that text is exactly what they would get as the owner.');
  } catch (err) {
    console.error('demo-alert send failed:', err.message);
    await logAudit({
      event_type: 'sms_failed',
      status: 'failed',
      call_id: call.call_id || null,
      from_number: call.from_number || null,
      detail: `demo alert: ${err.message.slice(0, 400)}`,
    });
    return toolResult('The text failed to send. Apologize briefly and continue the conversation.');
  }
}
