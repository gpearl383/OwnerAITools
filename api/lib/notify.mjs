// Owner ops alerts (SMS via Retell + email via Resend) with per-key cooldown.
// Used by inline failure hooks and the /api/monitor cron. Best-effort — never
// throws to the caller.

const COOLDOWN_MS = 30 * 60 * 1000;
const DEMO_LINE = '+15169731973';

function normalizePhone(v) {
  const digits = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

async function sbHeaders() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key, headers: { apikey: key, Authorization: `Bearer ${key}` } };
}

async function getIncident(checkKey) {
  const sb = await sbHeaders();
  if (!sb) return null;
  const qs = new URLSearchParams({ select: '*', check_key: `eq.${checkKey}`, limit: '1' });
  const res = await fetch(`${sb.url}/rest/v1/monitor_incidents?${qs}`, { headers: sb.headers });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function upsertIncident(row) {
  const sb = await sbHeaders();
  if (!sb) return;
  const res = await fetch(`${sb.url}/rest/v1/monitor_incidents`, {
    method: 'POST',
    headers: {
      ...sb.headers,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) console.error('monitor_incidents upsert failed:', res.status, await res.text());
}

function inCooldown(incident) {
  if (!incident?.last_alerted_at) return false;
  return Date.now() - new Date(incident.last_alerted_at).getTime() < COOLDOWN_MS;
}

async function sendMonitorSms(body) {
  const apiKey = process.env.RETELL_API_KEY;
  const from = process.env.RETELL_SMS_FROM;
  const agentId = process.env.RETELL_ALERT_AGENT_ID;
  const to = normalizePhone(process.env.OWNERAI_ALERT_PHONE);
  if (!apiKey || !from || !agentId || !to) {
    console.warn('monitor SMS skipped — missing Retell/alert env');
    return { skipped: true };
  }

  const res = await fetch('https://api.retellai.com/create-sms-chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: from,
      to_number: to,
      override_agent_id: agentId,
      metadata: { source: 'ownerai-monitor' },
      retell_llm_dynamic_variables: { alert_body: String(body).slice(0, 1000) },
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

async function sendMonitorEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.OWNERAI_NOTIFY_EMAIL || 'info@owneraitools.com';
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI Tools <info@owneraitools.com>';
  if (!apiKey) {
    console.warn('monitor email skipped — RESEND_API_KEY missing');
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

/**
 * Notify the owner about a failure/recovery. Honors a 30-minute per-key cooldown
 * unless force=true. Never throws.
 *
 * @param {{ key: string, subject: string, sms: string, detail?: string, html?: string, force?: boolean }} opts
 */
export async function notifyOwner({ key, subject, sms, detail, html, force = false }) {
  try {
    if (!key || !subject || !sms) return { sent: false, reason: 'missing_fields' };
    const existing = await getIncident(key);
    if (!force && inCooldown(existing)) {
      return { sent: false, reason: 'cooldown' };
    }

    const emailHtml =
      html ||
      `
      <h2 style="font-family:sans-serif;color:#14355e;">${escapeHtml(subject)}</h2>
      <p style="font-family:sans-serif;font-size:14px;white-space:pre-wrap;">${escapeHtml(sms)}</p>
      ${detail ? `<pre style="font-family:monospace;font-size:12px;background:#f2f7fc;padding:12px;border-radius:8px;">${escapeHtml(detail)}</pre>` : ''}
      <p style="font-family:sans-serif;font-size:12px;color:#5a6b81;">OwnerAI monitor · key <code>${escapeHtml(key)}</code></p>
    `;

    const results = { sms: null, email: null };
    try {
      results.sms = await sendMonitorSms(`MONITOR: ${sms}`);
    } catch (err) {
      console.error('monitor SMS failed:', err.message);
      results.sms = { error: err.message };
    }
    try {
      results.email = await sendMonitorEmail(`[OwnerAI MONITOR] ${subject}`, emailHtml);
    } catch (err) {
      console.error('monitor email failed:', err.message);
      results.email = { error: err.message };
    }

    await upsertIncident({
      check_key: key,
      status: existing?.status || 'ok',
      detail: (detail || sms || '').slice(0, 500),
      consecutive_failures: existing?.consecutive_failures ?? 0,
      last_checked_at: existing?.last_checked_at || new Date().toISOString(),
      last_alerted_at: new Date().toISOString(),
      opened_at: existing?.opened_at || null,
      recovered_at: existing?.recovered_at || null,
    });

    return { sent: true, results };
  } catch (err) {
    console.error('notifyOwner failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

function escapeHtml(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * Record a probe result and open/recover incidents with alert fan-out.
 * Opens after 2 consecutive failures; recovers on first success after open.
 */
export async function recordProbeResult(checkKey, ok, detail = '') {
  const now = new Date().toISOString();
  const existing = (await getIncident(checkKey)) || {
    check_key: checkKey,
    status: 'ok',
    consecutive_failures: 0,
  };

  if (ok) {
    const wasOpen = existing.status === 'open';
    await upsertIncident({
      check_key: checkKey,
      status: wasOpen ? 'recovered' : 'ok',
      detail: (detail || 'ok').slice(0, 500),
      consecutive_failures: 0,
      last_checked_at: now,
      last_alerted_at: existing.last_alerted_at || null,
      opened_at: existing.opened_at || null,
      recovered_at: wasOpen ? now : existing.recovered_at || null,
    });
    if (wasOpen) {
      await notifyOwner({
        key: checkKey,
        subject: `Recovered: ${checkKey}`,
        sms: `${checkKey} recovered — ${detail || 'ok'}`,
        detail,
        force: true,
      });
    }
    return { status: wasOpen ? 'recovered' : 'ok' };
  }

  const fails = (existing.consecutive_failures || 0) + 1;
  const shouldOpen = fails >= 2 && existing.status !== 'open';
  await upsertIncident({
    check_key: checkKey,
    status: shouldOpen || existing.status === 'open' ? 'open' : existing.status || 'ok',
    detail: (detail || 'failed').slice(0, 500),
    consecutive_failures: fails,
    last_checked_at: now,
    last_alerted_at: existing.last_alerted_at || null,
    opened_at: shouldOpen ? now : existing.opened_at || null,
    recovered_at: existing.recovered_at || null,
  });

  if (shouldOpen) {
    await notifyOwner({
      key: checkKey,
      subject: `Down: ${checkKey}`,
      sms: `${checkKey} failing — ${detail || 'probe failed'}`,
      detail,
      force: true,
    });
    return { status: 'opened', failures: fails };
  }
  return { status: existing.status === 'open' ? 'still_open' : 'warming', failures: fails };
}

export async function listIncidents() {
  const sb = await sbHeaders();
  if (!sb) return [];
  const qs = new URLSearchParams({
    select: '*',
    order: 'updated_at.desc',
    limit: '100',
  });
  const res = await fetch(`${sb.url}/rest/v1/monitor_incidents?${qs}`, { headers: sb.headers });
  if (!res.ok) return [];
  return res.json();
}

export { DEMO_LINE, COOLDOWN_MS };
