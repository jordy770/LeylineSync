-- Phase 1, slice 2: the generic "pending decision" state machine + a modal
-- ("choose one") vertical slice.
--
-- A pending decision is anything the game must pause and ask a player before a
-- stack item can finish resolving (modal mode choice now; scry/order, distribute,
-- choose-player later). This migration adds:
--   * game_pending_decisions    — the decision rows
--   * submit_decision(id, result)— the single entry point a deciding player calls
--   * get_pending_decisions(...) — what a client/UI reads
--   * cast_modal_spell(...)      — announce a modal spell (Tier A: mode is chosen
--                                  on announcement; spell resolves later)
--   * resolve_top_of_stack       — gains a 'modal_spell' branch that runs the
--                                  chosen mode's (untargeted) actions, then
--                                  finalize_stack_resolution.
--
-- Tier A only here: a modal mode's actions are UNTARGETED (applied via
-- apply_triggered_ability_effects). Targeted modes (which need target selection)
-- are a later slice. (IDE T-SQL diagnostics false-positive on $$.)

-- Allow the new 'modal_spell' stack action type.
alter table public.game_stack_items
  drop constraint if exists game_stack_items_action_type_check;
alter table public.game_stack_items
  add constraint game_stack_items_action_type_check
  check (action_type = any (array[
    'deal_damage_player', 'deal_damage_creature', 'pump_creature', 'cast_permanent',
    'counter_spell', 'triggered_ability', 'draw_cards', 'destroy_creature',
    'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature',
    'exile_creature', 'modal_spell'
  ]));

create table if not exists public.game_pending_decisions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  deciding_player_id uuid not null,
  source_stack_item_id uuid,
  decision_type text not null,
  prompt text,
  options jsonb not null default '[]'::jsonb,
  min_choices integer not null default 1,
  max_choices integer not null default 1,
  status text not null default 'pending',
  result jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint game_pending_decisions_status_check
    check (status in ('pending', 'resolved', 'cancelled'))
);

create index if not exists game_pending_decisions_session_idx
  on public.game_pending_decisions (session_id, status);
create index if not exists game_pending_decisions_item_idx
  on public.game_pending_decisions (source_stack_item_id);

-- Whether a stack item still has an unresolved decision blocking its resolution.
create or replace function public.stack_item_has_pending_decision(
  p_stack_item_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.game_pending_decisions
    where source_stack_item_id = p_stack_item_id and status = 'pending'
  );
$$;

grant execute on function public.stack_item_has_pending_decision(uuid) to authenticated;

-- What a player needs to act on: their pending decisions in this session.
create or replace function public.get_pending_decisions(
  p_session_id uuid
)
returns table (
  id uuid,
  deciding_player_id uuid,
  source_stack_item_id uuid,
  decision_type text,
  prompt text,
  options jsonb,
  min_choices integer,
  max_choices integer
)
language sql
security definer
set search_path = public
as $$
  select id, deciding_player_id, source_stack_item_id, decision_type,
         prompt, options, min_choices, max_choices
  from public.game_pending_decisions
  where session_id = p_session_id and status = 'pending'
  order by created_at;
$$;

grant execute on function public.get_pending_decisions(uuid) to authenticated;

-- Submit a decision result. Validates the caller is the deciding player and the
-- choice is legal. For choose_mode the result is { "chosen": [idx, ...] } (or a
-- single int); each index must be in range and the count within min/max.
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
  end if;

  update public.game_pending_decisions
  set result = p_result, status = 'resolved', resolved_at = now()
  where id = p_decision_id
  returning * into v_decision;

  return v_decision;
end;
$$;

grant execute on function public.submit_decision(uuid, jsonb) to authenticated;

-- Announce a modal spell. Puts a modal_spell item on the stack and creates the
-- choose_mode decision for the caster. The spell cannot resolve until the mode
-- is chosen (enforced in resolve_top_of_stack).
create or replace function public.cast_modal_spell(
  p_session_id uuid,
  p_modes jsonb,
  p_choose integer default 1,
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

  if jsonb_typeof(p_modes) <> 'array' or jsonb_array_length(p_modes) < 1 then
    raise exception 'Modal spell needs at least one mode';
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
    'modal_spell',
    jsonb_build_object('modes', p_modes, 'choose', greatest(1, p_choose), 'timing', 'instant'),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  insert into public.game_pending_decisions (
    session_id, deciding_player_id, source_stack_item_id, decision_type,
    prompt, options, min_choices, max_choices
  )
  values (
    p_session_id,
    auth.uid(),
    v_stack.id,
    'choose_mode',
    'Choose ' || greatest(1, p_choose) || ' mode(s)',
    p_modes,
    greatest(1, p_choose),
    greatest(1, p_choose)
  );

  return v_stack;
end;
$$;

grant execute on function public.cast_modal_spell(uuid, jsonb, integer, uuid) to authenticated;

-- resolve_top_of_stack: reproduced from migration 087 with a 'modal_spell' branch
-- added (runs the chosen mode's untargeted actions). Everything else unchanged.
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
