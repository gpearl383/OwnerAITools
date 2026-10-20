#!/usr/bin/env node
import assert from 'node:assert/strict';
import { clientIp } from '../api/lib/client-ip.mjs';
import { callLinkSecret } from '../api/lib/call-link-secret.mjs';
import { retellVerifyKeys, trialRetellVerifyKeys } from '../api/lib/retell-verify.mjs';

function req(headers) {
  return { headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null } };
}

assert.equal(
  clientIp(req({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9', 'x-vercel-forwarded-for': '9.9.9.9' })),
  '9.9.9.9'
);
assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 8.8.8.8' })), '8.8.8.8');
assert.equal(clientIp(req({ 'x-real-ip': '7.7.7.7' })), '7.7.7.7');

assert.deepEqual(retellVerifyKeys({ webhookKey: 'wh', apiKey: 'api' }), ['wh']);
assert.deepEqual(retellVerifyKeys({ webhookKey: '', apiKey: 'api' }), ['api']);
assert.deepEqual(retellVerifyKeys({ webhookKey: '', apiKey: '' }), []);
assert.deepEqual(trialRetellVerifyKeys({ webhookKey: 'twh', apiKey: 'tapi' }), ['twh']);
assert.deepEqual(trialRetellVerifyKeys({ webhookKey: '', apiKey: 'tapi' }), ['tapi']);

const prev = process.env.CALL_LINK_SECRET;
delete process.env.CALL_LINK_SECRET;
assert.equal(callLinkSecret(), null);
process.env.CALL_LINK_SECRET = 'test-call-link-secret';
assert.equal(callLinkSecret(), 'test-call-link-secret');
if (prev === undefined) delete process.env.CALL_LINK_SECRET;
else process.env.CALL_LINK_SECRET = prev;

console.log('test-security-helpers: ok');
