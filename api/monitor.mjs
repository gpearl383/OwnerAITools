// OwnerAI agent health monitor.
//
//   GET|POST /api/monitor              — probes + failed-row sweep (CRON_SECRET)
//   GET|POST /api/monitor?mode=digest   — same as /api/monitor-digest (+ send-path probe)
//   GET|POST /api/monitor?mode=send-probe — synthetic demo SMS compose check only
//   GET|POST /api/monitor?mode=test-alert — forced owner SMS+email
//
// Vercel Cron: every 5 minutes → /api/monitor; daily → /api/monitor-digest.
//
// Required env vars:
//   CRON_SECRET
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   RETELL_API_KEY (+ RETELL_SMS_FROM for line check)
//   RESEND_API_KEY
//   ANTHROPIC_API_KEY
//   CAL_API_KEY + CAL_EVENT_TYPE_ID
//   OWNERAI_ALERT_PHONE / OWNERAI_NOTIFY_EMAIL (via notify.mjs)
//   RETELL_DEMO_ALERT_AGENT_ID (for send-path probe)

import {
  notifyOwner,
  recordProbeResult,
  listIncidents,
  DEMO_LINE,
  TESTING_LINE,
} from './lib/notify.mjs';
import { cronAuthorized } from './lib/cron-auth.mjs';

// Must match retell/manifest.json — both public + testing DIDs share these agents.
const DEMO_VOICE_AGENT_ID = 'agent_fcec78e0c72574d61945abdbf3';
const SMS_RECEPTIONIST_AGENT_ID = 'agent_464d6d1636bdf8b135f04f2990';

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(request) {
  return cronAuthorized(request);
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
  const res = await fetch('https://api.retellai.com/v2/list-agents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Retell list-agents ${res.status}`);
  const data = await res.json();
  const count = Array.isArray(data?.items) ? data.items.length : 0;
  return `${count} agents`;
}

async function fetchPhoneNumber(line) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error('RETELL_API_KEY missing');
  const res = await fetch(`https://api.retellai.com/get-phone-number/${encodeURIComponent(line)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`phone ${line} ${res.status}`);
  return res.json();
}

function inboundVoiceAgentId(phone) {
  return (
    phone?.inbound_agents?.[0]?.agent_id ||
    phone?.inbound_agent_id ||
    null
  );
}

function inboundSmsAgentId(phone) {
  return (
    phone?.inbound_sms_agents?.[0]?.agent_id ||
    phone?.inbound_sms_agent_id ||
    null
  );
}

/**
 * @param {string} line
 * @param {{ requireSms?: boolean }} opts
 *   requireSms: public demo must have SMS receptionist.
 *   Testing DID may omit SMS (not on A2P); if SMS is bound it must still match.
 */
async function checkSharedDemoLine(line, { requireSms = true } = {}) {
  const phone = await fetchPhoneNumber(line);
  const voice = inboundVoiceAgentId(phone);
  if (!voice) throw new Error(`${line} has no inbound voice agent`);
  if (voice !== DEMO_VOICE_AGENT_ID) {
    throw new Error(
      `${line} voice agent drift: ${voice} (expected demo-voice ${DEMO_VOICE_AGENT_ID})`,
    );
  }

  const sms = inboundSmsAgentId(phone);
  if (requireSms) {
    if (!sms) throw new Error(`${line} has no inbound SMS agent`);
    if (sms !== SMS_RECEPTIONIST_AGENT_ID) {
      throw new Error(
        `${line} SMS agent drift: ${sms} (expected sms-receptionist ${SMS_RECEPTIONIST_AGENT_ID})`,
      );
    }
    return `${line} → voice ${voice}, sms ${sms}`;
  }

  if (sms && sms !== SMS_RECEPTIONIST_AGENT_ID) {
    throw new Error(
      `${line} SMS agent drift: ${sms} (expected sms-receptionist ${SMS_RECEPTIONIST_AGENT_ID} or unbound)`,
    );
  }
  return sms
    ? `${line} → voice ${voice}, sms ${sms}`
    : `${line} → voice ${voice}, sms unbound (A2P ok)`;
}

async function checkDemoLine() {
  return checkSharedDemoLine(process.env.RETELL_SMS_FROM || DEMO_LINE, {
    requireSms: true,
  });
}

async function checkTestingLine() {
  return checkSharedDemoLine(TESTING_LINE, { requireSms: false });
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

async function checkDemoSendPath() {
  const apiKey = process.env.RETELL_API_KEY;
  const from = process.env.RETELL_SMS_FROM;
  const agent = process.env.RETELL_DEMO_ALERT_AGENT_ID;
  const to = process.env.OWNERAI_ALERT_PHONE;
  if (!apiKey || !from || !agent || !to) throw new Error('demo send env missing');

  const res = await fetch('https://api.retellai.com/create-sms-chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: from,
      to_number: to,
      override_agent_id: agent,
      metadata: { source: 'monitor-send-probe' },
      retell_llm_dynamic_variables: {
        demo_alert_body: `MONITOR PROBE ${new Date().toISOString().slice(11, 19)}Z — ignore.`,
      },
    }),
  });
  if (!res.ok) throw new Error(`create-sms-chat ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const chat = await res.json();

  const started = Date.now();
  let composed = false;
  while (Date.now() - started < 10000) {
    const r = await fetch(`https://api.retellai.com/get-chat/${chat.chat_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) {
      const c = await r.json();
      const msgs = c.message_with_tool_calls || c.messages || [];
      if (msgs.some((m) => m.role === 'agent' && String(m.content || '').length > 0)) {
        composed = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  try {
    await fetch(`https://api.retellai.com/end-chat/${chat.chat_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    /* non-fatal */
  }
  if (!composed) throw new Error('no agent message in 10s');
  return `composed in ${Date.now() - started}ms`;
}

async function runProbes({ includeSendPath = false } = {}) {
  const jobs = [
    probe('retell_api', checkRetellApi),
    probe(`line:${process.env.RETELL_SMS_FROM || DEMO_LINE}`, checkDemoLine),
    probe(`line:${TESTING_LINE}`, checkTestingLine),
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
  ];
  // Send-path probe texts OWNERAI_ALERT_PHONE — run only on digest / send-probe
  // modes (not every 5 min) to avoid spamming the founder's phone.
  if (includeSendPath) {
    jobs.push(probe('demo_send_path', checkDemoSendPath));
  }

  const results = await Promise.all(jobs);

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

/**
 * Shared monitor runner.
 * @param {Request} request
 * @param {{ mode?: 'probe' | 'digest' | 'test-alert' }} [opts]
 *   When opts.mode is set (e.g. from /api/monitor-digest), it wins over ?mode=.
 *   Vercel Cron on /api/monitor is always probe — digest is a separate path.
 */
export async function runMonitor(request, opts = {}) {
  if (!authorized(request)) return unauthorized();

  const url = new URL(request.url);
  const requested = url.searchParams.get('mode') || '';
  const mode =
    opts.mode ||
    (requested === 'digest'
      ? 'digest'
      : requested === 'test-alert'
        ? 'test-alert'
        : requested === 'send-probe'
          ? 'send-probe'
          : 'probe');

  try {
    if (mode === 'test-alert') {
      const result = await notifyOwner({
        key: 'test:manual',
        subject: 'Monitor test alert',
        sms: 'Test alert from OwnerAI monitor — ignore if unexpected.',
        detail: `Forced test at ${new Date().toISOString()}`,
        force: true,
      });
      return json(200, { ok: true, mode, at: new Date().toISOString(), result });
    }

    if (mode === 'send-probe') {
      const r = await probe('demo_send_path', checkDemoSendPath);
      const incident = await recordProbeResult(r.name, r.ok, r.detail);
      return json(200, {
        ok: r.ok,
        mode,
        at: new Date().toISOString(),
        probe: { ...r, incident },
      });
    }

    const includeSendPath = mode === 'digest';
    const probes = await runProbes({ includeSendPath });
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
  return runMonitor(request);
}

export async function POST(request) {
  return runMonitor(request);
}
