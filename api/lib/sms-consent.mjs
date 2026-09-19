// Consent gates for post-call SMS (booking confirmation + hangup nurture).
// Role-play callback numbers must never receive marketing/booking SMS unless
// they match the caller's ANI or a real setup booking exists.

/**
 * @param {{
 *   callbackPhone?: string | null,
 *   fromNumber?: string | null,
 *   setupCallBookedTime?: string | null,
 *   ourNumbers?: Array<string | null | undefined>,
 * }} opts
 * @returns {{ ok: boolean, reason?: string, confirmTo?: string | null }}
 */
export function bookingConfirmConsent({
  callbackPhone,
  fromNumber,
  setupCallBookedTime,
  ourNumbers = [],
  normalizePhone,
}) {
  const confirmTo = normalizePhone(callbackPhone);
  const fromNorm = normalizePhone(fromNumber);
  const bookedOk = !!(setupCallBookedTime || '').trim();
  const ours = (ourNumbers || []).map(normalizePhone).filter(Boolean);

  if (!confirmTo) return { ok: false, reason: 'invalid_callback', confirmTo };
  if (ours.includes(confirmTo)) {
    return { ok: false, reason: 'own_line', confirmTo };
  }
  if (confirmTo === fromNorm || bookedOk) {
    return { ok: true, confirmTo };
  }
  return { ok: false, reason: 'ani_mismatch_no_booking', confirmTo, fromNorm };
}

/**
 * Hangup nurture may only text the actual calling number.
 * @param {{ nurtureTo?: string | null, fromNumber?: string | null, normalizePhone: Function }} opts
 */
export function hangupNurtureConsent({ nurtureTo, fromNumber, normalizePhone }) {
  const to = normalizePhone(nurtureTo);
  const fromNorm = normalizePhone(fromNumber);
  if (!to) return { ok: false, reason: 'invalid_to' };
  if (fromNorm && to !== fromNorm) {
    return { ok: false, reason: 'ani_mismatch', to, fromNorm };
  }
  return { ok: true, to };
}
