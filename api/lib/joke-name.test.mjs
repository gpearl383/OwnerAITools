import assert from 'node:assert/strict';
import test from 'node:test';
import { isMutatedJokeName } from './joke-name.mjs';

test('flags repeated oink / piggy speech-game names', () => {
  assert.equal(isMutatedJokeName('Geoink oink oink oink'), true);
  assert.equal(isMutatedJokeName('G piggy O OINK OINK piggy'), true);
  assert.equal(isMutatedJokeName('oink oink oink'), true);
  assert.equal(isMutatedJokeName('piggy piggy piggy'), true);
});

test('flags repeated nonsense fillers', () => {
  assert.equal(isMutatedJokeName('blah blah blah'), true);
  assert.equal(isMutatedJokeName('na na na'), true);
});

test('allows normal names', () => {
  assert.equal(isMutatedJokeName('Geoff'), false);
  assert.equal(isMutatedJokeName('Comfort Air HVAC'), false);
  assert.equal(isMutatedJokeName(null), false);
  assert.equal(isMutatedJokeName(''), false);
});
