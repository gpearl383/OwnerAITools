-- Leads queue source of truth (service-role only).
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  phone text,
  email text,
  name text,
  business text,
  business_type text,
  status text not null check (status in ('needs_callback', 'booked', 'hung_up', 'done')),
  priority integer not null default 1,
  wants_setup_call boolean not null default false,
  lead_quality text,
  sentiment text,
  setup_call_booked_at timestamptz,
  setup_call_booked_label text,
  last_channel text check (last_channel is null or last_channel in ('call', 'sms', 'chat')),
  last_call_id text,
  last_summary text,
  last_reason text,
  last_duration_sec integer,
  last_event_at timestamptz not null default now(),
  done_at timestamptz,
  done_via text check (done_via is null or done_via in ('dashboard', 'deep_link'))
);

create unique index leads_phone_unique on public.leads (phone) where phone is not null;
create unique index leads_email_unique on public.leads (email) where email is not null;
create index leads_status_priority_event_idx on public.leads (status, priority desc, last_event_at desc);

alter table public.leads enable row level security;

revoke all on public.leads from anon, authenticated;
grant all on public.leads to service_role;
