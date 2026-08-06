import { upsertLead, leadActionUrl, normalizePhone } from './lib/leads.mjs';
import { notifyOwner } from './lib/notify.mjs';
import { allowRate, hashIp } from './lib/rate-limit.mjs';

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
//   OWNERAI_RESEND_FROM  — sender (default: OwnerAI <info@owneraitools.com>)

const SYSTEM_PROMPT = `You are the OwnerAI Assistant on owneraitools.com — the website of OwnerAI, a done-for-you AI phone answering service for small businesses, operated by CSM Integrated Solutions LLC (Albany, NY, serving the US).

WHAT OWNERAI TOOLS DOES:
A fully managed AI receptionist answers a business's phone 24/7/365 in under 2 seconds — nights, weekends, holidays. Every caller's name, number, and problem is captured and emailed to the owner before the caller hangs up, with full transcript and recording. Appointments get booked, CRMs get updated. It speaks English and Spanish (auto-detected), screens spam, and handles unlimited simultaneous calls. This is a managed service, not software: OwnerAI builds the receptionist, tests it, monitors it, and tunes it monthly. The customer just forwards their phone and reads their leads.

WHO IT'S FOR:
Phone-first local businesses — owner-operated and small teams that book jobs, appointments, or consults by phone. Four lanes: field & home services (plumbing, HVAC, electrical, contractors, restoration), appointment practices (med spa, PT, dental, small medical), professional services (law, accounting, insurance, real estate teams), and shop/bay services (auto repair, salons, pet grooming). Home services is the best-proven proof lane; the product fits any of these when missed calls mean missed revenue. 62% of calls to small businesses go unanswered; 80% of callers who hit voicemail hang up and call a competitor.

OFFERING (two packages on the site; no published dollar amounts or minute allotments):
- Custom quote on the free setup call (https://cal.com/owneraitools/30min). Never invent dollar amounts, setup fees, discounts, minute allotments, overage rates, or add-on prices. If they ask about cost or minutes/usage, say that is sized on the free setup call — then offer to book. Under no circumstances state how many minutes are in any package.
- You may share: 30-day money-back guarantee on the first month.
- Advanced (most popular / standard close): 24/7 answering, full caller intake, instant email summaries with transcript + recording, English + Spanish, FAQ answering, spam screening, keep existing number, monthly lead report, live calendar booking (Google, Outlook, Calendly, Cal.com), SMS confirmations and reminders, mid-call texting, emergency warm transfer to the owner's cell, lead qualification and scoring, reschedules/cancellations, monthly optimization call. Live in about 1–3 weeks.
- Expert (custom): everything in Advanced plus CRM & calendar integration (HubSpot, Salesforce, GoHighLevel, Jobber, Housecall Pro, ServiceTitan, practice calendars), caller/number recognition for returning customers, outbound follow-ups and review requests, multi-location routing, HIPAA compliance with signed BAA, analytics dashboard, priority support. Scoped and priced on the setup call. Live in about 3–4 weeks.
- Add-ons (available; quote on setup call — never invent prices): extra languages, extra number/location, website chat + text widget, extra CRM integration, outbound campaign pack, HIPAA on Advanced, custom cloned voice, dedicated Spanish line.
- There is no Basic package — do not offer or invent one.

KEY FACTS FOR COMMON QUESTIONS:
- No number change: customers keep their existing number; smart forwarding sends calls always, after-hours only, or on no-answer. Rollback is instant.
- Emergencies: flagged urgent; on Advanced and Expert the call is warm-transferred to the owner's cell.
- Setup process: one 45-minute onboarding call, then OwnerAI scripts and builds the receptionist and the owner hears and approves it before it goes live.
- Data: encrypted in transit and at rest, belongs to the customer, never sold or used to train anything outside their own receptionist. HIPAA-ready with signed BAA on Expert (and as an add-on for Advanced).
- vs cheap DIY AI phone apps: those are DIY tools; this is managed end to end.
- Compare: a full-time receptionist is $2,800–$4,500/mo for 40 hrs/week; human answering services charge $2–$5/min; voicemail loses 80% of callers. (Competitor/substitute costs are fine to cite — never invent OwnerAI prices.)

CALLS TO ACTION (steer toward these):
- Call the live demo line right now: (516) 973-1973 — it's live; call it and see for yourself.
- Book a free 30-minute setup call: https://cal.com/owneraitools/30min
- Email: info@owneraitools.com

PARENT COMPANY / OTHER TECH:
- OwnerAI is a product of CSM Integrated Solutions. CSM handles other technology needs (IT support, managed services, AI consulting, enterprise AI). Website: csmintegrated.com.
- If the visitor names a product or industry (AV systems, HVAC, dental equipment, etc.), do NOT assume they want that product and do NOT jump to a CSM referral. Ask one clarifying question first: are they looking to buy that product themselves, or do they run that kind of business and want an AI receptionist for it? If they want the receptionist, stay on OwnerAI (demo line, setup call).
- Only refer to CSM after a clear answer that they need something other than the AI receptionist. Refer briefly to csmintegrated.com; never invent CSM pricing or services.

BEHAVIOR:
- Friendly, plainspoken, confident — like a helpful small-business owner, not a corporate bot. No emojis.
- Plain text only: no markdown, no asterisks, no bullet lists, no headers. Write in sentences.
- Keep responses to 2–4 sentences unless asked for more detail.
- You are yourself a demo of the product: if someone asks whether AI can really handle their calls, point out they're talking to the same technology right now, then suggest calling the demo line.
- You may name Advanced and Expert and describe their features only — never minute allotments. Never invent OwnerAI dollar amounts. For cost or minutes/usage, suggest the free setup call. There is no Basic package.
- Never invent names of people (owners, founders, staff) at OwnerAI or CSM Integrated Solutions. If asked who owns or works there, say you don't have personnel details and offer info@owneraitools.com or the setup call.
- Never claim information comes from company records, files, or a database beyond this prompt.
- If the visitor shares what business they run, tailor examples to their industry.
- If the visitor seems interested, ask for their name, phone number, and business type so the team can follow up — but only after answering their question, and never more than once.
- Only discuss OwnerAI and its services; politely decline unrelated requests (except the CSM referral path above).
- Current year: 2026.`;

/* ---------- rate limiting (Supabase-backed + memory fallback) ---------- */

const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX = 20;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_MAX = 300;

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

async function sendLeadEmail(lead, transcript, queueLead) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY missing');
  const to = process.env.OWNERAI_NOTIFY_EMAIL || 'info@owneraitools.com';
  const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI <info@owneraitools.com>';
  const e = escapeHtml;

  const convo = (transcript || [])
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content}`)
    .join('\n')
    .slice(0, 6000);

  const actions = [];
  const phone = normalizePhone(lead.phone);
  if (phone) actions.push(`<a href="tel:${e(phone)}">Call back</a>`);
  const doneUrl = queueLead?.id ? leadActionUrl(queueLead.id, 'done') : null;
  if (doneUrl) actions.push(`<a href="${e(doneUrl)}">Mark done</a>`);

  const isForm = lead.source === 'callback_form';
  const title = isForm ? 'Website Callback Form Lead' : 'Website Chat Lead';
  const label = isForm ? 'Callback form lead' : 'Chat lead';
  const smsLine =
    lead.sms_consent === true
      ? 'YES — agreed to receive texts'
      : lead.sms_consent === false
        ? 'No'
        : '—';

  const html = `
    <h2>OwnerAI — ${e(title)}</h2>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>Name</strong></td><td>${e(lead.name) || '—'}</td></tr>
      <tr><td><strong>Phone</strong></td><td>${e(lead.phone) || '—'}</td></tr>
      <tr><td><strong>Business</strong></td><td>${e(lead.business) || '—'}</td></tr>
      <tr><td><strong>Source</strong></td><td>${e(lead.source || 'chat')}</td></tr>
      <tr><td><strong>SMS consent</strong></td><td>${e(smsLine)}</td></tr>
      <tr><td><strong>Page</strong></td><td>${e(lead.page) || '—'}</td></tr>
    </table>
    ${actions.length ? `<p><strong>Actions</strong> — ${actions.join(' &nbsp;·&nbsp; ')}</p>` : ''}
    ${convo ? `<details open><summary style="cursor:pointer;font-weight:bold;">Chat transcript</summary><pre style="white-space:pre-wrap;font-family:sans-serif;font-size:13px;">${e(convo)}</pre></details>` : ''}
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `[OwnerAI] ${label}: ${lead.name || 'Unknown'}${lead.business ? ' — ' + lead.business : ''}`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/* ---------- audit trail ---------- */

// Best-effort insert into the Supabase audit log; never affects the response.
async function logChatLead(lead) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([
        {
          event_type: lead.source === 'callback_form' ? 'web_form_lead' : 'chat_lead',
          status: 'ok',
          caller_name: lead.name || null,
          from_number: lead.phone || null,
          detail: lead.business || null,
          payload: {
            page: lead.page,
            source: lead.source || 'chat',
            sms_consent: lead.sms_consent,
          },
        },
      ]),
    });
    if (!res.ok) console.error('chat lead audit insert failed:', res.status);
  } catch (err) {
    console.error('chat lead audit failed:', err.message);
  }
}

/* ---------- handler ---------- */

export async function POST(request) {
  const origin = request.headers.get('origin') || '';
  if (!isAllowedOrigin(origin)) {
    return json(403, { error: 'Forbidden' });
  }

  const ipKey = hashIp(clientIp(request));
  const ipOk = await allowRate(`chat:ip:${ipKey}`, { windowMs: IP_WINDOW_MS, max: IP_MAX });
  const globalOk = await allowRate('chat:global', { windowMs: GLOBAL_WINDOW_MS, max: GLOBAL_MAX });
  if (!ipOk || !globalOk) {
    return json(429, { error: 'Too many requests — please try again shortly.' }, origin);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'Invalid request' }, origin);
  }

  // Lead capture branch: chat widget or homepage callback form posts { lead, transcript? }.
  if (payload.lead && typeof payload.lead === 'object') {
    const sourceRaw = String(payload.lead.source || 'chat').slice(0, 40);
    const isForm = sourceRaw === 'callback_form';
    const lead = {
      name: String(payload.lead.name || '').slice(0, 200),
      phone: String(payload.lead.phone || '').slice(0, 50),
      business: String(payload.lead.business || '').slice(0, 300),
      page: String(payload.lead.page || '').slice(0, 300),
      source: isForm ? 'callback_form' : 'chat',
      sms_consent:
        typeof payload.lead.sms_consent === 'boolean' ? payload.lead.sms_consent : null,
    };
    if (!lead.name && !lead.phone) {
      return json(400, { error: 'Name or phone required' }, origin);
    }
    try {
      const channel = isForm ? 'web_form' : 'chat';
      const label = isForm ? 'Callback form lead' : 'Chat lead';
      const consentNote =
        lead.sms_consent === true
          ? 'SMS consent: yes'
          : lead.sms_consent === false
            ? 'SMS consent: no'
            : null;
      const queueLead = await upsertLead({
        phone: lead.phone,
        name: lead.name,
        business: lead.business,
        channel,
        reason: lead.business || label,
        summary: [label, `from ${lead.page || 'site'}`, consentNote].filter(Boolean).join(' — '),
        wantsSetup: false,
        leadQuality: 'warm',
      });
      await sendLeadEmail(
        lead,
        Array.isArray(payload.transcript) ? payload.transcript : [],
        queueLead,
      );
      await logChatLead(lead);
      return json(200, { ok: true }, origin);
    } catch (err) {
      console.error('chat lead email failed:', err.message);
      await notifyOwner({
        key: `inline:chat_lead_failed:${lead.phone || lead.name || 'unknown'}`,
        subject: `chat_lead_failed — ${lead.name || lead.phone || 'unknown'}`,
        sms: `chat lead email failed for ${lead.name || lead.phone || 'visitor'}: ${err.message.slice(0, 160)}`,
        detail: err.message,
      });
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
