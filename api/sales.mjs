// Sales Demo Console API — Sales Console — trial slot paint / reset / portal data.
//
//   POST /api/sales { email, password }           -> sales session cookie
//   POST /api/sales { logout: true }              -> clear cookie
//   GET  /api/sales                               -> slot + user
//   GET  /api/sales?view=portal&range=30d         -> client-view stats/leads/events
//   POST /api/sales { action: 'start_trial', ...} -> activate slot + paint Retell
//   POST /api/sales { action: 'reset_slot' }      -> idle + clear persona
//   POST /api/sales { action: 'set_e164', e164 }   -> assign trial number (idle only)
//
// Cookie: oat_sales (never oat_dash / DASHBOARD_PASSWORD)

import {
  allowSalesLogin,
  clearSalesSessionCookie,
  createSalesUser,
  findSalesUserByEmail,
  hasPendingInvite,
  lookupSalesInvite,
  makeSalesSessionCookie,
  requireSalesUser,
  salesSessionSecret,
  salesUsersEmpty,
  setSalesPasswordFromInvite,
  verifyPassword,
} from './lib/sales-auth.mjs';
import {
  TRIAL_AGENT_DEFAULTS,
  WEBSITE_DEMO_E164S,
  getSlotByKey,
  normalizeSlotInput,
  paintRetellPersona,
  publicSlot,
  refreshExpired,
  updateSlot,
} from './lib/demo-slots.mjs';
import { enrichLeadForClient, fetchLeads } from './lib/leads.mjs';
import { isHungUpCall } from './lib/alerts.mjs';

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

const RANGES = { '7d': 7, '30d': 30, '90d': 90, all: 3650 };

const MS_DAY = 24 * 60 * 60 * 1000;

/** Events for a slot in [now - offsetDays - rangeDays, now - offsetDays). */
async function fetchSlotEvents(slotId, rangeDays, { offsetDays = 0 } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const untilMs = Date.now() - offsetDays * MS_DAY;
  const sinceMs = untilMs - rangeDays * MS_DAY;
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();

  // Filter by payload->>slot_id via PostgREST. Window: [since, until).
  const qs = new URLSearchParams({
    select: '*',
    order: 'created_at.desc',
    limit: '2000',
    'payload->>slot_id': `eq.${slotId}`,
  });
  if (offsetDays > 0) {
    qs.set('and', `(created_at.gte.${since},created_at.lt.${until})`);
  } else {
    qs.set('created_at', `gte.${since}`);
  }
  const res = await fetch(`${url}/rest/v1/audit_events?${qs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

function pctDelta(current, previous) {
  if (previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function hoursFromDurations(secList) {
  const sum = secList.reduce((a, b) => a + b, 0);
  return Math.round((sum / 3600) * 10) / 10;
}

function leadsInWindow(leads, rangeDays, { offsetDays = 0 } = {}) {
  const untilMs = Date.now() - offsetDays * MS_DAY;
  const sinceMs = untilMs - rangeDays * MS_DAY;
  return (leads || []).filter((l) => {
    const t = new Date(l.last_event_at || l.created_at || 0).getTime();
    if (!t) return false;
    return t >= sinceMs && t < untilMs;
  });
}

function computePortalStats(events, rangeDays, { leads = [], prevEvents = null, prevLeads = null } = {}) {
  const calls = events.filter((e) => e.event_type === 'call_analyzed');
  const chats = events.filter((e) => e.event_type === 'sms_chat_analyzed');
  const conversations = [...calls, ...chats];
  const realDurations = calls
    .map((c) => c.duration_sec || 0)
    .filter((d) => d > 0 && !isHungUpCall(d));
  const hangups = calls.filter((c) => isHungUpCall(c.duration_sec || 0)).length;
  const count = (type) => events.filter((e) => e.event_type === type).length;
  const hoursAnswered = hoursFromDurations(realDurations);
  const windowLeads = leadsInWindow(leads, rangeDays, { offsetDays: 0 });
  const appointmentsBooked = windowLeads.filter((l) => l.status === 'booked').length;
  const leadsCaptured = windowLeads.length;

  const bucket = (field) => {
    const out = {};
    for (const c of conversations) {
      const v = (c[field] || '').toLowerCase();
      if (v) out[v] = (out[v] || 0) + 1;
    }
    return out;
  };

  const days = Math.min(rangeDays, 90);
  const series = [];
  const byDay = {};
  const chatsByDay = {};
  for (const c of calls) {
    const day = (c.created_at || '').slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  for (const c of chats) {
    const day = (c.created_at || '').slice(0, 10);
    chatsByDay[day] = (chatsByDay[day] || 0) + 1;
  }
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * MS_DAY).toISOString().slice(0, 10);
    series.push({ day, calls: byDay[day] || 0, chats: chatsByDay[day] || 0 });
  }

  let deltas = null;
  if (prevEvents) {
    const prevCalls = prevEvents.filter((e) => e.event_type === 'call_analyzed');
    const prevDurations = prevCalls
      .map((c) => c.duration_sec || 0)
      .filter((d) => d > 0 && !isHungUpCall(d));
    const prevHours = hoursFromDurations(prevDurations);
    const prevLeadRows = prevLeads != null
      ? prevLeads
      : leadsInWindow(leads, rangeDays, { offsetDays: rangeDays });
    const prevBooked = prevLeadRows.filter((l) => l.status === 'booked').length;
    deltas = {
      totalCalls: pctDelta(calls.length, prevCalls.length),
      leadsCaptured: pctDelta(leadsCaptured, prevLeadRows.length),
      appointmentsBooked: pctDelta(appointmentsBooked, prevBooked),
      hoursAnswered: pctDelta(hoursAnswered, prevHours),
    };
  }

  return {
    totalCalls: calls.length,
    totalChats: chats.length,
    avgDurationSec: realDurations.length
      ? Math.round(realDurations.reduce((a, b) => a + b, 0) / realDurations.length)
      : 0,
    hangups,
    emailsSent: count('email_sent'),
    smsSent: count('owner_sms_sent') + count('customer_sms_sent'),
    hoursAnswered,
    leadsCaptured,
    appointmentsBooked,
    sentiment: bucket('sentiment'),
    leadQuality: bucket('lead_quality'),
    series,
    deltas,
  };
}

async function ensureSlotAgentIds(slot) {
  const patch = {};
  const voiceAgent = process.env.TRIAL_VOICE_AGENT_ID || TRIAL_AGENT_DEFAULTS.voiceAgentId;
  const smsAgent = process.env.TRIAL_SMS_AGENT_ID || TRIAL_AGENT_DEFAULTS.smsAgentId;
  const voiceLlm = process.env.TRIAL_VOICE_LLM_ID || TRIAL_AGENT_DEFAULTS.voiceLlmId;
  if (!slot.retell_voice_agent_id && voiceAgent) patch.retell_voice_agent_id = voiceAgent;
  if (!slot.retell_sms_agent_id && smsAgent) patch.retell_sms_agent_id = smsAgent;
  if (!slot.retell_voice_llm_id && voiceLlm) patch.retell_voice_llm_id = voiceLlm;
  if (Object.keys(patch).length) {
    return updateSlot(slot.id, patch);
  }
  return slot;
}

export async function POST(request) {
  const secret = salesSessionSecret();
  if (!secret) return json(500, { error: 'Sales console not configured (SALES_SESSION_SECRET)' });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid request' });
  }

  if (body.logout) {
    return json(200, { ok: true }, { 'Set-Cookie': clearSalesSessionCookie() });
  }

  // Public invite: look up email for set-password page (rate-limited).
  if (body.inviteLookup && body.token) {
    if (!(await allowSalesLogin(request))) {
      return json(429, { error: 'Too many attempts — try again in 15 minutes.' });
    }
    const looked = await lookupSalesInvite(String(body.token));
    if (looked.error) return json(400, { error: looked.error });
    return json(200, { ok: true, email: looked.user.email, displayName: looked.user.display_name });
  }

  // Public invite: set password from one-time link (rate-limited).
  if (body.setPassword && body.token) {
    if (!(await allowSalesLogin(request))) {
      return json(429, { error: 'Too many attempts — try again in 15 minutes.' });
    }
    const result = await setSalesPasswordFromInvite({
      token: String(body.token),
      password: body.password,
    });
    if (result.error) return json(400, { error: result.error });
    return json(200, { ok: true });
  }

  // Login
  if (body.email && body.password && !body.action) {
    if (!(await allowSalesLogin(request))) {
      return json(429, { error: 'Too many attempts — try again in 15 minutes.' });
    }
    let user = await findSalesUserByEmail(body.email);

    // One-time bootstrap: only when sales_users is empty and env credentials match.
    // Remove SALES_BOOTSTRAP_* from Vercel after the first user exists.
    if (!user && (await salesUsersEmpty())) {
      const bootEmail = (process.env.SALES_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
      const bootPass = process.env.SALES_BOOTSTRAP_PASSWORD || '';
      const want = String(body.email).trim().toLowerCase();
      if (bootEmail && bootPass && want === bootEmail && body.password === bootPass) {
        try {
          user = await createSalesUser({
            email: bootEmail,
            password: bootPass,
            displayName: process.env.SALES_BOOTSTRAP_NAME || 'Sales',
          });
        } catch (err) {
          console.error('sales bootstrap failed:', err.message);
        }
      }
    }

    if (user && hasPendingInvite(user)) {
      return json(401, { error: 'Check your email for the set-password link before signing in.' });
    }

    if (!user || !user.active || !verifyPassword(body.password, user.password_salt, user.password_hash)) {
      return json(401, { error: 'Wrong email or password' });
    }

    return json(
      200,
      { ok: true, user: { id: user.id, email: user.email, displayName: user.display_name } },
      { 'Set-Cookie': makeSalesSessionCookie(secret, user.id) },
    );
  }

  const user = await requireSalesUser(request);
  if (!user) return json(401, { error: 'Not signed in' });

  const action = body.action;

  if (action === 'set_e164') {
    let slot = await getSlotByKey(1);
    if (!slot) return json(404, { error: 'Demo slot not found' });
    slot = await refreshExpired(slot);
    if (slot.status === 'active') {
      return json(409, { error: 'Cannot change number while a trial is active. Reset first.' });
    }
    const input = normalizeSlotInput(body);
    if (!input.e164) return json(400, { error: 'Valid E.164 phone number required' });
    if (WEBSITE_DEMO_E164S.has(input.e164)) {
      return json(400, {
        error: 'Cannot use the website demo or testing line as the trial number.',
      });
    }
    slot = await updateSlot(slot.id, { e164: input.e164 });
    return json(200, { ok: true, slot: publicSlot(slot) });
  }

  if (action === 'start_trial') {
    let slot = await getSlotByKey(1);
    if (!slot) return json(404, { error: 'Demo slot not found' });
    slot = await refreshExpired(slot);
    if (slot.status === 'active') {
      return json(409, {
        error: 'Demo license already in use. Reset the slot after the trial ends, or wait for expiry.',
        slot: publicSlot(slot),
      });
    }

    const input = normalizeSlotInput(body);
    if (!input.companyName) return json(400, { error: 'Company name is required' });
    if (!input.ownerPhone && !input.ownerEmail) {
      return json(400, { error: 'Owner mobile or email is required for alerts' });
    }

    const e164 = input.e164 || slot.e164 || normalizeSlotInput({ e164: process.env.TRIAL_SLOT_E164 }).e164;
    if (!e164) {
      return json(400, {
        error:
          'Assign a trial phone number first (set_e164 or TRIAL_SLOT_E164). Do not use the website demo line.',
      });
    }
    if (WEBSITE_DEMO_E164S.has(e164)) {
      return json(400, {
        error: 'Cannot use the website demo or testing line as the trial number.',
      });
    }

    const now = new Date();
    const ends = new Date(now.getTime() + input.trialDays * 24 * 60 * 60 * 1000);
    slot = await updateSlot(slot.id, {
      status: 'active',
      e164,
      company_name: input.companyName,
      greeting: input.greeting || null,
      voice: input.voice,
      language: input.language,
      website: input.website,
      owner_name: input.ownerName,
      owner_phone: input.ownerPhone,
      owner_email: input.ownerEmail,
      trial_days: input.trialDays,
      trial_started_at: now.toISOString(),
      trial_ends_at: ends.toISOString(),
    });

    slot = await ensureSlotAgentIds(slot);

    try {
      await paintRetellPersona(slot, { idle: false });
    } catch (err) {
      console.error('paintRetellPersona failed:', err.message);
      // Keep slot active — number may still work with last prompt; surface warning.
      return json(200, {
        ok: true,
        warning: `Trial saved but Retell paint failed: ${err.message}`,
        slot: publicSlot(slot),
      });
    }

    return json(200, { ok: true, slot: publicSlot(slot) });
  }

  if (action === 'reset_slot') {
    let slot = await getSlotByKey(1);
    if (!slot) return json(404, { error: 'Demo slot not found' });

    slot = await updateSlot(slot.id, {
      status: 'idle',
      company_name: null,
      greeting: null,
      voice: null,
      language: 'en',
      website: null,
      owner_name: null,
      owner_phone: null,
      owner_email: null,
      trial_started_at: null,
      trial_ends_at: null,
    });

    try {
      await paintRetellPersona(slot, { idle: true });
    } catch (err) {
      console.error('idle paint failed:', err.message);
      return json(200, {
        ok: true,
        warning: `Slot reset but Retell idle paint failed: ${err.message}`,
        slot: publicSlot(slot),
      });
    }

    return json(200, { ok: true, slot: publicSlot(slot) });
  }

  return json(400, { error: 'Unknown action' });
}

export async function GET(request) {
  const user = await requireSalesUser(request);
  if (!user) return json(401, { error: 'Not signed in' });

  const url = new URL(request.url);
  const view = url.searchParams.get('view') || 'console';

  let slot = await getSlotByKey(1);
  if (!slot) return json(404, { error: 'Demo slot not found' });
  slot = await refreshExpired(slot);
  slot = await ensureSlotAgentIds(slot);

  if (view === 'portal') {
    const range = url.searchParams.get('range') || '30d';
    const rangeDays = RANGES[range] || 30;
    // Skip previous-window fetch for "all" — no meaningful baseline.
    const wantPrev = range !== 'all' && rangeDays < 3650;
    try {
      const [events, rawLeads, prevEvents] = await Promise.all([
        fetchSlotEvents(slot.id, rangeDays),
        fetchLeads({ includeDone: true, slotId: slot.id }),
        wantPrev
          ? fetchSlotEvents(slot.id, rangeDays, { offsetDays: rangeDays })
          : Promise.resolve(null),
      ]);
      const leads = rawLeads.map(enrichLeadForClient);
      const prevLeads = wantPrev
        ? leadsInWindow(rawLeads, rangeDays, { offsetDays: rangeDays })
        : null;
      return json(200, {
        mode: 'portal',
        readOnly: true,
        slot: publicSlot(slot),
        user: { id: user.id, email: user.email, displayName: user.display_name },
        stats: computePortalStats(events, rangeDays, {
          leads: rawLeads,
          prevEvents,
          prevLeads,
        }),
        events,
        leads,
      });
    } catch (err) {
      console.error('sales portal fetch failed:', err.message);
      return json(500, { error: 'Failed to load portal data' });
    }
  }

  return json(200, {
    user: { id: user.id, email: user.email, displayName: user.display_name },
    slot: publicSlot(slot),
  });
}
