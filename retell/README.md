# Retell agent config — prompts as code

The live Retell agents (voice demo line, SMS receptionist, and the one-shot
template bots) are configured from this folder. **Never edit prompts in the
Retell dashboard or via ad-hoc API calls** — edit the files here, commit, and
push with the sync script, so every live prompt maps to a git commit.

## Phone numbers (shared agents)

Both OwnerAI inbound DIDs run the **same** production agents. There is no
separate test-agent clone.

| Number | Role | Voice | SMS |
|---|---|---|---|
| `+15169731973` | Public demo (website) | `demo-voice` | `sms-receptionist` |
| `+15169613838` | Testing line (internal) | `demo-voice` (same) | unbound until A2P — do not bind a different agent |

`node scripts/push-retell.mjs push demo-voice` (or `push` for all) updates the
shared agents. Both numbers pick it up on the next call. Do **not** rebind the
testing DID to a one-off agent in the dashboard — `/api/monitor` will fail on
voice drift. Do **not** use either DID as a live-transfer destination (loop).

## Files

- `manifest.json` — which agents/LLMs we manage and where their files live
- `<name>.prompt.md` — the LLM system prompt (`general_prompt`)
- `<name>.config.json` — managed fields: LLM (`model`, `begin_message`,
  `general_tools`, ...) and agent (`post_call_analysis_data`, `webhook_url`, ...)
- `industry-knowledge.md` — shared vertical fluency for website industries.
  Appended on push to **sms-receptionist** (and staging) only — **not** demo-voice
  (voice latency: Sep-10 postmortem). Website chat loads it separately. Edit when
  industries change.
- `simulations/demo-voice.cases.json` — Retell simulation scenarios (source of truth)
- `simulations/demo-voice.ids.json` — Retell test_case_definition_ids (written by sync)

## Workflow

```bash
# 1. Edit the .prompt.md / .config.json files
# 2. Commit (push refuses to run with uncommitted retell/ changes)
git add retell/ && git commit -m "Describe the prompt change"

# 3. Push to the live agents (OwnerAI demo RETELL_API_KEY in .env.local)
#    Never use client keys (RETELL_API_KEY_LI_STRETCH etc.) — those are OwnerAI-Deployments only.
#    Tool/webhook URLs are rewritten at push time from RETELL_TOOL_BASE_URL
#    (default https://owneraitools.com). Preview site deploys do NOT change Retell
#    tools — only an explicit push with a non-prod base does.
#    demo-voice push requires a green sim run in the last 24h
#    (retell/simulations/last-run.json). If Retell's sim platform is down, use --force.
node scripts/push-retell.mjs push            # all agents
node scripts/push-retell.mjs push demo-voice # one agent — updates BOTH DIDs
node scripts/push-retell.mjs push demo-voice --force  # escape hatch only
# Staging agent (name must end in -staging) → preview API:
# RETELL_TOOL_BASE_URL=https://<preview>.vercel.app node scripts/push-retell.mjs push demo-voice-staging
# Never point the live +15169731973 / +15169613838 agents at a preview URL.

# Check for drift between live and repo (e.g. someone edited the dashboard)
node scripts/push-retell.mjs diff

# Re-import live state into the repo (only when adopting external changes)
node scripts/push-retell.mjs pull

# Sync / run Retell LLM simulations for demo-voice (after every prompt push)
RETELL_API_KEY=... node scripts/sync-demo-sims.mjs
RETELL_API_KEY=... node scripts/sync-demo-sims.mjs --run

# Local CI-equivalent (no Retell key)
node scripts/test-demo-limits.mjs
node scripts/assert-demo-sim-cases.mjs
node scripts/test-retell-tool-base.mjs
node scripts/test-retell-transfer-phone.mjs
node scripts/test-testing-line.mjs
```

After changing `demo-voice.prompt.md`, sync+run sims before considering the change done.

**CI:** GitHub Actions runs unit + sim-case sanity on every PR/push to `main`/`dev`
(`.github/workflows/ci.yml`). The full Retell pack runs weekly (Monday) and on
manual `workflow_dispatch` (`.github/workflows/demo-sims.yml`) using the repo
secret `RETELL_API_KEY` (OwnerAI demo workspace only — never a client key).

**Human QA:** [`docs/ops/demo-qa-scorecard.md`](../docs/ops/demo-qa-scorecard.md) +
weekly paste prompt [`docs/ops/demo-agent-health-prompt.md`](../docs/ops/demo-agent-health-prompt.md) +
live mystery-shop script [`docs/ops/demo-mystery-shop-script.md`](../docs/ops/demo-mystery-shop-script.md).

Demo-voice uses a single Retell LLM with **Flow: Sample send**, **Flow: Setup book**,
and **Flow: Live transfer** step sections (deterministic tool paths inside the
prompt). Full Retell Conversation Flow product migration stays deferred — Wave B
sims are green (includes failure paths); revisit only if packs start failing on
tool skip / wrong tool.

## Troubleshooting history

To see when a prompt line changed and why: `git log -p -- retell/demo-voice.prompt.md`
or `git blame retell/demo-voice.prompt.md`.
