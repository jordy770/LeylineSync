-- supabase/functions_src/enqueue_triggered_ability.sql
-- CANONICAL current definition (seeded from 202605010123_apnap_trigger_ordering.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.enqueue_triggered_ability(
  p_session_id uuid, p_controller_id uuid, p_source_card_id uuid, p_label text, p_effects jsonb,
  -- The creature that CAUSED a watcher to fire (entering/attacking), so a
  -- reflexive effect ("it gains haste") can apply to it (mig 227).
  p_triggering_card_id uuid default null,
  -- Extra event context merged onto the payload (mig 247: event_amount /
  -- event_player_id for dragons_combat_damage).
  p_extra jsonb default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_next_position integer;
  v_target_type jsonb;
  v_requires_target boolean;
  v_target_controller text;
  v_target_filter jsonb;
  v_has_target boolean;
  v_active_player_id uuid;
  v_player_count integer;
  v_controller_seat integer;
  v_active_seat integer;
  v_apnap_rank integer := 0;
begin
  if p_effects is null or jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) = 0 then
    return;
  end if;

  v_target_type := public.trigger_effects_target_type(p_effects);
  v_requires_target := v_target_type is not null;

  if v_requires_target then
    v_target_controller := coalesce(public.trigger_effects_target_controller(p_effects), 'any');
    -- Optional type-line restriction on the target (mig 310, Opportunistic Dragon:
    -- "Human or artifact"). Carried into the payload so the client + the chooser
    -- both enforce it.
    v_target_filter := public.trigger_effects_target_filter(p_effects);

    if v_target_filter is not null then
      -- Filter-aware availability: don't enqueue a "choose target" trigger when no
      -- battlefield permanent matches BOTH the target type and the type-line
      -- filter — otherwise the trigger would sit unresolvable with no legal pick.
      v_has_target := exists (
        select 1
        from public.game_cards gc
        join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id
          and gc.zone = 'battlefield'
          and public.card_type_line_matches_target(c.type_line, v_target_type)
          and public.card_type_line_matches_filter(c.type_line, v_target_filter)
          and (
            v_target_controller = 'any'
            or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
            or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
          )
      );
    elsif public.behavior_target_type_is_creature_only(v_target_type) then
      v_has_target := public.session_has_targetable_creature(p_session_id, p_controller_id, v_target_controller);
    else
      v_has_target := public.session_has_targetable_permanent(p_session_id, p_controller_id, v_target_controller, v_target_type);
    end if;

    if not v_has_target then
      return;
    end if;
  end if;

  -- APNAP rank: how far the controller sits from the active player in seat order.
  -- 0 = active player (its triggers resolve last). Falls back to 0 if unknown.
  select active_player_id into v_active_player_id
  from public.game_turn_state where session_id = p_session_id;

  select count(*) into v_player_count
  from public.game_session_players where session_id = p_session_id;

  select seat_number into v_controller_seat
  from public.game_session_players
  where session_id = p_session_id and player_id = p_controller_id;

  select seat_number into v_active_seat
  from public.game_session_players
  where session_id = p_session_id and player_id = v_active_player_id;

  if coalesce(v_player_count, 0) > 0 and v_controller_seat is not null and v_active_seat is not null then
    v_apnap_rank := ((v_controller_seat - v_active_seat) % v_player_count + v_player_count) % v_player_count;
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position
  )
  values (
    p_session_id, p_controller_id, p_source_card_id, 'triggered_ability',
    jsonb_build_object(
      'label', p_label,
      'controller_player_id', p_controller_id,
      'effects', p_effects,
      'target_required', v_requires_target,
      'target_type', case when v_requires_target then v_target_type else null end,
      'target_count', case when v_requires_target then public.trigger_effects_target_count(p_effects) else null end,
      'target_controller', case when v_requires_target then v_target_controller else null end,
      'target_filter', case when v_requires_target then v_target_filter else null end,
      'timing', 'triggered',
      'apnap_rank', v_apnap_rank,
      'triggering_card_id', p_triggering_card_id
    ) || coalesce(p_extra, '{}'::jsonb),
    v_next_position
  );
end;
$$;
grant execute on function public.enqueue_triggered_ability(uuid, uuid, uuid, text, jsonb, uuid, jsonb) to authenticated;
