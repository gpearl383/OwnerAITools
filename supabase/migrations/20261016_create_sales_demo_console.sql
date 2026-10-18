-- Sales Demo Console: Sales Console login + one trial slot (service-role only).

create table if not exists public.sales_users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  email text not null,
  password_salt text not null,
  password_hash text not null,
  display_name text,
  active boolean not null default true
);

create unique index if not exists sales_users_email_unique
  on public.sales_users (lower(email));

alter table public.sales_users enable row level security;
revoke all on table public.sales_users from anon, authenticated;
grant all on table public.sales_users to service_role;

create table if not exists public.demo_slots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  slot_key integer not null unique check (slot_key >= 1),
  e164 text,
  status text not null default 'idle'
    check (status in ('idle', 'active', 'expired')),
  company_name text,
  greeting text,
  voice text check (voice is null or voice in ('female', 'male')),
  language text default 'en',
  website text,
  owner_name text,
  owner_phone text,
  owner_email text,
  trial_days integer not null default 14 check (trial_days >= 1 and trial_days <= 90),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  retell_voice_agent_id text,
  retell_sms_agent_id text,
  retell_voice_llm_id text,
  notes text
);

create index if not exists demo_slots_status_idx on public.demo_slots (status);

alter table public.demo_slots enable row level security;
revoke all on table public.demo_slots from anon, authenticated;
grant all on table public.demo_slots to service_role;

insert into public.demo_slots (slot_key, status, trial_days)
values (1, 'idle', 14)
on conflict (slot_key) do nothing;

-- Tag trial leads so the sales portal never mixes with website-demo queue.
alter table public.leads
  add column if not exists slot_id uuid references public.demo_slots(id) on delete set null;

create index if not exists leads_slot_id_idx on public.leads (slot_id)
  where slot_id is not null;
