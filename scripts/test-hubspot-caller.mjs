#!/usr/bin/env node
// Unit checks for HubSpot caller greeting helpers (no network).

import assert from 'node:assert/strict';
import {
  DEMO_VOICE_E164,
  isUsableFirstName,
  namedGreeting,
  phonesMatch,
  pickNamedCaller,
  buildCallInboundResponse,
  searchContactsByPhone,
} from '../api/lib/hubspot-caller.mjs';
import { handleInboundPayload } from '../api/inbound-caller.mjs';

assert.equal(DEMO_VOICE_E164, '+15169731973');

assert.equal(isUsableFirstName('Geoff'), true);
assert.equal(isUsableFirstName('Mary-Jane'), true);
assert.equal(isUsableFirstName("O'Brien"), true);
assert.equal(isUsableFirstName('  Ann  '), true);
assert.equal(isUsableFirstName(''), false);
assert.equal(isUsableFirstName(null), false);
assert.equal(isUsableFirstName('A'.repeat(40)), false);
assert.equal(isUsableFirstName('Geoff123'), false);
assert.equal(isUsableFirstName('http://x'), false);

assert.equal(
  namedGreeting('Geoff'),
  'Hi Geoff, thanks for calling OwnerAI, what can I help you with today?'
);
assert.equal(namedGreeting('  Ann  '), namedGreeting('Ann'));
assert.equal(namedGreeting(''), null);
assert.equal(namedGreeting('Geoff!!!'), null);

assert.equal(phonesMatch('+15165551212', '(516) 555-1212'), true);
assert.equal(phonesMatch('+15165551212', '+1 516-555-9999'), false);
assert.equal(phonesMatch('+15165551212', 'bad'), false);

const geoff = {
  id: '1',
  properties: { firstname: 'Geoff', phone: '+1 516-555-1212', mobilephone: '' },
};
const other = {
  id: '2',
  properties: { firstname: 'Other', phone: '+15165559999', mobilephone: '' },
};
const noName = {
  id: '3',
  properties: { firstname: '', phone: '516-555-1212', mobilephone: '' },
};
const mobileOnly = {
  id: '4',
  properties: { firstname: 'Maya', phone: '', mobilephone: '5165551212' },
};

assert.deepEqual(pickNamedCaller('+15165551212', [geoff]), {
  firstName: 'Geoff',
  contactId: '1',
});
assert.deepEqual(pickNamedCaller('+15165551212', [mobileOnly]), {
  firstName: 'Maya',
  contactId: '4',
});
assert.equal(pickNamedCaller('+15165551212', [geoff, mobileOnly]), null);
assert.equal(pickNamedCaller('+15165551212', [other]), null);
assert.equal(pickNamedCaller('+15165551212', [noName]), null);
assert.equal(pickNamedCaller('+15165551212', []), null);
assert.equal(pickNamedCaller('bad', [geoff]), null);

assert.deepEqual(buildCallInboundResponse('Geoff'), {
  call_inbound: {
    dynamic_variables: { caller_first_name: 'Geoff' },
    agent_override: {
      retell_llm: {
        begin_message:
          'Hi Geoff, thanks for calling OwnerAI, what can I help you with today?',
      },
    },
  },
});
assert.deepEqual(buildCallInboundResponse(null), { call_inbound: {} });
assert.deepEqual(buildCallInboundResponse(''), { call_inbound: {} });

// Inbound routing — SMS never hits HubSpot; wrong to_number fails open.
assert.deepEqual(
  await handleInboundPayload(
    { event: 'chat_inbound', chat_inbound: { from_number: '+15165551212' } },
    { resolveFirstName: async () => 'ShouldNotRun' }
  ),
  { chat_inbound: {} }
);

assert.deepEqual(
  await handleInboundPayload(
    {
      event: 'call_inbound',
      call_inbound: {
        from_number: '+15165551212',
        to_number: '+15169613838',
      },
    },
    { resolveFirstName: async () => 'ShouldNotRun' }
  ),
  { call_inbound: {} }
);

assert.deepEqual(
  await handleInboundPayload(
    {
      event: 'call_inbound',
      call_inbound: {
        from_number: '+15165551212',
        to_number: DEMO_VOICE_E164,
      },
    },
    { resolveFirstName: async () => 'Geoff' }
  ),
  buildCallInboundResponse('Geoff')
);

assert.deepEqual(
  await handleInboundPayload(
    {
      event: 'call_inbound',
      call_inbound: {
        from_number: '+15165551212',
        to_number: DEMO_VOICE_E164,
      },
    },
    {
      resolveFirstName: async () => {
        throw new Error('boom');
      },
    }
  ),
  { call_inbound: {} }
);

// Search body must use EQ on E.164 / searchable last-10 — not CONTAINS_TOKEN last-10.
{
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          results: [
            {
              id: '9',
              properties: {
                firstname: 'Geoff',
                phone: '+15165551212',
                mobilephone: '',
              },
            },
          ],
        };
      },
    };
  };
  const results = await searchContactsByPhone('+15165551212', {
    token: 'test-token',
    fetchImpl,
  });
  assert.equal(results.length, 1);
  const ops = captured.filterGroups.flatMap((g) =>
    g.filters.map((f) => [f.propertyName, f.operator, f.value])
  );
  assert.deepEqual(ops, [
    ['phone', 'EQ', '+15165551212'],
    ['mobilephone', 'EQ', '+15165551212'],
    ['hs_searchable_calculated_phone_number', 'EQ', '5165551212'],
  ]);
}

console.log('test-hubspot-caller: ok');
