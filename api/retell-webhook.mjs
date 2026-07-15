// Retell post-call webhook for the OwnerAI Tools demo line (+1 888-921-1994).
// Vercel serverless function (web-standard handler). Email-only: sends the
// owner a summary of every analyzed call via Resend.
//
// Required env vars (set in the Vercel project):
//   RETELL_API_KEY        — verifies the webhook signature from Retell
//   RESEND_API_KEY        — Resend key for sending email
// Optional:
//   OWNERAI_NOTIFY_EMAIL  — recipient (default: info@owneraitools.com)
//   OWNERAI_RESEND_FROM   — sender (default: OwnerAI Tools <info@owneraitools.com>)

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

  try {
    await sendResendEmail(subject, buildEmailHtml(call, data));
    return json(200, { ok: true });
  } catch (err) {
    console.error('retell-webhook email failed:', err.message);
    return json(500, { error: 'Internal error' });
  }
}
