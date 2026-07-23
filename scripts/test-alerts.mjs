// Unit checks for hangup / nurture eligibility.
import {
  isHungUpCall,
  shouldSendHangupNurture,
  buildHangupNurtureSms,
  HUNG_UP_MAX_SEC,
  HANGUP_NURTURE_MIN_SEC,
} from '../api/lib/alerts.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(HUNG_UP_MAX_SEC === 15, 'hung up max');
assert(HANGUP_NURTURE_MIN_SEC === 5, 'nurture min');

assert(isHungUpCall(1) === true, '1s hung up');
assert(isHungUpCall(14) === true, '14s hung up');
assert(isHungUpCall(15) === false, '15s not hung up');
assert(isHungUpCall(40) === false, '40s not hung up');
assert(isHungUpCall(0) === false, '0s not hung up');

assert(
  shouldSendHangupNurture({ durationSec: 3, name: 'Pat', business: '' }) === false,
  '3s with name — pocket dial, no nurture',
);
assert(
  shouldSendHangupNurture({ durationSec: 8, name: '', business: '' }) === false,
  '8s no identity — no nurture',
);
assert(
  shouldSendHangupNurture({ durationSec: 8, name: 'Pat', business: '' }) === true,
  '8s with name — nurture',
);
assert(
  shouldSendHangupNurture({ durationSec: 8, name: '', business: 'Acme HVAC' }) === true,
  '8s with business — nurture',
);
assert(
  shouldSendHangupNurture({ durationSec: 40, name: 'Pat', business: 'Acme' }) === false,
  '40s not a hangup — no nurture',
);

const body = buildHangupNurtureSms();
assert(/STOP/i.test(body) && /HELP/i.test(body), 'STOP/HELP footer');
assert(/disconnected/i.test(body), 'disconnected copy');

console.log('alerts unit checks passed');
