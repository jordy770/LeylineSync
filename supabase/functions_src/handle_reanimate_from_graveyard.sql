-- supabase/functions_src/handle_reanimate_from_graveyard.sql
-- CANONICAL current definition (created in mig 212).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

create or replace function public.handle_reanimate_from_graveyard(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_target uuid := nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid;
  v_owner uuid;
  v_pos integer;
  v_turn integer;
begin
  if v_target is null then
    raise exception 'reanimate_from_graveyard requires a target_card_id';
  end if;

  -- The target may have left the graveyard since the ability went on the stack
  -- (another effect moved it). If so the ability simply fizzles.
  select owner_id into v_owner
  from public.game_cards
  where id = v_target and session_id = p_session_id and zone = 'graveyard';
  if not found then
    return null;
  end if;

  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards
  where session_id = p_session_id and owner_id = v_owner and zone = 'battlefield';

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  update public.game_cards
  set zone = 'battlefield', zone_position = v_pos,
      controller_player_id = p_stack_item.controller_player_id,
      is_tapped = false, damage_marked = 0, plus_one_counters = 0,
      entered_battlefield_turn_number = coalesce(v_turn, 0)
  where id = v_target and session_id = p_session_id;

  perform public.rebuild_scripted_continuous_effects(p_session_id);
  return null;
end;
$fn$;
