// Disclosure gate: SMS without caller_confirmed_calling_number must be rejected
// with coaching text and must not call create-sms-chat.

import crypto from 'node:crypto';

process.env.RETELL_API_KEY = 'test-key-disclosure';
delete process.env.RETELL_WEBHOOK_KEY;
process.env.RETELL_SMS_FROM = '+15169731973';
process.env.RETELL_DEMO_ALERT_AGENT_ID = 'agent_test_template';
process.env.RESEND_API_KEY = 'test-resend-key';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { POST } = await import('../api/demo-alert.mjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const fetchCalls = [];
globalThis.fetch = async function stubFetch(url) {
  fetchCalls.push(String(url));
  return new Response(JSON.stringify({ chat_id: 'chat_x' }), {
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

const base = {
  name: 'send_demo_alert',
  call: { call_id: 'call_disclosure_1', from_number: '+15165551234' },
};

// 1) SMS without confirmation flag → blocked, no create-sms-chat
{
  fetchCalls.length = 0;
  const res = await POST(
    signedRequest({
      ...base,
      args: {
        business_name: 'Double V Contracting',
        send_text: true,
        customer_name: 'Robert',
      },
    })
  );
  const { result } = await res.json();
  assert(res.status === 200, 'status 200');
  assert(
    /caller_confirmed_calling_number|calling from|cell that can get texts/i.test(result),
    `expected coaching rejection, got: ${result}`
  );
  assert(
    !fetchCalls.some((u) => u.includes('create-sms-chat')),
    'must not create SMS chat when disclosure missing'
  );
}

// 2) Email-only without confirmation flag → allowed (no SMS disclosure needed)
{
  fetchCalls.length = 0;
  globalThis.fetch = async function stubFetch(url) {
    fetchCalls.push(String(url));
    if (String(url).includes('resend.com')) {
      return new Response(JSON.stringify({ id: 'email_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const res = await POST(
    signedRequest({
      ...base,
      call: { call_id: 'call_disclosure_2', from_number: '+15165551234' },
      args: {
        business_name: 'Double V Contracting',
        send_text: false,
        prospect_email: 'bob@example.com',
        customer_name: 'Robert',
      },
    })
  );
  const { result } = await res.json();
  assert(/Sent:.*owner email/i.test(result), `expected email sent, got: ${result}`);
  assert(
    !fetchCalls.some((u) => u.includes('create-sms-chat')),
    'email-only must not create SMS'
  );
}

console.log('test-demo-alert-disclosure: PASS');
