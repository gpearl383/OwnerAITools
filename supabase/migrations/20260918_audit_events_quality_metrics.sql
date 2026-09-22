-- Add quality_metrics jsonb to audit_events for post-call demo QA
-- (Sep-10 postmortem action #9). Service-role only; RLS already enabled.

alter table public.audit_events
  add column if not exists quality_metrics jsonb;

-- RLS already enabled on audit_events; keep anon/authenticated locked out.
alter table public.audit_events enable row level security;
revoke all on table public.audit_events from anon, authenticated;
grant all on table public.audit_events to service_role;
