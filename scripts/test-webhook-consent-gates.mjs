// Consent gates + rescue signals (pure helpers — no network).

import { bookingConfirmConsent, hangupNurtureConsent } from '../api/lib/sms-consent.mjs';
import { evaluateRescueSignals } from '../api/lib/rescue-signals.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function normalizePhone(v) {
  const digits = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

// --- booking confirm: role-play callback != ANI, no booking → block ---
{
  const r = bookingConfirmConsent({
    callbackPhone: '+15163144000',
    fromNumber: '+15166956600',
    setupCallBookedTime: '',
    ourNumbers: ['+15169731973'],
    normalizePhone,
  });
  assert(!r.ok && r.reason === 'ani_mismatch_no_booking', `expected ani mismatch, got ${JSON.stringify(r)}`);
}

// --- booking confirm: same mismatch but real booking → allow ---
{
  const r = bookingConfirmConsent({
    callbackPhone: '+15163144000',
    fromNumber: '+15166956600',
    setupCallBookedTime: 'Wednesday at 10 AM Eastern',
    ourNumbers: ['+15169731973'],
    normalizePhone,
  });
  assert(r.ok, `booking should allow, got ${JSON.stringify(r)}`);
}

// --- booking confirm: ANI match → allow ---
{
  const r = bookingConfirmConsent({
    callbackPhone: '+15166956600',
    fromNumber: '+15166956600',
    setupCallBookedTime: '',
    ourNumbers: ['+15169731973'],
    normalizePhone,
  });
  assert(r.ok, 'ANI match should allow');
}

// --- booking confirm: our own line → block ---
{
  const r = bookingConfirmConsent({
    callbackPhone: '+15169731973',
    fromNumber: '+15166956600',
    setupCallBookedTime: 'Wednesday at 10 AM',
    ourNumbers: ['+15169731973'],
    normalizePhone,
  });
  assert(!r.ok && r.reason === 'own_line', 'own line blocked');
}

// --- hangup nurture: mismatch → block ---
{
  const r = hangupNurtureConsent({
    nurtureTo: '+15163144000',
    fromNumber: '+15166956600',
    normalizePhone,
  });
  assert(!r.ok && r.reason === 'ani_mismatch', 'nurture ANI mismatch');
}

// --- hangup nurture: match → allow ---
{
  const r = hangupNurtureConsent({
    nurtureTo: '+15166956600',
    fromNumber: '+15166956600',
    normalizePhone,
  });
  assert(r.ok, 'nurture ANI match');
}

// --- rescue signals ---
{
  const s = evaluateRescueSignals({
    data: { lead_quality: 'hot', setup_call_booked_time: '' },
    hungUp: false,
    transcript: "I didn't get the text.",
    audit: [{ status: 'failed', event_type: 'sms_failed' }],
  });
  assert(s.includes('caller said sample not received'), `signals: ${s}`);
  assert(s.includes('hot lead, no setup call booked'), `signals: ${s}`);
  assert(s.includes('sample send failed mid-call'), `signals: ${s}`);
}

{
  const s = evaluateRescueSignals({
    data: { lead_quality: 'hot', setup_call_booked_time: 'Tue 10am' },
    hungUp: false,
    transcript: 'Looks great, thanks.',
    audit: [],
  });
  assert(s.length === 0, `booked hot lead should not rescue: ${s}`);
}

console.log('test-webhook-consent-gates: PASS');
