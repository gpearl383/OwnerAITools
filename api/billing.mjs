// Usage billing API for OwnerAI Tools (no payment processing).
//
//   POST /api/billing { password }     -> signed HttpOnly session cookie
//   POST /api/billing { logout }       -> clears the cookie
//   GET  /api/billing?cycle=current    -> all clients + selected usage
//   GET  /api/billing?client=<slug>    -> scoped to one client (portal-ready)
//
// Auth reuses DASHBOARD_PASSWORD + DASHBOARD_SESSION_SECRET.

import crypto from 'node:crypto';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'oat_dash';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSessionCookie(secret) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const token = `${exp}.${sign(exp, secret)}`;
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

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function sbUrl(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}

async function sbFetch(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  const res = await fetch(sbUrl(path), { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Billing cycle window for a client's billing_cycle_day (1–28). */
export function cycleWindow(now = new Date(), cycleDay = 1) {
  const day = Math.min(Math.max(Number(cycleDay) || 1, 1), 28);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const date = now.getUTCDate();

  let startY = y;
  let startM = m;
  if (date < day) {
    startM = m - 1;
    if (startM < 0) {
      startM = 11;
      startY -= 1;
    }
  }
  const start = new Date(Date.UTC(startY, startM, day, 0, 0, 0, 0));

  let endM = startM + 1;
  let endY = startY;
  if (endM > 11) {
    endM = 0;
    endY += 1;
  }
  const end = new Date(Date.UTC(endY, endM, day, 0, 0, 0, 0));
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Carrier-style: each call rounds up to whole minutes. */
export function billableMinutesFromSec(durationSec) {
  const sec = Number(durationSec) || 0;
  if (sec <= 0) return 0;
  return Math.ceil(sec / 60);
}

function eventLineNumber(event, defaultSmsFrom) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  if (typeof payload.to_number === 'string' && payload.to_number) return payload.to_number;
  // Legacy SMS rows lacked to_number — attribute to the configured SMS from-line.
  if (event.event_type === 'sms_chat_analyzed' && defaultSmsFrom) return defaultSmsFrom;
  return null;
}

function dayKey(iso) {
  return (iso || '').slice(0, 10);
}

function computeClientUsage(client, numbers, events, cycle, defaultSmsFrom) {
  const numberSet = new Set(numbers.map((n) => n.e164));
  const calls = [];
  const chats = [];

  for (const e of events) {
    const line = eventLineNumber(e, defaultSmsFrom);
    if (!line || !numberSet.has(line)) continue;
    if (e.event_type === 'call_analyzed') calls.push(e);
    else if (e.event_type === 'sms_chat_analyzed') chats.push(e);
  }

  let minutesUsed = 0;
  const byDay = {};
  for (const c of calls) {
    const mins = billableMinutesFromSec(c.duration_sec);
    minutesUsed += mins;
    const d = dayKey(c.created_at);
    if (!byDay[d]) byDay[d] = { day: d, minutes: 0, calls: 0, chats: 0 };
    byDay[d].minutes += mins;
    byDay[d].calls += 1;
  }
  for (const c of chats) {
    const d = dayKey(c.created_at);
    if (!byDay[d]) byDay[d] = { day: d, minutes: 0, calls: 0, chats: 0 };
    byDay[d].chats += 1;
  }

  const series = [];
  for (let t = cycle.start.getTime(); t < cycle.end.getTime(); t += 24 * 60 * 60 * 1000) {
    const day = new Date(t).toISOString().slice(0, 10);
    series.push(byDay[day] || { day, minutes: 0, calls: 0, chats: 0 });
  }

  const included = Number(client.included_minutes) || 0;
  const overageMinutes = Math.max(0, minutesUsed - included);
  const rateCents = Number(client.overage_rate_cents) || 0;
  const estimatedOverageCents = overageMinutes * rateCents;

  const activity = [...calls, ...chats]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50)
    .map((e) => ({
      id: e.id,
      created_at: e.created_at,
      event_type: e.event_type,
      caller_name: e.caller_name,
      from_number: e.from_number,
      duration_sec: e.duration_sec,
      minutes: e.event_type === 'call_analyzed' ? billableMinutesFromSec(e.duration_sec) : 0,
      detail: e.detail,
      lead_quality: e.lead_quality,
    }));

  return {
    id: client.id,
    name: client.name,
    slug: client.slug,
    plan_tier: client.plan_tier,
    status: client.status,
    portal_enabled: client.portal_enabled,
    included_minutes: included,
    overage_rate_cents: rateCents,
    billing_cycle_day: client.billing_cycle_day,
    numbers: numbers.map((n) => ({ e164: n.e164, label: n.label })),
    cycle: { start: cycle.startIso, end: cycle.endIso },
    minutes_used: minutesUsed,
    minutes_remaining: Math.max(0, included - minutesUsed),
    overage_minutes: overageMinutes,
    estimated_overage_cents: estimatedOverageCents,
    estimated_overage_dollars: estimatedOverageCents / 100,
    call_count: calls.length,
    sms_conversation_count: chats.length,
    series,
    activity,
  };
}

async function loadClientsWithNumbers() {
  const [clients, numbers] = await Promise.all([
    sbFetch('clients?select=*&order=name.asc'),
    sbFetch('client_numbers?select=*'),
  ]);
  const byClient = new Map();
  for (const n of numbers) {
    if (!byClient.has(n.client_id)) byClient.set(n.client_id, []);
    byClient.get(n.client_id).push(n);
  }
  return clients.map((c) => ({ client: c, numbers: byClient.get(c.id) || [] }));
}

async function fetchUsageEvents(startIso, endIso) {
  const qs = new URLSearchParams();
  qs.set('select', 'id,created_at,event_type,caller_name,from_number,duration_sec,detail,lead_quality,payload');
  qs.set('order', 'created_at.desc');
  qs.set('limit', '5000');
  qs.set('created_at', `gte.${startIso}`);
  qs.append('created_at', `lt.${endIso}`);
  qs.set('or', '(event_type.eq.call_analyzed,event_type.eq.sms_chat_analyzed)');
  const res = await fetch(`${sbUrl('audit_events')}?${qs}`, {
    headers: sbHeaders(),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function POST(request) {
  const password = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!password || !secret) return json(500, { error: 'Billing not configured' });

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
  const slug = (url.searchParams.get('client') || '').trim();
  const defaultSmsFrom = process.env.RETELL_SMS_FROM || '+15169731973';

  try {
    const rows = await loadClientsWithNumbers();
    if (!rows.length) return json(200, { clients: [], selected: null });

    const selectedRow = slug
      ? rows.find((r) => r.client.slug === slug)
      : rows[0];
    if (slug && !selectedRow) return json(404, { error: 'Client not found' });

    // Widest cycle among clients so one fetch covers admin list
    const now = new Date();
    let earliest = null;
    let latest = null;
    for (const { client } of rows) {
      const w = cycleWindow(now, client.billing_cycle_day);
      if (!earliest || w.start < earliest) earliest = w.start;
      if (!latest || w.end > latest) latest = w.end;
    }
    const events = await fetchUsageEvents(earliest.toISOString(), latest.toISOString());

    const clients = rows.map(({ client, numbers }) => {
      const cycle = cycleWindow(now, client.billing_cycle_day);
      const usage = computeClientUsage(client, numbers, events, cycle, defaultSmsFrom);
      // Slim list for the selector / admin cards
      return {
        id: usage.id,
        name: usage.name,
        slug: usage.slug,
        plan_tier: usage.plan_tier,
        status: usage.status,
        included_minutes: usage.included_minutes,
        minutes_used: usage.minutes_used,
        minutes_remaining: usage.minutes_remaining,
        overage_minutes: usage.overage_minutes,
        estimated_overage_dollars: usage.estimated_overage_dollars,
        call_count: usage.call_count,
        sms_conversation_count: usage.sms_conversation_count,
        cycle: usage.cycle,
      };
    });

    const sel = selectedRow;
    const selected = computeClientUsage(
      sel.client,
      sel.numbers,
      events,
      cycleWindow(now, sel.client.billing_cycle_day),
      defaultSmsFrom
    );

    return json(200, { clients, selected });
  } catch (err) {
    console.error('billing fetch failed:', err.message);
    return json(500, { error: 'Failed to load billing data' });
  }
}
