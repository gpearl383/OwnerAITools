# Weekly demo-agent health prompt (copy/paste)

Open Cursor on **OwnerAITools** (not Deployments). Paste into a new agent chat weekly (or after any prompt push). Ask for a report first; only implement if you say go.

Also fill [`demo-qa-scorecard.md`](demo-qa-scorecard.md) from the live-health section.

```text
You are doing a recurring OwnerAI DEMO LINE health + development review.

Scope: OwnerAITools only — demo line +15169731973 / retell/manifest.json agents.
Out of scope: OwnerAI-Deployments clients, Jarvis, purchases.

Follow this Agent Delivery Loop: observe → score → gap → recommend (implement ONLY if I say go).

1) LIVE HEALTH (last 7 days)
- Query Supabase project wumwodvmsjfuifuhxbuj: recent call_analyzed / sms_chat_analyzed / email_failed / sms_failed / demo_alert_* / setup_call_booked / webhook_duplicate_skipped / unverified_info_flagged.
- Summarize volume, book rate, sample-send rate, failure rate, hallucination flags.
- Note any call that looks like a bad demo (no reclaim, invented facts, no close).
- Score using docs/ops/demo-qa-scorecard.md dimensions (0–2).

2) AGENT DRIFT
- Diff retell/demo-voice.prompt.md + sms-receptionist.prompt.md vs last known hard rules (identity, reclaim, regulated, anti-hallucination, sample-budget vs booking, CSM clarify).
- Compare retell/simulations/demo-voice.cases.json: every hard-rule section must have a sim; list missing cases.
- Check scripts/push-retell.mjs diff if RETELL_API_KEY is available (live vs repo).

3) RELIABILITY CHECKLIST
- Webhook started→ok markers healthy (no stuck started >2 min)?
- Demo sample budgets still durable (demo_sample_budgets)?
- Tool URLs: RETELL_TOOL_BASE_URL / push-retell rewrite still defaulting to production for live agents?
- Unit scripts scripts/test-*.mjs still runnable?

4) EVALS
- If RETELL_API_KEY present: run node scripts/sync-demo-sims.mjs --run (or report why skipped).
- Run node scripts/test-demo-limits.mjs, scripts/assert-demo-sim-cases.mjs, scripts/test-retell-tool-base.mjs.

5) OUTPUT FORMAT (keep short)
- Scorecard (0–10): Reliability / Conversion / Guardrails / Eval coverage
- Top 3 incidents or risks from the last week
- Top 3 recommended next improvements (P0/P1), with file paths
- One mystery-shop script I can call/text today to validate the weakest area
- Do NOT implement changes unless I reply "go" or "implement …"
```
