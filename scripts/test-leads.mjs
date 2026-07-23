// Unit checks for lead classify / priority / phone normalize.
import {
  normalizePhone,
  normalizeEmail,
  classifyStatus,
  computePriority,
} from '../api/lib/leads.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(normalizePhone('516-555-1212') === '+15165551212', 'phone 10-digit');
assert(normalizePhone('+1 (516) 555-1212') === '+15165551212', 'phone e164');
assert(normalizePhone('bad') === null, 'phone invalid');
assert(normalizeEmail('A@B.com') === 'a@b.com', 'email');
assert(normalizeEmail('nope') === null, 'email invalid');

assert(classifyStatus({ booked: true, channel: 'call', durationSec: 5 }) === 'booked', 'booked wins');
assert(classifyStatus({ booked: false, channel: 'call', durationSec: 10 }) === 'hung_up', 'hung up');
assert(classifyStatus({ booked: false, channel: 'call', durationSec: 40 }) === 'needs_callback', 'callback');
assert(classifyStatus({ booked: false, channel: 'sms', durationSec: 5 }) === 'needs_callback', 'sms not hung up');

assert(computePriority({ wantsSetup: true, leadQuality: 'cold' }) === 3, 'wants setup hot');
assert(computePriority({ wantsSetup: false, leadQuality: 'hot' }) === 3, 'quality hot');
assert(computePriority({ wantsSetup: false, leadQuality: 'warm' }) === 2, 'warm');
assert(computePriority({ wantsSetup: false, leadQuality: 'cold' }) === 1, 'cold');

console.log('leads unit checks passed');
