-- supabase/functions_src/handle_permanent_effect.sql
-- CANONICAL current definition (seeded from 202605010196_mana_value_rider.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.handle_permanent_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_controller uuid := p_stack_item.controller_player_id;
  v_rider jsonb;
  v_rtype text;
  v_ramount integer;
  v_card uuid;
  v_pos integer;
  i integer;
  v_target_card_id uuid := nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid;
  v_affected_controller uuid;
  v_search_options jsonb;
  v_decision_id uuid;
begin
  -- The destroyed permanent's controller, captured BEFORE the removal (which resets
  -- it to the owner) — for the affected-player search rider.
  select controller_player_id into v_affected_controller
  from public.game_cards
  where id = v_target_card_id and session_id = p_session_id and zone = 'battlefield';

  perform public.apply_creature_effect(
    p_session_id,
    lower(coalesce(p_stack_item.payload ->> 'kind', '')),
    v_target_card_id,
    p_stack_item.payload
  );

  -- Caster `then` riders (mig 150): simple effects applied to the CASTER.
  for v_rider in
    select value from jsonb_array_elements(coalesce(p_stack_item.payload -> 'then', '[]'::jsonb))
  loop
    v_rtype := lower(coalesce(v_rider ->> 'type', ''));
    -- Amount may be a fixed number, or {"mana_value_of":"target"} = the destroyed
    -- permanent's mana value (Feed the Swarm).
    if jsonb_typeof(v_rider -> 'amount') = 'object'
       and (v_rider -> 'amount' ->> 'mana_value_of') = 'target' then
      v_ramount := public.card_mana_value(
        p_session_id, nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid);
    else
      v_ramount := coalesce((v_rider ->> 'amount')::integer, 0);
    end if;

    if v_rtype = 'lose_life' then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_ramount)
      where session_id = p_session_id and player_id = v_controller;

    elsif v_rtype = 'gain_life' then
      update public.game_session_players
      set life_total = life_total + v_ramount
      where session_id = p_session_id and player_id = v_controller;

    elsif v_rtype = 'draw' then
      for i in 1..greatest(0, v_ramount) loop
        select id into v_card
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc
        limit 1 for update skip locked;

        exit when v_card is null;

        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'hand';

        update public.game_cards
        set zone = 'hand', zone_position = v_pos, is_tapped = false, damage_marked = 0
        where id = v_card;
      end loop;

    else
      raise exception 'Unsupported rider effect in then: % (allowed: lose_life, gain_life, draw)', v_rtype;
    end if;
  end loop;

  -- Affected-controller rider: "its controller may search their library for a basic
  -- land, put it onto the battlefield, then shuffle." Park a search decision for that
  -- player (min 0 = may). Resolution awaits the decision (submit_decision finishes it).
  if coalesce((p_stack_item.payload ->> 'controller_searches_basic_land')::boolean, false)
     and v_affected_controller is not null then
    select coalesce(
             jsonb_agg(jsonb_build_object('game_card_id', lib.id, 'name', c.name) order by c.name, lib.id),
             '[]'::jsonb)
      into v_search_options
    from public.game_cards lib
    join public.cards c on c.id = lib.card_id
    where lib.session_id = p_session_id
      and lib.owner_id = v_affected_controller
      and lib.zone = 'library'
      and c.type_line ilike '%basic%'
      and c.type_line ilike '%land%';

    if jsonb_array_length(v_search_options) > 0 then
      insert into public.game_pending_decisions (
        session_id, deciding_player_id, source_stack_item_id, decision_type,
        prompt, options, min_choices, max_choices, params
      )
      values (
        p_session_id, v_affected_controller, p_stack_item.id, 'search_library',
        'Search your library for a basic land', v_search_options, 0, 1,
        jsonb_build_object('to', 'battlefield')
      )
      returning id into v_decision_id;

      update public.game_stack_items
      set status = 'awaiting_decision'
      where id = p_stack_item.id;

      return jsonb_build_object('awaiting_decision', true, 'decision_id', v_decision_id);
    end if;
  end if;

  -- Caster graveyard-return rider (mig 220, Cruel Revival: "Return up to one
  -- target Zombie card from your graveyard to your hand"). Parks the existing
  -- return_from_graveyard decision (min 0 = "up to") for the CASTER; the
  -- submit_decision branch finishes the move.
  if jsonb_typeof(p_stack_item.payload -> 'then_return_from_graveyard') = 'object' then
    select coalesce(
             jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id),
             '[]'::jsonb)
      into v_search_options
    from public.game_cards gy
    join public.cards c on c.id = gy.card_id
    where gy.session_id = p_session_id
      and gy.owner_id = v_controller
      and gy.zone = 'graveyard'
      and c.type_line ilike '%' || coalesce(
            p_stack_item.payload -> 'then_return_from_graveyard' -> 'filter' ->> 'type_line',
            'creature') || '%';

    if jsonb_array_length(v_search_options) > 0 then
      insert into public.game_pending_decisions (
        session_id, deciding_player_id, source_stack_item_id, decision_type,
        prompt, options, min_choices, max_choices, params
      )
      values (
        p_session_id, v_controller, p_stack_item.id, 'return_from_graveyard',
        'Return up to '
          || coalesce(p_stack_item.payload -> 'then_return_from_graveyard' ->> 'count', '1')
          || ' from your graveyard',
        v_search_options, 0,
        coalesce((p_stack_item.payload -> 'then_return_from_graveyard' ->> 'count')::integer, 1),
        jsonb_build_object(
          'to', coalesce(p_stack_item.payload -> 'then_return_from_graveyard' ->> 'to', 'hand'),
          'tapped', coalesce((p_stack_item.payload -> 'then_return_from_graveyard' ->> 'tapped')::boolean, false))
      )
      returning id into v_decision_id;

      update public.game_stack_items
      set status = 'awaiting_decision'
      where id = p_stack_item.id;

      return jsonb_build_object('awaiting_decision', true, 'decision_id', v_decision_id);
    end if;
  end if;

  return null;
end;
$$;
