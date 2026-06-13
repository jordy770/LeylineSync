-- 202605010286_decision_params
-- Client step 2 support (mig 286): get_pending_decisions returns params,
-- so divide_damage (amount, max_targets), pay_x_mana_damage (color) and
-- vote chains can render. Return-type change requires a drop first.

drop function if exists public.get_pending_decisions(uuid);
-- Generated from supabase/functions_src (get_pending_decisions) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.get_pending_decisions(
  p_session_id uuid
)
returns table (
  id uuid,
  deciding_player_id uuid,
  source_stack_item_id uuid,
  decision_type text,
  prompt text,
  options jsonb,
  min_choices integer,
  max_choices integer,
  params jsonb
)
language sql
security definer
set search_path = public
as $$
  select id, deciding_player_id, source_stack_item_id, decision_type,
         prompt, options, min_choices, max_choices, params
  from public.game_pending_decisions
  where session_id = p_session_id and status = 'pending'
  order by created_at;
$$;
grant execute on function public.get_pending_decisions(uuid) to authenticated;
