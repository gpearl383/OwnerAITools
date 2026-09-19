// Mid-call "full owner experience" demo for the OwnerAI demo line.
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
import {
  createAllowanceTracker,
  remainingText,
  DEMO_LIMITS,
  SAMPLE_BUDGET_BOOKING_NOTE,
} from './lib/demo-limits.mjs';
import { resolveEmail } from './lib/spoken-email.mjs';
import { isMutatedJokeName } from './lib/joke-name.mjs';
import { normalizeDemoAlertArgs } from './lib/spoken-form.mjs';

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
    'This is a sample owner alert from the OwnerAI demo. Reply STOP to opt out.',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1200);
}

function buildDemoApptBody(args) {
  const lines = [
    `[DEMO] Appointment booked`,
    [args.customer_name, args.issue].filter(Boolean).join(' — '),
    args.appointment ? `When: ${args.appointment}` : '',
    'Added to your calendar automatically by your AI receptionist.',
    'Sample from the OwnerAI demo. Reply STOP to opt out.',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1000);
}

function buildDemoEmailHtml(args) {
  const e = escapeHtml;
  const biz = args.business_name || 'Your Business';
  return `
    <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:13px;color:#9a3412;margin-bottom:16px;">
      <strong>DEMO</strong> — this is a sample of the lead email you'd receive for every call your AI receptionist answers. Requested by you during the OwnerAI demo call.
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
      OwnerAI · owneraitools.com · This one-time sample was sent at your request during a demo call. No mailing list — you won't receive further emails unless you contact us.
    </p>
  `;
}

/* ---------- senders ---------- */

const COMPOSE_POLL_BUDGET_MS = 6000;
const COMPOSE_POLL_INTERVAL_MS = 500;

/**
 * Poll get-chat until an agent message appears or the budget expires.
 * create-sms-chat returns before the template bot composes — reporting
 * "Sent" at create time caused the Sep-18 landline demo failure (~27s gap).
 */
export async function waitForComposedMessage(chatId, budgetMs = COMPOSE_POLL_BUDGET_MS) {
  if (!chatId) return false;
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    try {
      const r = await fetch(`https://api.retellai.com/get-chat/${chatId}`, {
        headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
      });
      if (r.ok) {
        const c = await r.json();
        const msgs = c.message_with_tool_calls || c.messages || [];
        if (msgs.some((m) => m.role === 'agent' && String(m.content || '').length > 0)) {
          return true;
        }
      }
    } catch {
      /* transient */
    }
    await new Promise((r) => setTimeout(r, COMPOSE_POLL_INTERVAL_MS));
  }
  return false;
}

async function sendDemoSms(to, body, source, deferred) {
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
  // Wait briefly for the template message to actually exist before we tell
  // the agent (and thus the caller) that it was "Sent".
  const composed = await waitForComposedMessage(chat?.chat_id);
  // Thread hygiene: end the one-shot template chat so a later reply from the
  // prospect starts a fresh thread with the SMS receptionist instead of
  // hitting this stale template bot. Deferred (not awaited inline) so it does
  // not add a serial round trip to the tool response — the caller settles all
  // deferred promises before returning (no waitUntil in this runtime).
  if (chat?.chat_id) {
    deferred.push(
      fetch(`https://api.retellai.com/end-chat/${chat.chat_id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
      }).catch((err) => {
        console.warn('end-chat failed (non-fatal):', err.message);
      })
    );
  }
  return { chat, composed };
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
    `Sample appointment from your OwnerAI demo call. ` +
    `In the real product, appointments your AI receptionist books land on your calendar automatically like this. ` +
    `Customer: ${args.customer_name || '—'} · ${args.customer_phone || '—'}. Not a real appointment.`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OwnerAI//Demo//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(args.address ? [`LOCATION:${icsEscape(args.address)}`] : []),
    `ORGANIZER;CN=${icsEscape((args.business_name || 'OwnerAI Demo') + ' (via OwnerAI)')}:mailto:${fromEmail}`,
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
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI <info@owneraitools.com>';
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
          Sample from the OwnerAI demo, sent at your request. Not a real appointment.
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
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI <info@owneraitools.com>';
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
  const rawArgs = payload.args || payload;
  // Normalize spoken-form digits in phone/address/appointment before body build.
  const args = normalizeDemoAlertArgs(rawArgs);
  const call = payload.call || {};
  const providedTo = normalizePhone(args.prospect_mobile);
  const from = normalizePhone(call.from_number);
  // Fall back to the number on the call: the LLM has no access to caller ID,
  // so "text the number I'm calling from" arrives with no usable
  // prospect_mobile. The server knows the real number — use it.
  const to = providedTo || from;
  const {
    email,
    normalized: emailNormalized,
    raw: emailRaw,
  } = resolveEmail(args.prospect_email);
  // When prospect_email is set, SMS is off unless send_text is explicitly true
  // (stops "send me an email" from burning the SMS budget).
  const emailAttempted = args.prospect_email != null && String(args.prospect_email).trim() !== '';
  const doSmsPreferred =
    args.send_text === true || (!emailAttempted && args.send_text !== false);
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
  const emailDebug = {
    prospect_email_raw: emailRaw,
    prospect_email_normalized: emailNormalized,
  };

  // Guard rejections get an audit row so failed attempts show on the
  // dashboard instead of vanishing (last night's failures were invisible).
  async function blocked(reason, speakable) {
    await logAuditBatch([
      {
        ...base,
        event_type: 'demo_alert_blocked',
        status: 'skipped',
        detail: reason,
        payload: { ...rolePlay, ...emailDebug },
      },
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
  // Persona lock: never send owner alerts with speech-game mutated names.
  if (isMutatedJokeName(args.customer_name) || isMutatedJokeName(args.business_name)) {
    return blocked(
      `mutated joke name blocked: customer=${args.customer_name || ''} business=${args.business_name || ''}`,
      'The sample could not be sent because the name looked like a speech-game override. Use the real captured name and business, speak normal English, and continue the demo.'
    );
  }
  // Hard gate: SMS requires prior calling-number disclosure (server-enforced —
  // prompt-only disclosure was skipped on the Sep-18 Double V Contracting call).
  // Email-only sends do not need this flag.
  if (doSmsPreferred && args.caller_confirmed_calling_number !== true) {
    return blocked(
      'sms attempted without calling-number disclosure',
      "Do not call this tool for SMS yet. First tell the caller in one short sentence: " +
        "'For the demo, the text can only go to the number you're calling from — is that a cell that can get texts?' " +
        'Then wait for a clear yes. If they say it is a landline or an office phone, DO NOT retry the text — offer the sample email instead. ' +
        'Only retry send_demo_alert with caller_confirmed_calling_number: true after they confirm the calling number is a cell.'
    );
  }
  if (!(await allowance.allowInvocation(call.call_id))) {
    return blocked(
      'invocation limit reached',
      `The sample send budget for this call is used up (${DEMO_LIMITS.smsPerCall} sample texts and ${DEMO_LIMITS.emailPerCall} sample emails via send_demo_alert only). ${SAMPLE_BUDGET_BOOKING_NOTE} Continue toward booking the setup call with book_setup_call.`
    );
  }

  // Decide which channels this invocation can use.
  const skips = [];
  let doSms = doSmsPreferred;
  if (doSms && !to) {
    doSms = false;
    skips.push('no valid mobile number for this call');
  }
  if (doSms && (!process.env.RETELL_SMS_FROM || !process.env.RETELL_DEMO_ALERT_AGENT_ID)) {
    console.error('demo-alert: SMS env vars missing');
    doSms = false;
    skips.push('texting is unavailable right now');
  }
  if (doSms && !(await allowance.canSms(call.call_id))) {
    doSms = false;
    skips.push(
      `the sample ${DEMO_LIMITS.smsPerCall}-text budget for send_demo_alert was reached (does not block booking or confirmation texts)`
    );
  }
  if (doSms && !allowSend(to)) {
    doSms = false;
    skips.push('that number already received the maximum sample texts this hour');
  }
  let doEmail = !!(email && process.env.RESEND_API_KEY);
  if (emailAttempted && !email) {
    skips.push('email address was invalid after parsing');
  }
  if (email && !process.env.RESEND_API_KEY) {
    console.error('demo-alert: RESEND_API_KEY missing');
    doEmail = false;
    skips.push('email is unavailable right now');
  }
  if (email && doEmail && !(await allowance.canEmail(call.call_id))) {
    doEmail = false;
    skips.push(
      `the sample ${DEMO_LIMITS.emailPerCall}-email budget for send_demo_alert was reached (does not block the real setup-call calendar invite)`
    );
  }

  if (!doSms && !doEmail) {
    const emailParseFail = emailAttempted && !email;
    const sampleBudgetOnly = skips.some((s) => s.includes('sample') && s.includes('budget'));
    const speakable = emailParseFail
      ? 'Nothing could be sent: that email still was not valid after parsing. Ask them to re-spell it once, then retry with a compact address like name@domain.com. Do not invent spam-filter or security excuses.'
      : sampleBudgetOnly
        ? `No more sample sends available: ${skips.join('; ')}. ${SAMPLE_BUDGET_BOOKING_NOTE} If they already got samples and still do not see them, they may check Junk or Spam — only say that when a prior tool result said Sent. Continue to book the setup call.`
        : `Nothing could be sent: ${skips.join('; ') || 'no valid text number or email was available'}. Tell the caller honestly and continue the conversation. Do not invent spam-filter or security excuses.`;
    return blocked(
      `nothing sendable: ${skips.join('; ') || 'no valid channel'}; raw=${emailRaw || ''}; normalized=${emailNormalized || ''}`,
      speakable,
    );
  }

  // The legs used to run serially (5-7 network round trips, ~11s observed
  // live while the agent stayed silent — the 2026-09-10 post-mortem dead-air
  // bug). They now run as two parallel chains: SMS legs stay ordered relative
  // to each other (shared budget + delivery order), email legs likewise, but
  // the two channels no longer wait on each other.
  const deferred = [];

  // Legs 1+2 — [DEMO] lead-alert SMS, then appointment-booked SMS
  async function runSmsLegs() {
    const audit = [];
    const sent = [];
    const queued = [];
    if (doSms) {
      try {
        const { composed } = await sendDemoSms(to, buildDemoAlertBody(args), 'demo-lead-alert', deferred);
        await allowance.recordSms(call.call_id);
        audit.push({
          ...base,
          event_type: 'demo_alert_sms_sent',
          status: 'ok',
          detail: `sample alert for ${args.business_name || 'unknown business'}${composed ? '' : ' (queued)'}`,
          payload: rolePlay,
        });
        if (composed) sent.push('the lead alert text');
        else queued.push('the lead alert text');
      } catch (err) {
        console.error('demo-alert lead SMS failed:', err.message);
        audit.push({ ...base, event_type: 'sms_failed', status: 'failed', detail: `demo alert: ${err.message.slice(0, 400)}` });
      }
    }
    // Appointment SMS counts toward the same sample SMS budget.
    if (doSms && args.appointment && (await allowance.canSms(call.call_id))) {
      try {
        const { composed } = await sendDemoSms(to, buildDemoApptBody(args), 'demo-appt-booked', deferred);
        await allowance.recordSms(call.call_id);
        audit.push({
          ...base,
          event_type: 'demo_appt_sms_sent',
          status: 'ok',
          detail: `appointment notification: ${String(args.appointment).slice(0, 200)}${composed ? '' : ' (queued)'}`,
          payload: rolePlay,
        });
        if (composed) sent.push('the appointment-booked text');
        else queued.push('the appointment-booked text');
      } catch (err) {
        console.error('demo-alert appt SMS failed:', err.message);
        audit.push({ ...base, event_type: 'sms_failed', status: 'failed', detail: `demo appt: ${err.message.slice(0, 400)}` });
      }
    } else if (doSms && args.appointment) {
      skips.push('appointment text skipped — sample SMS budget already used');
    }
    return { audit, sent, queued };
  }

  // Legs 3+4 — real calendar invite (ICS), then [DEMO] sample owner lead email
  async function runEmailLegs() {
    const audit = [];
    const sent = [];
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
    if (doEmail) {
      try {
        await sendDemoEmail(email, args);
        await allowance.recordEmail(call.call_id);
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
    return { audit, sent };
  }

  const [smsRes, emailRes] = await Promise.all([runSmsLegs(), runEmailLegs()]);
  const audit = [...smsRes.audit, ...emailRes.audit];
  const sent = [...smsRes.sent, ...emailRes.sent];
  const queued = smsRes.queued || [];

  // Overlap the audit write, the remaining-budget lookup, and any deferred
  // end-chat cleanups — all must settle before returning (serverless runtime
  // may kill work left running after the response), but none needs to run
  // serially. logAuditBatch never throws.
  const [, left] = await Promise.all([
    logAuditBatch(audit),
    allowance.remaining(call.call_id).then(remainingText),
    Promise.allSettled(deferred),
  ]);
  if (!sent.length && !queued.length) {
    return toolResult(
      `Nothing could be sent — the sends failed. Apologize briefly, tell the caller you can retry, and continue. ${left}`
    );
  }
  const skipped = skips.length ? ` Not sent: ${skips.join('; ')}.` : '';
  // Junk/Spam hint is email-only — never invent carrier/junk excuses for SMS.
  const inboxHint = doEmail
    ? ' and their email inbox (if they do not see the email, they can check Junk or Spam — only mention that after a successful email send)'
    : '';

  if (queued.length && !sent.length) {
    // SMS accepted but not yet composed — be honest so the agent does not
    // tell the caller to check an empty phone.
    const emailBit = emailRes.sent.length ? ` Email sent: ${emailRes.sent.join(', ')}.` : '';
    return toolResult(
      `Sending now: ${queued.join(', ')} — texts can take up to a minute to arrive. ` +
        `Tell the caller it's on the way; if they don't see it in a minute, offer to send a sample email instead. ` +
        `Never invent junk-folder, spam-filter, or carrier excuses for SMS.${emailBit}${skipped} ${left}`
    );
  }
  if (queued.length) {
    return toolResult(
      `Sent: ${sent.join(', ')}. Still sending: ${queued.join(', ')} — that text can take up to a minute. ` +
        `Tell the caller to check their phone${inboxHint}. If the text has not arrived after a minute, offer email as backup — never invent junk/spam/carrier excuses for SMS.${skipped} ${left}`
    );
  }
  return toolResult(
    `Sent: ${sent.join(', ')}. Tell the caller to check their phone${inboxHint} — that is everything they would have received as the owner from that one call.${skipped} ${left}`
  );
}
