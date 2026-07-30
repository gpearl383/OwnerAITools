// Unit checks for per-call demo send allowances (memory tracker).
import {
  createAllowanceTracker,
  remainingText,
  DEMO_LIMITS,
  SAMPLE_BUDGET_BOOKING_NOTE,
} from '../api/lib/demo-limits.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(DEMO_LIMITS.smsPerCall === 2, 'sms cap is 2');
assert(DEMO_LIMITS.emailPerCall === 2, 'email cap is 2');
assert(DEMO_LIMITS.invocationsPerCall === 4, 'invocation cap is 4');

const t = createAllowanceTracker(DEMO_LIMITS, { memoryOnly: true });
const id = 'call_test_1';

// Invocation cap
assert((await t.allowInvocation(id)) === true, 'invocation 1 allowed');
assert((await t.allowInvocation(id)) === true, 'invocation 2 allowed');
assert((await t.allowInvocation(id)) === true, 'invocation 3 allowed');
assert((await t.allowInvocation(id)) === true, 'invocation 4 allowed');
assert((await t.allowInvocation(id)) === false, 'invocation 5 blocked');
assert((await t.allowInvocation('call_other')) === true, 'other call unaffected');

// SMS allowance: only successful sends burn the budget
assert((await t.canSms(id)) === true, 'sms available initially');
await t.recordSms(id);
assert((await t.canSms(id)) === true, 'sms available after 1 send');
await t.recordSms(id);
assert((await t.canSms(id)) === false, 'sms blocked after 2 sends');
assert((await t.canEmail(id)) === true, 'email budget independent of sms');

// Email allowance
await t.recordEmail(id);
await t.recordEmail(id);
assert((await t.canEmail(id)) === false, 'email blocked after 2 sends');

// Remaining counts
const r0 = await t.remaining('call_fresh');
assert(r0.sms === 2 && r0.email === 2, 'fresh call has full budget');
const r1 = await t.remaining(id);
assert(r1.sms === 0 && r1.email === 0, 'exhausted call has zero budget');

// Missing call_id never blocks (defensive; Retell always sends one)
assert((await t.allowInvocation(null)) === true, 'no call_id: invocation allowed');
assert((await t.canSms(null)) === true, 'no call_id: sms allowed');

// Speakable remaining text
assert(
  remainingText({ sms: 2, email: 1 }) ===
    'This call has 2 more sample texts and 1 more sample email available.',
  'remaining text plural/singular'
);
assert(
  remainingText({ sms: 0, email: 0 }) ===
    `This call has no more sample texts and no more sample emails available. ${SAMPLE_BUDGET_BOOKING_NOTE}`,
  'remaining text exhausted includes booking-still-allowed note'
);
assert(
  SAMPLE_BUDGET_BOOKING_NOTE.includes('does not affect booking'),
  'booking note says sample budget does not affect booking'
);
assert(
  SAMPLE_BUDGET_BOOKING_NOTE.includes('Never tell the caller the sample cap blocks'),
  'booking note forbids citing sample cap against real invites'
);

console.log('demo-limits tests passed');
