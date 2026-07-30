-- Defense in depth: revoke residual anon/authenticated privileges on public.
-- OwnerAI APIs use SUPABASE_SERVICE_ROLE_KEY only; tables already have RLS
-- with no anon/authenticated policies. These GRANTs were leftover defaults.
--
-- Applied remotely as migration `revoke_anon_authenticated_grants`.
--
-- Note: storage.* table ACLs are owned by supabase_storage_admin. Migrations
-- running as `postgres` cannot revoke those grants (SET ROLE denied). The
-- call-recordings bucket is private with RLS and no anon policies, so browser
-- clients still cannot read objects even if storage table GRANTs remain.

revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;

revoke all on all sequences in schema public from anon, authenticated;
grant all on all sequences in schema public to service_role;

revoke all on all routines in schema public from anon, authenticated;
grant all on all routines in schema public to service_role;

alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on routines from anon, authenticated;
