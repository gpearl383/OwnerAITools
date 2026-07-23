// Shared lead upsert + action-token helpers for the OwnerAI demo queue.
import crypto from 'node:crypto';
import { isHungUpCall } from './alerts.mjs';

const ACTION_TTL_SEC = 7 * 24 * 60 * 60;

export function normalizePhone(v) {
  const digits = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

export function normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

export function classifyStatus({ durationSec, booked, channel }) {
  if (booked) return 'booked';
  if (channel === 'call' && isHungUpCall(durationSec)) return 'hung_up';
  return 'needs_callback';
}

export function computePriority({ wantsSetup, leadQuality }) {
  const q = String(leadQuality || '').toLowerCase();
  if (wantsSetup || q === 'hot' || q === 'high') return 3;
  if (q === 'warm') return 2;
  return 1;
}

function callLinkSecret() {
  if (process.env.CALL_LINK_SECRET) return process.env.CALL_LINK_SECRET;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!srk) return null;
  return crypto.createHash('sha256').update(`ownerai-call-link:${srk}`).digest('hex');
}

export function callDetailUrl(callId) {
  const secret = callLinkSecret();
  if (!secret || !callId) return null;
  const token = crypto.createHmac('sha256', secret).update(String(callId)).digest('hex');
  const base = (process.env.OWNERAI_SITE_URL || 'https://owneraitools.com').replace(/\/$/, '');
  return `${base}/api/call?id=${encodeURIComponent(callId)}&t=${token}`;
}

export function leadActionUrl(leadId, action = 'done') {
  const secret = callLinkSecret();
  if (!secret || !leadId) return null;
  const exp = Math.floor(Date.now() / 1000) + ACTION_TTL_SEC;
  const payload = `${leadId}|${action}|${exp}`;
  const t = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const base = (process.env.OWNERAI_SITE_URL || 'https://owneraitools.com').replace(/\/$/, '');
  return `${base}/api/lead-action?id=${encodeURIComponent(leadId)}&a=${encodeURIComponent(action)}&exp=${exp}&t=${t}`;
}

export function verifyLeadActionToken(leadId, action, exp, token) {
  const secret = callLinkSecret();
  if (!secret || !leadId || !action || !exp || !token) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${leadId}|${action}|${exp}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(String(token)), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function supabaseFetch(path, { method = 'GET', body, prefer } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

async function findLead({ phone, email }) {
  if (phone) {
    const qs = new URLSearchParams({ select: '*', phone: `eq.${phone}`, limit: '1' });
    const res = await supabaseFetch(`leads?${qs}`);
    if (res?.ok) {
      const rows = await res.json();
      if (rows[0]) return rows[0];
    }
  }
  if (email) {
    const qs = new URLSearchParams({ select: '*', email: `eq.${email}`, limit: '1' });
    const res = await supabaseFetch(`leads?${qs}`);
    if (res?.ok) {
      const rows = await res.json();
      if (rows[0]) return rows[0];
    }
  }
  return null;
}

/**
 * Best-effort upsert. Returns the lead row (with id) or null on failure/skip.
 *
 * fields: {
 *   phone?, email?, name?, business?, business_type?,
 *   channel: 'call'|'sms'|'chat',
 *   callId?, summary?, reason?, durationSec?,
 *   wantsSetup?, leadQuality?, sentiment?,
 *   bookedLabel?, bookedAt?, // ISO or null; bookedLabel alone implies booked
 * }
 */
export async function upsertLead(fields) {
  const phone = normalizePhone(fields.phone);
  const email = normalizeEmail(fields.email);
  if (!phone && !email) return null;

  const booked = !!(fields.bookedLabel || fields.bookedAt);
  const status = classifyStatus({
    durationSec: fields.durationSec || 0,
    booked,
    channel: fields.channel,
  });
  const priority = computePriority({
    wantsSetup: !!fields.wantsSetup,
    leadQuality: fields.leadQuality,
  });
  const now = new Date().toISOString();

  try {
    const existing = await findLead({ phone, email });
    const patch = {
      updated_at: now,
      last_event_at: now,
      status,
      priority,
      wants_setup_call: !!fields.wantsSetup,
      last_channel: fields.channel || null,
      done_at: null,
      done_via: null,
    };
    if (phone) patch.phone = phone;
    if (email) patch.email = email;
    if (fields.name) patch.name = String(fields.name).slice(0, 200);
    if (fields.business) patch.business = String(fields.business).slice(0, 200);
    if (fields.business_type) patch.business_type = String(fields.business_type).slice(0, 200);
    if (fields.leadQuality) patch.lead_quality = String(fields.leadQuality).slice(0, 80);
    if (fields.sentiment) patch.sentiment = String(fields.sentiment).slice(0, 80);
    if (fields.callId) patch.last_call_id = String(fields.callId).slice(0, 120);
    if (fields.summary != null) patch.last_summary = String(fields.summary).slice(0, 4000);
    if (fields.reason != null) patch.last_reason = String(fields.reason).slice(0, 1000);
    if (fields.durationSec != null) patch.last_duration_sec = Number(fields.durationSec) || null;
    if (fields.bookedLabel) patch.setup_call_booked_label = String(fields.bookedLabel).slice(0, 300);
    if (fields.bookedAt) patch.setup_call_booked_at = fields.bookedAt;
    else if (booked && !existing?.setup_call_booked_at) patch.setup_call_booked_at = now;

    if (existing) {
      // Preserve stronger identity fields if new event lacks them.
      if (!patch.name && existing.name) delete patch.name;
      const res = await supabaseFetch(`leads?id=eq.${existing.id}`, {
        method: 'PATCH',
        body: patch,
        prefer: 'return=representation',
      });
      if (!res?.ok) {
        console.error('leads update failed:', res?.status, res ? await res.text() : '');
        return null;
      }
      const rows = await res.json();
      return rows[0] || { ...existing, ...patch };
    }

    const insert = {
      ...patch,
      created_at: now,
    };
    const res = await supabaseFetch('leads', {
      method: 'POST',
      body: insert,
      prefer: 'return=representation',
    });
    if (!res?.ok) {
      console.error('leads insert failed:', res?.status, res ? await res.text() : '');
      return null;
    }
    const rows = await res.json();
    return rows[0] || null;
  } catch (err) {
    console.error('upsertLead failed:', err.message);
    return null;
  }
}

export async function markLeadDone(leadId, via) {
  const now = new Date().toISOString();
  const res = await supabaseFetch(`leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    body: {
      status: 'done',
      done_at: now,
      done_via: via,
      updated_at: now,
    },
    prefer: 'return=representation',
  });
  if (!res?.ok) {
    console.error('markLeadDone failed:', res?.status, res ? await res.text() : '');
    return null;
  }
  const rows = await res.json();
  return rows[0] || null;
}

export async function setLeadStatus(leadId, status, via) {
  if (!['needs_callback', 'booked', 'hung_up', 'done'].includes(status)) return null;
  if (status === 'done') return markLeadDone(leadId, via || 'dashboard');
  const now = new Date().toISOString();
  const res = await supabaseFetch(`leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    body: {
      status,
      done_at: null,
      done_via: null,
      updated_at: now,
    },
    prefer: 'return=representation',
  });
  if (!res?.ok) {
    console.error('setLeadStatus failed:', res?.status, res ? await res.text() : '');
    return null;
  }
  const rows = await res.json();
  return rows[0] || null;
}

export async function fetchLeads({ includeDone = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const qs = new URLSearchParams({
    select: '*',
    order: 'priority.desc,last_event_at.desc',
    limit: '500',
  });
  if (!includeDone) qs.set('status', 'neq.done');

  const res = await fetch(`${url}/rest/v1/leads?${qs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

export function enrichLeadForClient(lead) {
  if (!lead) return null;
  return {
    ...lead,
    transcriptUrl: lead.last_call_id ? callDetailUrl(lead.last_call_id) : null,
    markDoneUrl: leadActionUrl(lead.id, 'done'),
    callbackTel: lead.phone ? `tel:${lead.phone}` : null,
  };
}

export async function logLeadAudit({ lead, eventType, status = 'ok', detail, via }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !lead) return;
  try {
    await fetch(`${url}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([
        {
          event_type: eventType,
          status,
          caller_name: lead.name || null,
          from_number: lead.phone || null,
          call_id: lead.last_call_id || null,
          detail: detail || null,
          payload: { lead_id: lead.id, via: via || null, lead_status: lead.status },
        },
      ]),
    });
  } catch (err) {
    console.error('lead audit failed:', err.message);
  }
}
