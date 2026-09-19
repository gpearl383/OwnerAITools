# Mystery-shop script — OwnerAI demo line accuracy bar

**Number:** `+1 (516) 961-3838` (testing DID — same production agents as the public demo)  
**Do not use** `+1 (516) 973-1973` for this QA call if you can avoid it (keeps public line free).  
**Pass bar (from Sep-10 postmortem):** (a) Spanish switch works, (b) zero silent stretches >3s, (c) no agent sentence fragments from talk-over, (d) clean one-ask setup close. Plus Sep-18: landline → email without SMS.

After the call, send the Call ID (from Retell dashboard or your phone log time) to the agent so they can pull `transcript_object` and run `api/lib/call-quality.mjs`.

---

## Before you dial

1. Have a **cell** and a way to receive SMS (for later segments if you flip channels).
2. Have an email you can open (Gmail is fine).
3. Be ready to speak Spanish briefly (Segment A).
4. Be ready to interrupt mid-sentence twice (Segment B).

---

## Segment A — Spanish switch (~30–45s)

1. Let the greeting finish (or say “Hello?” once if you barge in).
2. Ask in English: **“Hi, what do you guys do?”**
3. After their answer, say clearly: **“No… hablo español.”**
4. Continue **only in Spanish** for 1–2 turns (e.g. ask what it costs: “¿Cuánto cuesta?”).
5. Then say: **“Can we switch back to English?”**

**Pass:** Agent offers/switches to Spanish within one turn of “hablo español”; never claims it cannot speak Spanish; pricing stays “setup call” with no invented dollars.

**Fail:** English clarifying loop; “I’ve let you guys”-style confusion; stays English after Spanish request.

---

## Segment B — Interruption / no fragments (~30s)

1. Ask them to explain Advanced features.
2. **Interrupt mid-sentence twice** with short phrases (“wait—” / “actually—”).
3. Let them finish one clean sentence.

**Pass:** No stranded fragments (“Of”, “If you”); agent recovers without restarting the whole pitch.

**Fail:** Repeated talk-over fragments; agent piles pitches on top of you.

---

## Segment C — Landline SMS → email (~45s)

1. Say you want a **sample owner alert text**.
2. When they ask if you’re calling from a cell: **“No — this is my office landline / desk phone.”**
3. Agree to **email** instead when offered.

**Pass:** No SMS send attempt after landline; switches to email offer.

**Fail:** Tries to text anyway; invents another cell to text.

---

## Segment D — Email sample + mandatory read-back (~60s)

1. Spell an email slowly (use a real inbox), e.g. letter-by-letter local part.
2. Wait for them to **read it back** with spaced letters and ask you to confirm.
3. Say **yes**, then wait for send.

**Pass:** Read-back happens **before** send; you hear a short filler while sending (“One sec — sending…”); confirmation is honest (Sent / still sending — not silent >3s).

**Fail:** Sends without read-back; ~15s dead air; says Sent when nothing arrived.

---

## Segment E — One-ask close (~20s)

1. After send confirmation, **pause** — let them ask about a setup call once.
2. Say: **“Let me think about it.”**
3. If they restart the full pitch, interrupt: **“I already heard that.”**

**Pass:** Exactly one setup ask; stops when you interrupt; no pitch restart.

**Fail:** Double pitch within seconds; talks over your reaction.

---

## Segment F — Setup book (optional if time; do at least once this week)

1. Say yes to a 15-minute setup.
2. Give name + business.
3. Pick the **first** slot they offer from the tool (not invented times).
4. Confirm email spelling; complete booking.
5. Check inbox for Cal.com invite.

**Pass:** `check_availability` then `book_setup_call`; invite arrives; no invented slots.

---

## After the call — score checklist

| Check | Pass? |
|---|---|
| Spanish switch ≤1 turn | |
| No silent stretch >3s (esp. during send) | |
| No talk-over fragments | |
| Landline → email (no SMS) | |
| Email read-back before send | |
| One setup ask; no restart | |
| (Optional) Setup booked + invite | |

Paste Call ID here: `____________________________`

Agent will run:

```bash
# After fetching the call JSON from Retell:
node -e "import { computeCallQuality } from './api/lib/call-quality.mjs'; ..."
```

**Do not demo to a real prospect until this scorecard is all Pass.**
