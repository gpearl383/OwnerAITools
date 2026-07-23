// One-time backfill: last 30 days of conversation events → leads table.
//
// Usage (with Supabase env in shell):
//   node scripts/backfill-leads.mjs

import { upsertLead } from '../api/lib/leads.mjs';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const types = ['call_analyzed', 'sms_chat_analyzed', 'chat_lead', 'setup_call_booked'];
const qs = new URLSearchParams({
  select: '*',
  order: 'created_at.asc',
  limit: '2000',
  created_at: `gte.${since}`,
});
// PostgREST in= filter
const typeFilter = types.map((t) => `"${t}"`).join(',');
const res = await fetch(
  `${url}/rest/v1/audit_events?${qs}&event_type=in.(${typeFilter})`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
);
if (!res.ok) {
  console.error('fetch failed', res.status, await res.text());
  process.exit(1);
}
const events = await res.json();
let ok = 0;
let skip = 0;

for (const e of events) {
  const payload = e.payload || {};
  const channel =
    e.event_type === 'sms_chat_analyzed'
      ? 'sms'
      : e.event_type === 'chat_lead'
        ? 'chat'
        : 'call';
  const bookedLabel =
    e.event_type === 'setup_call_booked'
      ? (e.detail || '').split(' — ')[0] || e.detail
      : payload.setup_call_booked_time || null;

  const lead = await upsertLead({
    phone: payload.callback_phone || e.from_number,
    email: null,
    name: e.caller_name,
    business: payload.business,
    business_type: payload.business_type,
    channel,
    callId: e.call_id,
    summary: payload.summary,
    reason: e.detail || payload.page,
    durationSec: e.duration_sec,
    wantsSetup: !!e.wants_setup_call || e.event_type === 'setup_call_booked',
    leadQuality: e.lead_quality,
    sentiment: e.sentiment,
    bookedLabel,
    bookedAt: e.event_type === 'setup_call_booked' ? e.created_at : null,
  });
  if (lead) ok += 1;
  else skip += 1;
}

console.log(`Backfill done: ${ok} upserted, ${skip} skipped (no phone/email), ${events.length} events`);
