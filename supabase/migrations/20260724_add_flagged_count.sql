-- Running count of flagged conversations (security probes / abuse) per lead,
-- so repeat offenders are visible at a glance on the dashboard queue.
alter table public.leads
  add column if not exists flagged_count integer not null default 0;
