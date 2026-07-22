// Mid-call "full owner experience" demo for the OwnerAI Tools demo line.
//
// The demo voice agent calls this endpoint (Retell custom function
// `send_demo_alert`) right after a role-play. Up to four legs run, each
// independent and best-effort, while the prospect is still on the call:
//   1. [DEMO] lead-alert SMS to the prospect's phone
//   2. [DEMO] appointment-booked SMS (when the role-play booked a slot)
//   3. Real Cal.com calendar invite for the pretend customer's appointment,
//      sent to the prospect's email (attendee email = prospect)
//   4. [DEMO] sample owner lead email via Resend to the prospect's email
// Legs 3-4 only run when the caller volunteered an email.
//
// Required env vars:
//   RETELL_WEBHOOK_KEY / RETELL_API_KEY — verify the X-Retell-Signature header
//   RETELL_SMS_FROM                     — sending number (+15169731973)
//   RETELL_DEMO_ALERT_AGENT_ID          — chat agent with {{demo_alert_body}} template
// Optional (legs skipped when unset):
//   CAL_API_KEY + CAL_DEMO_EVENT_TYPE_ID     — demo calendar invite
//   RESEND_API_KEY (+ OWNERAI_RESEND_FROM)   — sample owner email
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — audit trail logging

import crypto from 'node:crypto';

const TZ = 'America/New_York';

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

function validEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function speakableTime(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
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

/* ---------- message bodies ---------- */

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

function buildDemoApptBody(args) {
  const lines = [
    `[DEMO] Appointment booked`,
    [args.customer_name, args.issue].filter(Boolean).join(' — '),
    args.appointment ? `When: ${args.appointment}` : '',
    'Added to your calendar automatically by your AI receptionist.',
    'Sample from the OwnerAI Tools demo. Reply STOP to opt out.',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1000);
}

function buildDemoEmailHtml(args) {
  const e = escapeHtml;
  const biz = args.business_name || 'Your Business';
  return `
    <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:13px;color:#9a3412;margin-bottom:16px;">
      <strong>DEMO</strong> — this is a sample of the lead email you'd receive for every call your AI receptionist answers. Requested by you during the OwnerAI Tools demo call.
    </div>
    <h2 style="font-family:sans-serif;">${e(biz)} — New Lead Captured</h2>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>Caller</strong></td><td>${e(args.customer_name) || '—'}</td></tr>
      <tr><td><strong>Callback</strong></td><td>${e(args.customer_phone) || '—'}</td></tr>
      <tr><td><strong>Reason</strong></td><td>${e(args.issue) || '—'}${args.urgent ? ' — <strong style="color:#b91c1c;">URGENT</strong>' : ''}</td></tr>
      <tr><td><strong>Address</strong></td><td>${e(args.address) || '—'}</td></tr>
      <tr><td><strong>Appointment</strong></td><td>${e(args.appointment) || '—'}</td></tr>
    </table>
    <p style="font-family:sans-serif;font-size:14px;">
      In the real product this email arrives before the caller hangs up, with the full
      call summary, transcript, and recording attached — for every single call, 24/7.
    </p>
    <p style="font-family:sans-serif;font-size:14px;">
      Ready to never miss another lead?
      <a href="https://cal.com/owneraitools/30min">Book your 15-minute setup call</a>
      or email <a href="mailto:info@owneraitools.com">info@owneraitools.com</a>.
    </p>
    <p style="font-family:sans-serif;font-size:12px;color:#6b7280;">
      OwnerAI Tools · owneraitools.com · This one-time sample was sent at your request during a demo call. No mailing list — you won't receive further emails unless you contact us.
    </p>
  `;
}

/* ---------- senders ---------- */

async function sendDemoSms(to, body, source) {
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
      metadata: { source },
      retell_llm_dynamic_variables: { demo_alert_body: body },
    }),
  });
  if (!res.ok) throw new Error(`Retell SMS ${res.status}: ${await res.text()}`);
  return res.json();
}

async function bookDemoAppointment({ startIso, customerName, email, businessName }) {
  const res = await fetch('https://api.cal.com/v2/bookings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'cal-api-version': '2024-08-13',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      eventTypeId: Number(process.env.CAL_DEMO_EVENT_TYPE_ID),
      start: new Date(startIso).toISOString(),
      attendee: {
        name: customerName || 'Demo Customer',
        email,
        timeZone: TZ,
      },
      metadata: {
        source: 'ownerai-demo-roleplay',
        ...(businessName ? { business: String(businessName).slice(0, 100) } : {}),
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cal.com ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function sendDemoEmail(toEmail, args) {
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI Tools <info@owneraitools.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: `[DEMO] New lead: ${args.customer_name || 'caller'} — ${args.business_name || 'your business'}`,
      html: buildDemoEmailHtml(args),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

async function logAuditBatch(rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !rows.length) return;
  try {
    const res = await fetch(`${url}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
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
    return toolResult('The demo could not be sent. Continue the conversation without it.');
  }

  // Retell custom-function body: { name, call, args }. Tolerate args-only too.
  const args = payload.args || payload;
  const call = payload.call || {};
  const to = normalizePhone(args.prospect_mobile);
  const email = validEmail(args.prospect_email);
  const apptStart =
    args.appointment_start && !Number.isNaN(new Date(args.appointment_start).getTime())
      ? args.appointment_start
      : null;

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

  const base = {
    call_id: call.call_id || null,
    caller_name: (args.customer_name || '').slice(0, 200) || null,
    from_number: call.from_number || null,
  };
  const rolePlay = {
    business_name: args.business_name,
    issue: args.issue,
    appointment: args.appointment,
    urgent: args.urgent === true,
  };
  const audit = [];
  const sent = [];

  // Leg 1 — [DEMO] lead-alert SMS
  try {
    await sendDemoSms(to, buildDemoAlertBody(args), 'demo-lead-alert');
    audit.push({
      ...base,
      event_type: 'demo_alert_sms_sent',
      status: 'ok',
      detail: `sample alert for ${args.business_name || 'unknown business'}`,
      payload: rolePlay,
    });
    sent.push('the lead alert text');
  } catch (err) {
    console.error('demo-alert lead SMS failed:', err.message);
    audit.push({ ...base, event_type: 'sms_failed', status: 'failed', detail: `demo alert: ${err.message.slice(0, 400)}` });
  }

  // Leg 2 — [DEMO] appointment-booked SMS (only when the role-play booked something)
  if (args.appointment) {
    try {
      await sendDemoSms(to, buildDemoApptBody(args), 'demo-appt-booked');
      audit.push({
        ...base,
        event_type: 'demo_appt_sms_sent',
        status: 'ok',
        detail: `appointment notification: ${String(args.appointment).slice(0, 200)}`,
        payload: rolePlay,
      });
      sent.push('the appointment-booked text');
    } catch (err) {
      console.error('demo-alert appt SMS failed:', err.message);
      audit.push({ ...base, event_type: 'sms_failed', status: 'failed', detail: `demo appt: ${err.message.slice(0, 400)}` });
    }
  }

  // Leg 3 — real Cal.com invite for the pretend customer's appointment
  if (email && apptStart && process.env.CAL_API_KEY && process.env.CAL_DEMO_EVENT_TYPE_ID) {
    try {
      const booking = await bookDemoAppointment({
        startIso: apptStart,
        customerName: args.customer_name,
        email,
        businessName: args.business_name,
      });
      audit.push({
        ...base,
        event_type: 'demo_invite_booked',
        status: 'ok',
        detail: `${speakableTime(apptStart)} — invite to ${email}`,
        payload: { ...rolePlay, booking_uid: booking?.data?.uid || null, slot_start: apptStart },
      });
      sent.push('the calendar invite');
    } catch (err) {
      console.error('demo-alert invite failed:', err.message);
      audit.push({ ...base, event_type: 'demo_invite_failed', status: 'failed', detail: err.message.slice(0, 400) });
    }
  }

  // Leg 4 — [DEMO] sample owner lead email
  if (email && process.env.RESEND_API_KEY) {
    try {
      await sendDemoEmail(email, args);
      audit.push({
        ...base,
        event_type: 'demo_email_sent',
        status: 'ok',
        detail: `sample owner email to ${email}`,
        payload: rolePlay,
      });
      sent.push('the owner email');
    } catch (err) {
      console.error('demo-alert email failed:', err.message);
      audit.push({ ...base, event_type: 'demo_email_failed', status: 'failed', detail: err.message.slice(0, 400) });
    }
  }

  await logAuditBatch(audit);

  if (!sent.length) {
    return toolResult('Nothing could be sent. Apologize briefly and continue the conversation.');
  }
  return toolResult(
    `Sent: ${sent.join(', ')}. Tell the caller to check their phone${email ? ' and their email inbox' : ''} — that is everything they would have received as the owner from that one call.`,
  );
}
