#!/usr/bin/env node
import {
  TRANSFER_PHONE_PLACEHOLDER,
  applyTransferPhoneToConfig,
  isEmergencyNumber,
  redactTransferPhone,
  resolveTransferPhone,
} from './lib/retell-transfer-phone.mjs';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

function throws(fn, needle, msg) {
  try {
    fn();
    console.error('FAIL:', msg, '(did not throw)');
    process.exit(1);
  } catch (err) {
    const text = String(err?.message || err);
    if (needle && !text.includes(needle)) {
      console.error('FAIL:', msg, `(threw "${text}", expected "${needle}")`);
      process.exit(1);
    }
  }
}

assert(TRANSFER_PHONE_PLACEHOLDER === 'env:OWNERAI_TRANSFER_PHONE', 'placeholder');

assert(resolveTransferPhone('+15166431994') === '+15166431994', 'already E.164');
assert(resolveTransferPhone('5166431994') === '+15166431994', '10-digit → E.164');

assert(
  resolveTransferPhone(TRANSFER_PHONE_PLACEHOLDER, {
    OWNERAI_TRANSFER_PHONE: '+15166431994',
  }) === '+15166431994',
  'env placeholder',
);

throws(
  () => resolveTransferPhone(TRANSFER_PHONE_PLACEHOLDER, {}),
  'OWNERAI_TRANSFER_PHONE',
  'missing env',
);

throws(
  () => resolveTransferPhone('+15169731973'),
  'forbidden',
  'refuse demo line',
);
throws(
  () => resolveTransferPhone('+15169613838'),
  'forbidden',
  'refuse testing line',
);
throws(
  () => resolveTransferPhone('+15163662711'),
  'forbidden',
  'refuse Google Voice',
);
throws(
  () => resolveTransferPhone('+15165079380'),
  'forbidden',
  'refuse personal cell',
);

assert(isEmergencyNumber('911') === true, '911');
assert(isEmergencyNumber('+1911') === true, '+1911');
assert(isEmergencyNumber('112') === true, '112');
assert(isEmergencyNumber('+15166431994') === false, 'transfer number is not emergency');

throws(() => resolveTransferPhone('911'), 'emergency', 'refuse 911');
throws(() => resolveTransferPhone('+1911'), 'emergency', 'refuse +1911');

const cfg = applyTransferPhoneToConfig(
  {
    llm: {
      general_tools: [
        {
          name: 'live_transfer',
          type: 'transfer_call',
          transfer_destination: {
            type: 'predefined',
            number: TRANSFER_PHONE_PLACEHOLDER,
          },
        },
        { name: 'end_call', type: 'end_call' },
      ],
    },
  },
  { OWNERAI_TRANSFER_PHONE: '+15166431994' },
);
assert(
  cfg.llm.general_tools[0].transfer_destination.number === '+15166431994',
  'config substitution',
);
assert(cfg.llm.general_tools[1].type === 'end_call', 'leave other tools');

const pulled = redactTransferPhone({
  llm: {
    general_tools: [
      {
        name: 'live_transfer',
        type: 'transfer_call',
        transfer_destination: { type: 'predefined', number: '+15166431994' },
      },
    ],
  },
});
assert(
  pulled.llm.general_tools[0].transfer_destination.number === TRANSFER_PHONE_PLACEHOLDER,
  'pull redacts dest',
);

console.log('test-retell-transfer-phone: PASS');
