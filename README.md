# OwnerAI — Landing Page

Landing page for owneraitools.com. All HTML/CSS/JS lives in `index.html` — no build step, no dependencies. Serverless functions in `api/` (chat proxy + Retell call webhook) run on Vercel.

## Development workflow

Production deploys automatically from `main`. **Never commit work-in-progress to `main`.**

1. Work on the `dev` branch.
2. Preview locally: `node scripts/dev-server.mjs` → http://localhost:8090
   (for a working chatbot, export `ANTHROPIC_API_KEY` first)
3. Push `dev` — Vercel builds a preview deployment at a `*.vercel.app` URL for review on desktop and phone. The live site is untouched.
4. After approval, merge to `main` and push — that is the only step that changes owneraitools.com:

   ```bash
   git checkout main && git merge --ff-only dev && git push origin main && git checkout dev
   ```

## Sales Demo Console (`demo.owneraitools.com`)

Separate Vercel project **`ownerai-demo`** (not the marketing site).

| URL | Purpose |
|-----|---------|
| https://demo.owneraitools.com/sales | Paint / start / reset 14-day trial |
| https://demo.owneraitools.com/portal | Client view for the active trial |
| Trial voice | `(516) 475-5855` — Retell workspace `ownerai-demo` |

Docs: [docs/ops/sales-demo-console.md](docs/ops/sales-demo-console.md).

Production branch for this project: **`demo`**. Marketing `owneraitools.com` stays on **`main`**.
