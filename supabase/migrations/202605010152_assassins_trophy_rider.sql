-- Assassin's Trophy — "Destroy target permanent an opponent controls. Its controller
-- may search their library for a basic land card, put it onto the battlefield, then
-- shuffle." The destroy is the existing permanent_effect; this adds the AFFECTED-
-- PLAYER decision rider.
--
-- Unlike the `then` self-riders (caster, simple effects), this rider:
--   * applies to the DESTROYED permanent's controller (an opponent), and
--   * is a DECISION ("may search…").
--
-- The decision system already supports both: a pending decision carries any
-- deciding_player_id, and submit_decision's search_library branch searches THAT
-- player's library (→ to:battlefield) then shuffles. So handle_permanent_effect parks
-- a search_library decision for the affected controller and returns the dispatcher's
-- `awaiting_decision` contract (exactly like handle_scry) — the spell finishes
-- resolving when that player submits (or declines — min_choices 0). A pending decision
-- freezes priority, so nothing else happens until it's resolved.
--
-- Authoring: a `controller_searches_basic_land` flag on the removal payload. Reproduces
-- the two permanent_effect fns from mig 150. (IDE T-SQL false-positives on $$.)

-- ---------------------------------------------------------------------------
-- Builder — carry `controller_searches_basic_land` (+ the `then` riders, mig 150).
-- ---------------------------------------------------------------------------
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
  if v_kind not in ('destroy', 'exile', 'bounce', 'tap', 'untap') then
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

  return jsonb_build_object(
    'kind', v_kind,
    'target_card_id', v_target_card_id,
    'target_type', v_target_type,
    'target_controller', p_target_controller,
    'timing', p_timing,
    'then', coalesce(p_payload -> 'then', '[]'::jsonb),
    'controller_searches_basic_land', coalesce((p_payload ->> 'controller_searches_basic_land')::boolean, false)
  );
end;
$$;

revoke all on function public.build_stack_payload_permanent_simple(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- Handler — apply the removal + caster `then` riders, then (optionally) park the
-- affected controller's "may search a basic land → battlefield" decision.
-- ---------------------------------------------------------------------------
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
    v_ramount := coalesce((v_rider ->> 'amount')::integer, 0);

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

  return null;
end;
$$;

revoke all on function public.handle_permanent_effect(uuid, public.game_stack_items) from public;
