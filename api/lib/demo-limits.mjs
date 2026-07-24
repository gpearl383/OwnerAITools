// Per-call demo-send allowances for the mid-call send_demo_alert tool.
//
// Replaces the old one-successful-send-per-call rule: a demo call now gets a
// small independent budget of sample texts and sample emails, plus an
// invocation cap so a confused agent can't loop the tool. Counters only
// increment on successful sends, so a failed leg doesn't burn the budget.
// State is per warm serverless instance (same trade-off as before).

export const DEMO_LIMITS = {
  smsPerCall: 2,
  emailPerCall: 2,
  invocationsPerCall: 4,
};

const TTL_MS = 24 * 60 * 60 * 1000;

export function createAllowanceTracker(limits = DEMO_LIMITS) {
  const perCall = new Map();

  function entry(callId) {
    const now = Date.now();
    let rec = perCall.get(callId);
    if (!rec || now - rec.start > TTL_MS) {
      rec = { start: now, invocations: 0, sms: 0, email: 0 };
      perCall.set(callId, rec);
    }
    if (perCall.size > 5000) {
      for (const [k, v] of perCall) if (now - v.start > TTL_MS) perCall.delete(k);
    }
    return rec;
  }

  return {
    // Counts one tool invocation; false when the per-call cap is exhausted.
    allowInvocation(callId) {
      if (!callId) return true;
      const rec = entry(callId);
      if (rec.invocations >= limits.invocationsPerCall) return false;
      rec.invocations += 1;
      return true;
    },
    canSms(callId) {
      return !callId || entry(callId).sms < limits.smsPerCall;
    },
    canEmail(callId) {
      return !callId || entry(callId).email < limits.emailPerCall;
    },
    recordSms(callId) {
      if (callId) entry(callId).sms += 1;
    },
    recordEmail(callId) {
      if (callId) entry(callId).email += 1;
    },
    remaining(callId) {
      if (!callId) return { sms: limits.smsPerCall, email: limits.emailPerCall };
      const rec = entry(callId);
      return {
        sms: Math.max(0, limits.smsPerCall - rec.sms),
        email: Math.max(0, limits.emailPerCall - rec.email),
      };
    },
  };
}

// Speakable summary of what's left, appended to tool results so the agent
// can state real limits instead of inventing policy.
export function remainingText(remaining) {
  const parts = [];
  parts.push(
    remaining.sms > 0
      ? `${remaining.sms} more sample text${remaining.sms === 1 ? '' : 's'}`
      : 'no more sample texts'
  );
  parts.push(
    remaining.email > 0
      ? `${remaining.email} more sample email${remaining.email === 1 ? '' : 's'}`
      : 'no more sample emails'
  );
  return `This call has ${parts.join(' and ')} available.`;
}
