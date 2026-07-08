-- Premium entitlements + AI usage quota (Collection Optimizer monetization).
--
-- Policy (2026-07-08): LLM features may run in production ONLY behind a
-- paywall — subscribers cover the API cost. co_entitlements says who is
-- premium; co_ai_usage counts calls per user/month/feature; and
-- consume_ai_credit() is the ONE gate every AI route calls: it checks the
-- entitlement and atomically consumes a credit, so quotas can't be bypassed
-- or reset client-side (the tables have no user write policies at all).
--
-- Entitlements are managed operationally (SQL / dashboard) until a payment
-- provider exists: insert a row with premium=true (premium_until null = no
-- end date).

create table if not exists public.co_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  premium boolean not null default false,
  premium_until timestamptz,
  note text,
  updated_at timestamptz not null default now()
);

alter table public.co_entitlements enable row level security;

create policy co_entitlements_select_own on public.co_entitlements
  for select using (auth.uid() = user_id);
-- deliberately NO insert/update/delete policies

create table if not exists public.co_ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null,           -- 'YYYY-MM'
  feature text not null,         -- e.g. 'deck_doctor'
  calls integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month, feature)
);

alter table public.co_ai_usage enable row level security;

create policy co_ai_usage_select_own on public.co_ai_usage
  for select using (auth.uid() = user_id);
-- deliberately NO write policies: only consume_ai_credit mutates this table

create or replace function public.consume_ai_credit(p_feature text, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_month text := to_char(now(), 'YYYY-MM');
  v_premium boolean;
  v_calls integer;
begin
  if v_user is null then
    return jsonb_build_object('allowed', false, 'reason', 'auth');
  end if;

  select coalesce(bool_or(premium and (premium_until is null or premium_until > now())), false)
    into v_premium
    from co_entitlements
   where user_id = v_user;

  if not v_premium then
    return jsonb_build_object('allowed', false, 'reason', 'premium_required');
  end if;

  -- Row-lock the counter so concurrent calls serialize and can't skip the cap.
  insert into co_ai_usage (user_id, month, feature, calls)
  values (v_user, v_month, p_feature, 0)
  on conflict (user_id, month, feature) do nothing;

  select calls into v_calls
    from co_ai_usage
   where user_id = v_user and month = v_month and feature = p_feature
   for update;

  if v_calls >= p_limit then
    return jsonb_build_object('allowed', false, 'reason', 'quota_exceeded', 'used', v_calls, 'limit', p_limit);
  end if;

  update co_ai_usage
     set calls = calls + 1, updated_at = now()
   where user_id = v_user and month = v_month and feature = p_feature;

  return jsonb_build_object('allowed', true, 'used', v_calls + 1, 'limit', p_limit);
end;
$$;

revoke all on function public.consume_ai_credit(text, integer) from public;
grant execute on function public.consume_ai_credit(text, integer) to authenticated;
