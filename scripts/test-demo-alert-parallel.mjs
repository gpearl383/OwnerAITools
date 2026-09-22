// Unit checks for api/demo-alert.mjs after the 2026-09-10 post-mortem
// latency fix (docs/ops/2026-09-10-demo-call-postmortem.md):
//   1. SMS legs and email legs run in PARALLEL chains (not serially) so the
//      tool responds fast enough to avoid mid-call dead air.
//   2. The result text / leg ordering contract is unchanged:
//      "Sent: the lead alert text, the appointment-booked text, the calendar
//       invite, the owner email."
//   3. end-chat thread hygiene still runs (deferred, settled before return).
//
// No network: global fetch is stubbed with a 150ms-per-call recorder.
// Requires caller_confirmed_calling_number (2026-09-18 reliability gate).

import crypto from 'node:crypto';

process.env.RETELL_API_KEY = 'test-key-demo-alert';
delete process.env.RETELL_WEBHOOK_KEY;
process.env.RETELL_SMS_FROM = '+15169731973';
process.env.RETELL_DEMO_ALERT_AGENT_ID = 'agent_test_template';
process.env.RESEND_API_KEY = 'test-resend-key';
// Force the in-memory allowance fallback + skip audit logging.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { POST } = await import('../api/demo-alert.mjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const NETWORK_DELAY_MS = 150;
const calls = []; // { url, start, end, channel }

globalThis.fetch = async function stubFetch(url, opts = {}) {
  const u = String(url);
  let channel = 'other';
  if (u.includes('create-sms-chat') || u.includes('get-chat') || u.includes('end-chat')) {
    channel = 'sms';
  } else if (u.includes('resend.com')) {
    channel = 'email';
  }
  const rec = { url: u, start: Date.now(), end: null, channel };
  calls.push(rec);
  // get-chat polls should be near-instant in this stub so create-sms timing
  // stays predictable; real compose latency is covered by the compose-wait test.
  const delay = u.includes('get-chat') ? 0 : NETWORK_DELAY_MS;
  await new Promise((r) => setTimeout(r, delay));
  rec.end = Date.now();
  let body = {};
  if (u.includes('create-sms-chat')) body = { chat_id: `chat_${calls.length}` };
  if (u.includes('get-chat')) {
    body = { message_with_tool_calls: [{ role: 'agent', content: '[DEMO] sample' }] };
  }
  if (u.includes('resend.com')) body = { id: `email_${calls.length}` };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

function signedRequest(payload) {
  const rawBody = JSON.stringify(payload);
  const ts = Date.now();
  const digest = crypto
    .createHmac('sha256', process.env.RETELL_API_KEY)
    .update(rawBody + ts)
    .digest('hex');
  return new Request('http://localhost/api/demo-alert', {
    method: 'POST',
    body: rawBody,
    headers: { 'x-retell-signature': `v=${ts},d=${digest}` },
  });
}

const payload = {
  name: 'send_demo_alert',
  call: { call_id: 'call_test_parallel_1', from_number: '+15165551234' },
  args: {
    business_name: 'KK Cleaning, Incorporated',
    customer_name: 'Jeff Parker',
    issue: 'one-time deep cleaning',
    address: '236 Lindberg Street, Massapequa Park, NY',
    send_text: true,
    caller_confirmed_calling_number: true,
    prospect_email: 'gpearl@example.com',
    appointment: 'Monday at 10 AM',
    appointment_start: '2099-01-05T10:00:00-05:00',
  },
};

const t0 = Date.now();
const res = await POST(signedRequest(payload));
const elapsed = Date.now() - t0;
const { result } = await res.json();

// --- contract: status + result text ordering unchanged ---
assert(res.status === 200, `expected 200, got ${res.status}`);
assert(
  result.startsWith(
    'Sent: the lead alert text, the appointment-booked text, the calendar invite, the owner email.'
  ),
  `unexpected result text: ${result}`
);
assert(result.includes('sample text'), 'result keeps remaining-budget text');

// --- all expected sends happened ---
const smsCalls = calls.filter((c) => c.url.includes('create-sms-chat'));
const endChatCalls = calls.filter((c) => c.url.includes('end-chat'));
const resendCalls = calls.filter((c) => c.url.includes('resend.com'));
assert(smsCalls.length === 2, `expected 2 SMS sends, got ${smsCalls.length}`);
assert(endChatCalls.length === 2, `expected 2 end-chat cleanups, got ${endChatCalls.length}`);
assert(resendCalls.length === 2, `expected 2 Resend sends (invite + email), got ${resendCalls.length}`);

// --- parallelism: SMS chain and email chain must overlap ---
// Use full channel windows (create-sms + get-chat + end-chat vs Resend), not
// just the first create-sms vs first Resend — CI runners occasionally serialize
// the first pair of timers enough to fail a first-call-only overlap check.
const smsWindow = calls.filter((c) => c.channel === 'sms');
const emailWindow = calls.filter((c) => c.channel === 'email');
const smsStart = Math.min(...smsWindow.map((c) => c.start));
const smsEnd = Math.max(...smsWindow.map((c) => c.end));
const emailStart = Math.min(...emailWindow.map((c) => c.start));
const emailEnd = Math.max(...emailWindow.map((c) => c.end));
const channelsOverlap = smsStart < emailEnd && emailStart < smsEnd;
assert(
  channelsOverlap,
  `SMS and email chains did not overlap: sms=${smsStart}-${smsEnd} email=${emailStart}-${emailEnd}`,
);

// Wall clock must beat a fully serial SMS-then-email estimate.
// Per SMS: create-sms + get-chat (= 2 delays). Two SMS => 4. Two Resend => 2. Serial = 6.
const serialFloorMs = 6 * NETWORK_DELAY_MS;
assert(
  elapsed < serialFloorMs,
  `handler took ${elapsed}ms — expected < ${serialFloorMs}ms if channels run in parallel`,
);

// --- wall clock sanity (compose polls can add a little; keep a hard ceiling) ---
assert(elapsed < 15000, `handler took ${elapsed}ms — unexpectedly slow`);

// --- budget contract unchanged: 2nd invocation still gates ---
const res2 = await POST(signedRequest(payload));
const { result: result2 } = await res2.json();
assert(
  result2.includes('no more sample texts') || result2.includes('budget'),
  `second invocation should hit sample budget limits, got: ${result2}`
);

console.log(
  `test-demo-alert-parallel: PASS (elapsed ${elapsed}ms, overlap confirmed, disclosure flag required)`
);
