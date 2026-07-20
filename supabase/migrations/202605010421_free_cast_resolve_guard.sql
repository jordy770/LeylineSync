-- 202605010421_free_cast_resolve_guard.sql
-- handle_spell_effect: block resolution of a free-cast spell whose required target
-- has not been chosen yet — mirrors the guard handle_triggered_ability already has
-- (mig 104). Without it, a targeted 'spell_effect' item parked by cast_card_free
-- (mig 420) could be resolved before its target is set and silently fizzle in
-- apply_trigger_effects (null target = no-op), with the source card already in the
-- graveyard — a silent value-loss bug. This becomes reachable once Task 4/5 fire
-- cascade in live play (priority passes / bot passes / client race).
--
-- handle_spell_effect is a migration-only function (no functions_src canonical
-- body): this is its latest definition — hand-copied from mig 104 plus the guard.
create or replace function public.handle_spell_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision_id uuid;
begin
  -- A free nested-cast (cast_card_free) parks a targeted spell as a 'spell_effect'
  -- item carrying target_required. Block premature resolution until a target is
  -- chosen — via either chooser RPC (single writes target_card_id, array writes
  -- target_card_ids) — so a graveyard-bound spell never fizzles silently.
  if coalesce((p_stack_item.payload ->> 'target_required')::boolean, false)
    and nullif(p_stack_item.payload ->> 'target_card_id', '') is null
    and (p_stack_item.payload -> 'target_card_ids') is null
  then
    raise exception 'This spell requires a target to be chosen first';
  end if;

  v_decision_id := public.apply_trigger_effects(p_session_id, p_stack_item.id, 0);
  if v_decision_id is not null then
    return jsonb_build_object(
      'awaiting_decision', true,
      'decision_id', v_decision_id,
      'stack_item_id', p_stack_item.id
    );
  end if;
  return null;
end;
$$;
