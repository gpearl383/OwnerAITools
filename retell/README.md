# Retell agent config — prompts as code

The live Retell agents (voice demo line, SMS receptionist, and the one-shot
template bots) are configured from this folder. **Never edit prompts in the
Retell dashboard or via ad-hoc API calls** — edit the files here, commit, and
push with the sync script, so every live prompt maps to a git commit.

## Files

- `manifest.json` — which agents/LLMs we manage and where their files live
- `<name>.prompt.md` — the LLM system prompt (`general_prompt`)
- `<name>.config.json` — managed fields: LLM (`model`, `begin_message`,
  `general_tools`, ...) and agent (`post_call_analysis_data`, `webhook_url`, ...)
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
node scripts/push-retell.mjs push            # all agents
node scripts/push-retell.mjs push demo-voice # one agent
# Staging / OwnerAI Testing Line (+15169613838) — agent name must end in -staging:
# node scripts/push-retell.mjs push demo-voice-staging
# Optional preview API (staging only):
# RETELL_TOOL_BASE_URL=https://<preview>.vercel.app node scripts/push-retell.mjs push demo-voice-staging
# Never point the live +15169731973 agent (demo-voice) at a preview URL.
#
# Lines:
#   +15169731973  OwnerAI website demo line     → demo-voice
#   +15169613838  OwnerAI Testing Line          → demo-voice-staging

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
```

After changing `demo-voice.prompt.md`, sync+run sims before considering the change done.

**CI:** GitHub Actions runs unit + sim-case sanity on every PR/push to `main`/`dev`
(`.github/workflows/ci.yml`). The full Retell pack runs weekly (Monday) and on
manual `workflow_dispatch` (`.github/workflows/demo-sims.yml`) using the repo
secret `RETELL_API_KEY` (OwnerAI demo workspace only — never a client key).

**Human QA:** [`docs/ops/demo-qa-scorecard.md`](../docs/ops/demo-qa-scorecard.md) +
weekly paste prompt [`docs/ops/demo-agent-health-prompt.md`](../docs/ops/demo-agent-health-prompt.md).

Demo-voice uses a single Retell LLM with **Flow: Sample send** and **Flow: Setup book**
step sections (deterministic tool paths inside the prompt). Full Retell Conversation
Flow product migration stays deferred — Wave B sims are green (14/14 including
failure paths); revisit only if packs start failing on tool skip / wrong tool.

## Troubleshooting history

To see when a prompt line changed and why: `git log -p -- retell/demo-voice.prompt.md`
or `git blame retell/demo-voice.prompt.md`.
