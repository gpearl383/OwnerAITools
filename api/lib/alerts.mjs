// Owner-alert + hangup-nurture eligibility helpers.

export const HUNG_UP_MAX_SEC = 15;
export const HANGUP_NURTURE_MIN_SEC = 5;

export function isHungUpCall(durationSec) {
  const d = Number(durationSec) || 0;
  return d > 0 && d < HUNG_UP_MAX_SEC;
}

/**
 * Prospect hangup nurture: early hangup, not a pocket-dial, and we captured
 * at least a name or business.
 */
export function shouldSendHangupNurture({ durationSec, name, business }) {
  if (!isHungUpCall(durationSec)) return false;
  if ((Number(durationSec) || 0) < HANGUP_NURTURE_MIN_SEC) return false;
  const hasName = String(name || '').trim().length > 0;
  const hasBiz = String(business || '').trim().length > 0;
  return hasName || hasBiz;
}

export function buildHangupNurtureSms() {
  return [
    'Looks like we got disconnected — this is OwnerAI Tools.',
    'Call or text us back at (516) 973-1973, or book a setup call: https://cal.com/owneraitools/30min',
    'Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
  ].join(' ');
}
