#!/usr/bin/env node
// Unit checks for Sales Demo Console helpers (no network).

import assert from 'node:assert/strict';
import {
  VOICE_IDS,
  buildDynamicVariables,
  idleDynamicVariables,
  normalizeSlotInput,
  publicSlot,
} from '../api/lib/demo-slots.mjs';
import { hashPassword, verifyPassword } from '../api/lib/sales-auth.mjs';

const { salt, hash } = hashPassword('secret-demo');
assert.equal(verifyPassword('secret-demo', salt, hash), true);
assert.equal(verifyPassword('wrong', salt, hash), false);

const input = normalizeSlotInput({
  companyName: 'Jerry Pizza',
  voice: 'male',
  ownerPhone: '5165551212',
  ownerEmail: 'Jerry@Example.com',
  trialDays: 14,
  e164: '+1 (516) 555-9999',
});
assert.equal(input.companyName, 'Jerry Pizza');
assert.equal(input.voice, 'male');
assert.equal(input.ownerPhone, '+15165551212');
assert.equal(input.ownerEmail, 'jerry@example.com');
assert.equal(input.e164, '+15165559999');

const idle = idleDynamicVariables();
assert.equal(idle.trial_active, 'false');
assert.match(idle.greeting, /not assigned/i);

const activeVars = buildDynamicVariables({
  company_name: "Jerry's Pizza",
  owner_name: 'Jerry',
  greeting: 'Welcome to Jerry\'s',
  language: 'en',
  website: 'https://example.com',
  status: 'active',
});
assert.equal(activeVars.company_name, "Jerry's Pizza");
assert.equal(activeVars.trial_active, 'true');
assert.equal(VOICE_IDS.female, '11labs-Grace');
assert.equal(VOICE_IDS.male, '11labs-Brian');

const pub = publicSlot({
  id: 'x',
  slot_key: 1,
  e164: '+15165559999',
  status: 'active',
  company_name: "Jerry's",
  trial_days: 14,
  trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString(),
  retell_voice_agent_id: 'a',
  retell_sms_agent_id: 'b',
});
assert.equal(pub.status, 'active');
assert.ok(pub.daysLeft >= 2 && pub.daysLeft <= 3);
assert.equal(pub.hasAgents, true);

console.log('test-sales-demo: ok');
