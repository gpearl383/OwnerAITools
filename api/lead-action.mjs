// Signed one-click lead actions (confirm page — no silent GET mutation).
//
//   GET  /api/lead-action?id=&a=done&exp=&t=  -> confirm form (safe for prefetch)
//   POST /api/lead-action  (form body)        -> mark done
//
// Token: HMAC-SHA256(`${id}|${action}|${exp}`, CALL_LINK_SECRET) — 7 day TTL.

import {
  verifyLeadActionToken,
  markLeadDone,
  logLeadAudit,
} from './lib/leads.mjs';

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlResponse(status, title, body) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f2f7fc;color:#24384f;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  .card{background:#fff;border:1px solid rgba(20,53,94,.12);border-radius:16px;padding:28px 24px;max-width:420px;text-align:center}
  h1{font-size:22px;margin:0 0 8px;color:#14355e}
  p{margin:0;color:#5a6b81;line-height:1.45}
  a{color:#2680cf}
  button{margin-top:18px;background:#2680cf;color:#fff;border:0;border-radius:999px;padding:12px 22px;font-weight:700;font-size:15px;cursor:pointer}
  button:hover{background:#1a66b0}
  .ghost{display:inline-block;margin-top:14px;font-size:14px}
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function parseParams(request) {
  const url = new URL(request.url);
  return {
    id: url.searchParams.get('id') || '',
    action: url.searchParams.get('a') || '',
    exp: url.searchParams.get('exp') || '',
    token: url.searchParams.get('t') || '',
  };
}

async function parseFormParams(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const form = await request.formData();
    return {
      id: String(form.get('id') || ''),
      action: String(form.get('a') || ''),
      exp: String(form.get('exp') || ''),
      token: String(form.get('t') || ''),
    };
  }
  try {
    const body = await request.json();
    return {
      id: String(body.id || ''),
      action: String(body.a || body.action || ''),
      exp: String(body.exp || ''),
      token: String(body.t || body.token || ''),
    };
  } catch {
    return { id: '', action: '', exp: '', token: '' };
  }
}

function validateAction(params) {
  if (params.action !== 'done') {
    return htmlResponse(400, 'Unknown action', 'This link is not valid.');
  }
  if (!verifyLeadActionToken(params.id, params.action, params.exp, params.token)) {
    return htmlResponse(
      403,
      'Link expired or invalid',
      'Open the dashboard to mark this lead done, or use a fresher email/SMS link.',
    );
  }
  return null;
}

export async function GET(request) {
  const params = parseParams(request);
  const err = validateAction(params);
  if (err) return err;

  const actionUrl = `/api/lead-action?id=${encodeURIComponent(params.id)}&a=${encodeURIComponent(params.action)}&exp=${encodeURIComponent(params.exp)}&t=${encodeURIComponent(params.token)}`;
  const body = `
    Confirm you want to mark this lead done and clear it from your callback queue.
    <form method="POST" action="${escapeHtml(actionUrl)}">
      <input type="hidden" name="id" value="${escapeHtml(params.id)}" />
      <input type="hidden" name="a" value="${escapeHtml(params.action)}" />
      <input type="hidden" name="exp" value="${escapeHtml(params.exp)}" />
      <input type="hidden" name="t" value="${escapeHtml(params.token)}" />
      <button type="submit">Yes, mark done</button>
    </form>
    <a class="ghost" href="/dashboard">Open dashboard instead</a>
  `;
  return htmlResponse(200, 'Confirm mark done', body);
}

export async function POST(request) {
  const params = await parseFormParams(request);
  const err = validateAction(params);
  if (err) return err;

  const lead = await markLeadDone(params.id, 'deep_link');
  if (!lead) {
    return htmlResponse(404, 'Lead not found', 'That lead may have been removed.');
  }

  await logLeadAudit({
    lead,
    eventType: 'lead_marked_done',
    detail: 'Marked done via deep link',
    via: 'deep_link',
  });

  const who = escapeHtml(lead.name || lead.phone || 'Lead');
  return htmlResponse(
    200,
    'Marked done',
    `${who} is off your queue. <a href="/dashboard">Open dashboard</a>`,
  );
}
