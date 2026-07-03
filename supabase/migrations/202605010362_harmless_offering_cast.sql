-- 202605010362_harmless_offering_cast
-- Wires the CAST path for Harmless Offering (the engine donate already exists in
-- apply_creature_effect.gain_control, mig 353). build_stack_payload_permanent_simple
-- now accepts kind=gain_control and threads `to` into the stack payload;
-- handle_permanent_effect injects acting_controller=the caster for gain_control
-- (the gain_control branch redirects to an opponent when to:opponent). Lets the
-- controller cast Harmless Offering: donate a permanent you control to an opponent.
-- Generated from supabase/functions_src (handle_permanent_effect, build_stack_payload_permanent_simple) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
  v_kind text := lower(coalesce(p_stack_item.payload ->> 'kind', ''));
  v_effect_params jsonb := p_stack_item.payload;
begin
  -- The destroyed permanent's controller, captured BEFORE the removal (which resets
  -- it to the owner) — for the affected-player search rider.
  select controller_player_id into v_affected_controller
  from public.game_cards
  where id = v_target_card_id and session_id = p_session_id and zone = 'battlefield';

  -- gain_control needs an `acting_controller` — the CASTER (apply_creature_effect
  -- raises without it). For a DONATE (`to:opponent`, Harmless Offering) the
  -- gain_control branch itself redirects the permanent to an opponent of the
  -- caster (mig 353); a plain steal lets the caster gain it. Either way the
  -- acting controller passed in is the caster.
  if v_kind = 'gain_control' then
    v_effect_params := p_stack_item.payload
      || jsonb_build_object('acting_controller', v_controller);
  end if;

  perform public.apply_creature_effect(
    p_session_id,
    v_kind,
    v_target_card_id,
    v_effect_params
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
      perform public.fire_lifegain_triggers(p_session_id, v_controller, v_ramount);

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

create or replace function public.build_stack_payload_permanent_simple(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_kind text;
  v_target_card_id uuid;
  v_target_type jsonb;
begin
  v_kind := lower(coalesce(p_payload ->> 'kind', ''));
  -- gain_control: a cast permanent-targeted control change. `to:opponent`
  -- DONATES the target (one you control) to an opponent (Harmless Offering);
  -- otherwise the caster gains control. handle_permanent_effect picks the
  -- acting controller.
  if v_kind not in ('destroy', 'exile', 'bounce', 'tap', 'untap', 'gain_control') then
    raise exception 'Unsupported permanent effect kind: %', v_kind;
  end if;

  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;

  v_target_type := coalesce(p_payload -> 'target_type', '"permanent"'::jsonb);

  if not public.permanent_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller, v_target_type) then
    raise exception 'Target is not a legal permanent for this spell';
  end if;

  -- NEGATIVE type restriction (mig 220, Cruel Revival "Destroy target NON-Zombie
  -- creature"): reject a target whose type line matches exclude_type_line.
  if nullif(p_payload ->> 'exclude_type_line', '') is not null and exists (
    select 1 from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = v_target_card_id and gc.session_id = p_session_id
      and c.type_line ilike '%' || (p_payload ->> 'exclude_type_line') || '%'
  ) then
    raise exception 'Target may not be a % permanent', p_payload ->> 'exclude_type_line';
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'target_card_id', v_target_card_id,
    'target_type', v_target_type,
    'target_controller', p_target_controller,
    'timing', p_timing,
    'then', coalesce(p_payload -> 'then', '[]'::jsonb),
    'controller_searches_basic_land', coalesce((p_payload ->> 'controller_searches_basic_land')::boolean, false),
    'exclude_type_line', p_payload ->> 'exclude_type_line',
    -- Donate direction for kind=gain_control (Harmless Offering).
    'to', p_payload ->> 'to',
    -- Cruel Revival's second half: the CASTER picks a matching card from their
    -- graveyard after the removal resolves (handled in handle_permanent_effect).
    'then_return_from_graveyard', p_payload -> 'then_return_from_graveyard'
  );
end;
$$;
