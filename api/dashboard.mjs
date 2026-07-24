// Dashboard API for the OwnerAI Tools audit trail + call stats page.
//
//   POST /api/dashboard { password }  -> sets a signed HttpOnly session cookie
//   POST /api/dashboard { logout }    -> clears the cookie
//   GET  /api/dashboard?range=30d     -> stats + audit events (cookie required)
//
// Required env vars:
//   DASHBOARD_PASSWORD        — shared password for the login gate
//   DASHBOARD_SESSION_SECRET  — HMAC key for session cookies
//   SUPABASE_URL              — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — server-side only; never sent to the browser

import crypto from 'node:crypto';
import {
  fetchLeads,
  enrichLeadForClient,
  setLeadStatus,
  logLeadAudit,
} from './lib/leads.mjs';
import { listIncidents } from './lib/notify.mjs';
import { isHungUpCall } from './lib/alerts.mjs';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'oat_dash';

/* ---------- session cookie (HMAC-signed expiry timestamp) ---------- */

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSessionCookie(secret) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const token = `${exp}.${sign(exp, secret)}`;
  // Path=/ so the same session works for /dashboard and /billing.
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function hasValidSession(request, secret) {
  if (!secret) return false;
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [exp, sig] = match[1].split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = sign(exp, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function constantTimeEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- login rate limiting (per warm instance) ---------- */

const attempts = new Map();
function allowLogin(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.start >= 15 * 60 * 1000) {
    attempts.set(ip, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= 10;
}

function clientIp(request) {
  return (
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

/* ---------- data ---------- */

const RANGES = { '7d': 7, '30d': 30, '90d': 90, all: 3650 };

async function fetchEvents(rangeDays) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
  const qs = new URLSearchParams({
    select: '*',
    order: 'created_at.desc',
    limit: '2000',
  });
  const res = await fetch(`${url}/rest/v1/audit_events?${qs}&created_at=gte.${since}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

function computeStats(events, rangeDays) {
  const calls = events.filter((e) => e.event_type === 'call_analyzed');
  const chats = events.filter((e) => e.event_type === 'sms_chat_analyzed');
  const conversations = [...calls, ...chats];
  // Early hangups excluded so 3-second pocket dials don't drag the average.
  const realDurations = calls
    .map((c) => c.duration_sec || 0)
    .filter((d) => d > 0 && !isHungUpCall(d));
  const hangups = calls.filter((c) => isHungUpCall(c.duration_sec || 0)).length;
  const count = (type) => events.filter((e) => e.event_type === type).length;

  // Sentiment/lead-quality buckets cover voice calls AND text conversations.
  const bucket = (field) => {
    const out = {};
    for (const c of conversations) {
      const v = (c[field] || '').toLowerCase();
      if (v) out[v] = (out[v] || 0) + 1;
    }
    return out;
  };

  // Per-day series covering the full range (max 90 bars), calls + texts.
  const days = Math.min(rangeDays, 90);
  const series = [];
  const byDay = {};
  const chatsByDay = {};
  for (const c of calls) {
    const day = (c.created_at || '').slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  for (const c of chats) {
    const day = (c.created_at || '').slice(0, 10);
    chatsByDay[day] = (chatsByDay[day] || 0) + 1;
  }
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    series.push({ day, calls: byDay[day] || 0, chats: chatsByDay[day] || 0 });
  }

  // Funnel + engagement stats from analysis payloads already being captured.
  const rolePlays = calls.filter((c) => c.payload?.did_role_play === true).length;
  const tierInterest = {};
  for (const c of conversations) {
    const t = (c.payload?.interested_tier || '').trim().toLowerCase();
    if (t) tierInterest[t] = (tierInterest[t] || 0) + 1;
  }
  const booked = count('setup_call_booked');

  return {
    totalCalls: calls.length,
    totalChats: chats.length,
    avgDurationSec: realDurations.length
      ? Math.round(realDurations.reduce((a, b) => a + b, 0) / realDurations.length)
      : 0,
    hangups,
    wantsSetupCall: conversations.filter((c) => c.wants_setup_call === true).length,
    emailsSent: count('email_sent'),
    smsSent: count('owner_sms_sent') + count('customer_sms_sent'),
    demoAlerts: count('demo_alert_sms_sent'),
    setupCallsBooked: booked,
    chatLeads: count('chat_lead'),
    failures: events.filter((e) => e.status === 'failed').length,
    flagged:
      count('security_probe_detected') +
      count('abusive_conversation') +
      count('unverified_info_flagged'),
    rolePlays,
    rolePlayConversion: rolePlays ? Math.round((booked / rolePlays) * 100) : null,
    tierInterest,
    funnel: {
      conversations: conversations.length,
      wantsSetup: conversations.filter((c) => c.wants_setup_call === true).length,
      booked,
    },
    sentiment: bucket('sentiment'),
    leadQuality: bucket('lead_quality'),
    series,
  };
}

/* ---------- handlers ---------- */

export async function POST(request) {
  const password = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!password || !secret) return json(500, { error: 'Dashboard not configured' });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid request' });
  }

  if (body.logout) {
    return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  if (!allowLogin(clientIp(request))) {
    return json(429, { error: 'Too many attempts — try again in 15 minutes.' });
  }

  if (typeof body.password !== 'string' || !constantTimeEquals(body.password, password)) {
    return json(401, { error: 'Wrong password' });
  }

  return json(200, { ok: true }, { 'Set-Cookie': makeSessionCookie(secret) });
}

export async function GET(request) {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!hasValidSession(request, secret)) {
    return json(401, { error: 'Not signed in' });
  }

  const url = new URL(request.url);
  const range = url.searchParams.get('range') || '30d';
  const rangeDays = RANGES[range] || 30;
  const includeDone = url.searchParams.get('queue') === 'all';

  try {
    const [events, rawLeads, incidents] = await Promise.all([
      fetchEvents(rangeDays),
      fetchLeads({ includeDone }),
      listIncidents(),
    ]);
    const leads = rawLeads.map(enrichLeadForClient);
    const health = {
      checks: incidents.map((i) => ({
        key: i.check_key,
        status: i.status,
        detail: i.detail,
        consecutiveFailures: i.consecutive_failures,
        lastCheckedAt: i.last_checked_at,
        lastAlertedAt: i.last_alerted_at,
        openedAt: i.opened_at,
        recoveredAt: i.recovered_at,
      })),
      openCount: incidents.filter((i) => i.status === 'open').length,
      lastCheckedAt: incidents.reduce((max, i) => {
        const t = i.last_checked_at || '';
        return t > max ? t : max;
      }, ''),
    };
    return json(200, { stats: computeStats(events, rangeDays), events, leads, health });
  } catch (err) {
    console.error('dashboard fetch failed:', err.message);
    return json(500, { error: 'Failed to load data' });
  }
}

export async function PATCH(request) {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!hasValidSession(request, secret)) {
    return json(401, { error: 'Not signed in' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid request' });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const status = typeof body.status === 'string' ? body.status : '';
  if (!id || !status) return json(400, { error: 'id and status required' });

  const lead = await setLeadStatus(id, status, 'dashboard');
  if (!lead) return json(404, { error: 'Lead not found or invalid status' });

  await logLeadAudit({
    lead,
    eventType: status === 'done' ? 'lead_marked_done' : 'lead_status_changed',
    detail: `Status → ${status}`,
    via: 'dashboard',
  });

  return json(200, { ok: true, lead: enrichLeadForClient(lead) });
}
