# Post-mortem: Failed live demo on the OwnerAI demo line

**Date of call:** 2026-09-10, ~6:38 PM ET
**Call ID:** `call_0f7c37c356ed4fcd62c60c28181`
**Agent:** OwnerAI Tools — Website Demo Line (`agent_fcec78e0c72574d61945abdbf3`, v0)
**LLM:** `llm_6d96c220b0b8da0889b76e16e5c5` (gpt-4.1)
**Direction:** Inbound to +15169731973 from +15165079380
**Duration:** 5 min 12 s, ended by caller hangup mid-agent-sentence
**Context:** Founder was demoing the system live to a prospect (commercial cleaning business). The demo failed to convert.

**Severity: SEV-1 for the business.** The product's core pitch — "handles every caller just like a sharp human receptionist" — visibly failed in front of a prospect. Retell's own post-call analysis scored the call "successful / positive sentiment / hot lead," which is wrong and itself a finding (see Failure 7).

---

## Executive summary

Four distinct system failures compounded during one live demo:

1. Spanish was requested repeatedly and never worked — the ASR misheard "hablo español" five times.
2. Caller and agent talked over each other for the whole call (14 of 68 speaker transitions overlapped) because interruption sensitivity, responsiveness, and backchannel are all tuned near maximum.
3. ~15 seconds of dead air after the caller gave their email — the agent is configured to stay silent during `send_demo_alert`, and the webhook runs four network legs sequentially before answering. The demo operator had to ask "Did you get that?"
4. Every agent turn was slow (median 2.0 s, p90 3.1 s from caller-stops-talking to agent-audio) — driven by a 39,000-character system prompt on gpt-4.1 — while the agent's own opening pitch claims "picks up in under two seconds."

The one thing that worked: the lead-alert SMS and owner email both delivered correctly with accurate role-play data.

**Call score: 2/10.** Lead alert delivery earns the 2. The demo failed at its only job.

---

## Timeline (from word-level transcript timestamps)

| Time | Event |
|---|---|
| 0:00–0:30 | Greeting and pitch OK. First slow turn (2.4 s gap). |
| 0:30–1:35 | **Spanish meltdown.** Caller says "No, hablo español" — ASR transcribes it as "No, I've let you guys" five separate times (and "I've let español" once). Agent loops through clarifying questions, switches to Spanish only after the caller says "Only Spanish" in English, then falls back into confusion on the next misheard utterance. Caller gives up: "Can you speak English?" ~65 s (21% of the call) burned. |
| 1:35–3:55 | Role-play demo (KK Cleaning). Content is good — name, address, job details captured. But every agent turn lags 1.8–4.2 s and there are repeated talk-overs, including the agent splitting one sentence around a caller interjection ("Got it, a retail … space."). |
| 3:55–4:29 | Caller asks for sample text + email. Agent promises "I'll read it back to make sure it's correct before sending" — then never reads the email back. |
| 4:29–4:45 | **Dead air.** Caller finishes "gpearl383@gmail.com" at 4:29.6. Agent says nothing for ~15.5 s while `send_demo_alert` executes. Caller has to prompt twice: "Did you get that?" (4:41.9) and "Sent." (4:43.1). Agent finally confirms at 4:45.1. |
| 4:45–5:12 | **Ragged close.** Sends verified ("Amazing" / "Wow" — social smoothing, not satisfaction). Agent pitches the setup call twice back-to-back, gets barged in twice, produces stranded fragments ("If you", "Glad you're"), caller hangs up mid-fragment. No setup call booked. |

Measured turn-taking data: 18 agent responses had >1.5 s of silence after the caller finished (several 2.5–4.2 s); 14 of 68 role transitions had overlapping speech.

---

## Failures, root causes, and fixes

### Failure 1 — Spanish did not work despite multiple attempts

**What happened:** "No, hablo español" was transcribed as "No, I've let you guys" five times. The agent, seeing English text, kept asking clarifying questions in English. Even after switching to Spanish it could not understand the caller's Spanish replies, and the caller had to rescue the demo by returning to English.

**Why:**
- The agent is configured for multi-language (`language: ["en-US", "es-ES", "zh-CN"]`), but in practice the transcription layer stayed English-biased and rendered Spanish speech as phonetically-similar English words. No `boosted_keywords`, no `stt_mode`/`vocab_specialization` tuning is set.
- The LLM has no defense: the prompt says "If the caller speaks Spanish, switch to Spanish seamlessly," but the LLM only ever sees the (wrong) English transcription, so from its point of view the caller never spoke Spanish. There is no instruction to recognize garbled/repetitive transcripts as a possible language mismatch.

**Fix:**
1. Test Retell's multi-language transcription for en/es specifically on this agent (web-call test saying "hablo español"). If mid-call language switching is unreliable in the current config, evaluate `stt_mode: accurate` and/or restricting the language list to `en-US` + `es-ES` (dropping `zh-CN` reduces detection ambiguity).
2. Add `boosted_keywords` for the phrases that gate the language switch: "español", "hablo español", "en español".
3. Prompt defense in `retell/demo-voice.prompt.md`: if the same short unintelligible phrase repeats 2+ times, or anything resembling "español"/"Spanish" appears, explicitly offer: "¿Prefieres continuar en español?" instead of asking English clarifying questions.
4. Add a Spanish-switch regression case to `retell/simulations/demo-voice.cases.json`.

### Failure 2 — Constant talk-over and sentence fragments

**What happened:** 14 of 68 speaker transitions overlapped. The agent repeatedly started speaking while the caller was mid-thought, got cut off into fragments ("Of", "If you", "Glad you're"), and split its own sentences around caller interjections. The final 25 seconds were unrecoverable fragment exchanges ending in a hangup.

**Why:** Three settings compound on the live agent:
- `interruption_sensitivity: 0.9` — the agent aborts its own speech at the slightest caller sound, producing the stranded fragments.
- `responsiveness: 1` (maximum) — the agent jumps in at the smallest pause, so any caller hesitation ("I own a—") triggers an agent turn on top of the caller's continuation.
- `enable_backchannel: true` at `backchannel_frequency: 0.7` — frequent "mm-hm" injections add more overlap opportunities.
- Compounded by Failure 4: because responses arrive 2–4 s late, the agent is often answering a stale utterance just as the caller starts a new one.

**Fix:** Tune the live agent (and mirror in `retell/demo-voice.config.json`): `responsiveness` ≈ 0.7, `interruption_sensitivity` ≈ 0.6, `backchannel_frequency` ≈ 0.3. Re-test with a live call; these interact, so tune as a set.

### Failure 3 — ~15 seconds of dead air during the sample send; operator had to ask "Did you get that?"

**What happened:** After the caller gave their email, the line went silent for ~15.5 s while `send_demo_alert` ran. In a live demo this read as the system freezing.

**Why — two stacked causes:**
1. **Configured silence.** The `send_demo_alert` tool has `speak_during_execution: false` with the instruction "Stay silent while the samples send; you will narrate the result after the tool returns." That choice assumed a fast tool.
2. **The tool is slow by construction.** `api/demo-alert.mjs` runs up to four legs *sequentially*, each awaited before the response returns: (1) lead-alert SMS via Retell `create-sms-chat` **plus an awaited `end-chat` cleanup call**, (2) optional appointment SMS, (3) optional ICS invite via Resend, (4) owner email via Resend — then an awaited Supabase audit insert. That's 5–7 serial network round-trips; the call's LLM latency max of 11.4 s (p99 8.7 s vs p50 0.76 s) is this turn. Tool timeout is 20 s, so nothing failed — it just took forever, silently.

**Fix:**
1. Set `speak_during_execution: true` with an execution message like "One sec — sending your sample text and email right now…" (mirror `check_availability`, which already does this).
2. In `api/demo-alert.mjs`: run the independent legs concurrently with `Promise.allSettled` (SMS legs share a budget and must stay ordered relative to each other, but SMS / invite / email are independent); make the `end-chat` cleanup and the Supabase audit insert fire-and-forget (`waitUntil` on Vercel) instead of awaited before the tool response.
3. Target: tool response in < 3 s.

### Failure 4 — Every turn was slow (agent claims sub-2 s pickup, measured median was 2.0 s, p90 3.1 s)

**What happened:** 18 turns had >1.5 s silence before the agent responded; the worst mid-conversation gaps were 3.2–4.2 s. This made the agent feel sluggish and directly fed the talk-over loop (Failure 2).

**Why:** The Retell LLM's `general_prompt` is 39,155 characters (~10k tokens) processed by gpt-4.1 on every single turn. That inflates time-to-first-token and cost — the largest line item on this call was the LLM token surcharge ($0.41 of the $1.33 total; ~25.6¢/min all-in).

**Fix:**
1. Slim the prompt: move `retell/industry-knowledge.md`-style reference content out of the every-turn prompt (Retell knowledge base or state-scoped prompts) and cut redundant instruction blocks. Target under ~15k characters.
2. Evaluate a faster model for the demo line (e.g. gpt-4.1-mini or Retell's current low-latency recommendation) — the demo script is structured enough that the smaller model likely holds up; verify with the simulation suite.

### Failure 5 — Agent broke an explicit promise (email read-back)

**What happened:** Agent said "I'll read it back to make sure it's correct before sending," then invoked the tool without reading `gpearl383@gmail.com` back. A mis-transcribed email would have silently gone to the wrong address.

**Why:** The prompt makes read-back optional: "collect address; read it back with spaced letters if helpful." The LLM treated it as skippable while simultaneously promising it aloud.

**Fix:** In `retell/demo-voice.prompt.md`, make the read-back mandatory and sequenced: confirm the address back to the caller and get a "yes" **before** calling `send_demo_alert` with an email.

### Failure 6 — Ragged close, no conversion

**What happened:** After send confirmation, the agent pitched the setup call twice within ~8 seconds, talked over the caller's reactions, and the call died in fragments. `wants_setup_call: false`, no booking.

**Why:** Mostly downstream of Failures 2 and 4 (late, eager, interruptible turns). The prompt also pushes the setup-call ask immediately after samples send, leaving no beat for the caller to react.

**Fix:** Prompt: after confirming the samples sent, pause for the caller's reaction; make the setup-call ask once, concisely; if interrupted, do not restart the pitch. Retest after Failure 2/4 fixes land, since they are the main drivers.

### Failure 7 (meta) — Retell's post-call analysis called this a success

**What happened:** `call_successful: true`, `user_sentiment: Positive`, `lead_quality: hot`. The caller's "Wow" / "Amazing" was read as satisfaction; in reality it was the demo operator being polite while the demo failed.

**Why:** The sentiment/success classifier only sees transcript words. It has no signal for latency, dead air, talk-over, mishearing loops, or who was actually on the call.

**Fix:** Do not use `call_successful`/`user_sentiment` as demo-quality QA. Add objective custom analysis fields or offline checks that catch the mechanical failures: count of >1.5 s response gaps, overlap count, repeated-clarification loops, max tool-turn silence. (The gap/overlap numbers in this doc came from the word-level timestamps in `transcript_object` — that computation can be scripted for any call.)

---

## What worked

- `send_demo_alert` delivered both the lead-alert SMS and the owner email with correct captured data (name, business, address, job details), and the caller-ID fallback for "text the number I'm calling from" worked as designed.
- Role-play content quality was good: natural questions, correct captures, spoken-form address readback.
- Guardrails (budget, signature verification, number matching) did not misfire.

---

## Action items (priority order)

| # | Action | Where | Addresses |
|---|---|---|---|
| 1 | Turn-taking tuning: responsiveness ~0.7, interruption sensitivity ~0.6, backchannel ~0.3 | Retell agent + `retell/demo-voice.config.json` | F2, F6 |
| 2 | `speak_during_execution: true` + filler line on `send_demo_alert` | Retell LLM tool config | F3 |
| 3 | Parallelize send legs; fire-and-forget end-chat + audit insert | `api/demo-alert.mjs` | F3 |
| 4 | Spanish: verify multi-language STT, add boosted keywords, prompt fallback to offer Spanish on repeated garble | Retell agent + `retell/demo-voice.prompt.md` | F1 |
| 5 | Slim 39k-char prompt; evaluate faster model | Retell LLM + `retell/demo-voice.prompt.md` | F4, cost |
| 6 | Mandatory email read-back before send | `retell/demo-voice.prompt.md` | F5 |
| 7 | Post-demo close: one ask, pause for reaction | `retell/demo-voice.prompt.md` | F6 |
| 8 | Add Spanish-switch + tool-silence simulation cases | `retell/simulations/demo-voice.cases.json` | F1, F3 regression |
| 9 | Scripted call QA (gap/overlap/silence metrics) instead of trusting Retell sentiment | new script | F7 |

**Re-verification bar:** a full live test call that (a) switches to Spanish and back successfully, (b) has zero silent stretches > 3 s, (c) has no agent sentence fragments from talk-over, and (d) ends with a clean setup-call ask.

---

## Implementation status (2026-09-10)

Items 1, 2, 3, 4 (partial), 6, 7, and 8 were implemented and pushed the same evening:

- `retell/demo-voice.config.json` — `responsiveness: 0.7`, `interruption_sensitivity: 0.6`, `backchannel_frequency: 0.3`, `boosted_keywords` (español phrases), `send_demo_alert.speak_during_execution: true` with a spoken filler line.
- `scripts/push-retell.mjs` — the new agent fields added to the managed `AGENT_KEYS` so they push/diff like everything else.
- `retell/demo-voice.prompt.md` — garbled-speech → offer-Spanish fallback; mandatory email read-back before `send_demo_alert`; post-send close: one ask, pause for reaction, never restart an interrupted pitch.
- `api/demo-alert.mjs` — SMS legs and email legs now run as two parallel chains; end-chat cleanup and the audit insert overlap with the response path instead of running serially (was 5–7 serial round trips ≈ 11 s observed; unit test confirms parallel execution). Goes live with the next production deploy.
- `retell/simulations/demo-voice.cases.json` — new `spanish-switch` regression case.
- `scripts/test-demo-alert-parallel.mjs` — new unit test (concurrency + unchanged result-text/budget contract).

Deferred: prompt slimming + model evaluation (Failure 4 root cause) and the scripted call-QA metrics (item 9).

## Rollback plan

- **Retell config/prompt:** prompts-as-code is the rollback path — `git revert` the commit, `node scripts/push-retell.mjs push demo-voice`. Under a minute, affects both DIDs. Before the change was pushed, `push-retell.mjs diff` confirmed live matched the repo (only benign Retell-side normalization on `live_transfer`, which the repo now mirrors).
- **`api/demo-alert.mjs`:** inert until the next production Vercel deploy. If it misbehaves after deploy: instant rollback to the previous deployment in Vercel, or `git revert` + redeploy. The refactor does not touch guards, budgets, or the tool result-text contract.

## Validation

- Local: full suite green (`test-demo-limits`, `assert-demo-sim-cases` 22 cases, `test-retell-tool-base`, `test-retell-transfer-phone`, `test-testing-line`, `test-demo-alert-parallel`).
- Post-push: live agent + LLM fields verified via GET; Retell simulation pack run (see terminal/commit notes).
- **Outstanding — live call:** turn-taking feel, real Spanish ASR, and actual send-gap timing are audio-path properties sims cannot exercise. Final check is a live call to the testing line (+15169613838): say "hablo español" mid-call, run a role-play, request samples, time the gap. Compare against the re-verification bar above using the word-level timestamp analysis from this post-mortem.
