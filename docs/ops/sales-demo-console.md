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
   # needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
   node scripts/create-sales-user.mjs sales@example.com 'strong-password' Sales
   ```
   Or first-login bootstrap with `SALES_BOOTSTRAP_EMAIL` + `SALES_BOOTSTRAP_PASSWORD`.

## Demo script

1. Sign in at `https://demo.owneraitools.com/sales`
2. Confirm trial number shows `+15164755855` (Save number if needed)
3. Fill company / greeting / voice / language / owner mobile+email → **Start trial**
4. Give the prospect the trial number; **call** it live (SMS later when registered)
5. Open **Client view** — the conversation appears with transcript links
6. After 14 days (or when done) → **Reset slot**
