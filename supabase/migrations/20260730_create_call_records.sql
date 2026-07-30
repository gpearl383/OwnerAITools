-- Capture live `call_records` schema (was created outside git).
-- Idempotent: safe against the existing OwnerAI Tools Supabase project.
--
-- Recordings live in Storage bucket `call-recordings` (private + RLS).
-- That bucket is managed outside this migration (storage ACLs are owned by
-- supabase_storage_admin); see api/retell-webhook.mjs + api/purge-call-records.mjs.

create table if not exists public.call_records (
  id text primary key,
  kind text not null,
  caller_name text,
  from_number text,
  summary text,
  transcript text,
  recording_path text,
  created_at timestamptz not null default now()
);

create index if not exists call_records_created_at_idx
  on public.call_records (created_at desc);

alter table public.call_records enable row level security;

revoke all on public.call_records from anon, authenticated;
grant all on public.call_records to service_role;
