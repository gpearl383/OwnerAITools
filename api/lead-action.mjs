// Signed one-click lead actions (no dashboard login).
//
//   GET /api/lead-action?id=<uuid>&a=done&exp=<unix>&t=<hmac>
//
// Token: HMAC-SHA256(`${id}|${action}|${exp}`, CALL_LINK_SECRET) — 7 day TTL.

import {
  verifyLeadActionToken,
  markLeadDone,
  logLeadAudit,
} from './lib/leads.mjs';

function htmlResponse(status, title, body) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f2f7fc;color:#24384f;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  .card{background:#fff;border:1px solid rgba(20,53,94,.12);border-radius:16px;padding:28px 24px;max-width:420px;text-align:center}
  h1{font-size:22px;margin:0 0 8px;color:#14355e}
  p{margin:0;color:#5a6b81;line-height:1.45}
  a{color:#2680cf}
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
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

export async function GET(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const action = url.searchParams.get('a') || '';
  const exp = url.searchParams.get('exp') || '';
  const token = url.searchParams.get('t') || '';

  if (action !== 'done') {
    return htmlResponse(400, 'Unknown action', 'This link is not valid.');
  }
  if (!verifyLeadActionToken(id, action, exp, token)) {
    return htmlResponse(
      403,
      'Link expired or invalid',
      'Open the dashboard to mark this lead done, or use a fresher email/SMS link.',
    );
  }

  const lead = await markLeadDone(id, 'deep_link');
  if (!lead) {
    return htmlResponse(404, 'Lead not found', 'That lead may have been removed.');
  }

  await logLeadAudit({
    lead,
    eventType: 'lead_marked_done',
    detail: `Marked done via deep link`,
    via: 'deep_link',
  });

  const who = lead.name || lead.phone || 'Lead';
  return htmlResponse(
    200,
    'Marked done',
    `${who} is off your queue. <a href="/dashboard">Open dashboard</a>`,
  );
}
