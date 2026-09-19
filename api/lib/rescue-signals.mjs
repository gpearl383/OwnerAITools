// Demo-line rescue signals — detect failed demos that need founder callback.

const NOT_RECEIVED_RE =
  /didn'?t get (the |a |that |it)?|did not get (the |a |that |it)?|didn'?t receive|did not receive|nothing came|no text|i don'?t see (the |a )?text|haven'?t (got|gotten|received)/i;

/**
 * @param {{
 *   call?: { from_number?: string, call_id?: string },
 *   data?: {
 *     lead_quality?: string,
 *     setup_call_booked_time?: string,
 *     agent_stated_unlisted_fact?: boolean,
 *     name?: string,
 *     business?: string,
 *     callback_phone?: string,
 *   },
 *   hungUp?: boolean,
 *   transcript?: string,
 *   audit?: Array<{ status?: string, event_type?: string }>,
 * }} opts
 * @returns {string[]}
 */
export function evaluateRescueSignals({ call, data = {}, hungUp = false, transcript = '', audit = [] } = {}) {
  const signals = [];
  const tx = String(transcript || '');
  if (NOT_RECEIVED_RE.test(tx)) {
    signals.push('caller said sample not received');
  }
  if (data.lead_quality === 'hot' && !(data.setup_call_booked_time || '').trim() && !hungUp) {
    signals.push('hot lead, no setup call booked');
  }
  if (data.agent_stated_unlisted_fact) {
    signals.push('agent stated unlisted fact');
  }
  const sendFailed = (audit || []).some(
    (r) =>
      r.status === 'failed' &&
      /sms|email|demo|invite/.test(String(r.event_type || '')),
  );
  if (sendFailed) {
    signals.push('sample send failed mid-call');
  }
  // Silence unused — call kept for future ANI context.
  void call;
  return signals;
}
