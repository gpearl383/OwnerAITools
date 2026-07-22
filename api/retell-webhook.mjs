// Retell post-call webhook for the OwnerAI Tools demo line (+1 516-973-1973).
// Vercel serverless function (web-standard handler). Sends the owner an email
// summary of every analyzed call via Resend, plus two optional SMS legs
// through Retell's create-sms-chat API (the number lives in Retell under an
// approved A2P 10DLC campaign, so all outbound SMS goes through Retell):
//   1. Owner alert SMS — for calls longer than ALERT_SMS_MIN_SECONDS.
//   2. Customer confirmation SMS — only when the caller explicitly opted in
//      during the call (wants_sms_confirmation analysis flag).
//
// Also handles chat_analyzed events from the SMS receptionist agent (texting
// the demo line): owner summary email + owner alert SMS + audit trail.
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
//   RETELL_SMS_AGENT_ID     — SMS receptionist chat agent (chat_analyzed pipeline)
//   OWNERAI_NOTIFY_EMAIL    — recipient (default: info@owneraitools.com)
//   OWNERAI_RESEND_FROM     — sender (default: OwnerAI Tools <info@owneraitools.com>)
//   CALL_LINK_SECRET        — HMAC key for /api/call links (durable transcript/recording page);
//                             when unset, a key is derived from SUPABASE_SERVICE_ROLE_KEY
//   OWNERAI_SITE_URL        — base URL for links (default: https://owneraitools.com)

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
    setup_call_booked_time: (custom.setup_call_booked_time || '').trim(),
    summary:
      (call?.call_analysis?.call_summary || '').trim() ||
      'No summary available — see transcript below.',
    sentiment: (call?.call_analysis?.user_sentiment || '').trim(),
  };
}

/* ---------- call record persistence (durable transcript + recording) ---------- */

// Signing key for /api/call links. Prefers CALL_LINK_SECRET; otherwise
// derives a key from the Supabase service-role key (already in the env) so
// no extra configuration is needed. Note: rotating the Supabase key breaks
// previously emailed links unless CALL_LINK_SECRET is set.
function callLinkSecret() {
  if (process.env.CALL_LINK_SECRET) return process.env.CALL_LINK_SECRET;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!srk) return null;
  return crypto.createHash('sha256').update(`ownerai-call-link:${srk}`).digest('hex');
}

function callLinkToken(id) {
  const secret = callLinkSecret();
  if (!secret || !id) return null;
  return crypto.createHmac('sha256', secret).update(String(id)).digest('hex');
}

function callDetailUrl(id) {
  const token = callLinkToken(id);
  if (!token) return null;
  const base = (process.env.OWNERAI_SITE_URL || 'https://owneraitools.com').replace(/\/$/, '');
  return `${base}/api/call?id=${encodeURIComponent(id)}&t=${token}`;
}

// Copies the (expiring) Retell recording into Supabase Storage and stores the
// full transcript + summary in call_records, so the email links never die.
// Returns { url, hasRecording } on success, or null when persistence isn't
// configured or failed — the email then falls back to the legacy full body.
async function persistCallRecord({ id, kind, callerName, fromNumber, summary, transcript, recordingUrl }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !id || !callLinkToken(id)) return null;

  // Copy the recording while Retell's signed URL is still valid.
  let recordingPath = null;
  if (recordingUrl && /^https:\/\//.test(recordingUrl)) {
    try {
      const audio = await fetch(recordingUrl);
      if (audio.ok) {
        const bytes = Buffer.from(await audio.arrayBuffer());
        // Storage rejects Content-Type params (e.g. "; codecs=...") and needs
        // both apikey + Authorization — missing apikey surfaces as
        // "Invalid Compact JWS".
        const contentType = (audio.headers.get('content-type') || 'audio/wav')
          .split(';')[0]
          .trim() || 'audio/wav';
        const path = `${id}.wav`;
        const up = await fetch(
          `${url}/storage/v1/object/call-recordings/${encodeURIComponent(path)}?upsert=true`,
          {
            method: 'POST',
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              'Content-Type': contentType,
              'x-upsert': 'true',
            },
            body: bytes,
          }
        );
        if (up.ok) recordingPath = path;
        else console.error('recording upload failed:', up.status, await up.text());
      } else {
        console.error('recording download failed:', audio.status);
      }
    } catch (err) {
      console.error('recording copy failed:', err.message);
    }
  }

  try {
    const res = await fetch(`${url}/rest/v1/call_records`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id,
        kind,
        caller_name: callerName || null,
        from_number: fromNumber || null,
        summary: summary || null,
        transcript: transcript || null,
        recording_path: recordingPath,
      }),
    });
    if (!res.ok) {
      console.error('call_records insert failed:', res.status, await res.text());
      return null;
    }
  } catch (err) {
    console.error('call_records insert failed:', err.message);
    return null;
  }

  return { url: callDetailUrl(id), hasRecording: !!recordingPath };
}

/* ---------- email bodies ---------- */

// Owner email: structured lead details + summary, with transcript/recording
// behind durable links (never inlined — sensitive content stays off email).
// Falls back to buildLegacyEmailHtml when persistence failed.
function buildEmailHtml(call, data, record) {
  const e = escapeHtml;
  const duration = callDurationSec(call);
  const name = data.name || '(name not captured)';

  if (!record?.url) return buildLegacyEmailHtml(call, data);

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
      ${data.setup_call_booked_time ? `<tr><td><strong>Setup call booked</strong></td><td>📅 ${e(data.setup_call_booked_time)}</td></tr>` : ''}
      <tr><td><strong>Lead quality</strong></td><td>${e(data.lead_quality) || '—'}</td></tr>
      <tr><td><strong>Sentiment</strong></td><td>${e(data.sentiment) || '—'}</td></tr>
      <tr><td><strong>Duration</strong></td><td>${duration ? duration + 's' : '—'}</td></tr>
    </table>
    <p><strong>Summary</strong><br/>${e(data.summary).replace(/\n/g, '<br/>')}</p>
    <p>
      <a href="${e(record.url)}#transcript">View full transcript</a>
      ${record.hasRecording ? ` &nbsp;·&nbsp; <a href="${e(record.url)}#recording">Listen to recording</a>` : ''}
    </p>
  `;
}

// Fallback when the call record couldn't be persisted — same details, no
// inline transcript (privacy). Retell's recording link is expiring.
function buildLegacyEmailHtml(call, data) {
  const e = escapeHtml;
  const duration = callDurationSec(call);
  const name = data.name || '(name not captured)';
  const recordingUrl =
    typeof call.recording_url === 'string' && /^https:\/\//.test(call.recording_url)
      ? call.recording_url
      : null;

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
      ${data.setup_call_booked_time ? `<tr><td><strong>Setup call booked</strong></td><td>📅 ${e(data.setup_call_booked_time)}</td></tr>` : ''}
      <tr><td><strong>Lead quality</strong></td><td>${e(data.lead_quality) || '—'}</td></tr>
      <tr><td><strong>Sentiment</strong></td><td>${e(data.sentiment) || '—'}</td></tr>
      <tr><td><strong>Duration</strong></td><td>${duration ? duration + 's' : '—'}</td></tr>
    </table>
    <p><strong>Summary</strong><br/>${e(data.summary).replace(/\n/g, '<br/>')}</p>
    ${recordingUrl ? `<p><a href="${e(recordingUrl)}">Recording (expiring link)</a></p>` : ''}
    <p style="color:#6b7280;font-size:13px;">Transcript page unavailable for this call — not included in email for privacy.</p>
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
  const chat = await res.json();
  // Thread hygiene: the template message is out — end the chat so a later
  // reply from this number starts a fresh thread with the SMS receptionist
  // instead of hitting the stale one-shot template bot.
  await endRetellChat(chat?.chat_id);
  return chat;
}

// Best-effort: ends an outbound template chat after its single message is sent.
async function endRetellChat(chatId) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey || !chatId) return;
  try {
    await fetch(`https://api.retellai.com/end-chat/${chatId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.warn('end-chat failed (non-fatal):', err.message);
  }
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
    data.setup_call_booked_time
      ? `You're booked for your setup call: ${data.setup_call_booked_time}. Calendar invite is in your email. Need to change it? https://cal.com/owneraitools/30min`
      : 'Book your 15-minute setup call here: https://cal.com/owneraitools/30min',
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
      body: JSON.stringify(normalizeAuditRows(rows)),
    });
    if (!res.ok) console.error('audit log insert failed:', res.status, await res.text());
  } catch (err) {
    console.error('audit log failed:', err.message);
  }
}

/* ---------- SMS receptionist (chat_analyzed) ---------- */

function extractChatData(chat) {
  const custom = chat?.chat_analysis?.custom_analysis_data || {};
  // Inbound SMS chat: from_number is the prospect; outbound would be reversed.
  const ourNumber = process.env.RETELL_SMS_FROM;
  const prospectNumber =
    chat?.from_number && chat.from_number !== ourNumber ? chat.from_number : chat?.to_number || '';
  return {
    name: (custom.caller_name || '').trim(),
    business: (custom.business_name || '').trim(),
    business_type: (custom.business_type || '').trim(),
    callback_phone: (custom.callback_phone || prospectNumber || '').trim(),
    call_reason: (custom.call_reason || '').trim(),
    interested_tier: (custom.interested_tier || '').trim(),
    wants_setup_call:
      custom.wants_setup_call === true || custom.wants_setup_call === 'true',
    lead_quality: (custom.lead_quality || '').trim(),
    setup_call_booked_time: (custom.setup_call_booked_time || '').trim(),
    summary:
      (chat?.chat_analysis?.chat_summary || '').trim() ||
      'No summary available — see message log below.',
    sentiment: (chat?.chat_analysis?.user_sentiment || '').trim(),
    prospect_number: prospectNumber,
  };
}

function countProspectMessages(chat) {
  const msgs = chat?.message_with_tool_calls;
  if (Array.isArray(msgs)) return msgs.filter((m) => m?.role === 'user').length;
  // Fallback when the webhook payload omits the message list.
  return ((chat?.transcript || '').match(/^User:/gm) || []).length;
}

// Owner email for text conversations: detail table + summary, message log
// behind a durable link. Falls back when the chat record couldn't be persisted.
function buildChatEmailHtml(chat, data, record) {
  const e = escapeHtml;
  const name = data.name || '(name not captured)';

  if (!record?.url) return buildLegacyChatEmailHtml(chat, data);

  return `
    <h2>OwnerAI Tools — Demo Line Text Conversation</h2>
    <p><strong>${e(name)}</strong>${data.business ? ` · ${e(data.business)}` : ''}</p>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>From</strong></td><td>${e(data.prospect_number) || '—'}</td></tr>
      <tr><td><strong>Callback</strong></td><td>${e(data.callback_phone) || '—'}</td></tr>
      <tr><td><strong>Business type</strong></td><td>${e(data.business_type) || '—'}</td></tr>
      <tr><td><strong>Reason</strong></td><td>${e(data.call_reason) || '—'}</td></tr>
      <tr><td><strong>Tier interest</strong></td><td>${e(data.interested_tier) || '—'}</td></tr>
      <tr><td><strong>Wants setup call</strong></td><td>${data.wants_setup_call ? '✅ YES' : 'No'}</td></tr>
      ${data.setup_call_booked_time ? `<tr><td><strong>Setup call booked</strong></td><td>📅 ${e(data.setup_call_booked_time)}</td></tr>` : ''}
      <tr><td><strong>Lead quality</strong></td><td>${e(data.lead_quality) || '—'}</td></tr>
      <tr><td><strong>Sentiment</strong></td><td>${e(data.sentiment) || '—'}</td></tr>
    </table>
    <p><strong>Summary</strong><br/>${e(data.summary).replace(/\n/g, '<br/>')}</p>
    <p><a href="${e(record.url)}#transcript">View full message log</a></p>
  `;
}

function buildLegacyChatEmailHtml(chat, data) {
  const e = escapeHtml;
  const name = data.name || '(name not captured)';
  return `
    <h2>OwnerAI Tools — Demo Line Text Conversation</h2>
    <p><strong>${e(name)}</strong>${data.business ? ` · ${e(data.business)}` : ''}</p>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>From</strong></td><td>${e(data.prospect_number) || '—'}</td></tr>
      <tr><td><strong>Callback</strong></td><td>${e(data.callback_phone) || '—'}</td></tr>
      <tr><td><strong>Business type</strong></td><td>${e(data.business_type) || '—'}</td></tr>
      <tr><td><strong>Reason</strong></td><td>${e(data.call_reason) || '—'}</td></tr>
      <tr><td><strong>Tier interest</strong></td><td>${e(data.interested_tier) || '—'}</td></tr>
      <tr><td><strong>Wants setup call</strong></td><td>${data.wants_setup_call ? '✅ YES' : 'No'}</td></tr>
      ${data.setup_call_booked_time ? `<tr><td><strong>Setup call booked</strong></td><td>📅 ${e(data.setup_call_booked_time)}</td></tr>` : ''}
      <tr><td><strong>Lead quality</strong></td><td>${e(data.lead_quality) || '—'}</td></tr>
      <tr><td><strong>Sentiment</strong></td><td>${e(data.sentiment) || '—'}</td></tr>
    </table>
    <p><strong>Summary</strong><br/>${e(data.summary).replace(/\n/g, '<br/>')}</p>
    <p style="color:#6b7280;font-size:13px;">Message log page unavailable for this conversation — not included in email for privacy.</p>
  `;
}

function buildChatAlertSms(data) {
  const name = data.name || 'Unknown texter';
  const lines = [
    data.setup_call_booked_time
      ? 'OwnerAI: text conversation — BOOKED SETUP CALL'
      : data.wants_setup_call
        ? 'OwnerAI: text conversation — WANTS SETUP CALL'
        : 'OwnerAI: new text conversation',
    `${name}${data.business ? ' — ' + data.business : ''}`,
    data.callback_phone ? `Number: ${data.callback_phone}` : '',
    data.call_reason ? `Re: ${data.call_reason.slice(0, 100)}` : '',
    'Details in email.',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1000);
}

async function handleChatAnalyzed(chat) {
  // Only the SMS receptionist agent gets the full pipeline; ended template
  // threads (owner alert / confirm / demo alert bots) are ignored.
  const smsAgentId = process.env.RETELL_SMS_AGENT_ID;
  if (!smsAgentId || chat?.agent_id !== smsAgentId) return json(204, null);

  const data = extractChatData(chat);
  const prospectMessages = countProspectMessages(chat);
  const who = data.name || data.prospect_number || 'Unknown texter';
  const subject = `[OwnerAI] Text conversation: ${who}${
    data.setup_call_booked_time
      ? ` — BOOKED ${data.setup_call_booked_time}`
      : data.wants_setup_call
        ? ' — WANTS SETUP CALL'
        : ''
  }`;

  const base = {
    call_id: chat.chat_id || null,
    caller_name: data.name || null,
    from_number: data.prospect_number || null,
    duration_sec: null,
    wants_setup_call: data.wants_setup_call,
    wants_sms_confirmation: false,
    lead_quality: data.lead_quality || null,
    sentiment: data.sentiment || null,
  };
  const audit = [
    {
      ...base,
      event_type: 'sms_chat_analyzed',
      status: 'ok',
      detail: data.call_reason || null,
      payload: {
        summary: data.summary,
        business: data.business,
        business_type: data.business_type,
        callback_phone: data.callback_phone,
        interested_tier: data.interested_tier,
        prospect_messages: prospectMessages,
        setup_call_booked_time: data.setup_call_booked_time || null,
      },
    },
  ];

  // Persist the message log so the email can link to it instead of
  // embedding it. Best-effort; falls back to the legacy full email.
  const record = await persistCallRecord({
    id: chat.chat_id,
    kind: 'chat',
    callerName: data.name,
    fromNumber: data.prospect_number,
    summary: data.summary,
    transcript: chat.transcript || '',
    recordingUrl: null,
  });

  let emailError = null;
  try {
    await sendResendEmail(subject, buildChatEmailHtml(chat, data, record));
    audit.push({ ...base, event_type: 'email_sent', status: 'ok', detail: subject });
  } catch (err) {
    emailError = err.message;
    console.error('retell-webhook chat email failed:', err.message);
    audit.push({ ...base, event_type: 'email_failed', status: 'failed', detail: err.message.slice(0, 500) });
  }

  // Owner alert SMS — gate on real engagement (2+ prospect messages) instead
  // of call duration, so a single stray "hi" doesn't cost an alert text.
  let smsError = null;
  const alertPhone = process.env.OWNERAI_ALERT_PHONE;
  try {
    if (!alertPhone) {
      console.warn('OWNERAI_ALERT_PHONE not configured — skipping owner SMS alert');
    } else if (prospectMessages < 2) {
      audit.push({
        ...base,
        event_type: 'owner_sms_skipped',
        status: 'skipped',
        detail: `only ${prospectMessages} prospect message(s) (min 2)`,
      });
    } else {
      const r = await sendRetellSms(alertPhone, {
        agentId: process.env.RETELL_ALERT_AGENT_ID,
        dynamicVariables: { alert_body: buildChatAlertSms(data) },
        source: 'owner-sms-chat-alert',
      });
      if (!r.skipped) audit.push({ ...base, event_type: 'owner_sms_sent', status: 'ok', detail: null });
    }
  } catch (err) {
    smsError = err.message;
    console.error('retell-webhook chat owner SMS failed:', err.message);
    audit.push({ ...base, event_type: 'sms_failed', status: 'failed', detail: `owner alert: ${err.message.slice(0, 400)}` });
  }

  await logAuditEvents(audit);

  if (emailError && smsError) return json(500, { error: 'Internal error' });
  return json(200, { ok: true, ...(emailError && { emailError: true }), ...(smsError && { smsError: true }) });
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-retell-signature');

  // Retell signs webhooks with the workspace's designated "webhook key",
  // which may differ from the API key used for sends. Accept either.
  const verifyKeys = [process.env.RETELL_WEBHOOK_KEY, process.env.RETELL_API_KEY].filter(Boolean);
  if (!verifyKeys.some((k) => verifyRetellSignature(rawBody, k, signature))) {
    console.warn('retell-webhook: signature verification failed');
    return json(401, { error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (payload.event === 'chat_analyzed') {
    return handleChatAnalyzed(payload.chat || {});
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
      : `[OwnerAI] Demo line call: ${who}${
          data.setup_call_booked_time
            ? ` — BOOKED ${data.setup_call_booked_time}`
            : data.wants_setup_call
              ? ' — WANTS SETUP CALL'
              : ''
        }`;

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

  // Persist the full transcript + a durable copy of the recording so the
  // email can carry links instead of the raw content. Best-effort: on
  // failure the email falls back to the legacy full body.
  const record = await persistCallRecord({
    id: call.call_id,
    kind: 'call',
    callerName: data.name,
    fromNumber: call.from_number,
    summary: data.summary,
    transcript: call.transcript || '',
    recordingUrl: typeof call.recording_url === 'string' ? call.recording_url : null,
  });

  let emailError = null;
  try {
    await sendResendEmail(subject, buildEmailHtml(call, data, record));
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
