-- Sales invite / set-password tokens for demo console users.
-- Service-role only (RLS already enabled; no policies).

alter table public.sales_users
  add column if not exists invite_token_hash text,
  add column if not exists invite_expires_at timestamptz;

comment on column public.sales_users.invite_token_hash is
  'SHA-256 hex of one-time invite token; null after password is set';
comment on column public.sales_users.invite_expires_at is
  'When the pending invite expires; null after password is set';
