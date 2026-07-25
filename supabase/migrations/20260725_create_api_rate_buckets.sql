-- Durable rate-limit buckets for serverless APIs (chat, etc.).

create table if not exists public.api_rate_buckets (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

create index if not exists api_rate_buckets_window_idx
  on public.api_rate_buckets (window_start);

comment on table public.api_rate_buckets is
  'OwnerAI API rate limits; rows older than 2h may be pruned.';

-- Atomic bump; returns true if still under max after increment.
create or replace function public.bump_rate_limit(
  p_bucket text,
  p_window timestamptz,
  p_max integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c integer;
begin
  insert into public.api_rate_buckets (bucket, window_start, count)
  values (p_bucket, p_window, 1)
  on conflict (bucket, window_start)
  do update set count = public.api_rate_buckets.count + 1
  returning count into c;
  return c <= p_max;
end;
$$;

revoke all on function public.bump_rate_limit(text, timestamptz, integer) from public;
grant execute on function public.bump_rate_limit(text, timestamptz, integer) to service_role;
