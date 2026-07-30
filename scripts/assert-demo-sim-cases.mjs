#!/usr/bin/env node
// Sanity-check demo-voice simulation pack (no Retell API).
// Used by CI on every PR.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_PATH = path.join(ROOT, 'retell/simulations/demo-voice.cases.json');
const IDS_PATH = path.join(ROOT, 'retell/simulations/demo-voice.ids.json');

const REQUIRED_KEYS = [
  'barge-in-hello',
  'av-clarify',
  'sms-only-sample',
  'email-spell-compact',
  'mid-roleplay-sample',
  'setup-book-yes',
  'no-owner-names',
  'sample-budget-then-setup',
  'reclaim-after-praise',
  'roleplay-not-caller-name',
  'regulated-no-invented-balance',
  'sample-send-fail',
  'empty-slots',
  'taken-slot',
];

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const pack = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
if (pack.agent !== 'demo-voice') fail(`expected agent demo-voice, got ${pack.agent}`);
if (!Array.isArray(pack.cases) || pack.cases.length < REQUIRED_KEYS.length) {
  fail(`expected at least ${REQUIRED_KEYS.length} cases, got ${pack.cases?.length}`);
}

const keys = pack.cases.map((c) => c.key);
const missing = REQUIRED_KEYS.filter((k) => !keys.includes(k));
if (missing.length) fail(`missing required case keys: ${missing.join(', ')}`);

for (const c of pack.cases) {
  if (!c.key || !c.name || !c.user_prompt) fail(`case missing key/name/user_prompt: ${JSON.stringify(c.key)}`);
  if (!Array.isArray(c.metrics) || c.metrics.length < 1) fail(`case ${c.key} needs metrics`);
  if (!Array.isArray(c.tool_mocks)) fail(`case ${c.key} needs tool_mocks array`);
}

if (fs.existsSync(IDS_PATH)) {
  const ids = JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'));
  const map = ids.ids || ids;
  for (const k of REQUIRED_KEYS) {
    const id = map[k];
    if (id != null && typeof id === 'string' && !id.startsWith('test_case_')) {
      fail(`ids.json ${k} looks invalid: ${id}`);
    }
  }
}

console.log(`assert-demo-sim-cases: PASS (${pack.cases.length} cases, ${REQUIRED_KEYS.length} required keys)`);
