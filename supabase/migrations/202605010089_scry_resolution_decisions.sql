-- Phase 1, slice 3: Tier-B resolution-time decisions — scry.
--
-- This is the first true suspend/resume through finalize_stack_resolution (087):
--   * cast_scry(...) pushes a 'scry' stack item (no decision yet).
--   * resolve_top_of_stack, on a 'scry' item, looks at the top N of the caster's
--     library, CREATES the scry decision, PARKS the item (status
--     'awaiting_decision'), and returns early — it does NOT finalize.
--   * submit_decision, for a 'scry' decision, validates the reorder, applies it to
--     the library, then calls finalize_stack_resolution to resume and finish.
--
-- Contrast with the Tier-A modal slice (088), where the decision is created on
-- announcement and resolution merely refuses until it's chosen. Here the decision
-- only exists because resolution reached a point that needs player input.
--
-- Library convention (from draw / dev_undo_last_draw): top of library = LOWEST
-- zone_position. "Put on top" => lowest positions; "put on bottom" => highest.
-- (IDE T-SQL diagnostics false-positive on $$ bodies — ignore.)

-- Allow the 'scry' stack action type (full list = 088 list + 'scry').
alter table public.game_stack_items
  drop constraint if exists game_stack_items_action_type_check;
alter table public.game_stack_items
  add constraint game_stack_items_action_type_check
  check (action_type = any (array[
    'deal_damage_player', 'deal_damage_creature', 'pump_creature', 'cast_permanent',
    'counter_spell', 'triggered_ability', 'draw_cards', 'destroy_creature',
    'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature',
    'exile_creature', 'modal_spell', 'scry'
  ]));

-- Allow a stack item to be parked awaiting a resolution-time decision.
alter table public.game_stack_items
  drop constraint if exists game_stack_items_status_check;
alter table public.game_stack_items
  add constraint game_stack_items_status_check
  check (status = any (array['pending', 'awaiting_decision', 'resolved', 'cancelled']));

-- Announce a scry. Pushes a 'scry' stack item; the decision is created later, at
-- resolution time (resolve_top_of_stack).
create or replace function public.cast_scry(
  p_session_id uuid,
  p_amount integer default 1,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_next_position integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if coalesce(p_amount, 0) < 1 then
    raise exception 'Scry amount must be at least 1';
  end if;

  select * into v_turn
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'scry',
    jsonb_build_object('amount', p_amount, 'timing', 'instant'),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  return v_stack;
end;
$$;

grant execute on function public.cast_scry(uuid, integer, uuid) to authenticated;

-- submit_decision: reproduced from 088 with a 'scry' branch added. For scry the
-- result is { "top": [game_card_id, ...], "bottom": [game_card_id, ...] }, each
-- ordered top-to-bottom; together they must be exactly the scryed cards. After
-- recording the result we reorder the library and resume via
-- finalize_stack_resolution.
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
  v_option_ids uuid[];
  v_chosen_ids uuid[];
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

    for v_idx in select (value)::integer from jsonb_array_elements_text(v_chosen)
    loop
      if v_idx < 0 or v_idx >= v_option_count then
        raise exception 'Chosen mode index % out of range', v_idx;
      end if;
    end loop;
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

    -- The submitted cards must be exactly the scryed cards: same count, all
    -- members of the option set, no duplicates.
    if cardinality(v_chosen_ids) <> cardinality(v_option_ids) then
      raise exception 'Scry must place every revealed card exactly once';
    end if;

    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_option_ids) then
      raise exception 'Scry placed a card more than once';
    end if;

    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then
      raise exception 'Scry placed a card that was not revealed';
    end if;
  end if;

  update public.game_pending_decisions
  set result = p_result, status = 'resolved', resolved_at = now()
  where id = p_decision_id
  returning * into v_decision;

  if v_decision.decision_type = 'scry' then
    -- Renumber the whole library: chosen "top" first (in order), then the
    -- library cards that were not revealed (keeping their order), then chosen
    -- "bottom" (in order).
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
  end if;

  return v_decision;
end;
$$;

grant execute on function public.submit_decision(uuid, jsonb) to authenticated;

-- resolve_top_of_stack: reproduced from 088 with a 'scry' branch that PARKS the
-- item (creates the scry decision, sets status 'awaiting_decision') and returns
-- early. Everything else is unchanged.
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
  v_decision public.game_pending_decisions;
  v_mode_index integer;
  v_mode jsonb;
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
  elsif v_stack_item.action_type = 'scry' then
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

    -- Empty library: nothing to look at — just finish.
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
      'scry',
      'Scry ' || v_amount,
      v_scry_options,
      0,
      jsonb_array_length(v_scry_options)
    )
    returning id into v_decision_id;

    update public.game_stack_items
    set status = 'awaiting_decision'
    where id = v_stack_item.id;

    -- Park: do NOT finalize. submit_decision resumes resolution.
    return jsonb_build_object(
      'awaiting_decision', true,
      'decision_id', v_decision_id,
      'decision_type', 'scry',
      'stack_item_id', v_stack_item.id
    );
  elsif v_stack_item.action_type = 'modal_spell' then
    select * into v_decision
    from public.game_pending_decisions
    where source_stack_item_id = v_stack_item.id and decision_type = 'choose_mode'
    order by created_at
    limit 1;

    if not found then
      raise exception 'Modal spell has no mode decision';
    end if;

    if v_decision.status <> 'resolved' then
      raise exception 'Modal spell requires a mode choice';
    end if;

    for v_mode_index in
      select (value)::integer
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_decision.result -> 'chosen') = 'array' then v_decision.result -> 'chosen'
          else jsonb_build_array(v_decision.result -> 'chosen')
        end
      )
    loop
      v_mode := (v_stack_item.payload -> 'modes') -> v_mode_index;
      perform public.apply_triggered_ability_effects(
        p_session_id,
        v_stack_item.controller_player_id,
        v_stack_item.source_card_id,
        coalesce(v_mode -> 'actions', '[]'::jsonb)
      );
    end loop;
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
