# Rollback: before Robert Viola / Double V (2026-09-18)

**Safe restore point:** git commit `b0f1bb3`  
`Merge pull request #12 from gpearl383/feat/industry-agent-knowledge`  
(Sep 10 postmortem fixes — **before** today’s reliability PR #13 and the accuracy-audit Retell push)

| Layer | Current (as of audit) | Rollback target |
|-------|------------------------|-----------------|
| Retell `demo-voice` | Slim prompt (~15.7k) + `stt_mode: accurate` + en/es only (pushed from `2cb17b8`) | Prompt/config from `b0f1bb3` (~41k with industry knowledge, en/es/zh, no `stt_mode`) |
| Vercel production | `562b3a3` (PR #13 reliability) | Deployment on `b0f1bb3` — `dpl_HyZpmLQMdaQbzuTZjQAM3jrYJ5At` |
| Supabase `quality_metrics` column | Added (harmless if unused) | Leave in place (additive; no need to drop) |

**Do not roll back** unless a mystery-shop fails or you need the pre–Double V behavior for a live demo **tonight**. Prefer fixing forward when possible — rolling back removes today’s landline/SMS server gates.

---

## A. Retell rollback (prompt + agent config) — ~1 minute

Run from OwnerAITools with demo `RETELL_API_KEY` in `.env.local`:

```bash
# 1. Snapshot current live files (optional safety net)
mkdir -p /tmp/ownerai-retell-backup-$(date +%Y%m%d)
cp retell/demo-voice.prompt.md retell/demo-voice.config.json \
  /tmp/ownerai-retell-backup-$(date +%Y%m%d)/

# 2. Restore retell demo-voice files from pre–Double V commit
git checkout b0f1bb3 -- retell/demo-voice.prompt.md retell/demo-voice.config.json

# 3. Commit so push-retell will accept (requires clean retell/ mapping to a commit)
git add retell/demo-voice.prompt.md retell/demo-voice.config.json
git commit -m "Rollback demo-voice Retell config to pre-Double-V (b0f1bb3)"

# 4. Push to live agents (both DIDs). Use --force if sim gate blocks.
node scripts/push-retell.mjs push demo-voice --force

# 5. Confirm
node scripts/push-retell.mjs diff demo-voice
# expect: demo-voice: in sync
```

To **re-apply** the accuracy-audit Retell state later:

```bash
git checkout 2cb17b8 -- retell/demo-voice.prompt.md retell/demo-voice.config.json
# commit + push --force as above
```

---

## B. Vercel production rollback (API / webhook) — dashboard or CLI

**Preferred (dashboard):**  
Vercel → project `owneraitools` → Deployments → find deployment  
`dpl_HyZpmLQMdaQbzuTZjQAM3jrYJ5At` (commit `b0f1bb3`, “PR #12 …”) → **Promote to Production** / Instant Rollback.

**Or** ask the agent to run Vercel `request_rollback` / promote that deployment ID after you type:

`APPROVE VERCEL ROLLBACK TO b0f1bb3`

That restores API behavior from **before** today’s server SMS gates / compose-poll / ANI consent (PR #13).

---

## C. What you get back / what you lose

**Restored (pre–Double V):**

- Sep 10 turn-taking / filler-on-send / Spanish prompt fallback
- Larger every-turn prompt (slower LLM turns — known tradeoff)

**Lost if you roll back Retell + Vercel:**

- Server `caller_confirmed_calling_number` SMS gate
- Compose-wait before saying “Sent”
- Landline prompt/server branch and ANI booking-SMS gates
- Slim prompt + `stt_mode: accurate` + dropped Mandarin
- Post-call `call_quality` alerts (webhook) until you re-deploy forward

---

## D. Smoke test after rollback

Run segments **4–6** only from [`demo-mystery-shop-script.md`](./demo-mystery-shop-script.md) (landline → email → read-back → one-ask).  
If those pass, the line is at least as good as “before Robert called.” If Spanish still fails, that’s the known Sep 10 ASR gap — not introduced today.

---

## E. Agent one-liner (paste when you want rollback executed)

> Roll back demo-voice Retell to `b0f1bb3` and promote Vercel deployment `dpl_HyZpmLQMdaQbzuTZjQAM3jrYJ5At`.  
> Approval: `APPROVE VERCEL ROLLBACK TO b0f1bb3` and `APPROVE MULTI-FILE CHANGE` for the retell checkout/commit.
