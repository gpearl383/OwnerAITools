// Per-call demo-send allowances for the mid-call send_demo_alert tool.
//
// Prefer durable Supabase counters (demo_sample_budgets). Fall back to
// in-memory Maps when Supabase is unavailable (same trade-off as rate-limit.mjs).

export const DEMO_LIMITS = {
  smsPerCall: 2,
  emailPerCall: 2,
  invocationsPerCall: 4,
};

const TTL_MS = 24 * 60 * 60 * 1000;

function createMemoryTracker(limits) {
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
    async allowInvocation(callId) {
      if (!callId) return true;
      const rec = entry(callId);
      if (rec.invocations >= limits.invocationsPerCall) return false;
      rec.invocations += 1;
      return true;
    },
    async canSms(callId) {
      return !callId || entry(callId).sms < limits.smsPerCall;
    },
    async canEmail(callId) {
      return !callId || entry(callId).email < limits.emailPerCall;
    },
    async recordSms(callId) {
      if (callId) entry(callId).sms += 1;
    },
    async recordEmail(callId) {
      if (callId) entry(callId).email += 1;
    },
    async remaining(callId) {
      if (!callId) return { sms: limits.smsPerCall, email: limits.emailPerCall };
      const rec = entry(callId);
      return {
        sms: Math.max(0, limits.smsPerCall - rec.sms),
        email: Math.max(0, limits.emailPerCall - rec.email),
      };
    },
  };
}

async function sbRpc(name, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function createDurableTracker(limits, memoryFallback) {
  let warned = false;
  function warnOnce() {
    if (!warned) {
      warned = true;
      console.warn('demo-limits: Supabase unavailable — using in-memory budget fallback');
    }
  }

  return {
    async allowInvocation(callId) {
      if (!callId) return true;
      const allowed = await sbRpc('bump_demo_sample_budget', {
        p_call_id: callId,
        p_kind: 'invocation',
        p_max: limits.invocationsPerCall,
      });
      if (allowed === true || allowed === false) return allowed;
      warnOnce();
      return memoryFallback.allowInvocation(callId);
    },
    async canSms(callId) {
      if (!callId) return true;
      const row = await sbRpc('get_demo_sample_budget', { p_call_id: callId });
      if (Array.isArray(row) && row[0]) return (row[0].sms ?? 0) < limits.smsPerCall;
      if (row && typeof row === 'object' && 'sms' in row) return (row.sms ?? 0) < limits.smsPerCall;
      warnOnce();
      return memoryFallback.canSms(callId);
    },
    async canEmail(callId) {
      if (!callId) return true;
      const row = await sbRpc('get_demo_sample_budget', { p_call_id: callId });
      if (Array.isArray(row) && row[0]) return (row[0].email ?? 0) < limits.emailPerCall;
      if (row && typeof row === 'object' && 'email' in row) return (row.email ?? 0) < limits.emailPerCall;
      warnOnce();
      return memoryFallback.canEmail(callId);
    },
    async recordSms(callId) {
      if (!callId) return;
      const ok = await sbRpc('bump_demo_sample_budget', {
        p_call_id: callId,
        p_kind: 'sms',
        p_max: limits.smsPerCall,
      });
      if (ok === true || ok === false) return;
      warnOnce();
      return memoryFallback.recordSms(callId);
    },
    async recordEmail(callId) {
      if (!callId) return;
      const ok = await sbRpc('bump_demo_sample_budget', {
        p_call_id: callId,
        p_kind: 'email',
        p_max: limits.emailPerCall,
      });
      if (ok === true || ok === false) return;
      warnOnce();
      return memoryFallback.recordEmail(callId);
    },
    async remaining(callId) {
      if (!callId) return { sms: limits.smsPerCall, email: limits.emailPerCall };
      const row = await sbRpc('get_demo_sample_budget', { p_call_id: callId });
      const rec = Array.isArray(row) ? row[0] : row;
      if (rec && typeof rec === 'object') {
        return {
          sms: Math.max(0, limits.smsPerCall - (rec.sms ?? 0)),
          email: Math.max(0, limits.emailPerCall - (rec.email ?? 0)),
        };
      }
      warnOnce();
      return memoryFallback.remaining(callId);
    },
  };
}

/**
 * Async allowance tracker. Prefer Durable Supabase; memory fallback if RPC missing.
 * Pass `{ memoryOnly: true }` for unit tests.
 */
export function createAllowanceTracker(limits = DEMO_LIMITS, opts = {}) {
  const memory = createMemoryTracker(limits);
  if (opts.memoryOnly) return memory;
  return createDurableTracker(limits, memory);
}

// Speakable summary of what's left, appended to tool results so the agent
// can state real limits instead of inventing policy.
// Cap applies ONLY to send_demo_alert samples — never to setup booking / Cal.com invites.
export const SAMPLE_BUDGET_BOOKING_NOTE =
  'This sample budget does not affect booking the real setup call — Cal.com still sends that calendar invite separately. Never tell the caller the sample cap blocks a real invite, confirmation text, or taking their info.';

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
  const base = `This call has ${parts.join(' and ')} available.`;
  if (remaining.sms === 0 && remaining.email === 0) {
    return `${base} ${SAMPLE_BUDGET_BOOKING_NOTE}`;
  }
  return base;
}
