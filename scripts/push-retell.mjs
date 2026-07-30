// Sync Retell agent config between the repo and the live Retell workspace.
//
//   node scripts/push-retell.mjs pull [name ...]   # live -> retell/ files
//   node scripts/push-retell.mjs push [name ...]   # retell/ files -> live
//   node scripts/push-retell.mjs diff [name ...]   # show live vs repo differences
//
// The repo is the source of truth: `push` refuses to run when the retell/
// files have uncommitted changes, so every live prompt matches a commit.
// Requires RETELL_API_KEY (OwnerAI demo workspace only) in .env.local / environment.
// Client keys (RETELL_API_KEY_<SLUG>) belong in OwnerAI-Deployments — never here.
// Optional RETELL_TOOL_BASE_URL (default https://owneraitools.com) rewrites
// general_tools[].url + webhook_url at push/diff time. Non-prod bases refuse
// non-*-staging agents unless --allow-nonprod-base.
//
// Files per agent (see retell/manifest.json):
//   retell/<name>.prompt.md   — the LLM general_prompt
//   retell/<name>.config.json — managed LLM + agent fields (tools, model, ...)

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  applyToolBaseToConfig,
  isProductionToolBase,
  normalizeToolBase,
} from './lib/retell-tool-base.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RETELL_DIR = path.join(ROOT, 'retell');
const API = 'https://api.retellai.com';

function loadEnvLocal() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();

const clientTagged = Object.keys(process.env).filter((k) =>
  /^RETELL_API_KEY_[A-Z0-9_]+$/.test(k),
);
if (clientTagged.length) {
  console.error(
    `error: client Retell keys found (${clientTagged.join(', ')}). ` +
      `OwnerAITools is demo-line only — move those to OwnerAI-Deployments/.env.local and remove them from this repo.`,
  );
  process.exit(1);
}

const KEY = process.env.RETELL_API_KEY;
const ALLOW_NONPROD_BASE = process.argv.includes('--allow-nonprod-base');

// LLM fields we manage (general_prompt lives in the .prompt.md file instead).
const LLM_KEYS = [
  'model',
  'model_temperature',
  'begin_message',
  'start_speaker',
  'general_tools',
  'default_dynamic_variables',
];
// Agent fields we manage (voice agents use post_call_analysis_data, chat
// agents use post_chat_analysis_data).
const AGENT_KEYS = [
  'post_call_analysis_data',
  'post_chat_analysis_data',
  'webhook_url',
  'webhook_events',
  'voice_model',
  'handbook_config',
];

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
  if (!res.ok) fail(`${method} ${endpoint} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

const agentEndpoints = (a) =>
  a.kind === 'voice'
    ? { get: `/get-agent/${a.agent_id}`, update: `/update-agent/${a.agent_id}` }
    : { get: `/get-chat-agent/${a.agent_id}`, update: `/update-chat-agent/${a.agent_id}` };

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function files(a) {
  return {
    prompt: path.join(RETELL_DIR, `${a.name}.prompt.md`),
    config: path.join(RETELL_DIR, `${a.name}.config.json`),
  };
}

async function fetchLive(a) {
  const llm = await api('GET', `/get-retell-llm/${a.llm_id}`);
  const agent = await api('GET', agentEndpoints(a).get);
  return {
    prompt: llm.general_prompt || '',
    config: { llm: pick(llm, LLM_KEYS), agent: pick(agent, AGENT_KEYS) },
  };
}

function readRepo(a) {
  const f = files(a);
  if (!fs.existsSync(f.prompt) || !fs.existsSync(f.config)) {
    fail(`${a.name}: missing ${f.prompt} or ${f.config} — run \`pull\` first`);
  }
  return {
    prompt: fs.readFileSync(f.prompt, 'utf8'),
    config: JSON.parse(fs.readFileSync(f.config, 'utf8')),
  };
}

function writeRepo(a, live) {
  const f = files(a);
  fs.writeFileSync(f.prompt, live.prompt);
  fs.writeFileSync(f.config, JSON.stringify(live.config, null, 2) + '\n');
}

// Key-order-insensitive stringify: Retell reorders object keys on save.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function summarizeDiff(name, live, repo) {
  const changes = [];
  if (live.prompt !== repo.prompt) {
    changes.push(`prompt (${live.prompt.length} -> ${repo.prompt.length} chars)`);
  }
  for (const scope of ['llm', 'agent']) {
    const a = live.config[scope] || {};
    const b = repo.config[scope] || {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (canonical(a[k]) !== canonical(b[k])) changes.push(`${scope}.${k}`);
    }
  }
  console.log(changes.length ? `${name}: differs — ${changes.join(', ')}` : `${name}: in sync`);
  return changes;
}

function assertClean() {
  const dirty = execSync('git status --porcelain -- retell/', { cwd: ROOT }).toString().trim();
  if (dirty) {
    fail(`retell/ has uncommitted changes — commit them first so live config maps to a commit:\n${dirty}`);
  }
}

async function main() {
  if (!KEY) {
    fail(
      'RETELL_API_KEY is not set. Put the OwnerAI demo workspace key in OwnerAITools/.env.local. ' +
        'Client keys (RETELL_API_KEY_LI_STRETCH, etc.) belong in OwnerAI-Deployments only.',
    );
  }
  const [cmd, ...rest] = process.argv.slice(2);
  const names = rest.filter((a) => !a.startsWith('--'));
  if (!['pull', 'push', 'diff'].includes(cmd)) {
    fail(
      'usage: node scripts/push-retell.mjs pull|push|diff [agent-name ...] [--allow-nonprod-base]',
    );
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(RETELL_DIR, 'manifest.json'), 'utf8'));
  const agents = manifest.agents.filter((a) => !names.length || names.includes(a.name));
  if (!agents.length) fail(`no agents match: ${names.join(', ')}`);

  if (cmd === 'push') assertClean();

  let toolBase;
  try {
    toolBase = normalizeToolBase(process.env.RETELL_TOOL_BASE_URL);
  } catch (err) {
    fail(err.message);
  }
  if (cmd === 'push' && !isProductionToolBase(toolBase)) {
    const nonStaging = agents.filter((a) => !/-staging$/i.test(a.name));
    if (nonStaging.length && !ALLOW_NONPROD_BASE) {
      fail(
        `RETELL_TOOL_BASE_URL=${toolBase} is not production. ` +
          `Refusing to push non-staging agents (${nonStaging.map((a) => a.name).join(', ')}). ` +
          `Use a *-staging agent in manifest, or pass --allow-nonprod-base only if you intend to point live tools at this base.`,
      );
    }
    console.warn(`warning: pushing with non-prod RETELL_TOOL_BASE_URL=${toolBase}`);
  }

  for (const a of agents) {
    const live = await fetchLive(a);
    if (cmd === 'pull') {
      writeRepo(a, live);
      console.log(`${a.name}: pulled (prompt ${live.prompt.length} chars)`);
      continue;
    }
    const repo = readRepo(a);
    const effective = {
      prompt: repo.prompt,
      config: applyToolBaseToConfig(repo.config, toolBase),
    };
    const changes = summarizeDiff(a.name, live, effective);
    if (cmd === 'push' && changes.length) {
      if (changes.some((c) => c.startsWith('prompt') || c.startsWith('llm.'))) {
        await api('PATCH', `/update-retell-llm/${a.llm_id}`, {
          general_prompt: effective.prompt,
          ...effective.config.llm,
        });
      }
      if (
        changes.some((c) => c.startsWith('agent.')) &&
        Object.keys(effective.config.agent || {}).length
      ) {
        await api('PATCH', agentEndpoints(a).update, effective.config.agent);
      }
      console.log(`${a.name}: pushed (tool base ${toolBase})`);
    }
  }
}

main();
