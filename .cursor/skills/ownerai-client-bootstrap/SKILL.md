---
name: ownerai-client-bootstrap
description: >-
  Bootstraps a post-contract OwnerAI client Retell stack (agents, prompts-as-code,
  phone number) using standardized naming and the onboarding checklist. Use when
  the user says onboard client, bootstrap client, new client Retell setup,
  contract signed and build agents, or workspace ready for a client API key.
---

# OwnerAI client bootstrap

Standardize initial Retell setup for a paying OwnerAI client after contract and agreements are in place. Stay inside the OwnerAITools repo — do not open a separate empty project.

## Canonical docs (read first; do not duplicate)

1. `docs/onboarding/2026-07-27-first-client-onboarding-checklist.md` — full operating checklist (intake, backend, go-live)
2. `clients/_template.md` — per-client profile template

Word copy of the checklist (human-facing): `docs/onboarding/2026-07-27-first-client-onboarding-checklist.docx`

## Naming (mandatory)

| Item | Pattern | Example |
|------|---------|---------|
| Retell workspace | `OwnerAI — <ClientName>` | `OwnerAI — LIStretch` |
| Slug | `kebab-case` | `li-stretch` |
| Profile | `clients/<slug>.md` | `clients/li-stretch.md` |
| Prompts as code | `clients/<slug>/retell/` | `clients/li-stretch/retell/` |
| Voice agent | `<slug>-voice` | `li-stretch-voice` |
| SMS agent | `<slug>-sms` | `li-stretch-sms` |
| Owner-alert agent | `<slug>-owner-alert` | `li-stretch-owner-alert` |
| Customer-confirm agent | `<slug>-customer-confirm` | `li-stretch-customer-confirm` |
| Future host | `https://<slug>.aiownertools.com` | `https://li-stretch.aiownertools.com` |

Agent display names in Retell: `OwnerAI — <ClientName> — voice` (and `— sms`, `— owner-alert`, `— customer-confirm`).

## Hard rules

- **Never** create or edit agents under root `retell/` (OwnerAI demo line only).
- **Never** overwrite `~/.claude/.env` (Jarvis Retell key). Client keys go in project `.env.local` as `RETELL_API_KEY`.
- Retell **workspaces cannot be created via API**. Halt and instruct the user if the workspace / key is missing.
- Before creating resources, verify the key: `POST https://api.retellai.com/v2/list-agents` must **not** return Jarvis agents (e.g. "Jarvis Inbound"). If it does, wrong workspace — stop.
- Voice agent must disclose that **calls are recorded** in the opening / begin message and prompt.
- Voice agent **must** include the full **voice security pack** (Persona + Confidentiality + Injection locks; 12m max call / 45s silence). Prefer provisioning in **OwnerAI-Deployments** (`security-prompt-blocks.mjs` + `scaffold.mjs` + `.cursor/rules/persona-lock-required.mdc`).
- Client gets business lead alerts only. Health / monitor alerts stay OwnerAI ops (document in profile; do not wire monitors to the client).
- Plan tiers: **Advanced** or **Expert** only.
- Do not invent client business facts. Use intake / `clients/<slug>.md`; use clear `TBD` placeholders until filled.
- No OwnerAI sales / demo role-play pitch in client receptionist prompts.

## Scope of this skill

**In scope:** Retell workspace handoff, profile file, four agents + LLMs, prompts-as-code, buy/bind phone number, write IDs into profile, UAT-ready stop.

**Out of scope (point to checklist Part 2; do not invent):** separate Vercel/Supabase project, Resend on `ai4operators.com` (`alerts@…`), Google/Microsoft calendar OAuth, call-forwarding cutover, Part 3 client walkthrough (human runs with client).

## Procedure

Copy this checklist and complete in order.

### 1. Load context

- [ ] Read the onboarding checklist and `clients/_template.md`
- [ ] Confirm client display name and slug with the user if unclear

### 2. Client profile

- [ ] Create or update `clients/<slug>.md` from `_template.md`
- [ ] Status: `building`
- [ ] Fill known intake; leave unknowns as `TBD`
- [ ] Record Retell workspace name: `OwnerAI — <ClientName>`

### 3. Human gate — Retell workspace + API key

If `.env.local` has no `RETELL_API_KEY`, or the key fails the Jarvis check:

Tell the user exactly:

1. Retell dashboard → workspace selector → **Add another workspace**
2. Name: `OwnerAI — <ClientName>`
3. Settings → API Keys → create key
4. Put in `OwnerAITools/.env.local`:
   ```bash
   RETELL_API_KEY=key_...
   ```
5. Reply: `workspace ready`

Do not proceed to create agents until this is done.

### 4. Verify key

- [ ] Load `RETELL_API_KEY` from `.env.local` (or session env)
- [ ] `POST /v2/list-agents` / `GET /v2/list-phone-numbers` — empty or only this client’s resources
- [ ] Abort if Jarvis / shared CSM tenant detected

### 5. Scaffold prompts-as-code

Under `clients/<slug>/retell/`:

- [ ] `manifest.json` with the four agents (ids filled after create, or placeholders then update)
- [ ] `<slug>-voice.prompt.md` + `.config.json` — receptionist for **this** business; recording disclosure; **full voice security pack** (Persona + Confidentiality + Injection locks; `max_call_duration_ms` 720000 + `end_call_after_silence_ms` 45000 — see OwnerAI-Deployments `.cursor/rules/persona-lock-required.mdc`); tools/webhooks → client host `/api/...` (book + retell-webhook). Omit OwnerAI demo `send_demo_alert` unless intake requests it.
- [ ] `<slug>-sms.prompt.md` + `.config.json` — SMS receptionist; STOP/HELP
- [ ] `<slug>-owner-alert.prompt.md` + `.config.json` — one-shot `{{alert_body}}`
- [ ] `<slug>-customer-confirm.prompt.md` + `.config.json` — one-shot `{{confirm_body}}`

Clone structure from root `retell/` demo configs (analysis fields, tool shapes) but rewrite prompts for the client. Prefer `scripts/push-client-retell.mjs` if it exists; otherwise sync via Retell API `update-retell-llm` / `update-agent` / `update-chat-agent`.

### 6. Create live Retell resources

Using this workspace’s API key:

- [ ] Create 4× Retell LLMs + 1 voice agent + 3 chat agents
- [ ] Voice: `voice_id` professional default (e.g. `11labs-Grace` unless profile specifies otherwise); `voice_model` `eleven_multilingual_v2` when set
- [ ] Wire webhook_url / webhook_events and post-call / post-chat analysis from config files
- [ ] Buy phone number: area code from profile, else **516**; nickname `OwnerAI — <ClientName>`
- [ ] Bind inbound voice agent + inbound SMS agent to that number
- [ ] Update `manifest.json` and `clients/<slug>.md` with agent IDs, llm IDs, E.164

### 7. Push and verify

- [ ] Push prompts/config to live agents
- [ ] Confirm agents appear only in this workspace
- [ ] Note: webhooks 404 until client Vercel host exists — expected; do not block Retell create

### 8. Stop at UAT handoff

- [ ] Summarize: workspace name, number, four agent IDs, paths created
- [ ] List open TBDs from the profile (hours, calendar, owner alert cell/email, etc.)
- [ ] Point user to checklist Part 2 (backend stack) and Part 3 (client go-live walkthrough)
- [ ] Do **not** enable public call-forwarding cutover without explicit user approval

## Example user prompts

- `Onboard client LIStretch using the ownerai-client-bootstrap skill`
- `Bootstrap Retell for Acme Plumbing — contract signed`
- `workspace ready — slug li-stretch`

## Example agent reply when blocked on workspace

> Retell workspaces can’t be created via API. Please create workspace **OwnerAI — LIStretch**, add an API key to `OwnerAITools/.env.local` as `RETELL_API_KEY`, then reply **workspace ready**.
