-- Monitor incident state for OwnerAI agent health checks (service-role only).
create table public.monitor_incidents (
  check_key text primary key,
  status text not null default 'ok'
    check (status in ('ok', 'open', 'recovered')),
  detail text,
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  last_checked_at timestamptz,
  last_alerted_at timestamptz,
  opened_at timestamptz,
  recovered_at timestamptz,
  updated_at timestamptz not null default now()
);

create index monitor_incidents_status_idx on public.monitor_incidents (status);
create index monitor_incidents_updated_at_idx on public.monitor_incidents (updated_at desc);

alter table public.monitor_incidents enable row level security;

revoke all on public.monitor_incidents from anon, authenticated;
grant all on public.monitor_incidents to service_role;
