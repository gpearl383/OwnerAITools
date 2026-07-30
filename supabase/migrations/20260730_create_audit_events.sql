-- Capture live `audit_events` schema (was created outside git).
-- Idempotent: safe against the existing OwnerAI Tools Supabase project.

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event_type text not null,
  call_id text,
  caller_name text,
  from_number text,
  duration_sec integer,
  wants_setup_call boolean,
  wants_sms_confirmation boolean,
  lead_quality text,
  sentiment text,
  status text not null default 'ok',
  detail text,
  payload jsonb
);

create index if not exists audit_events_created_at_idx
  on public.audit_events (created_at desc);

create index if not exists audit_events_event_type_idx
  on public.audit_events (event_type);

-- Used heavily by webhook idempotency lookups (event_type + call_id).
create index if not exists audit_events_event_type_call_id_idx
  on public.audit_events (event_type, call_id);

alter table public.audit_events enable row level security;

revoke all on public.audit_events from anon, authenticated;
grant all on public.audit_events to service_role;
