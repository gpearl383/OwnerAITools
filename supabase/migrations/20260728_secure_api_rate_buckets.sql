-- Lock api_rate_buckets to service_role (fixes Supabase rls_disabled_in_public).
-- Rate-limit RPC is only called from Vercel with SUPABASE_SERVICE_ROLE_KEY.

alter table public.api_rate_buckets enable row level security;

revoke all on table public.api_rate_buckets from anon, authenticated, public;
grant all on table public.api_rate_buckets to service_role;

revoke all on function public.bump_rate_limit(text, timestamptz, integer)
  from anon, authenticated, public;
grant execute on function public.bump_rate_limit(text, timestamptz, integer)
  to service_role;
