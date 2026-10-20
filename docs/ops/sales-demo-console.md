# Sales Demo Console


**Host:** [demo.owneraitools.com](https://demo.owneraitools.com) — Vercel project `ownerai-demo` (separate from marketing `owneraitools.com`).
Non-technical sales surface for 14-day trials. **Not** the Control Plane and **not** the ops `/dashboard`.

| URL | Purpose |
|-----|---------|
| `/sales` | Paint Demo Slot 1, start/reset trial |
| `/portal` | Read-only client view (stats, queue, transcripts) |
| Website demo `(516) 973-1973` | Stays OwnerAI pitch — **never** bind trial agents here |
| Trial voice `(516) 475-5855` | Sales trial — Retell workspace **`ownerai-demo`** |

## Isolation

| Surface | Retell workspace | Env key | Number | Webhook |
|---------|------------------|---------|--------|---------|
| Website pitch | OwnerAITools website org | `RETELL_API_KEY` | `+15169731973` | `/api/retell-webhook` |
| Sales trial | **ownerai-demo** | `TRIAL_RETELL_API_KEY` | `+15164755855` | `/api/trial-webhook` |

- Trial alerts go to the **slot owner**, not `OWNERAI_ALERT_PHONE`
- Leads/events tagged with `slot_id` so `/portal` never shows website-demo traffic
- Sales cookie `oat_sales` is separate from ops `oat_dash`
- **Voice-only** on the trial line until SMS/A2P is registered on `+15164755855`

## Setup checklist

1. Retell workspace **`ownerai-demo`**: trial voice agent bound to `+15164755855` (already done; do not reuse website `RETELL_API_KEY` for this).
2. Vercel / local env (OwnerAITools project):
   - `TRIAL_RETELL_API_KEY` — ownerai-demo API key (**not** the website demo key)
   - `TRIAL_SLOT_E164=+15164755855`
   - `TRIAL_VOICE_AGENT_ID` / `TRIAL_VOICE_LLM_ID` (defaults live in `api/lib/demo-slots.mjs`)
   - `SALES_SESSION_SECRET` (or reuse `DASHBOARD_SESSION_SECRET`)
   - Existing: `SUPABASE_*`, website `RETELL_API_KEY`, `RESEND_API_KEY`
3. Leave website `RETELL_API_KEY` unchanged.
4. Create a sales user login:
   ```bash
   # needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SALES_SESSION_SECRET
   # Preferred: email them a set-password link (also needs RESEND_API_KEY)
   node scripts/create-sales-user.mjs --invite sales@example.com Sales
   # Re-send / rotate a pending invite:
   node scripts/create-sales-user.mjs --invite --resend sales@example.com

   # Or set a known password yourself:
   node scripts/create-sales-user.mjs sales@example.com 'strong-password' Sales
   ```
   Invitees open `/set-password?token=…` on demo.owneraitools.com, then sign in at `/sales`.
   Optional first-login bootstrap (`SALES_BOOTSTRAP_EMAIL` + `SALES_BOOTSTRAP_PASSWORD`) runs **only when `sales_users` is empty** — remove those env vars from Vercel after the first user exists.

## Demo script

1. Sign in at `https://demo.owneraitools.com/sales`
2. Confirm trial number shows `+15164755855` (Save number if needed)
3. Fill company / greeting / voice / language / owner mobile+email → **Start trial**
4. Give the prospect the trial number; **call** it live (SMS later when registered)
5. Open **Client view** — the conversation appears with transcript links
6. After 14 days (or when done) → **Reset slot**

## Seed portal history (showcase)

`/portal` only looks lived-in when Demo Slot 1 has `audit_events` / `leads` tagged with that slot. To show a prospect what a used client dashboard looks like without waiting for live traffic:

```bash
# needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
node scripts/seed-portal-demo.mjs              # wipe prior seed, then insert ~30d of varied caller activity
node scripts/seed-portal-demo.mjs --wipe       # remove seed rows only
node scripts/seed-portal-demo.mjs --paint-slot # also force slot company_name=Harbor Plumbing (trial client)
```

- Slot header can stay **Harbor Plumbing**; recent callers use **different** prospect businesses (cafes, contractors, residences, etc.).
- Seeded phones are fake `+1555010xxxx` (not real callers).
- Events carry `payload.demo_seed=true` so wipe is safe.
- A **live trial on the same slot mixes** with seed data until you `--wipe`.
- Transcript buttons stay empty (no fake `call_records` in v1).
