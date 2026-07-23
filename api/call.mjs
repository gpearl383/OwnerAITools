// Call-detail page for the OwnerAI Tools demo line.
//
//   GET /api/call?id=<call_id>&t=<token>          -> HTML page (summary, audio player, transcript)
//   GET /api/call?id=<call_id>&t=<token>&audio=1  -> streams the recording from Supabase Storage
//
// The token is HMAC-SHA256(call_id, CALL_LINK_SECRET) — links are unguessable.
// Access expires 30 days after the record was created (LINK_TTL_MS). Storage is
// purged separately at 120 days by /api/purge-call-records.
//
// Required env vars:
//   CALL_LINK_SECRET          — HMAC key shared with the webhook
//   SUPABASE_URL              — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — server-side only

import crypto from 'node:crypto';

const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Must mirror callLinkSecret() in api/retell-webhook.mjs: prefer
// CALL_LINK_SECRET, otherwise derive from the Supabase service-role key.
function callLinkSecret() {
  if (process.env.CALL_LINK_SECRET) return process.env.CALL_LINK_SECRET;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!srk) return null;
  return crypto.createHash('sha256').update(`ownerai-call-link:${srk}`).digest('hex');
}

function validToken(id, token) {
  const secret = callLinkSecret();
  if (!secret || !id || !token) return false;
  const expected = crypto.createHmac('sha256', secret).update(String(id)).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(String(token)), Buffer.from(expected));
  } catch {
    return false;
  }
}

function isLinkExpired(record) {
  if (!record?.created_at) return true;
  const created = new Date(record.created_at).getTime();
  if (Number.isNaN(created)) return true;
  return Date.now() - created > LINK_TTL_MS;
}

function escapeHtml(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function fetchRecord(id) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  const qs = new URLSearchParams({ select: '*', id: `eq.${id}`, limit: '1' });
  const res = await fetch(`${url}/rest/v1/call_records?${qs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

function htmlResponse(status, html) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function renderPage(record, token) {
  const e = escapeHtml;
  const isChat = record.kind === 'chat';
  const title = isChat ? 'Text Conversation' : 'Call Details';
  const name = record.caller_name || '(name not captured)';
  const when = record.created_at
    ? new Date(record.created_at).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'America/New_York',
      }) + ' ET'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>OwnerAI Tools — ${e(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; color: #1f2937; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  .meta { color: #6b7280; font-size: 14px; margin-bottom: 20px; }
  .summary { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; font-size: 15px; line-height: 1.5; }
  pre { white-space: pre-wrap; font-family: inherit; font-size: 14px; line-height: 1.6; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; }
  audio { width: 100%; }
</style>
</head>
<body>
<h1>OwnerAI Tools — ${e(title)}</h1>
<p class="meta"><strong>${e(name)}</strong>${record.from_number ? ` · ${e(record.from_number)}` : ''}${when ? ` · ${e(when)}` : ''}</p>
${record.summary ? `<h2>Summary</h2><div class="summary">${e(record.summary).replace(/\n/g, '<br/>')}</div>` : ''}
${record.recording_path ? `<h2 id="recording">Recording</h2><audio controls preload="none" src="?id=${encodeURIComponent(record.id)}&amp;t=${e(token)}&amp;audio=1"></audio>` : ''}
<h2 id="transcript">${isChat ? 'Message log' : 'Transcript'}</h2>
<pre>${e(record.transcript || '(no transcript captured)')}</pre>
</body>
</html>`;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const id = params.get('id') || '';
  const token = params.get('t') || '';

  if (!validToken(id, token)) {
    return htmlResponse(404, '<h1>Not found</h1>');
  }

  let record;
  try {
    record = await fetchRecord(id);
  } catch (err) {
    console.error('call page fetch failed:', err.message);
    return htmlResponse(500, '<h1>Something went wrong — try again shortly.</h1>');
  }
  if (!record) return htmlResponse(404, '<h1>Not found</h1>');

  if (isLinkExpired(record)) {
    return htmlResponse(
      410,
      '<h1>Link expired</h1><p>Call recordings and transcripts are available for 30 days after the call.</p>'
    );
  }

  // Audio streaming leg: proxy the private recording through this endpoint
  // so the browser only ever talks to our own origin (CSP: default-src 'self').
  if (params.get('audio') === '1') {
    if (!record.recording_path) return htmlResponse(404, '<h1>No recording</h1>');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const audio = await fetch(
      `${url}/storage/v1/object/call-recordings/${encodeURIComponent(record.recording_path)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!audio.ok) {
      console.error('recording fetch failed:', audio.status);
      return htmlResponse(404, '<h1>Recording unavailable</h1>');
    }
    return new Response(audio.body, {
      status: 200,
      headers: {
        'Content-Type': audio.headers.get('content-type') || 'audio/wav',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }

  return htmlResponse(200, renderPage(record, token));
}
