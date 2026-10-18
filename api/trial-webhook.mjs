// Retell webhook for Sales Trial Slot agents (trial-voice / trial-sms).
// Routes owner alerts to the active demo_slots owner — never OWNERAI_ALERT_PHONE.
// Tags audit_events.payload.slot_id and leads.slot_id so /portal stays clean.
//
// Required: TRIAL_RETELL_API_KEY (ownerai-demo), RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: RETELL_API_KEY (fallback verify only), RETELL_ALERT_AGENT_ID, OWNERAI_RESEND_FROM
// Do not use website RETELL_API_KEY for trial paint/SMS — that is a different Retell workspace.

import crypto from 'node:crypto';
import { upsertLead, callDetailUrl as sharedCallDetailUrl } from './lib/leads.mjs';
import { isHungUpCall } from './lib/alerts.mjs';
import {
  getActiveSlotByE164,
  getSlotByKey,
  refreshExpired,
  trialRetellApiKey,
} from './lib/demo-slots.mjs';

const IN_FLIGHT_MS = 2 * 60 * 1000;

function json(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
  });
}

function supabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

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
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function normalizePhone(v) {
  const digits = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

function callDurationSec(call) {
  const start = call?.start_timestamp;
  const end = call?.end_timestamp;
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

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

function normalizeAuditRows(rows) {
  const keys = new Set();
  for (const row of rows) for (const k of Object.keys(row)) keys.add(k);
  return rows.map((row) => {
    const out = {};
    for (const k of keys) out[k] = row[k] !== undefined ? row[k] : null;
    return out;
  });
}

async function logAuditEvents(rows) {
  const sb = supabaseEnv();
  if (!sb || !rows.length) return;
  try {
    const res = await fetch(`${sb.url}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        apikey: sb.key,
        Authorization: `Bearer ${sb.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(normalizeAuditRows(rows)),
    });
    if (!res.ok) console.error('trial audit insert failed:', res.status, await res.text());
  } catch (err) {
    console.error('trial audit failed:', err.message);
  }
}

async function getAnalyzedMarker(eventType, callId) {
  const sb = supabaseEnv();
  if (!sb || !callId) return null;
  try {
    const res = await fetch(
      `${sb.url}/rest/v1/audit_events?select=id,status,created_at&event_type=eq.${eventType}&call_id=eq.${encodeURIComponent(callId)}&order=created_at.desc&limit=1`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) || [];
    return rows[0] || null;
  } catch {
    return null;
  }
}

function markerGate(marker) {
  if (!marker) return 'proceed';
  const status = marker.status || 'ok';
  if (status === 'ok' || status === 'completed') return 'skip_complete';
  if (status === 'started') {
    const age = Date.now() - new Date(marker.created_at).getTime();
    if (Number.isFinite(age) && age < IN_FLIGHT_MS) return 'skip_inflight';
    return 'resume';
  }
  return 'skip_complete';
}

async function insertStartedMarker(base, eventType, payload) {
  const sb = supabaseEnv();
  if (!sb) return null;
  try {
    const res = await fetch(`${sb.url}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        apikey: sb.key,
        Authorization: `Bearer ${sb.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(
        normalizeAuditRows([
          {
            ...base,
            event_type: eventType,
            status: 'started',
            detail: base.detail || null,
            payload: payload || null,
          },
        ]),
      ),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) || [];
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function markMarkerOk(markerId) {
  const sb = supabaseEnv();
  if (!sb || markerId == null) return;
  try {
    await fetch(`${sb.url}/rest/v1/audit_events?id=eq.${encodeURIComponent(markerId)}`, {
      method: 'PATCH',
      headers: {
        apikey: sb.key,
        Authorization: `Bearer ${sb.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: 'ok' }),
    });
  } catch (err) {
    console.error('trial marker patch failed:', err.message);
  }
}

async function hasAuditEvent(callId, eventType) {
  const sb = supabaseEnv();
  if (!sb || !callId) return false;
  try {
    const res = await fetch(
      `${sb.url}/rest/v1/audit_events?select=id&event_type=eq.${encodeURIComponent(eventType)}&call_id=eq.${encodeURIComponent(callId)}&status=neq.failed&limit=1`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!res.ok) return false;
    return ((await res.json()) || []).length > 0;
  } catch {
    return false;
  }
}

async function persistCallRecord({ id, kind, callerName, fromNumber, summary, transcript, recordingUrl }) {
  const sb = supabaseEnv();
  if (!sb || !id || !callLinkToken(id)) return null;

  let recordingPath = null;
  const recordingHostOk = (() => {
    try {
      const u = new URL(recordingUrl);
      if (u.protocol !== 'https:') return false;
      const h = u.hostname.toLowerCase();
      return (
        h === 'retellai.com' ||
        h.endsWith('.retellai.com') ||
        h.endsWith('.amazonaws.com') ||
        h.endsWith('.cloudfront.net')
      );
    } catch {
      return false;
    }
  })();

  if (recordingUrl && recordingHostOk) {
    try {
      const audio = await fetch(recordingUrl, { redirect: 'error' });
      if (audio.ok) {
        const bytes = Buffer.from(await audio.arrayBuffer());
        const contentType =
          (audio.headers.get('content-type') || 'audio/wav').split(';')[0].trim() || 'audio/wav';
        const path = `${id}.wav`;
        const up = await fetch(
          `${sb.url}/storage/v1/object/call-recordings/${encodeURIComponent(path)}?upsert=true`,
          {
            method: 'POST',
            headers: {
              apikey: sb.key,
              Authorization: `Bearer ${sb.key}`,
              'Content-Type': contentType,
              'x-upsert': 'true',
            },
            body: bytes,
          },
        );
        if (up.ok) recordingPath = path;
      }
    } catch (err) {
      console.error('trial recording copy failed:', err.message);
    }
  }

  try {
    const res = await fetch(`${sb.url}/rest/v1/call_records`, {
      method: 'POST',
      headers: {
        apikey: sb.key,
        Authorization: `Bearer ${sb.key}`,
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
      console.error('trial call_records insert failed:', res.status, await res.text());
      return null;
    }
  } catch (err) {
    console.error('trial call_records insert failed:', err.message);
    return null;
  }

  return { url: callDetailUrl(id), hasRecording: !!recordingPath };
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI <info@owneraitools.com>';
  if (!apiKey || !to) {
    console.warn('trial email skipped — missing RESEND_API_KEY or to');
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
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendRetellSms(to, from, { agentId, dynamicVariables, source }) {
  // Trial line lives in ownerai-demo — must use TRIAL_RETELL_API_KEY (voice-only until SMS registered).
  const apiKey = trialRetellApiKey() || process.env.RETELL_API_KEY;
  if (!apiKey || !from || !agentId) return { skipped: true };
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
      metadata: { source: source || 'ownerai-trial-webhook' },
      ...(dynamicVariables ? { retell_llm_dynamic_variables: dynamicVariables } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Retell SMS ${res.status}: ${await res.text()}`);
  const chat = await res.json();
  if (chat?.chat_id) {
    try {
      await fetch(`https://api.retellai.com/end-chat/${chat.chat_id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      /* non-fatal */
    }
  }
  return chat;
}

function extractCallData(call) {
  const custom = call?.call_analysis?.custom_analysis_data || {};
  return {
    name: (custom.caller_name || '').trim(),
    business: (custom.business_name || '').trim(),
    business_type: (custom.business_type || '').trim(),
    callback_phone: (custom.callback_phone || call?.from_number || '').trim(),
    call_reason: (custom.call_reason || '').trim(),
    lead_quality: (custom.lead_quality || '').trim(),
    wants_callback: custom.wants_callback === true || custom.wants_callback === 'true',
    summary:
      (call?.call_analysis?.call_summary || '').trim() ||
      'No summary available — see transcript.',
    sentiment: (call?.call_analysis?.user_sentiment || '').trim(),
    security_probe: custom.security_probe === true || custom.security_probe === 'true',
    abusive: custom.abusive === true || custom.abusive === 'true',
  };
}

function extractChatData(chat, trialE164) {
  const custom = chat?.chat_analysis?.custom_analysis_data || {};
  const prospectNumber =
    chat?.from_number && chat.from_number !== trialE164 ? chat.from_number : chat?.to_number || '';
  return {
    name: (custom.caller_name || '').trim(),
    business: (custom.business_name || '').trim(),
    business_type: (custom.business_type || '').trim(),
    callback_phone: (custom.callback_phone || prospectNumber || '').trim(),
    call_reason: (custom.call_reason || '').trim(),
    lead_quality: (custom.lead_quality || '').trim(),
    wants_callback: custom.wants_callback === true || custom.wants_callback === 'true',
    summary:
      (chat?.chat_analysis?.chat_summary || '').trim() ||
      'No summary available — see message log.',
    sentiment: (chat?.chat_analysis?.user_sentiment || '').trim(),
    prospect_number: prospectNumber,
    security_probe: custom.security_probe === true || custom.security_probe === 'true',
    abusive: custom.abusive === true || custom.abusive === 'true',
  };
}

function slotPayload(slot, extra = {}) {
  return {
    slot_id: slot.id,
    slot_key: slot.slot_key,
    company_name: slot.company_name || null,
    ...extra,
  };
}

function buildOwnerEmailHtml({ company, data, duration, record, channel }) {
  const e = escapeHtml;
  const name = data.name || '(name not captured)';
  return `
    <h2>OwnerAI trial — ${e(company)}</h2>
    <p>New ${channel === 'sms' ? 'text conversation' : 'call'} for your trial receptionist.</p>
    ${duration > 0 && duration < 15 ? '<p style="color:#b45309;"><strong>Caller hung up early</strong></p>' : ''}
    <p><strong>${e(name)}</strong>${data.business ? ` · ${e(data.business)}` : ''}</p>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>Callback</strong></td><td>${e(data.callback_phone) || '—'}</td></tr>
      <tr><td><strong>Reason</strong></td><td>${e(data.call_reason) || '—'}</td></tr>
      <tr><td><strong>Wants callback</strong></td><td>${data.wants_callback ? 'Yes' : 'No'}</td></tr>
      <tr><td><strong>Sentiment</strong></td><td>${e(data.sentiment) || '—'}</td></tr>
      ${duration != null ? `<tr><td><strong>Duration</strong></td><td>${duration}s</td></tr>` : ''}
    </table>
    <p><strong>Summary</strong><br/>${e(data.summary).replace(/\n/g, '<br/>')}</p>
    ${
      record?.url
        ? `<p><a href="${e(record.url)}#transcript">View transcript</a>${
            record.hasRecording ? ` · <a href="${e(record.url)}#recording">Listen</a>` : ''
          }</p>`
        : ''
    }
    <p style="color:#6b7280;font-size:13px;">OwnerAI trial alert — links expire in 30 days.</p>
  `;
}

function buildOwnerSms(company, data, record) {
  const name = data.name || 'Unknown caller';
  const lines = [
    `OwnerAI trial (${company}): new message`,
    `${name}${data.business ? ' — ' + data.business : ''}`,
    data.callback_phone ? `Number: ${data.callback_phone}` : '',
    data.call_reason ? `Re: ${data.call_reason.slice(0, 80)}` : '',
    record?.url ? `Transcript: ${record.url}` : '',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1000);
}

async function resolveSlot(event) {
  const call = event.call;
  const chat = event.chat;
  // Prefer the trial line as to_number on inbound.
  const candidates = [
    normalizePhone(call?.to_number),
    normalizePhone(chat?.to_number),
    normalizePhone(call?.from_number),
    normalizePhone(chat?.from_number),
  ].filter(Boolean);

  for (const e164 of candidates) {
    const slot = await getActiveSlotByE164(e164);
    if (slot && slot.status === 'active') return slot;
  }

  // Fallback: slot 1 if active (single-slot v1)
  let slot = await getSlotByKey(1);
  if (slot) slot = await refreshExpired(slot);
  if (slot?.status === 'active') return slot;
  return null;
}

async function handleCallAnalyzed(event, slot) {
  const call = event.call;
  const callId = call?.call_id;
  if (!callId) return json(200, { ok: true, skipped: 'no_call_id' });

  const marker = await getAnalyzedMarker('call_analyzed', callId);
  const gate = markerGate(marker);
  if (gate === 'skip_complete' || gate === 'skip_inflight') {
    return json(200, { ok: true, duplicate: true });
  }

  const data = extractCallData(call);
  const duration = callDurationSec(call);
  const hungUp = isHungUpCall(duration);
  const base = {
    call_id: callId,
    caller_name: data.name || null,
    from_number: call.from_number || null,
    duration_sec: duration || null,
    lead_quality: data.lead_quality || null,
    sentiment: data.sentiment || null,
    wants_setup_call: !!data.wants_callback,
    payload: slotPayload(slot, {
      did_role_play: false,
      interested_tier: null,
      wants_callback: data.wants_callback,
      company_name: slot.company_name,
    }),
  };

  const markerId =
    gate === 'resume' && marker?.id
      ? marker.id
      : await insertStartedMarker(base, 'call_analyzed', base.payload);

  const record = await persistCallRecord({
    id: callId,
    kind: 'call',
    callerName: data.name,
    fromNumber: call.from_number,
    summary: data.summary,
    transcript: call.transcript || null,
    recordingUrl: call.recording_url,
  });

  const lead = await upsertLead({
    phone: data.callback_phone || call.from_number,
    name: data.name,
    business: data.business || slot.company_name,
    business_type: data.business_type,
    channel: 'call',
    callId,
    summary: data.summary,
    reason: data.call_reason,
    durationSec: duration,
    wantsSetup: data.wants_callback,
    leadQuality: data.lead_quality,
    sentiment: data.sentiment,
    flagged: data.security_probe || data.abusive,
    slotId: slot.id,
  });

  const audit = [
    {
      ...base,
      event_type: 'call_analyzed',
      status: 'ok',
      detail: hungUp ? 'early hangup' : data.call_reason || null,
    },
  ];
  if (data.security_probe) {
    audit.push({
      ...base,
      event_type: 'security_probe_detected',
      status: 'flagged',
      detail: 'prompt/config probe',
    });
  }
  if (data.abusive) {
    audit.push({
      ...base,
      event_type: 'abusive_conversation',
      status: 'flagged',
      detail: 'abusive content',
    });
  }

  const company = slot.company_name || 'your business';
  const ownerEmail = slot.owner_email;
  const ownerPhone = slot.owner_phone;
  const trialFrom = slot.e164;

  if (ownerEmail && !(await hasAuditEvent(callId, 'email_sent'))) {
    try {
      await sendResendEmail({
        to: ownerEmail,
        subject: `OwnerAI trial — call for ${company}${data.name ? `: ${data.name}` : ''}`,
        html: buildOwnerEmailHtml({ company, data, duration, record, channel: 'call' }),
      });
      audit.push({ ...base, event_type: 'email_sent', status: 'ok', detail: ownerEmail });
    } catch (err) {
      audit.push({
        ...base,
        event_type: 'email_sent',
        status: 'failed',
        detail: err.message,
      });
    }
  }

  const alertAgent = process.env.RETELL_ALERT_AGENT_ID;
  if (ownerPhone && trialFrom && alertAgent && !(await hasAuditEvent(callId, 'owner_sms_sent'))) {
    try {
      await sendRetellSms(ownerPhone, trialFrom, {
        agentId: alertAgent,
        dynamicVariables: { alert_body: buildOwnerSms(company, data, record) },
        source: 'trial-owner-alert',
      });
      audit.push({ ...base, event_type: 'owner_sms_sent', status: 'ok', detail: ownerPhone });
    } catch (err) {
      audit.push({
        ...base,
        event_type: 'owner_sms_sent',
        status: 'failed',
        detail: err.message,
      });
    }
  }

  await logAuditEvents(audit);
  if (markerId) await markMarkerOk(markerId);
  return json(200, { ok: true, leadId: lead?.id || null, recordUrl: record?.url || null });
}

async function handleChatAnalyzed(event, slot) {
  const chat = event.chat;
  const chatId = chat?.chat_id;
  if (!chatId) return json(200, { ok: true, skipped: 'no_chat_id' });

  const marker = await getAnalyzedMarker('sms_chat_analyzed', chatId);
  const gate = markerGate(marker);
  if (gate === 'skip_complete' || gate === 'skip_inflight') {
    return json(200, { ok: true, duplicate: true });
  }

  const data = extractChatData(chat, slot.e164);
  const base = {
    call_id: chatId,
    caller_name: data.name || null,
    from_number: data.prospect_number || null,
    duration_sec: null,
    lead_quality: data.lead_quality || null,
    sentiment: data.sentiment || null,
    wants_setup_call: !!data.wants_callback,
    payload: slotPayload(slot, { channel: 'sms', wants_callback: data.wants_callback }),
  };

  const markerId =
    gate === 'resume' && marker?.id
      ? marker.id
      : await insertStartedMarker(base, 'sms_chat_analyzed', base.payload);

  const transcript =
    chat.transcript ||
    (Array.isArray(chat.message_with_tool_calls)
      ? chat.message_with_tool_calls
          .filter((m) => m?.role === 'user' || m?.role === 'agent')
          .map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content || ''}`)
          .join('\n')
      : null);

  const record = await persistCallRecord({
    id: chatId,
    kind: 'sms',
    callerName: data.name,
    fromNumber: data.prospect_number,
    summary: data.summary,
    transcript,
    recordingUrl: null,
  });

  const lead = await upsertLead({
    phone: data.callback_phone || data.prospect_number,
    name: data.name,
    business: data.business || slot.company_name,
    business_type: data.business_type,
    channel: 'sms',
    callId: chatId,
    summary: data.summary,
    reason: data.call_reason,
    wantsSetup: data.wants_callback,
    leadQuality: data.lead_quality,
    sentiment: data.sentiment,
    flagged: data.security_probe || data.abusive,
    slotId: slot.id,
  });

  const audit = [
    {
      ...base,
      event_type: 'sms_chat_analyzed',
      status: 'ok',
      detail: data.call_reason || null,
    },
  ];

  const company = slot.company_name || 'your business';
  if (slot.owner_email && !(await hasAuditEvent(chatId, 'email_sent'))) {
    try {
      await sendResendEmail({
        to: slot.owner_email,
        subject: `OwnerAI trial — text for ${company}${data.name ? `: ${data.name}` : ''}`,
        html: buildOwnerEmailHtml({ company, data, duration: null, record, channel: 'sms' }),
      });
      audit.push({ ...base, event_type: 'email_sent', status: 'ok', detail: slot.owner_email });
    } catch (err) {
      audit.push({ ...base, event_type: 'email_sent', status: 'failed', detail: err.message });
    }
  }

  const alertAgent = process.env.RETELL_ALERT_AGENT_ID;
  if (
    slot.owner_phone &&
    slot.e164 &&
    alertAgent &&
    !(await hasAuditEvent(chatId, 'owner_sms_sent'))
  ) {
    try {
      await sendRetellSms(slot.owner_phone, slot.e164, {
        agentId: alertAgent,
        dynamicVariables: { alert_body: buildOwnerSms(company, data, record) },
        source: 'trial-owner-alert-sms',
      });
      audit.push({ ...base, event_type: 'owner_sms_sent', status: 'ok', detail: slot.owner_phone });
    } catch (err) {
      audit.push({
        ...base,
        event_type: 'owner_sms_sent',
        status: 'failed',
        detail: err.message,
      });
    }
  }

  await logAuditEvents(audit);
  if (markerId) await markMarkerOk(markerId);
  return json(200, {
    ok: true,
    leadId: lead?.id || null,
    recordUrl: record?.url || sharedCallDetailUrl(chatId),
  });
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-retell-signature') || '';
  const trialKey = trialRetellApiKey();
  const websiteKey = process.env.RETELL_API_KEY;
  const ok =
    (trialKey && verifyRetellSignature(rawBody, trialKey, signature)) ||
    (websiteKey && verifyRetellSignature(rawBody, websiteKey, signature));

  if (!ok) {
    return json(401, { error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const eventType = event.event || event.event_type || '';
  if (eventType === 'call_ended' || eventType === 'chat_ended') {
    return json(200, { ok: true });
  }

  const slot = await resolveSlot(event);
  if (!slot || slot.status !== 'active') {
    console.warn('trial-webhook: no active slot for event', eventType);
    await logAuditEvents([
      {
        event_type: 'trial_webhook_no_slot',
        status: 'skipped',
        call_id: event.call?.call_id || event.chat?.chat_id || null,
        detail: 'No active demo slot — ignored',
        payload: { event: eventType },
      },
    ]);
    return json(200, { ok: true, skipped: 'no_active_slot' });
  }

  try {
    if (eventType === 'call_analyzed') return await handleCallAnalyzed(event, slot);
    if (eventType === 'chat_analyzed') return await handleChatAnalyzed(event, slot);
    return json(200, { ok: true, ignored: eventType });
  } catch (err) {
    console.error('trial-webhook failed:', err.message);
    return json(500, { error: 'Webhook failed' });
  }
}
