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

# 3. Push to the live agents (RETELL_API_KEY required)
node scripts/push-retell.mjs push            # all agents
node scripts/push-retell.mjs push demo-voice # one agent

# Check for drift between live and repo (e.g. someone edited the dashboard)
node scripts/push-retell.mjs diff

# Re-import live state into the repo (only when adopting external changes)
node scripts/push-retell.mjs pull

# Sync / run Retell LLM simulations for demo-voice (after prompt push)
RETELL_API_KEY=... node scripts/sync-demo-sims.mjs
RETELL_API_KEY=... node scripts/sync-demo-sims.mjs --run
```

Demo-voice uses a single Retell LLM with **Flow: Sample send** and **Flow: Setup book**
step sections (deterministic tool paths inside the prompt). Full Conversation Flow
migration is deferred until sims show remaining skip/wrong-tool issues.

## Troubleshooting history

To see when a prompt line changed and why: `git log -p -- retell/demo-voice.prompt.md`
or `git blame retell/demo-voice.prompt.md`.
