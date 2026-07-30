# OwnerAI demo line — QA scorecard

**Line:** +1 (516) 973-1973  
**Scope:** OwnerAITools demo agents only (not OwnerAI-Deployments clients).

Use this weekly (or after any `push-retell` of demo-voice / sms-receptionist). Score the last ~20 real `call_analyzed` / `sms_chat_analyzed` rows in Supabase project `wumwodvmsjfuifuhxbuj`, plus one mystery-shop if a dimension is weak.

## Dimensions (0–2 each)

| Dimension | 0 | 1 | 2 |
|-----------|---|---|---|
| Greeting / identity | Broken or invented staff names | OK but stiff / repeated intro | Clear AI receptionist, no invented people |
| Clarify-before-CSM | Jumps to CSM on product/industry words | Clarifies late or inconsistently | Asks equipment vs receptionist before referring |
| Sample path | Skips tool, invents excuses, wrong channel rules | Tool used but shaky disclosure | Correct security rule + tool + honest result |
| Setup book | Invents slots or skips tools | Tools used with friction | `check_availability` → pick → `book_setup_call` |
| Reclaim / close | Goes silent after praise / no next step | Soft close only sometimes | Reclaims after praise; offers sample or setup |
| Guardrails | Invented prices, balances, or personnel | Minor drift | Stays on prompt facts |

**Pass bar:** average ≥ 1.5 and no dimension at 0 on a live mystery-shop.

## Cadence

1. **Weekly** — paste the prompt in [`demo-agent-health-prompt.md`](demo-agent-health-prompt.md) into a Cursor chat on OwnerAITools.
2. **After prompt push** — run `node scripts/sync-demo-sims.mjs --run` (or wait for Monday CI `demo-sims`).
3. **Monthly** — one live mystery-shop call + one SMS thread.

## Automated coverage (not a substitute)

- Unit: `node scripts/test-demo-limits.mjs`, `node scripts/assert-demo-sim-cases.mjs`, `node scripts/test-retell-tool-base.mjs`
- Retell pack: 14 cases in `retell/simulations/demo-voice.cases.json` (includes failure paths)
- Infra probes: `/api/monitor` (ops uptime, not conversation QA)
