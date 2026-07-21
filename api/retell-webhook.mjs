// Retell post-call webhook for the OwnerAI Tools demo line (+1 516-973-1973).
// Vercel serverless function (web-standard handler). Sends the owner an email
// summary of every analyzed call via Resend, plus two optional SMS legs
// through Retell's create-sms-chat API (the number lives in Retell under an
// approved A2P 10DLC campaign, so all outbound SMS goes through Retell):
//   1. Owner alert SMS — for calls longer than ALERT_SMS_MIN_SECONDS.
//   2. Customer confirmation SMS — only when the caller explicitly opted in
//      during the call (wants_sms_confirmation analysis flag).
//
// Required env vars (set in the Vercel project):
//   RETELL_API_KEY          — CSM workspace key; verifies webhook signature and sends SMS
//   RESEND_API_KEY          — Resend key for sending email
// Optional (SMS legs are skipped when unset):
//   RETELL_SMS_FROM         — E.164 sending number (+15169731973)
//   RETELL_ALERT_AGENT_ID   — chat agent for owner alerts ({{alert_body}} template)
//   RETELL_CONFIRM_AGENT_ID — chat agent for customer confirmations ({{confirm_body}} template)
//   OWNERAI_ALERT_PHONE     — owner cell for alert texts
//   ALERT_SMS_MIN_SECONDS   — skip owner SMS for calls at or under this (default 12)
//   OWNERAI_NOTIFY_EMAIL    — recipient (default: info@owneraitools.com)
//   OWNERAI_RESEND_FROM     — sender (default: OwnerAI Tools <info@owneraitools.com>)

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

function escapeHtml(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function callDurationSec(call) {
  const start = call?.start_timestamp;
  const end = call?.end_timestamp;
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

function extractData(call) {
  const custom = call?.call_analysis?.custom_analysis_data || {};
  return {
    name: (custom.caller_name || '').trim(),
    business: (custom.business_name || '').trim(),
    business_type: (custom.business_type || '').trim(),
    callback_phone: (custom.callback_phone || call?.from_number || '').trim(),
    call_reason: (custom.call_reason || '').trim(),
    interested_tier: (custom.interested_tier || '').trim(),
    did_role_play: custom.did_role_play === true || custom.did_role_play === 'true',
    wants_setup_call:
      custom.wants_setup_call === true || custom.wants_setup_call === 'true',
    wants_sms_confirmation:
      custom.wants_sms_confirmation === true || custom.wants_sms_confirmation === 'true',
    lead_quality: (custom.lead_quality || '').trim(),
    summary:
      (call?.call_analysis?.call_summary || '').trim() ||
      'No summary available — see transcript below.',
    sentiment: (call?.call_analysis?.user_sentiment || '').trim(),
  };
}

function buildEmailHtml(call, data) {
  const e = escapeHtml;
  const duration = callDurationSec(call);
  const name = data.name || '(name not captured)';
  const recordingUrl =
    typeof call.recording_url === 'string' && /^https:\/\//.test(call.recording_url)
      ? call.recording_url
      : null;
  const transcript = (call.transcript || '').slice(0, 8000);

  return `
    <h2>OwnerAI Tools — Demo Line Call</h2>
    ${duration > 0 && duration < 15 ? '<p style="color:#b45309;"><strong>⚠ Caller hung up early</strong> — details may be incomplete.</p>' : ''}
    <p><strong>${e(name)}</strong>${data.business ? ` · ${e(data.business)}` : ''}</p>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>From</strong></td><td>${e(call.from_number) || '—'}</td></tr>
      <tr><td><strong>Callback</strong></td><td>${e(data.callback_phone) || '—'}</td></tr>
      <tr><td><strong>Business type</strong></td><td>${e(data.business_type) || '—'}</td></tr>
      <tr><td><strong>Reason</strong></td><td>${e(data.call_reason) || '—'}</td></tr>
      <tr><td><strong>Tier interest</strong></td><td>${e(data.interested_tier) || '—'}</td></tr>
      <tr><td><strong>Did role-play demo</strong></td><td>${data.did_role_play ? 'Yes' : 'No'}</td></tr>
      <tr><td><strong>Wants setup call</strong></td><td>${data.wants_setup_call ? '✅ YES' : 'No'}</td></tr>
      <tr><td><strong>Lead quality</strong></td><td>${e(data.lead_quality) || '—'}</td></tr>
      <tr><td><strong>Sentiment</strong></td><td>${e(data.sentiment) || '—'}</td></tr>
      <tr><td><strong>Duration</strong></td><td>${duration ? duration + 's' : '—'}</td></tr>
      <tr><td><strong>Retell call ID</strong></td><td>${e(call.call_id) || '—'}</td></tr>
    </table>
    <p><strong>Summary</strong><br/>${e(data.summary).replace(/\n/g, '<br/>')}</p>
    ${recordingUrl ? `<p><a href="${e(recordingUrl)}">Recording (expiring link)</a></p>` : ''}
    <details>
      <summary style="cursor:pointer;font-weight:bold;">Transcript</summary>
      <pre style="white-space:pre-wrap;font-family:sans-serif;font-size:13px;">${e(transcript)}</pre>
    </details>
  `;
}

function normalizePhone(v) {
  const digits = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

// The +15169731973 number lives in Retell (approved A2P 10DLC campaign), so
// all outbound SMS goes through Retell's create-sms-chat API. Each SMS agent's
// begin_message is a "{{...}}" template filled via dynamic variables.
async function sendRetellSms(to, { agentId, dynamicVariables, source }) {
  const apiKey = process.env.RETELL_API_KEY;
  const from = process.env.RETELL_SMS_FROM;

  if (!apiKey || !from || !agentId) {
    console.warn(`Retell SMS env missing — skipping SMS (${source})`);
    return { skipped: true };
  }

  const normalized = normalizePhone(to);
  if (!normalized) return { skipped: true, reason: 'invalid_to' };

  const res = await fetch('https://api.retellai.com/create-sms-chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: from,
      to_number: normalized,
      override_agent_id: agentId,
      metadata: { source: source || 'ownerai-webhook' },
      ...(dynamicVariables ? { retell_llm_dynamic_variables: dynamicVariables } : {}),
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Retell SMS ${res.status}: ${t}`);
  }
  return res.json();
}

function buildAlertSms(data, duration) {
  const name = data.name || 'Unknown caller';
  const hungUpEarly = duration > 0 && duration < 15;
  const lines = [
    hungUpEarly
      ? `OwnerAI: missed demo call (hung up after ${duration}s)`
      : data.wants_setup_call
        ? 'OwnerAI: demo call — WANTS SETUP CALL'
        : 'OwnerAI: new demo call answered',
    `${name}${data.business ? ' — ' + data.business : ''}`,
    data.callback_phone ? `Number: ${data.callback_phone}` : '',
    data.call_reason ? `Re: ${data.call_reason.slice(0, 100)}` : '',
    'Details in email.',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1000);
}

function buildConfirmSms(data) {
  const first = (data.name || '').split(/\s+/)[0];
  return [
    `${first ? first + ', thanks' : 'Thanks'} for calling OwnerAI Tools!`,
    'Book your 15-minute setup call here: https://cal.com/owneraitools/30min',
    'Questions? info@owneraitools.com. Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
  ].join(' ');
}

async function sendResendEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.OWNERAI_NOTIFY_EMAIL || 'info@owneraitools.com';
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI Tools <info@owneraitools.com>';

  if (!apiKey) {
    console.warn('RESEND_API_KEY missing — skipping email');
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend ${res.status}: ${t}`);
  }
  return res.json();
}

function json(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
  });
}

// Audit trail: one batched insert into Supabase per webhook. Best-effort —
// a logging failure never affects call handling.
async function logAuditEvents(rows) {
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
    if (!res.ok) console.error('audit log insert failed:', res.status, await res.text());
  } catch (err) {
    console.error('audit log failed:', err.message);
  }
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-retell-signature');

  if (!verifyRetellSignature(rawBody, process.env.RETELL_API_KEY, signature)) {
    return json(401, { error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (payload.event !== 'call_analyzed') {
    return json(204, null);
  }

  const call = payload.call || {};
  const data = extractData(call);
  const duration = callDurationSec(call);
  const who = data.name || call.from_number || 'Unknown caller';
  const subject =
    duration > 0 && duration < 15
      ? `[OwnerAI] Missed demo call (hung up): ${who}`
      : `[OwnerAI] Demo line call: ${who}${data.wants_setup_call ? ' — WANTS SETUP CALL' : ''}`;

  // Common fields stamped onto every audit row for this call.
  const base = {
    call_id: call.call_id || null,
    caller_name: data.name || null,
    from_number: call.from_number || null,
    duration_sec: duration || null,
    wants_setup_call: data.wants_setup_call,
    wants_sms_confirmation: data.wants_sms_confirmation,
    lead_quality: data.lead_quality || null,
    sentiment: data.sentiment || null,
  };
  const audit = [
    {
      ...base,
      event_type: 'call_analyzed',
      status: 'ok',
      detail: data.call_reason || null,
      payload: {
        summary: data.summary,
        business: data.business,
        business_type: data.business_type,
        callback_phone: data.callback_phone,
        interested_tier: data.interested_tier,
        did_role_play: data.did_role_play,
        to_number: call.to_number || null,
        recording_url: typeof call.recording_url === 'string' ? call.recording_url : null,
      },
    },
  ];

  let emailError = null;
  try {
    await sendResendEmail(subject, buildEmailHtml(call, data));
    audit.push({ ...base, event_type: 'email_sent', status: 'ok', detail: subject });
  } catch (err) {
    emailError = err.message;
    console.error('retell-webhook email failed:', err.message);
    audit.push({ ...base, event_type: 'email_failed', status: 'failed', detail: err.message.slice(0, 500) });
  }

  // SMS legs are best-effort: an SMS failure never fails the webhook, so
  // Retell doesn't retry (which would duplicate the email).
  let smsError = null;
  const alertPhone = process.env.OWNERAI_ALERT_PHONE;
  const smsMinSec = Number(process.env.ALERT_SMS_MIN_SECONDS || 12);
  try {
    if (!alertPhone) {
      console.warn('OWNERAI_ALERT_PHONE not configured — skipping owner SMS alert');
    } else if (duration > 0 && duration <= smsMinSec) {
      console.log(`owner SMS skipped — call lasted ${duration}s (min ${smsMinSec}s)`);
      audit.push({
        ...base,
        event_type: 'owner_sms_skipped',
        status: 'skipped',
        detail: `call lasted ${duration}s (min ${smsMinSec}s)`,
      });
    } else {
      const r = await sendRetellSms(alertPhone, {
        agentId: process.env.RETELL_ALERT_AGENT_ID,
        dynamicVariables: { alert_body: buildAlertSms(data, duration) },
        source: 'owner-call-alert',
      });
      if (!r.skipped) audit.push({ ...base, event_type: 'owner_sms_sent', status: 'ok', detail: null });
    }
  } catch (err) {
    smsError = err.message;
    console.error('retell-webhook owner SMS failed:', err.message);
    audit.push({ ...base, event_type: 'sms_failed', status: 'failed', detail: `owner alert: ${err.message.slice(0, 400)}` });
  }

  // Customer confirmation: only when the caller explicitly said yes to a
  // text during the call (A2P consent) and left a usable number.
  if (data.wants_sms_confirmation && data.callback_phone) {
    try {
      const r = await sendRetellSms(data.callback_phone, {
        agentId: process.env.RETELL_CONFIRM_AGENT_ID,
        dynamicVariables: { confirm_body: buildConfirmSms(data) },
        source: 'customer-booking-confirmation',
      });
      if (!r.skipped) audit.push({ ...base, event_type: 'customer_sms_sent', status: 'ok', detail: null });
    } catch (err) {
      smsError = err.message;
      console.error('retell-webhook customer SMS failed:', err.message);
      audit.push({ ...base, event_type: 'sms_failed', status: 'failed', detail: `customer confirmation: ${err.message.slice(0, 400)}` });
    }
  }

  await logAuditEvents(audit);

  if (emailError && smsError) {
    return json(500, { error: 'Internal error' });
  }
  return json(200, { ok: true, ...(emailError && { emailError: true }), ...(smsError && { smsError: true }) });
}
