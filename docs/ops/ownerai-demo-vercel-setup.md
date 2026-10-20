# ownerai-demo Vercel project setup

Marketing site stays on project **owneraitools** / branch **`main`** / **owneraitools.com**.

Sales console runs on project **`ownerai-demo`** / branch **`demo`** / **demo.owneraitools.com**.

## Create the project (dashboard)

1. Vercel → **Add New… → Project**
2. Import GitHub repo `gpearl383/OwnerAITools`
3. Project name: **`ownerai-demo`**
4. Production Branch: **`demo`** (not `main`)
5. Framework: Other / no framework; leave build blank (static + serverless `api/`)
6. Deploy

## Domain

1. Project **ownerai-demo** → Settings → Domains → add **`demo.owneraitools.com`**
2. At your DNS host, add:
   - Type: **CNAME**
   - Name: `demo`
   - Value: the target Vercel shows (often `cname.vercel-dns.com`)

## Environment variables (this project only)

| Key | Notes |
|-----|--------|
| `TRIAL_RETELL_API_KEY` | Retell workspace ownerai-demo |
| `TRIAL_SLOT_E164` | `+15164755855` |
| `TRIAL_VOICE_AGENT_ID` | `agent_47dc64ae3a12423f391d3e78b8` |
| `TRIAL_VOICE_LLM_ID` | `llm_8993dfcb658f37c0cb86b3ed8cc7` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | same demo Supabase as needed for slots |
| `SALES_SESSION_SECRET` | sales cookie signing (distinct from dashboard secret) |
| `CALL_LINK_SECRET` | HMAC for `/api/call` + lead-action links (required; no service-role fallback) |
| `RESEND_API_KEY` | owner email alerts |
| `TRIAL_RETELL_WEBHOOK_KEY` | optional; if set, used instead of `TRIAL_RETELL_API_KEY` for webhook verify |
| `SALES_BOOTSTRAP_EMAIL` / `SALES_BOOTSTRAP_PASSWORD` | optional **only while `sales_users` is empty** — delete both after first login |

Do **not** put the website `RETELL_API_KEY` here.

## After first deploy

- Open https://demo.owneraitools.com/sales  
- Trial agent webhook already points at `https://demo.owneraitools.com/api/trial-webhook`
