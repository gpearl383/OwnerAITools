// OwnerAI agent health monitor.
//
//   GET|POST /api/monitor            — run probes + failed-row sweep (CRON_SECRET)
//   GET|POST /api/monitor?mode=digest — daily digest email + probes
//
// Triggered every 5 minutes by GitHub Actions; daily digest by Vercel Cron.
//
// Required env vars:
//   CRON_SECRET
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   RETELL_API_KEY (+ RETELL_SMS_FROM for line check)
//   RESEND_API_KEY
//   ANTHROPIC_API_KEY
//   CAL_API_KEY + CAL_EVENT_TYPE_ID
//   OWNERAI_ALERT_PHONE / OWNERAI_NOTIFY_EMAIL (via notify.mjs)

import {
  notifyOwner,
  recordProbeResult,
  listIncidents,
  DEMO_LINE,
} from '../lib/notify.mjs';

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function probe(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail || 'ok', ms: Date.now() - started };
  } catch (err) {
    return { name, ok: false, detail: (err.message || String(err)).slice(0, 400), ms: Date.now() - started };
  }
}

async function checkRetellApi() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error('RETELL_API_KEY missing');
  const res = await fetch('https://api.retellai.com/list-agents', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Retell list-agents ${res.status}`);
  const agents = await res.json();
  return `${Array.isArray(agents) ? agents.length : 0} agents`;
}

async function checkDemoLine() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error('RETELL_API_KEY missing');
  const line = process.env.RETELL_SMS_FROM || DEMO_LINE;
  const res = await fetch(`https://api.retellai.com/get-phone-number/${encodeURIComponent(line)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`phone ${line} ${res.status}`);
  const phone = await res.json();
  const agent = phone?.inbound_agent_id || phone?.outbound_agent_id;
  if (!agent) throw new Error(`${line} has no bound agent`);
  return `${line} → ${agent}`;
}

async function checkSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env missing');
  const res = await fetch(`${url}/rest/v1/audit_events?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return 'audit_events reachable';
}

async function checkResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY missing');
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Resend domains ${res.status}`);
  const body = await res.json();
  const n = Array.isArray(body?.data) ? body.data.length : Array.isArray(body) ? body.length : 0;
  return `${n} domain(s)`;
}

async function checkAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  // Some Anthropic accounts may 404 models list; treat 401/403 as auth fail,
  // anything else as reachable-enough for chat.
  if (res.status === 401 || res.status === 403) throw new Error(`Anthropic ${res.status}`);
  if (!res.ok && res.status !== 404) throw new Error(`Anthropic ${res.status}`);
  return res.ok ? 'models ok' : 'key accepted';
}

async function checkCalcom() {
  const apiKey = process.env.CAL_API_KEY;
  const eventTypeId = process.env.CAL_EVENT_TYPE_ID;
  if (!apiKey || !eventTypeId) throw new Error('CAL_API_KEY or CAL_EVENT_TYPE_ID missing');
  const dateOnly = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const start = dateOnly(now);
  const end = dateOnly(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  const qs = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    start,
    end,
    timeZone: 'America/New_York',
  });
  const res = await fetch(`https://api.cal.com/v2/slots?${qs}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'cal-api-version': '2024-09-04',
    },
  });
  if (!res.ok) throw new Error(`Cal.com slots ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const days = Object.keys(body?.data || {}).length;
  return `event ${eventTypeId}: ${days} day(s) with slots`;
}

async function fetchRecentFailures(sinceIso) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];
  const qs = new URLSearchParams({
    select: 'id,created_at,event_type,status,detail,caller_name,from_number,call_id',
    status: 'eq.failed',
    created_at: `gte.${sinceIso}`,
    order: 'created_at.desc',
    limit: '50',
  });
  const res = await fetch(`${url}/rest/v1/audit_events?${qs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`failed sweep ${res.status}`);
  return res.json();
}

async function fetchDayStats() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const qs = new URLSearchParams({
    select: 'event_type,status',
    created_at: `gte.${since}`,
    limit: '2000',
  });
  const res = await fetch(`${url}/rest/v1/audit_events?${qs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const count = (pred) => rows.filter(pred).length;
  return {
    total: rows.length,
    calls: count((r) => r.event_type === 'call_analyzed'),
    chats: count((r) => r.event_type === 'sms_chat_analyzed'),
    chatLeads: count((r) => r.event_type === 'chat_lead'),
    failures: count((r) => r.status === 'failed'),
    emails: count((r) => r.event_type === 'email_sent'),
    sms: count((r) => /_sms_sent$/.test(r.event_type)),
  };
}

async function runProbes() {
  const results = await Promise.all([
    probe('retell_api', checkRetellApi),
    probe(`line:${process.env.RETELL_SMS_FROM || DEMO_LINE}`, checkDemoLine),
    probe('supabase', checkSupabase),
    probe('resend', checkResend),
    probe('anthropic', checkAnthropic),
    probe('calcom', checkCalcom),
    probe('chat_widget', async () => {
      // Chat widget depends on Anthropic + Supabase; surface as composite.
      await checkAnthropic();
      await checkSupabase();
      return 'anthropic+supabase ok';
    }),
  ]);

  const outcomes = [];
  for (const r of results) {
    const outcome = await recordProbeResult(r.name, r.ok, r.detail);
    outcomes.push({ ...r, incident: outcome });
  }
  return outcomes;
}

async function sweepFailedRows() {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const failures = await fetchRecentFailures(since);
  const alerted = [];
  for (const f of failures) {
    const key = `audit:${f.event_type}:${f.call_id || f.id}`;
    const who = f.caller_name || f.from_number || 'unknown';
    const result = await notifyOwner({
      key,
      subject: `${f.event_type} — ${who}`,
      sms: `${f.event_type} for ${who}: ${(f.detail || '').slice(0, 160)}`,
      detail: JSON.stringify(f),
    });
    if (result.sent) alerted.push(key);
  }
  return { scanned: failures.length, alerted: alerted.length, keys: alerted };
}

async function sendDigest(probeResults, stats, incidents) {
  const open = incidents.filter((i) => i.status === 'open');
  const lines = probeResults
    .map((p) => `${p.ok ? '✅' : '❌'} ${p.name}: ${p.detail} (${p.ms}ms)`)
    .join('\n');
  const subject = open.length
    ? `Daily digest — ${open.length} open incident(s)`
    : 'Daily digest — all green';
  const sms = open.length
    ? `Digest: ${open.length} open — ${open.map((i) => i.check_key).join(', ')}. 24h: ${stats?.calls || 0} calls, ${stats?.failures || 0} fails`
    : `Digest: all green. 24h: ${stats?.calls || 0} calls, ${stats?.chats || 0} texts, ${stats?.failures || 0} fails`;

  const html = `
    <h2 style="font-family:sans-serif;color:#14355e;">OwnerAI monitor — daily digest</h2>
    <p style="font-family:sans-serif;">Last 24h: <strong>${stats?.calls || 0}</strong> calls,
      <strong>${stats?.chats || 0}</strong> text conversations,
      <strong>${stats?.chatLeads || 0}</strong> chat leads,
      <strong>${stats?.emails || 0}</strong> emails,
      <strong>${stats?.sms || 0}</strong> SMS,
      <strong>${stats?.failures || 0}</strong> failures.</p>
    <h3 style="font-family:sans-serif;">Probes</h3>
    <pre style="font-family:monospace;font-size:12px;background:#f2f7fc;padding:12px;border-radius:8px;">${escapeHtml(lines)}</pre>
    <h3 style="font-family:sans-serif;">Open incidents (${open.length})</h3>
    <pre style="font-family:monospace;font-size:12px;">${escapeHtml(
      open.length
        ? open.map((i) => `${i.check_key}: ${i.detail || ''} (since ${i.opened_at || '?'})`).join('\n')
        : 'None',
    )}</pre>
  `;

  // Digest always forces delivery so silence means "monitor died", not "all quiet".
  return notifyOwner({
    key: 'digest:daily',
    subject,
    sms,
    html,
    force: true,
  });
}

function escapeHtml(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function handle(request) {
  if (!authorized(request)) return unauthorized();

  const url = new URL(request.url);
  // Vercel Cron hits /api/monitor daily (x-vercel-cron: 1) → digest.
  // GitHub Actions / manual ?mode=digest also request digest.
  // Default (GHA every 5m) is probe-only.
  const mode =
    url.searchParams.get('mode') === 'digest' ||
    request.headers.get('x-vercel-cron') === '1'
      ? 'digest'
      : 'probe';

  try {
    const probes = await runProbes();
    const sweep = await sweepFailedRows();
    const incidents = await listIncidents();
    let digest = null;
    if (mode === 'digest') {
      const stats = await fetchDayStats();
      digest = await sendDigest(probes, stats, incidents);
    }
    return json(200, {
      ok: true,
      mode,
      at: new Date().toISOString(),
      probes,
      sweep,
      openIncidents: incidents.filter((i) => i.status === 'open').map((i) => i.check_key),
      digest,
    });
  } catch (err) {
    console.error('monitor failed:', err.message);
    try {
      await notifyOwner({
        key: 'monitor:runner',
        subject: 'Monitor runner crashed',
        sms: `Monitor runner error: ${err.message.slice(0, 200)}`,
        detail: err.stack || err.message,
      });
    } catch {
      /* ignore */
    }
    return json(500, { error: err.message });
  }
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}
