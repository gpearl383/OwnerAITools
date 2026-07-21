// Live Cal.com booking for the OwnerAI Tools demo line.
//
// The demo voice agent calls this endpoint through two Retell custom tools:
//   check_availability — reads real open slots from Cal.com
//   book_setup_call    — books the 15-minute setup call on the owner's calendar
// Both arrive as POSTs here; the Retell tool-call body's `name` field tells
// them apart. Cal.com emails the attendee its own calendar invite on booking.
//
// Required env vars:
//   RETELL_WEBHOOK_KEY / RETELL_API_KEY — verify the X-Retell-Signature header
//   CAL_API_KEY                          — Cal.com API key (cal_...)
//   CAL_EVENT_TYPE_ID                    — numeric ID of the 30min setup event
// Optional:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — audit trail logging

import crypto from 'node:crypto';

const TZ = 'America/New_York';

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

function normalizePhone(v) {
  const digits = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

// "Wednesday, July 22 at 10:00 AM Eastern"
function speakableTime(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function dateOnly(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
}

/* ---------- Cal.com API ---------- */

async function calFetch(path, { method = 'GET', body, version } = {}) {
  const res = await fetch(`https://api.cal.com/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'cal-api-version': version,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cal.com ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// Returns up to 3 upcoming slots across the next 7 days, spread over
// different days where possible so the agent can offer variety.
async function getUpcomingSlots() {
  const now = new Date();
  const start = dateOnly(now);
  const end = dateOnly(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  const out = await calFetch(
    `/slots?eventTypeId=${process.env.CAL_EVENT_TYPE_ID}&start=${start}&end=${end}&timeZone=${encodeURIComponent(TZ)}`,
    { version: '2024-09-04' },
  );
  const byDay = out.data || {};
  const picks = [];
  for (const day of Object.keys(byDay).sort()) {
    const future = (byDay[day] || [])
      .map((s) => (typeof s === 'string' ? s : s.start))
      .filter((iso) => new Date(iso).getTime() > now.getTime() + 30 * 60 * 1000);
    if (!future.length) continue;
    picks.push(future[0]);
    // On the first available day offer a second time (morning + afternoon feel)
    if (picks.length === 1 && future.length > 1) {
      picks.push(future[Math.min(future.length - 1, Math.ceil(future.length / 2))]);
    }
    if (picks.length >= 3) break;
  }
  return picks.slice(0, 3);
}

async function createBooking({ slotStart, name, email, phone, businessName }) {
  return calFetch('/bookings', {
    method: 'POST',
    version: '2024-08-13',
    body: {
      eventTypeId: Number(process.env.CAL_EVENT_TYPE_ID),
      start: new Date(slotStart).toISOString(),
      attendee: {
        name,
        email,
        timeZone: TZ,
        ...(phone ? { phoneNumber: phone } : {}),
      },
      metadata: {
        source: 'ownerai-demo-line',
        ...(businessName ? { business: String(businessName).slice(0, 100) } : {}),
      },
    },
  });
}

/* ---------- rate limiting (per warm instance) ---------- */

const hits = { start: 0, count: 0 };
function allowBooking() {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  if (now - hits.start >= HOUR) {
    hits.start = now;
    hits.count = 0;
  }
  if (hits.count >= 10) return false;
  hits.count += 1;
  return true;
}

/* ---------- audit ---------- */

async function logAudit(row) {
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
      body: JSON.stringify([row]),
    });
    if (!res.ok) console.error('book-setup-call audit insert failed:', res.status);
  } catch (err) {
    console.error('book-setup-call audit failed:', err.message);
  }
}

// The tool response is read back to the LLM — short and speakable.
function toolResult(text) {
  return new Response(JSON.stringify({ result: text }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ---------- handlers ---------- */

async function handleCheckAvailability() {
  const slots = await getUpcomingSlots();
  if (!slots.length) {
    return toolResult(
      'No open slots in the next week. Tell the caller the team will reach out within one business day to schedule, and capture their info.',
    );
  }
  const lines = slots.map((iso) => `${speakableTime(iso)} [slot_start: ${iso}]`);
  return toolResult(
    `Open slots (Eastern time): ${lines.join('; ')}. Offer these naturally. When the caller picks one, pass its exact slot_start value to book_setup_call.`,
  );
}

async function handleBook(args, call) {
  const name = String(args.name || '').trim();
  const email = String(args.email || '').trim();
  const slotStart = String(args.slot_start || '').trim();
  const phone = normalizePhone(args.phone || call.from_number);

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || Number.isNaN(new Date(slotStart).getTime())) {
    return toolResult(
      'Missing or invalid details. Confirm the caller\'s full name, a valid email address for the calendar invite, and which time slot they picked, then try again.',
    );
  }
  if (!allowBooking()) {
    return toolResult('The calendar is unavailable right now. Tell the caller the team will reach out within one business day to schedule.');
  }

  const base = {
    call_id: call.call_id || null,
    caller_name: name,
    from_number: call.from_number || null,
  };
  try {
    const booking = await createBooking({
      slotStart,
      name,
      email,
      phone,
      businessName: args.business_name,
    });
    const when = speakableTime(slotStart);
    await logAudit({
      ...base,
      event_type: 'setup_call_booked',
      status: 'ok',
      detail: `${when} — ${email}`,
      payload: {
        booking_uid: booking?.data?.uid || null,
        slot_start: slotStart,
        business_name: args.business_name || null,
      },
    });
    return toolResult(
      `Booked for ${when} Eastern. A calendar invite is on its way to ${email}. Confirm the time back to the caller.`,
    );
  } catch (err) {
    console.error('book-setup-call booking failed:', err.message);
    await logAudit({
      ...base,
      event_type: 'booking_failed',
      status: 'failed',
      detail: err.message.slice(0, 400),
    });
    if (/no_available_users|already|conflict|unavailable/i.test(err.message)) {
      return toolResult('That slot was just taken. Call check_availability again and offer the caller a fresh set of times.');
    }
    return toolResult('The calendar could not be reached. Tell the caller the team will reach out within one business day to schedule.');
  }
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-retell-signature');
  const verifyKeys = [process.env.RETELL_WEBHOOK_KEY, process.env.RETELL_API_KEY].filter(Boolean);
  if (!verifyKeys.some((k) => verifyRetellSignature(rawBody, k, signature))) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  if (!process.env.CAL_API_KEY || !process.env.CAL_EVENT_TYPE_ID) {
    console.error('book-setup-call: Cal.com env vars missing');
    return toolResult('Live booking is unavailable. Tell the caller the team will reach out within one business day to schedule.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return toolResult('Something went wrong. Continue the conversation and capture the caller\'s info instead.');
  }

  const args = payload.args || payload;
  const call = payload.call || {};

  try {
    if (payload.name === 'book_setup_call') return await handleBook(args, call);
    return await handleCheckAvailability();
  } catch (err) {
    console.error('book-setup-call error:', err.message);
    return toolResult('The calendar could not be reached. Tell the caller the team will reach out within one business day to schedule.');
  }
}
