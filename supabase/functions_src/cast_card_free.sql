-- supabase/functions_src/cast_card_free.sql
-- CANONICAL current definition.
-- Casts a card (currently in exile) for free: permanents get a real
-- cast_permanent stack push (true ETBs on resolution); no-target instants/
-- sorceries go through cast_spell_effect(..., p_free := true). Written for
-- cascade / generalized nested-cast (design doc: 2026-07-20-cascade-nested-cast-design.md).
create or replace function public.cast_card_free(
  p_session_id uuid, p_game_card_id uuid, p_controller uuid
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_type_line text;
  v_card_id uuid;
  v_script jsonb;
  v_actions jsonb;
  v_next_position integer;
  v_is_permanent boolean;
begin
  select gc.card_id, c.type_line, public.effective_script(p_session_id, p_game_card_id)
    into v_card_id, v_type_line, v_script
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_game_card_id and gc.session_id = p_session_id;

  v_is_permanent := v_type_line ilike any (array[
    '%creature%','%artifact%','%enchantment%','%planeswalker%','%battle%','%land%']);

  if v_is_permanent then
    -- Real cast: push a cast_permanent stack item from exile (mirrors
    -- cast_card_from_hand:480-515, minus payment). Resolves with true ETBs.
    select coalesce(max(position), -1) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;

    update public.game_cards
    set zone = 'stack', zone_position = v_next_position, is_tapped = false, damage_marked = 0
    where id = p_game_card_id and session_id = p_session_id;

    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position)
    values (
      p_session_id, p_controller, p_game_card_id, 'cast_permanent',
      jsonb_build_object('timing', 'sorcery', 'card_id', v_card_id, 'type_line', v_type_line, 'free', true),
      v_next_position);

    -- perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, p_controller); -- enabled in Task 5
    return null;
  end if;

  -- Instant / sorcery. Task 3 inserts the targeted branch ABOVE this line.
  v_actions := v_script -> 'spell_effect' -> 'actions';
  if v_actions is null or jsonb_typeof(v_actions) <> 'array' then
    -- Unsupported shape → caller bottoms it (fallback). Signal with a sentinel.
    return '00000000-0000-0000-0000-000000000000'::uuid;
  end if;

  -- cast_spell_effect gates any exile-zone source on a play_from_exile
  -- permission (checked unconditionally, ahead of the p_free-guarded payment
  -- block — see cast_spell_effect.sql:94-104). cast_card_free is an
  -- engine-authorized cast (cascade / free nested-cast), so grant it here
  -- rather than requiring every caller to pre-arrange it.
  insert into public.game_continuous_effects (
    session_id, source_card_id, affected_player_id, effect_type, payload
  ) values (
    p_session_id, p_game_card_id, auth.uid(), 'play_from_exile',
    jsonb_build_object('card_ids', jsonb_build_array(p_game_card_id), 'permanent', true)
  );

  perform public.cast_spell_effect(p_session_id, v_actions, p_game_card_id, 0, null, false, true);
  return null;
end;
$$;
grant execute on function public.cast_card_free(uuid, uuid, uuid) to authenticated;
