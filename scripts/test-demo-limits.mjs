// Unit checks for per-call demo send allowances.
import {
  createAllowanceTracker,
  remainingText,
  DEMO_LIMITS,
} from '../api/lib/demo-limits.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(DEMO_LIMITS.smsPerCall === 2, 'sms cap is 2');
assert(DEMO_LIMITS.emailPerCall === 2, 'email cap is 2');
assert(DEMO_LIMITS.invocationsPerCall === 4, 'invocation cap is 4');

const t = createAllowanceTracker();
const id = 'call_test_1';

// Invocation cap
assert(t.allowInvocation(id) === true, 'invocation 1 allowed');
assert(t.allowInvocation(id) === true, 'invocation 2 allowed');
assert(t.allowInvocation(id) === true, 'invocation 3 allowed');
assert(t.allowInvocation(id) === true, 'invocation 4 allowed');
assert(t.allowInvocation(id) === false, 'invocation 5 blocked');
assert(t.allowInvocation('call_other') === true, 'other call unaffected');

// SMS allowance: only successful sends burn the budget
assert(t.canSms(id) === true, 'sms available initially');
t.recordSms(id);
assert(t.canSms(id) === true, 'sms available after 1 send');
t.recordSms(id);
assert(t.canSms(id) === false, 'sms blocked after 2 sends');
assert(t.canEmail(id) === true, 'email budget independent of sms');

// Email allowance
t.recordEmail(id);
t.recordEmail(id);
assert(t.canEmail(id) === false, 'email blocked after 2 sends');

// Remaining counts
const r0 = t.remaining('call_fresh');
assert(r0.sms === 2 && r0.email === 2, 'fresh call has full budget');
const r1 = t.remaining(id);
assert(r1.sms === 0 && r1.email === 0, 'exhausted call has zero budget');

// Missing call_id never blocks (defensive; Retell always sends one)
assert(t.allowInvocation(null) === true, 'no call_id: invocation allowed');
assert(t.canSms(null) === true, 'no call_id: sms allowed');

// Speakable remaining text
assert(
  remainingText({ sms: 2, email: 1 }) ===
    'This call has 2 more sample texts and 1 more sample email available.',
  'remaining text plural/singular'
);
assert(
  remainingText({ sms: 0, email: 0 }) ===
    'This call has no more sample texts and no more sample emails available.',
  'remaining text exhausted'
);

console.log('demo-limits tests passed');
