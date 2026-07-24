// Mid-call "full owner experience" demo for the OwnerAI Tools demo line.
//
// The demo voice agent calls this endpoint (Retell custom function
// `send_demo_alert`) right after a role-play. Up to four legs run, each
// independent and best-effort, while the prospect is still on the call:
//   1. [DEMO] lead-alert SMS to the prospect's phone
//   2. [DEMO] appointment-booked SMS (when the role-play booked a slot)
//   3. Real calendar invite (ICS attachment via Resend) for the pretend
//      customer's appointment, sent to the prospect's email. Deliberately NOT
//      a Cal.com booking: demo bookings were verified to block real
//      setup-call availability on the owner's calendar.
//   4. [DEMO] sample owner lead email via Resend to the prospect's email
// Legs 3-4 only run when the caller volunteered an email.
//
// Required env vars:
//   RETELL_WEBHOOK_KEY / RETELL_API_KEY — verify the X-Retell-Signature header
//   RETELL_SMS_FROM                     — sending number (+15169731973)
//   RETELL_DEMO_ALERT_AGENT_ID          — chat agent with {{demo_alert_body}} template
// Optional (legs skipped when unset):
//   RESEND_API_KEY (+ OWNERAI_RESEND_FROM)   — invite + sample owner email
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — audit trail logging

import crypto from 'node:crypto';
import { createAllowanceTracker, remainingText, DEMO_LIMITS } from './lib/demo-limits.mjs';

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

// Per-call budget: 2 sample texts + 2 sample emails, max 4 invocations.
const allowance = createAllowanceTracker();

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
  const chat = await res.json();
  // Thread hygiene: end the one-shot template chat immediately so a later
  // reply from the prospect starts a fresh thread with the SMS receptionist
  // instead of hitting this stale template bot.
  if (chat?.chat_id) {
    try {
      await fetch(`https://api.retellai.com/end-chat/${chat.chat_id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
      });
    } catch (err) {
      console.warn('end-chat failed (non-fatal):', err.message);
    }
  }
  return chat;
}

// ICS timestamp: 20260722T130000Z
function icsUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function buildInviteIcs({ startIso, args, toEmail, fromEmail, uid }) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const summary = `[DEMO] ${args.customer_name || 'Customer'} — ${args.issue || 'appointment'}`;
  const description =
    `Sample appointment from your OwnerAI Tools demo call. ` +
    `In the real product, appointments your AI receptionist books land on your calendar automatically like this. ` +
    `Customer: ${args.customer_name || '—'} · ${args.customer_phone || '—'}. Not a real appointment.`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OwnerAI Tools//Demo//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(args.address ? [`LOCATION:${icsEscape(args.address)}`] : []),
    `ORGANIZER;CN=${icsEscape((args.business_name || 'OwnerAI Tools Demo') + ' (via OwnerAI)')}:mailto:${fromEmail}`,
    `ATTENDEE;CN=Business Owner;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${toEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// Sends the demo appointment as a real ICS calendar invite via Resend. This
// intentionally does not create a Cal.com booking — demo bookings block real
// setup-call slots on the owner's calendar (verified in testing).
async function sendDemoInvite(toEmail, args, startIso) {
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI Tools <info@owneraitools.com>';
  const fromEmail = (/<([^>]+)>/.exec(from) || [null, from])[1];
  const uid = `demo-${crypto.randomUUID()}@owneraitools.com`;
  const ics = buildInviteIcs({ startIso, args, toEmail, fromEmail, uid });
  const when = speakableTime(startIso);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: `[DEMO] Appointment booked: ${args.customer_name || 'customer'} — ${when}`,
      html: `
        <p style="font-family:sans-serif;font-size:14px;">
          Your AI receptionist just booked this appointment during the demo role-play —
          open the attached invite to add it to your calendar, exactly like the real product does automatically.
        </p>
        <p style="font-family:sans-serif;font-size:14px;">
          <strong>${escapeHtml(args.customer_name) || 'Customer'}</strong> — ${escapeHtml(args.issue) || 'appointment'}<br/>
          ${escapeHtml(when)}${args.address ? `<br/>${escapeHtml(args.address)}` : ''}
        </p>
        <p style="font-family:sans-serif;font-size:12px;color:#6b7280;">
          Sample from the OwnerAI Tools demo, sent at your request. Not a real appointment.
        </p>
      `,
      attachments: [
        {
          filename: 'invite.ics',
          content: Buffer.from(ics).toString('base64'),
          contentType: 'text/calendar; method=REQUEST',
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Resend invite ${res.status}: ${await res.text()}`);
  return res.json();
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

// PostgREST batch inserts require every object to share the same keys
// (PGRST102 otherwise). Fill missing keys with null.
function normalizeAuditRows(rows) {
  const keys = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row)) keys.add(k);
  }
  return rows.map((row) => {
    const out = {};
    for (const k of keys) out[k] = row[k] !== undefined ? row[k] : null;
    return out;
  });
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
      body: JSON.stringify(normalizeAuditRows(rows)),
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
  const providedTo = normalizePhone(args.prospect_mobile);
  const from = normalizePhone(call.from_number);
  // Fall back to the number on the call: the LLM has no access to caller ID,
  // so "text the number I'm calling from" arrives with no usable
  // prospect_mobile. The server knows the real number — use it.
  const to = providedTo || from;
  const wantsText = args.send_text !== false;
  const email = validEmail(args.prospect_email);
  const apptStart =
    args.appointment_start && !Number.isNaN(new Date(args.appointment_start).getTime())
      ? args.appointment_start
      : null;

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

  // Guard rejections get an audit row so failed attempts show on the
  // dashboard instead of vanishing (last night's failures were invisible).
  async function blocked(reason, speakable) {
    await logAuditBatch([
      { ...base, event_type: 'demo_alert_blocked', status: 'skipped', detail: reason, payload: rolePlay },
    ]);
    return toolResult(speakable);
  }

  // Anti-abuse: an explicitly provided number must match the caller's number.
  if (providedTo && from && providedTo !== from) {
    return blocked(
      `provided number ${providedTo} does not match caller ${from}`,
      'The sample text can only go to the phone number this person is calling from. Retry without a phone number to use the calling number automatically.'
    );
  }
  if (!allowance.allowInvocation(call.call_id)) {
    return blocked(
      'invocation limit reached',
      `The demo send limit for this call has been reached (${DEMO_LIMITS.smsPerCall} sample texts and ${DEMO_LIMITS.emailPerCall} sample emails). Tell the caller plainly that is the cap for one demo call and continue toward booking the setup call.`
    );
  }

  // Decide which channels this invocation can use.
  const skips = [];
  let doSms = wantsText;
  if (doSms && !to) {
    doSms = false;
    skips.push('no valid mobile number for this call');
  }
  if (doSms && (!process.env.RETELL_SMS_FROM || !process.env.RETELL_DEMO_ALERT_AGENT_ID)) {
    console.error('demo-alert: SMS env vars missing');
    doSms = false;
    skips.push('texting is unavailable right now');
  }
  if (doSms && !allowance.canSms(call.call_id)) {
    doSms = false;
    skips.push(`the ${DEMO_LIMITS.smsPerCall}-text limit for this call was reached`);
  }
  if (doSms && !allowSend(to)) {
    doSms = false;
    skips.push('that number already received the maximum sample texts this hour');
  }
  let doEmail = !!(email && process.env.RESEND_API_KEY);
  if (email && doEmail && !allowance.canEmail(call.call_id)) {
    doEmail = false;
    skips.push(`the ${DEMO_LIMITS.emailPerCall}-email limit for this call was reached`);
  }

  if (!doSms && !doEmail) {
    return blocked(
      `nothing sendable: ${skips.join('; ') || 'no valid channel'}`,
      `Nothing could be sent: ${skips.join('; ') || 'no valid text number or email was available'}. Tell the caller honestly and continue the conversation.`
    );
  }

  const audit = [];
  const sent = [];

  // Leg 1 — [DEMO] lead-alert SMS
  if (doSms) {
    try {
      await sendDemoSms(to, buildDemoAlertBody(args), 'demo-lead-alert');
      allowance.recordSms(call.call_id);
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
  }

  // Leg 2 — [DEMO] appointment-booked SMS (only when the role-play booked something)
  if (doSms && args.appointment) {
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

  // Leg 3 — real calendar invite (ICS) for the pretend customer's appointment
  if (doEmail && apptStart) {
    try {
      await sendDemoInvite(email, args, apptStart);
      audit.push({
        ...base,
        event_type: 'demo_invite_sent',
        status: 'ok',
        detail: `${speakableTime(apptStart)} — invite to ${email}`,
        payload: { ...rolePlay, slot_start: apptStart },
      });
      sent.push('the calendar invite');
    } catch (err) {
      console.error('demo-alert invite failed:', err.message);
      audit.push({ ...base, event_type: 'demo_invite_failed', status: 'failed', detail: err.message.slice(0, 400) });
    }
  }

  // Leg 4 — [DEMO] sample owner lead email
  if (doEmail) {
    try {
      await sendDemoEmail(email, args);
      allowance.recordEmail(call.call_id);
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

  const left = remainingText(allowance.remaining(call.call_id));
  if (!sent.length) {
    return toolResult(
      `Nothing could be sent — the sends failed. Apologize briefly, tell the caller you can retry, and continue. ${left}`
    );
  }
  const skipped = skips.length ? ` Not sent: ${skips.join('; ')}.` : '';
  return toolResult(
    `Sent: ${sent.join(', ')}. Tell the caller to check their phone${doEmail ? ' and their email inbox' : ''} — that is everything they would have received as the owner from that one call.${skipped} ${left}`
  );
}
