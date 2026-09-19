// Compose-wait: "Sent" only after get-chat shows an agent message;
// otherwise result text says "Sending now" / "up to a minute".

import crypto from 'node:crypto';

process.env.RETELL_API_KEY = 'test-key-compose';
delete process.env.RETELL_WEBHOOK_KEY;
process.env.RETELL_SMS_FROM = '+15169731973';
process.env.RETELL_DEMO_ALERT_AGENT_ID = 'agent_test_template';
delete process.env.RESEND_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { POST, waitForComposedMessage } = await import('../api/demo-alert.mjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

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
  call: { call_id: 'call_compose_1', from_number: '+15165551234' },
  args: {
    business_name: 'Test Co',
    send_text: true,
    caller_confirmed_calling_number: true,
    customer_name: 'Pat',
  },
};

// --- waitForComposedMessage unit ---
{
  let polls = 0;
  globalThis.fetch = async function (url) {
    if (String(url).includes('get-chat')) {
      polls += 1;
      const msgs =
        polls >= 3
          ? [{ role: 'agent', content: '[DEMO] lead alert' }]
          : [];
      return new Response(JSON.stringify({ message_with_tool_calls: msgs }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const ok = await waitForComposedMessage('chat_wait', 5000);
  assert(ok === true, 'should compose after polls');
  assert(polls >= 3, `expected >=3 polls, got ${polls}`);
}

// --- POST: composed path reports Sent ---
{
  let getChatPolls = 0;
  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes('create-sms-chat')) {
      return new Response(JSON.stringify({ chat_id: 'chat_composed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('get-chat')) {
      getChatPolls += 1;
      return new Response(
        JSON.stringify({
          message_with_tool_calls: [{ role: 'agent', content: '[DEMO] body' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.includes('end-chat')) {
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const res = await POST(
    signedRequest({
      ...payload,
      call: { call_id: 'call_compose_sent', from_number: '+15165551234' },
    })
  );
  const { result } = await res.json();
  assert(/^Sent:/.test(result), `expected Sent:, got: ${result}`);
  assert(getChatPolls >= 1, 'should have polled get-chat');
}

// --- POST: never-composes path reports Sending now ---
{
  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes('create-sms-chat')) {
      return new Response(JSON.stringify({ chat_id: 'chat_queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('get-chat')) {
      return new Response(JSON.stringify({ message_with_tool_calls: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('end-chat')) {
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  // Use a short budget by temporarily wrapping — waitForComposedMessage uses 6s.
  // For this test we accept the wait; reduce by monkey-patching Date if needed.
  // Speeding up: replace wait via short poll by stubbing setTimeout? Keep real 6s is slow.
  // Instead: patch waitForComposedMessage by making get-chat empty and reducing
  // budget isn't exported as mutable. Use real wait but with interval — 6s is long for CI.
}

// Speed up queued test: export uses 6s budget. Stub Date.now to advance.
{
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    fake += ms || 0;
    return realTimeout(fn, 0);
  };

  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes('create-sms-chat')) {
      return new Response(JSON.stringify({ chat_id: 'chat_queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('get-chat')) {
      return new Response(JSON.stringify({ message_with_tool_calls: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('end-chat')) {
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  const res = await POST(
    signedRequest({
      ...payload,
      call: { call_id: 'call_compose_queued', from_number: '+15165551234' },
      args: {
        ...payload.args,
        business_name: 'Queued Co',
      },
    })
  );
  const { result } = await res.json();
  Date.now = realNow;
  globalThis.setTimeout = realTimeout;

  assert(
    /Sending now|up to a minute|Still sending/i.test(result),
    `expected queued wording, got: ${result}`
  );
  assert(!/^Sent:/.test(result), 'must not claim Sent when not composed');
}

console.log('test-demo-alert-compose-wait: PASS');
