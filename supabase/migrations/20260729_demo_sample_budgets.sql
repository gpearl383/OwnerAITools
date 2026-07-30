-- Durable per-call demo sample budgets (send_demo_alert).
-- Replaces in-memory Maps that reset across serverless instances.

create table if not exists public.demo_sample_budgets (
  call_id text primary key,
  invocations integer not null default 0,
  sms integer not null default 0,
  email integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.demo_sample_budgets is
  'Per-call sample send counters for OwnerAI demo send_demo_alert tool.';

alter table public.demo_sample_budgets enable row level security;

revoke all on table public.demo_sample_budgets from anon, authenticated, public;
grant all on table public.demo_sample_budgets to service_role;

-- Atomic bump. p_kind: invocation | sms | email.
-- For invocation: increments only when under max (check-then-bump).
-- For sms/email: always increments (caller already checked can*).
-- Returns true if the action was allowed / recorded under the cap.
create or replace function public.bump_demo_sample_budget(
  p_call_id text,
  p_kind text,
  p_max integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.demo_sample_budgets%rowtype;
  cur integer;
begin
  if p_call_id is null or length(trim(p_call_id)) = 0 then
    return true;
  end if;

  insert into public.demo_sample_budgets (call_id)
  values (p_call_id)
  on conflict (call_id) do nothing;

  select * into rec from public.demo_sample_budgets where call_id = p_call_id for update;

  if p_kind = 'invocation' then
    if rec.invocations >= p_max then
      return false;
    end if;
    update public.demo_sample_budgets
      set invocations = invocations + 1, updated_at = now()
      where call_id = p_call_id;
    return true;
  elsif p_kind = 'sms' then
    cur := rec.sms;
    if cur >= p_max then
      return false;
    end if;
    update public.demo_sample_budgets
      set sms = sms + 1, updated_at = now()
      where call_id = p_call_id;
    return true;
  elsif p_kind = 'email' then
    cur := rec.email;
    if cur >= p_max then
      return false;
    end if;
    update public.demo_sample_budgets
      set email = email + 1, updated_at = now()
      where call_id = p_call_id;
    return true;
  else
    raise exception 'unknown p_kind: %', p_kind;
  end if;
end;
$$;

create or replace function public.get_demo_sample_budget(p_call_id text)
returns table (invocations integer, sms integer, email integer)
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(b.invocations, 0), coalesce(b.sms, 0), coalesce(b.email, 0)
  from (select p_call_id as call_id) c
  left join public.demo_sample_budgets b on b.call_id = c.call_id;
$$;

revoke all on function public.bump_demo_sample_budget(text, text, integer) from public;
grant execute on function public.bump_demo_sample_budget(text, text, integer) to service_role;

revoke all on function public.get_demo_sample_budget(text) from public;
grant execute on function public.get_demo_sample_budget(text) to service_role;
