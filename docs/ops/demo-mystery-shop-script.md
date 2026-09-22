# Demo line — regression test script (post Double V / accuracy audit)

**Call:** `+1 (516) 961-3838` (testing DID — same agents as public `973-1973`)  
**Avoid** the public website number for QA when possible.  
**Goal:** Confirm today’s fixes work and nothing critical regressed.  
**Pass rule:** Every required row in the scorecard is Pass before any real prospect demo.

After the call, paste the **Retell Call ID** (dashboard → Calls) into chat so the agent can score `transcript_object` with `call-quality.mjs`.

**Rollback** (if this test fails badly): see [`demo-rollback-pre-double-v.md`](./demo-rollback-pre-double-v.md) — restores to commit `b0f1bb3` (before today’s Robert Viola / Double V reliability + accuracy work).

---

## Setup (2 min)

- [ ] Phone that can receive SMS (cell) **or** plan to stay on the landline path only
- [ ] Email inbox open (Gmail fine)
- [ ] Quiet room; plan to interrupt mid-sentence twice
- [ ] Optional: second device to watch for SMS while on the call

**What “good” feels like**

- Agent responds in ~1–2s, not 3–4s dead air
- Speaks a short filler while samples send (“One sec — sending…”)
- Never invents junk/spam excuses for missing **SMS**
- Never texts a number that isn’t the one you’re calling from

---

## Call script (say roughly this)

### 1. Greeting (~15s) — required

- Let them finish, **or** barge in once with: **“Hello?”**
- Then: **“Hi — what do you guys do?”**

| Check | Pass / Fail |
|-------|-------------|
| Clean AI receptionist intro (no invented owner/staff names) | |
| No broken mid-word greeting fragments | |

---

### 2. Spanish switch (~45s) — required

- After their pitch: **“No… hablo español.”**
- Then only Spanish: **“¿Cuánto cuesta el servicio?”**
- Then: **“Can we switch back to English?”**

| Check | Pass / Fail |
|-------|-------------|
| Switches (or offers Spanish) within **one** turn of “hablo español” | |
| Never says it can’t speak Spanish | |
| No price invented — pushes to free setup call | |
| Switches back to English cleanly | |

---

### 3. Interruption feel (~30s) — required

- **“Tell me what’s in the Advanced plan.”**
- Interrupt twice mid-sentence: **“wait—”** then **“actually—”**
- Let them finish one clean sentence

| Check | Pass / Fail |
|-------|-------------|
| No stranded fragments (“Of”, “If you”, “Glad you’re”) | |
| Doesn’t restart the whole pitch after each interrupt | |
| Feels responsive, not sluggish (no multi-second freezes) | |

---

### 4. Double V landline path (~60s) — required  
*(this is the Robert Viola failure mode)*

- **“I want a sample of the owner alert text.”**
- When they ask if the calling number is a cell:  
  **“No — this is my office landline / desk phone.”**
- Agree to email when offered

| Check | Pass / Fail |
|-------|-------------|
| Does **not** send SMS after landline | |
| Offers email instead (no “different cell”) | |
| Does not go silent >3s waiting on a tool | |

---

### 5. Email sample + read-back (~90s) — required

- Spell a real email slowly (letter by letter for the part before `@`)
- Wait for read-back
- Confirm **“Yes”**
- Stay quiet and listen during send

| Check | Pass / Fail |
|-------|-------------|
| Reads email back (spaced letters) **before** sending | |
| Speaks a filler while sending (not dead air) | |
| Honest result (“Sent” / “still sending — can take a minute”) | |
| Email actually arrives (check inbox / junk once if needed) | |
| Silent stretch during send **≤ 3 seconds** | |

---

### 6. One-ask close (~20s) — required

- After send confirm, **pause** — let them ask about setup once
- Say: **“Let me think about it.”**
- If they re-pitch: **“I already heard that.”**

| Check | Pass / Fail |
|-------|-------------|
| Setup ask happens **once** | |
| Stops when interrupted — no pitch restart | |

---

### 7. Happy-path SMS sample (optional if you have a cell) (~60s)

Do this on a **second short call** if the first call already burned the landline path.

- Call again from a **cell**
- Ask for sample text → confirm calling number is a cell → yes
- After “Sent,” wait up to ~60s for SMS
- If missing: say **“I didn’t get the text.”**

| Check | Pass / Fail |
|-------|-------------|
| Discloses “only the number you’re calling from” before send | |
| SMS arrives (or agent says it can take up to a minute — **no** junk/carrier excuses) | |
| Offers email backup once if text missing | |

---

### 8. Setup book (optional weekly) (~2 min)

- **“Actually yes — let’s book a 15-minute setup.”**
- Give name + business
- Pick **first** real slot they offer
- Confirm email spelling → book → check Cal.com invite

| Check | Pass / Fail |
|-------|-------------|
| Uses live calendar (no invented times) | |
| Invite arrives at the confirmed email | |

---

## Final scorecard (all required rows must Pass)

| # | Required check | Pass? |
|---|----------------|-------|
| 1 | Greeting / identity | |
| 2 | Spanish ≤1 turn | |
| 3 | Interruptions / no fragments | |
| 4 | Landline → email (no SMS) | |
| 5 | Email read-back + ≤3s send silence | |
| 6 | One setup ask / no restart | |

**Call ID:** `________________________________`

**Verdict:** ☐ PASS — ok for prospect demos ☐ FAIL — do not demo; roll back or fix

---

## Local checks (no phone) — run anytime

From repo root:

```bash
node scripts/assert-demo-sim-cases.mjs
node scripts/test-call-quality.mjs
node scripts/test-demo-alert-disclosure.mjs
node scripts/test-demo-alert-compose-wait.mjs
node scripts/test-demo-alert-normalize.mjs
node scripts/test-demo-alert-parallel.mjs
node scripts/test-webhook-consent-gates.mjs
node scripts/push-retell.mjs diff demo-voice
```

`diff` must say `demo-voice: in sync` (live matches repo).

---

## If the call fails

1. **Do not** put a prospect on the line.
2. Open [`demo-rollback-pre-double-v.md`](./demo-rollback-pre-double-v.md) and restore to `b0f1bb3`.
3. Re-run segments 4–6 at minimum (Double V path + email send).
