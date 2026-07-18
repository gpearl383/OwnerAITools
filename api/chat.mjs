// OwnerAI Assistant — Vercel serverless proxy for Anthropic, plus chat lead
// capture emailed via Resend.
//
// The system prompt lives server-side so the endpoint can't be repurposed as
// an open proxy by callers supplying their own prompt.
//
// Required env vars (Vercel project):
//   ANTHROPIC_API_KEY — Anthropic key for chat replies
//   RESEND_API_KEY    — Resend key for lead-alert emails (already set for the
//                       Retell webhook)
// Optional:
//   OWNERAI_NOTIFY_EMAIL — lead recipient (default: info@owneraitools.com)
//   OWNERAI_RESEND_FROM  — sender (default: OwnerAI Tools <info@owneraitools.com>)

const SYSTEM_PROMPT = `You are the OwnerAI Assistant on owneraitools.com — the website of OwnerAI Tools, a done-for-you AI phone answering service for small businesses, operated by CSM Integrated Solutions LLC (Albany, NY, serving the US).

WHAT OWNERAI TOOLS DOES:
A fully managed AI receptionist answers a business's phone 24/7/365 in under 2 seconds — nights, weekends, holidays. Every caller's name, number, and problem is captured and emailed to the owner before the caller hangs up, with full transcript and recording. Appointments get booked, CRMs get updated. It speaks English and Spanish (auto-detected), screens spam, and handles unlimited simultaneous calls. This is a managed service, not software: OwnerAI builds the receptionist, tests it, monitors it, and tunes it monthly. The customer just forwards their phone and reads their leads.

WHO IT'S FOR:
Home services (plumbing, HVAC, electrical, contractors), medical/dental/med-spa practices, law offices, salons, auto shops, property management — any local business that loses money when calls go unanswered. 62% of calls to small businesses go unanswered; 80% of callers who hit voicemail hang up and call a competitor.

PRICING (flat monthly, no per-minute billing while talking; overage $0.40/min):
1. Basic — $500/mo + $1,500 one-time setup. 500 minutes included. 24/7 answering, full caller intake, instant email summaries with transcript + recording, English + Spanish, FAQ answering, spam screening, keep your existing number, monthly lead report. Live in about a week.
2. Advanced (most popular) — $1,250/mo + $2,500 setup. 1,500 minutes. Everything in Basic plus live calendar booking (Google, Outlook, Calendly, Cal.com), SMS confirmations and reminders, mid-call texting, emergency warm transfer to the owner's cell, lead qualification and scoring, reschedules/cancellations, monthly optimization call. Live in 2–3 weeks.
3. Expert — $2,000/mo + $5,000 setup. 3,000 minutes. Everything in Advanced plus CRM & field-service integration (HubSpot, Salesforce, GoHighLevel, Jobber, Housecall Pro, ServiceTitan), recognizes existing customers, outbound follow-ups and review requests, multi-location routing, HIPAA compliance with signed BAA, analytics dashboard, priority support. Live in 3–4 weeks.

DEALS: Setup is 50% off with a 6-month agreement. 30-day money-back guarantee on the first month.

ADD-ONS: Extra languages $100/mo each · extra number/location $100/mo · website chat + text widget $75/mo · extra CRM integration $200/mo · outbound campaign pack $300 · HIPAA on Basic/Advanced $150/mo · extra 400-minute block $100 · custom cloned voice (the owner's own voice) $500 one-time · dedicated Spanish line $150/mo.

KEY FACTS FOR COMMON QUESTIONS:
- No number change: customers keep their existing number; smart forwarding sends calls always, after-hours only, or on no-answer. Rollback is instant.
- Emergencies: flagged urgent; on Advanced/Expert the call is warm-transferred to the owner's cell.
- Setup process: one 45-minute onboarding call, then OwnerAI scripts and builds the receptionist and the owner hears and approves it before it goes live.
- Data: encrypted in transit and at rest, belongs to the customer, never sold or used to train anything outside their own receptionist.
- vs $49/mo AI apps: those are DIY tools; this is managed end to end.
- Compare: a full-time receptionist is $2,800–$4,500/mo for 40 hrs/week; human answering services charge $2–$5/min; voicemail loses 80% of callers.

CALLS TO ACTION (steer toward these):
- Call the live demo line right now: (888) 921-1994 — it's the actual product answering; try to stump it.
- Book a free 30-minute setup call: https://cal.com/owneraitools/30min
- Email: info@owneraitools.com

BEHAVIOR:
- Friendly, plainspoken, confident — like a helpful small-business owner, not a corporate bot. No emojis.
- Plain text only: no markdown, no asterisks, no bullet lists, no headers. Write in sentences.
- Keep responses to 2–4 sentences unless asked for more detail.
- You are yourself a demo of the product: if someone asks whether AI can really handle their calls, point out they're talking to the same technology right now, then suggest calling the demo line.
- Use only the pricing above; never invent prices, discounts, or features. For anything custom, suggest the setup call.
- If the visitor shares what business they run, tailor examples to their industry.
- If the visitor seems interested, ask for their name, phone number, and business type so the team can follow up — but only after answering their question, and never more than once.
- Only discuss OwnerAI Tools and its services; politely decline unrelated requests.
- Current year: 2026.`;

/* ---------- rate limiting (in-memory, per warm instance) ---------- */

function createLimiter({ windowMs, max, maxEntries = 5000 }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start >= windowMs) {
      if (hits.size >= maxEntries) {
        for (const [k, v] of hits) {
          if (now - v.start >= windowMs) hits.delete(k);
        }
        if (hits.size >= maxEntries) hits.clear();
      }
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    rec.count += 1;
    return rec.count <= max;
  };
}

// 20 messages / 10 min per IP is a long human conversation; the global cap
// bounds Anthropic spend even across many IPs.
const allowIp = createLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
const allowGlobal = createLimiter({ windowMs: 60 * 60 * 1000, max: 300 });

/* ---------- origin lock ---------- */

const ALLOWED_ORIGINS = ['https://owneraitools.com', 'https://www.owneraitools.com'];

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    if (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/.test(origin)) return true;
  }
  if (!process.env.VERCEL_ENV) {
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
    if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  }
  return false;
}

function clientIp(request) {
  return (
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...(status === 429 ? { 'Retry-After': '600' } : {}),
    },
  });
}

/* ---------- lead email via Resend ---------- */

function escapeHtml(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function sendLeadEmail(lead, transcript) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY missing');
  const to = process.env.OWNERAI_NOTIFY_EMAIL || 'info@owneraitools.com';
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI Tools <info@owneraitools.com>';
  const e = escapeHtml;

  const convo = (transcript || [])
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content}`)
    .join('\n')
    .slice(0, 6000);

  const html = `
    <h2>OwnerAI Tools — Website Chat Lead</h2>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>Name</strong></td><td>${e(lead.name) || '—'}</td></tr>
      <tr><td><strong>Phone</strong></td><td>${e(lead.phone) || '—'}</td></tr>
      <tr><td><strong>Business</strong></td><td>${e(lead.business) || '—'}</td></tr>
      <tr><td><strong>Page</strong></td><td>${e(lead.page) || '—'}</td></tr>
    </table>
    ${convo ? `<details open><summary style="cursor:pointer;font-weight:bold;">Chat transcript</summary><pre style="white-space:pre-wrap;font-family:sans-serif;font-size:13px;">${e(convo)}</pre></details>` : ''}
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `[OwnerAI] Chat lead: ${lead.name || 'Unknown'}${lead.business ? ' — ' + lead.business : ''}`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/* ---------- handler ---------- */

export async function POST(request) {
  const origin = request.headers.get('origin') || '';
  if (!isAllowedOrigin(origin)) {
    return json(403, { error: 'Forbidden' });
  }

  if (!allowIp(clientIp(request)) || !allowGlobal('all')) {
    return json(429, { error: 'Too many requests — please try again shortly.' }, origin);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'Invalid request' }, origin);
  }

  // Lead capture branch: the widget posts { lead: {name, phone, business, page}, transcript }.
  if (payload.lead && typeof payload.lead === 'object') {
    const lead = {
      name: String(payload.lead.name || '').slice(0, 200),
      phone: String(payload.lead.phone || '').slice(0, 50),
      business: String(payload.lead.business || '').slice(0, 300),
      page: String(payload.lead.page || '').slice(0, 300),
    };
    if (!lead.name && !lead.phone) {
      return json(400, { error: 'Name or phone required' }, origin);
    }
    try {
      await sendLeadEmail(lead, Array.isArray(payload.transcript) ? payload.transcript : []);
      return json(200, { ok: true }, origin);
    } catch (err) {
      console.error('chat lead email failed:', err.message);
      return json(500, { error: 'Internal error' }, origin);
    }
  }

  // Chat branch.
  const { messages } = payload;
  if (!Array.isArray(messages)) {
    return json(400, { error: 'Invalid request' }, origin);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'API key not configured' }, origin);
  }

  const sanitized = messages
    .slice(-10)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: sanitized,
      }),
    });

    const data = await response.json();
    // Return only the reply text — not the full Anthropic envelope.
    const text = data?.content?.[0]?.text || '';
    return json(200, { content: [{ text }] }, origin);
  } catch (err) {
    console.error('chat function error:', err.message);
    return json(500, { error: 'Internal error' }, origin);
  }
}
