-- Billing clients + numbers (service-role only). Usage is computed from audit_events.
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  slug text not null unique,
  plan_tier text not null default 'basic'
    check (plan_tier in ('basic', 'advanced', 'expert', 'custom')),
  included_minutes integer not null default 500 check (included_minutes >= 0),
  overage_rate_cents integer not null default 40 check (overage_rate_cents >= 0),
  billing_cycle_day integer not null default 1 check (billing_cycle_day between 1 and 28),
  status text not null default 'active'
    check (status in ('active', 'paused', 'churned')),
  portal_enabled boolean not null default false
);

create table public.client_numbers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  client_id uuid not null references public.clients (id) on delete cascade,
  e164 text not null unique,
  label text
);

create index client_numbers_client_id_idx on public.client_numbers (client_id);

alter table public.clients enable row level security;
alter table public.client_numbers enable row level security;

revoke all on public.clients from anon, authenticated;
revoke all on public.client_numbers from anon, authenticated;
grant all on public.clients to service_role;
grant all on public.client_numbers to service_role;

-- Seed: OwnerAI Tools demo line
insert into public.clients (
  name, slug, plan_tier, included_minutes, overage_rate_cents, billing_cycle_day, status, portal_enabled
) values (
  'OwnerAI Tools (Demo)', 'ownerai-demo', 'basic', 500, 40, 1, 'active', false
);

insert into public.client_numbers (client_id, e164, label)
select id, '+15169731973', 'Demo line'
from public.clients
where slug = 'ownerai-demo';
