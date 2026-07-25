#!/usr/bin/env node
// Sync Retell simulation test cases for the demo-voice agent and optionally run a batch.
//
//   RETELL_API_KEY=... node scripts/sync-demo-sims.mjs           # create/update definitions
//   RETELL_API_KEY=... node scripts/sync-demo-sims.mjs --run     # sync then create-batch-test
//
// Case definitions live in retell/simulations/demo-voice.cases.json (source of truth).
// IDs written back to retell/simulations/demo-voice.ids.json after sync.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.retellai.com';
const KEY = process.env.RETELL_API_KEY;
const CASES_PATH = path.join(ROOT, 'retell/simulations/demo-voice.cases.json');
const IDS_PATH = path.join(ROOT, 'retell/simulations/demo-voice.ids.json');
const MANIFEST = path.join(ROOT, 'retell/manifest.json');

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) fail(`${method} ${endpoint} -> ${res.status}: ${text}`);
  return data;
}

async function main() {
  if (!KEY) fail('RETELL_API_KEY is not set');
  const runBatch = process.argv.includes('--run');

  const pack = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const agent = manifest.agents.find((a) => a.name === pack.agent);
  if (!agent) fail(`agent ${pack.agent} not in manifest`);
  const llmId = pack.llm_id || agent.llm_id;

  let ids = {};
  if (fs.existsSync(IDS_PATH)) {
    ids = JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'));
  }

  const definitionIds = [];
  for (const c of pack.cases) {
    const body = {
      name: c.name,
      response_engine: { type: 'retell-llm', llm_id: llmId },
      user_prompt: c.user_prompt,
      metrics: c.metrics,
      tool_mocks: c.tool_mocks || [],
    };

    const existingId = ids[c.key];
    let def;
    if (existingId) {
      try {
        def = await api('PATCH', `/update-test-case-definition/${existingId}`, body);
        console.log(`updated ${c.key} -> ${existingId}`);
      } catch (err) {
        console.warn(`update failed for ${c.key}, creating new: ${err.message || err}`);
        def = await api('POST', '/create-test-case-definition', body);
        ids[c.key] = def.test_case_definition_id;
        console.log(`created ${c.key} -> ${ids[c.key]}`);
      }
    } else {
      def = await api('POST', '/create-test-case-definition', body);
      ids[c.key] = def.test_case_definition_id;
      console.log(`created ${c.key} -> ${ids[c.key]}`);
    }
    definitionIds.push(ids[c.key] || def.test_case_definition_id);
  }

  fs.writeFileSync(
    IDS_PATH,
    JSON.stringify(
      {
        agent: pack.agent,
        llm_id: llmId,
        updated_at: new Date().toISOString(),
        ids,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${IDS_PATH}`);

  if (!runBatch) {
    console.log('Done. Pass --run to create a batch test job.');
    return;
  }

  const batch = await api('POST', '/create-batch-test', {
    response_engine: { type: 'retell-llm', llm_id: llmId },
    test_case_definition_ids: definitionIds,
  });
  const jobId = batch.test_case_batch_job_id;
  console.log(`batch job started: ${jobId}`);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await api('GET', `/get-batch-test/${jobId}`);
    console.log(
      `status=${status.status} pass=${status.pass_count} fail=${status.fail_count} error=${status.error_count} total=${status.total_count}`,
    );
    if (status.status === 'complete') {
      if ((status.fail_count || 0) + (status.error_count || 0) > 0) {
        fail(`batch finished with failures — inspect in Retell dashboard (job ${jobId})`);
      }
      console.log('batch complete — all passed');
      return;
    }
  }
  fail(`batch still in progress after timeout — job ${jobId}`);
}

main().catch((err) => fail(err.message || String(err)));
