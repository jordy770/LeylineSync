-- Phase 1, slice 5: targeted modal modes.
--
-- Extends the Tier-A modal slice (088) so a chosen mode's actions may target a
-- creature (e.g. a charm: "Choose one — destroy target creature; or you gain 3
-- life"). The target rides on the existing choose_mode submission:
--   submit_decision(choose_mode, { "chosen": [idx], "target_card_id": "<uuid>" })
-- validated at submit time (a targeted mode requires a battlefield creature),
-- and applied at resolution via apply_creature_effect.
--
-- Also extracts the modal-resolution logic into apply_modal_spell(session, item)
-- so resolve_top_of_stack's modal branch is a one-line call (same "centralize the
-- tail" move as finalize_stack_resolution) — future modal changes touch one
-- function instead of reproducing resolve_top_of_stack. (IDE T-SQL false-positives
-- on $$ bodies — ignore.)

-- Runs a resolved modal spell: for each chosen mode, apply its actions. A
-- creature-targeting action (target_type "creature") goes through
-- apply_creature_effect against the chosen target; everything else is untargeted.
create or replace function public.apply_modal_spell(
  p_session_id uuid,
  p_stack_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stack public.game_stack_items;
  v_decision public.game_pending_decisions;
  v_target uuid;
  v_mode_index integer;
  v_mode jsonb;
  v_action jsonb;
  v_act_type text;
  v_tt jsonb;
begin
  select * into v_stack
  from public.game_stack_items
  where id = p_stack_item_id;

  select * into v_decision
  from public.game_pending_decisions
  where source_stack_item_id = p_stack_item_id and decision_type = 'choose_mode'
  order by created_at
  limit 1;

  if not found then
    raise exception 'Modal spell has no mode decision';
  end if;

  if v_decision.status <> 'resolved' then
    raise exception 'Modal spell requires a mode choice';
  end if;

  v_target := nullif(v_decision.result ->> 'target_card_id', '')::uuid;

  for v_mode_index in
    select (value)::integer
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_decision.result -> 'chosen') = 'array' then v_decision.result -> 'chosen'
        else jsonb_build_array(v_decision.result -> 'chosen')
      end
    )
  loop
    v_mode := (v_stack.payload -> 'modes') -> v_mode_index;

    for v_action in
      select value from jsonb_array_elements(coalesce(v_mode -> 'actions', '[]'::jsonb))
    loop
      v_act_type := v_action ->> 'type';
      v_tt := v_action -> 'target_type';

      if v_act_type in ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters', 'pump')
        and (v_tt = '"creature"'::jsonb or (jsonb_typeof(v_tt) = 'array' and v_tt ? 'creature'))
      then
        perform public.apply_creature_effect(p_session_id, v_act_type, v_target, v_action);
      else
        perform public.apply_triggered_ability_effects(
          p_session_id,
          v_stack.controller_player_id,
          v_stack.source_card_id,
          jsonb_build_array(v_action)
        );
      end if;
    end loop;
  end loop;
end;
$$;

grant execute on function public.apply_modal_spell(uuid, uuid) to authenticated;

-- submit_decision: reproduced from 090 with creature-target validation added to
-- the choose_mode branch (a chosen targeted mode requires a battlefield creature).
create or replace function public.submit_decision(
  p_decision_id uuid,
  p_result jsonb
)
returns public.game_pending_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision public.game_pending_decisions;
  v_chosen jsonb;
  v_count integer;
  v_option_count integer;
  v_idx integer;
  v_top jsonb;
  v_bottom jsonb;
  v_grave jsonb;
  v_option_ids uuid[];
  v_chosen_ids uuid[];
  v_needs_target boolean;
  v_mode jsonb;
  v_target_card uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_decision
  from public.game_pending_decisions
  where id = p_decision_id
  for update;

  if not found then
    raise exception 'Decision not found';
  end if;

  if v_decision.status <> 'pending' then
    raise exception 'Decision already %', v_decision.status;
  end if;

  if v_decision.deciding_player_id <> auth.uid() then
    raise exception 'Only the deciding player can submit this decision';
  end if;

  if v_decision.decision_type = 'choose_mode' then
    -- Normalize chosen to a json array of ints.
    v_chosen := case
      when jsonb_typeof(p_result -> 'chosen') = 'array' then p_result -> 'chosen'
      when p_result -> 'chosen' is not null then jsonb_build_array(p_result -> 'chosen')
      else '[]'::jsonb
    end;

    v_count := jsonb_array_length(v_chosen);
    v_option_count := jsonb_array_length(v_decision.options);

    if v_count < v_decision.min_choices or v_count > v_decision.max_choices then
      raise exception 'Must choose between % and % option(s)', v_decision.min_choices, v_decision.max_choices;
    end if;

    v_needs_target := false;

    for v_idx in select (value)::integer from jsonb_array_elements_text(v_chosen)
    loop
      if v_idx < 0 or v_idx >= v_option_count then
        raise exception 'Chosen mode index % out of range', v_idx;
      end if;

      v_mode := v_decision.options -> v_idx;
      if exists (
        select 1
        from jsonb_array_elements(coalesce(v_mode -> 'actions', '[]'::jsonb)) a(value)
        where (a.value ->> 'type') in ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters', 'pump')
          and ((a.value -> 'target_type') = '"creature"'::jsonb
               or (jsonb_typeof(a.value -> 'target_type') = 'array' and (a.value -> 'target_type') ? 'creature'))
      ) then
        v_needs_target := true;
      end if;
    end loop;

    if v_needs_target then
      v_target_card := nullif(p_result ->> 'target_card_id', '')::uuid;
      if v_target_card is null then
        raise exception 'This mode requires a creature target';
      end if;
      if not exists (
        select 1
        from public.game_cards gc
        join public.cards c on c.id = gc.card_id
        where gc.id = v_target_card
          and gc.session_id = v_decision.session_id
          and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%'
      ) then
        raise exception 'Modal target must be a creature on the battlefield';
      end if;
    end if;
  elsif v_decision.decision_type = 'scry' then
    v_top := case when jsonb_typeof(p_result -> 'top') = 'array' then p_result -> 'top' else '[]'::jsonb end;
    v_bottom := case when jsonb_typeof(p_result -> 'bottom') = 'array' then p_result -> 'bottom' else '[]'::jsonb end;

    select array_agg((value ->> 'game_card_id')::uuid)
      into v_option_ids
    from jsonb_array_elements(v_decision.options);

    select array_agg(id)
      into v_chosen_ids
    from (
      select (value)::uuid as id from jsonb_array_elements_text(v_top)
      union all
      select (value)::uuid from jsonb_array_elements_text(v_bottom)
    ) q;

    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);

    if cardinality(v_chosen_ids) <> cardinality(v_option_ids) then
      raise exception 'Scry must place every revealed card exactly once';
    end if;

    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_option_ids) then
      raise exception 'Scry placed a card more than once';
    end if;

    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then
      raise exception 'Scry placed a card that was not revealed';
    end if;
  elsif v_decision.decision_type = 'surveil' then
    v_grave := case when jsonb_typeof(p_result -> 'graveyard') = 'array' then p_result -> 'graveyard' else '[]'::jsonb end;
    v_top := case when jsonb_typeof(p_result -> 'top') = 'array' then p_result -> 'top' else '[]'::jsonb end;

    select array_agg((value ->> 'game_card_id')::uuid)
      into v_option_ids
    from jsonb_array_elements(v_decision.options);

    select array_agg(id)
      into v_chosen_ids
    from (
      select (value)::uuid as id from jsonb_array_elements_text(v_grave)
      union all
      select (value)::uuid from jsonb_array_elements_text(v_top)
    ) q;

    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);

    if cardinality(v_chosen_ids) <> cardinality(v_option_ids) then
      raise exception 'Surveil must place every revealed card exactly once';
    end if;

    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_option_ids) then
      raise exception 'Surveil placed a card more than once';
    end if;

    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then
      raise exception 'Surveil placed a card that was not revealed';
    end if;
  end if;

  update public.game_pending_decisions
  set result = p_result, status = 'resolved', resolved_at = now()
  where id = p_decision_id
  returning * into v_decision;

  if v_decision.decision_type = 'scry' then
    with ordered as (
      select (t.value)::uuid as id, 0 as section, t.ord as ordnum
      from jsonb_array_elements_text(v_top) with ordinality as t(value, ord)
      union all
      select gc.id, 1 as section, gc.zone_position::bigint as ordnum
      from public.game_cards gc
      where gc.session_id = v_decision.session_id
        and gc.owner_id = v_decision.deciding_player_id
        and gc.zone = 'library'
        and gc.id <> all(v_option_ids)
      union all
      select (b.value)::uuid, 2 as section, b.ord as ordnum
      from jsonb_array_elements_text(v_bottom) with ordinality as b(value, ord)
    ),
    renum as (
      select id, (row_number() over (order by section, ordnum) - 1) as np
      from ordered
    )
    update public.game_cards g
    set zone_position = renum.np
    from renum
    where g.id = renum.id;

    perform public.finalize_stack_resolution(v_decision.session_id, v_decision.source_stack_item_id);
  elsif v_decision.decision_type = 'surveil' then
    with g as (
      select (value)::uuid as id, ord
      from jsonb_array_elements_text(v_grave) with ordinality as t(value, ord)
    ),
    base as (
      select coalesce(max(zone_position), -1) as m
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = v_decision.deciding_player_id
        and zone = 'graveyard'
    )
    update public.game_cards gc
    set zone = 'graveyard', zone_position = base.m + g.ord, is_tapped = false
    from g, base
    where gc.id = g.id;

    with ordered as (
      select (t.value)::uuid as id, 0 as section, t.ord as ordnum
      from jsonb_array_elements_text(v_top) with ordinality as t(value, ord)
      union all
      select lib.id, 1 as section, lib.zone_position::bigint as ordnum
      from public.game_cards lib
      where lib.session_id = v_decision.session_id
        and lib.owner_id = v_decision.deciding_player_id
        and lib.zone = 'library'
        and lib.id <> all(v_option_ids)
    ),
    renum as (
      select id, (row_number() over (order by section, ordnum) - 1) as np
      from ordered
    )
    update public.game_cards g
    set zone_position = renum.np
    from renum
    where g.id = renum.id;

    perform public.finalize_stack_resolution(v_decision.session_id, v_decision.source_stack_item_id);
  end if;

  return v_decision;
end;
$$;

grant execute on function public.submit_decision(uuid, jsonb) to authenticated;

-- resolve_top_of_stack: reproduced from 090 with the inline modal_spell block
-- replaced by a single apply_modal_spell(...) call (and the now-unused v_decision /
-- v_mode_index / v_mode declarations dropped). Everything else unchanged.
create or replace function public.resolve_top_of_stack(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_stack_item public.game_stack_items;
  v_target_stack_item public.game_stack_items;
  v_target_player_id uuid;
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
  v_scry_options jsonb;
  v_decision_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot resolve stack in a finished game session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending'
  order by position desc
  limit 1
  for update;

  if not found then
    raise exception 'Stack is empty';
  end if;

  if v_stack_item.action_type = 'deal_damage_player' then
    v_target_player_id := nullif(v_stack_item.payload ->> 'target_player_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_player_id is null or v_amount <= 0 then
      raise exception 'Invalid deal_damage_player payload';
    end if;

    update public.game_session_players
    set life_total = greatest(0, life_total - v_amount)
    where session_id = p_session_id
      and player_id = v_target_player_id;

    if not found then
      raise exception 'Target player not found';
    end if;
  elsif v_stack_item.action_type in (
    'deal_damage_creature',
    'pump_creature',
    'destroy_creature',
    'exile_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature'
  ) then
    perform public.apply_creature_effect(
      p_session_id,
      regexp_replace(v_stack_item.action_type, '_creature$', ''),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid,
      v_stack_item.payload
    );
  elsif v_stack_item.action_type = 'draw_cards' then
    perform public.apply_triggered_ability_effects(
      p_session_id,
      v_stack_item.controller_player_id,
      null,
      jsonb_build_array(
        jsonb_build_object('type', 'draw', 'amount', coalesce((v_stack_item.payload ->> 'amount')::integer, 1))
      )
    );
  elsif v_stack_item.action_type in ('scry', 'surveil') then
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 1);

    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'game_card_id', top.id,
                 'name', c.name,
                 'library_position', top.zone_position
               )
               order by top.zone_position asc, top.id asc
             ),
             '[]'::jsonb
           )
      into v_scry_options
    from (
      select id, card_id, zone_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_stack_item.controller_player_id
        and zone = 'library'
      order by zone_position asc, id asc
      limit v_amount
    ) top
    join public.cards c on c.id = top.card_id;

    if jsonb_array_length(v_scry_options) = 0 then
      return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
    end if;

    insert into public.game_pending_decisions (
      session_id, deciding_player_id, source_stack_item_id, decision_type,
      prompt, options, min_choices, max_choices
    )
    values (
      p_session_id,
      v_stack_item.controller_player_id,
      v_stack_item.id,
      v_stack_item.action_type,
      initcap(v_stack_item.action_type) || ' ' || v_amount,
      v_scry_options,
      0,
      jsonb_array_length(v_scry_options)
    )
    returning id into v_decision_id;

    update public.game_stack_items
    set status = 'awaiting_decision'
    where id = v_stack_item.id;

    return jsonb_build_object(
      'awaiting_decision', true,
      'decision_id', v_decision_id,
      'decision_type', v_stack_item.action_type,
      'stack_item_id', v_stack_item.id
    );
  elsif v_stack_item.action_type = 'modal_spell' then
    perform public.apply_modal_spell(p_session_id, v_stack_item.id);
  elsif v_stack_item.action_type = 'counter_spell' then
    select *
    into v_target_stack_item
    from public.game_stack_items
    where id = nullif(v_stack_item.payload ->> 'target_stack_item_id', '')::uuid
      and session_id = p_session_id
      and status = 'pending'
    for update;

    if found then
      if v_target_stack_item.id = v_stack_item.id then
        raise exception 'A stack item cannot counter itself';
      end if;

      if v_target_stack_item.action_type = 'cast_permanent'
        and v_target_stack_item.source_card_id is not null
      then
        select coalesce(max(zone_position), -1) + 1
        into v_next_graveyard_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'graveyard';

        update public.game_cards
        set
          zone = 'graveyard',
          zone_position = v_next_graveyard_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_target_stack_item.source_card_id
          and session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'stack';
      end if;

      update public.game_stack_items
      set
        status = 'cancelled',
        resolved_at = now()
      where id = v_target_stack_item.id;
    end if;
  elsif v_stack_item.action_type = 'cast_permanent' then
    if v_stack_item.source_card_id is null then
      raise exception 'Permanent spell has no source card';
    end if;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = false,
      damage_marked = 0
    where id = v_stack_item.source_card_id
      and session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'stack';

    if not found then
      raise exception 'Permanent spell source card not found on stack';
    end if;
  elsif v_stack_item.action_type = 'triggered_ability' then
    if coalesce((v_stack_item.payload ->> 'target_required')::boolean, false)
      and nullif(v_stack_item.payload ->> 'target_card_id', '') is null
    then
      if public.session_has_targetable_creature(
        p_session_id,
        nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any')
      ) then
        raise exception 'Triggered ability requires a target';
      end if;
    end if;

    perform public.apply_targeted_triggered_ability_effects(
      p_session_id,
      nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
      v_stack_item.source_card_id,
      coalesce(v_stack_item.payload -> 'effects', '[]'::jsonb),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid
    );
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
end;
$$;

grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
