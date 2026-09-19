// Spoken-form digit normalization for demo-alert SMS bodies.

import { normalizeSpokenDigits, normalizeDemoAlertArgs } from '../api/lib/spoken-form.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  normalizeSpokenDigits('five one six … three one four … four zero zero zero') === '5163144000',
  'phone digits'
);
assert(
  normalizeSpokenDigits('one twenty-three Lincoln Street') === '123 Lincoln Street',
  'street number idiom'
);
assert(
  normalizeSpokenDigits('Five Star Plumbing') === 'Five Star Plumbing',
  'must not clobber business names with a single digit-word'
);
assert(
  normalizeSpokenDigits('Callback: five one six-three one four-four zero zero zero') ===
    'Callback: 5163144000',
  'phone with hyphens between digit words'
);

const args = normalizeDemoAlertArgs({
  business_name: 'Five Star Plumbing',
  customer_phone: 'five one six three one four four zero zero zero',
  address: 'one twenty-three Lincoln Street, Massapequa',
  appointment: 'Monday at 10 AM',
});
assert(args.business_name === 'Five Star Plumbing', 'business name untouched');
assert(args.customer_phone === '5163144000', `phone normalized: ${args.customer_phone}`);
assert(
  args.address === '123 Lincoln Street, Massapequa',
  `address normalized: ${args.address}`
);

console.log('test-demo-alert-normalize: PASS');
