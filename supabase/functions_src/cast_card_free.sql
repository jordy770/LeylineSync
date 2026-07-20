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
  v_spec jsonb;
  v_stack_item_id uuid;
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

    perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, p_controller); -- enabled in Task 5
    return null;
  end if;

  -- Instant / sorcery.
  v_actions := v_script -> 'spell_effect' -> 'actions';
  if v_actions is null or jsonb_typeof(v_actions) <> 'array' then
    -- Unsupported shape → caller bottoms it (fallback). Signal with a sentinel.
    return '00000000-0000-0000-0000-000000000000'::uuid;
  end if;

  -- Does the spell need a cast-time target? If so, park it in the triggered-ability
  -- target shape and let choose_triggered_ability_(creature_)target set the target
  -- (guards relaxed to accept 'spell_effect'); apply_trigger_effects resolves the
  -- effects against the chosen target when the item resolves.
  v_spec := public.spell_free_cast_target_spec(v_actions);
  if coalesce((v_spec ->> 'required')::boolean, false) then
    select coalesce(max(position), -1) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status)
    values (
      p_session_id, p_controller, p_game_card_id, 'spell_effect',
      jsonb_build_object(
        'effects', v_actions, 'controller_player_id', p_controller, 'timing', 'instant',
        'free_cast', true, 'target_required', true,
        'target_type', v_spec -> 'target_type',
        'target_controller', v_spec ->> 'target_controller',
        'target_count', (v_spec ->> 'target_count')::integer),
      v_next_position, 'pending')
    returning id into v_stack_item_id;
    -- The instant/sorcery leaves exile for the graveyard on cast (mirrors
    -- cast_spell_effect's cast-time zone move). Only instants/sorceries reach the
    -- spell branch here — targeted permanents (Auras) are caught by v_is_permanent
    -- above and go through the cast_permanent push; their targeting is a later gap.
    if v_type_line ilike '%instant%' or v_type_line ilike '%sorcery%' then
      update public.game_cards
      set zone = 'graveyard',
          zone_position = (select coalesce(max(zone_position), -1) + 1 from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = game_cards.owner_id and x.zone = 'graveyard')
      where id = p_game_card_id and session_id = p_session_id;
    end if;
    -- Fire this spell's own cast triggers (e.g. a cascade card found by cascade —
    -- Bituminous Blast). The no-target branch below gets this via cast_spell_effect;
    -- the targeted branch parks its own stack item, so fire it here.
    perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, p_controller);
    return v_stack_item_id;
  end if;

  perform public.cast_spell_effect(p_session_id, v_actions, p_game_card_id, 0, null, false, true);
  return null;
end;
$$;
grant execute on function public.cast_card_free(uuid, uuid, uuid) to authenticated;
