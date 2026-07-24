// Sync Retell agent config between the repo and the live Retell workspace.
//
//   node scripts/push-retell.mjs pull [name ...]   # live -> retell/ files
//   node scripts/push-retell.mjs push [name ...]   # retell/ files -> live
//   node scripts/push-retell.mjs diff [name ...]   # show live vs repo differences
//
// The repo is the source of truth: `push` refuses to run when the retell/
// files have uncommitted changes, so every live prompt matches a commit.
// Requires RETELL_API_KEY in the environment.
//
// Files per agent (see retell/manifest.json):
//   retell/<name>.prompt.md   — the LLM general_prompt
//   retell/<name>.config.json — managed LLM + agent fields (tools, model, ...)

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RETELL_DIR = path.join(ROOT, 'retell');
const API = 'https://api.retellai.com';
const KEY = process.env.RETELL_API_KEY;

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
  if (!KEY) fail('RETELL_API_KEY is not set');
  const [cmd, ...names] = process.argv.slice(2);
  if (!['pull', 'push', 'diff'].includes(cmd)) {
    fail('usage: node scripts/push-retell.mjs pull|push|diff [agent-name ...]');
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(RETELL_DIR, 'manifest.json'), 'utf8'));
  const agents = manifest.agents.filter((a) => !names.length || names.includes(a.name));
  if (!agents.length) fail(`no agents match: ${names.join(', ')}`);

  if (cmd === 'push') assertClean();

  for (const a of agents) {
    const live = await fetchLive(a);
    if (cmd === 'pull') {
      writeRepo(a, live);
      console.log(`${a.name}: pulled (prompt ${live.prompt.length} chars)`);
      continue;
    }
    const repo = readRepo(a);
    const changes = summarizeDiff(a.name, live, repo);
    if (cmd === 'push' && changes.length) {
      if (changes.some((c) => c.startsWith('prompt') || c.startsWith('llm.'))) {
        await api('PATCH', `/update-retell-llm/${a.llm_id}`, {
          general_prompt: repo.prompt,
          ...repo.config.llm,
        });
      }
      if (changes.some((c) => c.startsWith('agent.')) && Object.keys(repo.config.agent).length) {
        await api('PATCH', agentEndpoints(a).update, repo.config.agent);
      }
      console.log(`${a.name}: pushed`);
    }
  }
}

main();
