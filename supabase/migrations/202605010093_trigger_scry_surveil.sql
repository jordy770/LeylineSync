-- Phase 1, slice 6: scry / surveil from inside a triggered ability.
--
-- Until now Tier-B decisions (scry/surveil) could only originate from a dedicated
-- stack item (cast_scry / cast_surveil). A triggered ability resolved all its
-- effects inline (apply_targeted_triggered_ability_effects) and could not pause.
-- This adds resumable trigger resolution:
--
--   apply_trigger_effects(session, stack_item, start_index) walks the trigger's
--   effects from start_index. A normal effect is applied immediately (reusing
--   apply_targeted_triggered_ability_effects per effect). A scry/surveil effect
--   creates a pending decision, stashes the NEXT effect index on the stack item
--   (payload.resume_index), parks the item (status 'awaiting_decision'), and
--   returns the decision id. resolve_top_of_stack returns early when parked;
--   submit_decision, after applying the scry/surveil reorder, RESUMES the trigger
--   from resume_index (which may park again on a later scry) and only finalizes
--   once the trigger runs to completion.
--
-- (IDE T-SQL diagnostics false-positive on $$ bodies — ignore.)

create or replace function public.apply_trigger_effects(
  p_session_id uuid,
  p_stack_item_id uuid,
  p_start_index integer
)
returns uuid  -- the pending-decision id if parked, else null (ran to completion)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.game_stack_items;
  v_effects jsonb;
  v_target uuid;
  v_controller uuid;
  v_count integer;
  v_i integer;
  v_effect jsonb;
  v_type text;
  v_amount integer;
  v_options jsonb;
  v_decision_id uuid;
begin
  select * into v_item from public.game_stack_items where id = p_stack_item_id;
  if not found then
    return null;
  end if;

  v_effects := coalesce(v_item.payload -> 'effects', '[]'::jsonb);
  v_target := nullif(v_item.payload ->> 'target_card_id', '')::uuid;
  v_controller := nullif(v_item.payload ->> 'controller_player_id', '')::uuid;
  v_count := jsonb_array_length(v_effects);
  v_i := greatest(0, coalesce(p_start_index, 0));

  while v_i < v_count loop
    v_effect := v_effects -> v_i;
    v_type := lower(coalesce(v_effect ->> 'type', ''));

    if v_type in ('scry', 'surveil') then
      v_amount := coalesce((v_effect ->> 'amount')::integer, 1);

      select coalesce(
               jsonb_agg(
                 jsonb_build_object('game_card_id', top.id, 'name', c.name, 'library_position', top.zone_position)
                 order by top.zone_position asc, top.id asc
               ),
               '[]'::jsonb
             )
        into v_options
      from (
        select id, card_id, zone_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_controller
          and zone = 'library'
        order by zone_position asc, id asc
        limit v_amount
      ) top
      join public.cards c on c.id = top.card_id;

      -- Empty library: nothing to look at — skip this effect, keep going.
      if jsonb_array_length(v_options) = 0 then
        v_i := v_i + 1;
        continue;
      end if;

      insert into public.game_pending_decisions (
        session_id, deciding_player_id, source_stack_item_id, decision_type,
        prompt, options, min_choices, max_choices
      )
      values (
        p_session_id,
        v_controller,
        p_stack_item_id,
        v_type,
        initcap(v_type) || ' ' || v_amount,
        v_options,
        0,
        jsonb_array_length(v_options)
      )
      returning id into v_decision_id;

      update public.game_stack_items
      set status = 'awaiting_decision',
          payload = payload || jsonb_build_object('resume_index', v_i + 1)
      where id = p_stack_item_id;

      return v_decision_id;  -- parked; submit_decision will resume from resume_index
    else
      perform public.apply_targeted_triggered_ability_effects(
        p_session_id,
        v_controller,
        v_item.source_card_id,
        jsonb_build_array(v_effect),
        v_target
      );
    end if;

    v_i := v_i + 1;
  end loop;

  return null;  -- ran to completion without parking
end;
$$;

grant execute on function public.apply_trigger_effects(uuid, uuid, integer) to authenticated;

-- submit_decision: reproduced from 091; the scry & surveil tails now RESUME a
-- triggered-ability source (via apply_trigger_effects from resume_index) instead
-- of always finalizing. A standalone scry/surveil spell item still just finalizes.
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
  v_src_type text;
  v_src_resume integer;
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

    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids
    from jsonb_array_elements(v_decision.options);

    select array_agg(id) into v_chosen_ids
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

    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids
    from jsonb_array_elements(v_decision.options);

    select array_agg(id) into v_chosen_ids
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
      select id, (row_number() over (order by section, ordnum) - 1) as np from ordered
    )
    update public.game_cards g set zone_position = renum.np
    from renum where g.id = renum.id;

    select action_type, coalesce((payload ->> 'resume_index')::integer, 0)
      into v_src_type, v_src_resume
    from public.game_stack_items where id = v_decision.source_stack_item_id;

    if v_src_type = 'triggered_ability' then
      if public.apply_trigger_effects(v_decision.session_id, v_decision.source_stack_item_id, v_src_resume) is null then
        perform public.finalize_stack_resolution(v_decision.session_id, v_decision.source_stack_item_id);
      end if;
    else
      perform public.finalize_stack_resolution(v_decision.session_id, v_decision.source_stack_item_id);
    end if;
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
      select id, (row_number() over (order by section, ordnum) - 1) as np from ordered
    )
    update public.game_cards g set zone_position = renum.np
    from renum where g.id = renum.id;

    select action_type, coalesce((payload ->> 'resume_index')::integer, 0)
      into v_src_type, v_src_resume
    from public.game_stack_items where id = v_decision.source_stack_item_id;

    if v_src_type = 'triggered_ability' then
      if public.apply_trigger_effects(v_decision.session_id, v_decision.source_stack_item_id, v_src_resume) is null then
        perform public.finalize_stack_resolution(v_decision.session_id, v_decision.source_stack_item_id);
      end if;
    else
      perform public.finalize_stack_resolution(v_decision.session_id, v_decision.source_stack_item_id);
    end if;
  end if;

  return v_decision;
end;
$$;

grant execute on function public.submit_decision(uuid, jsonb) to authenticated;

-- resolve_top_of_stack: reproduced from 091; the triggered_ability branch now runs
-- through apply_trigger_effects and parks (returns early) if a scry/surveil effect
-- needs a decision. Everything else unchanged.
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

    v_decision_id := public.apply_trigger_effects(p_session_id, v_stack_item.id, 0);
    if v_decision_id is not null then
      return jsonb_build_object(
        'awaiting_decision', true,
        'decision_id', v_decision_id,
        'stack_item_id', v_stack_item.id
      );
    end if;
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
end;
$$;

grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
