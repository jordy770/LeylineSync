-- Phase 3, slice 4b — MULTI-target triggered abilities. "When this enters,
-- destroy up to N target creatures/permanents." The trigger analogue of mig 112's
-- spell-side multi_creature_effect, threaded through the announcement-time
-- trigger-target machinery generalised in mig 114.
--
-- A removal trigger effect carries `targets: N` (same field as the spell side). The
-- trigger is enqueued with target_count = N; the controller picks up to N targets
-- via the NEW choose_triggered_ability_targets RPC (stores target_card_ids); at
-- resolution apply_trigger_effects applies the targeted effect to EACH chosen target.
--
-- Back-compatible: a single-target trigger (targets 1/absent) still uses the single
-- picker (choose_triggered_ability_creature_target → target_card_id) and the single
-- apply path; the new array path only fires when target_card_ids is present.
--
-- Reproduces enqueue_triggered_ability + handle_triggered_ability (mig 114) and
-- apply_trigger_effects (mig 111) with surgical changes; adds 2 helpers + 1 RPC.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- How many targets a trigger effect wants (1 unless it carries `targets`).
-- ---------------------------------------------------------------------------
create or replace function public.trigger_effect_target_count(p_effect jsonb)
returns integer language sql immutable as $$
  select case
    when public.trigger_effect_target_type(p_effect) is null then 0
    else greatest(1, coalesce((p_effect ->> 'targets')::integer, 1))
  end;
$$;

grant all on function public.trigger_effect_target_count(jsonb) to anon, authenticated, service_role;

create or replace function public.trigger_effects_target_count(p_effects jsonb)
returns integer language sql immutable as $$
  select public.trigger_effect_target_count(effects.effect)
  from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
  where public.trigger_effect_target_type(effects.effect) is not null
  limit 1;
$$;

grant all on function public.trigger_effects_target_count(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- enqueue_triggered_ability (mig 114) — also stamp target_count into the payload.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_triggered_ability(
  p_session_id uuid, p_controller_id uuid, p_source_card_id uuid, p_label text, p_effects jsonb
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_next_position integer;
  v_target_type jsonb;
  v_requires_target boolean;
  v_target_controller text;
  v_has_target boolean;
begin
  if p_effects is null or jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) = 0 then
    return;
  end if;

  v_target_type := public.trigger_effects_target_type(p_effects);
  v_requires_target := v_target_type is not null;

  if v_requires_target then
    v_target_controller := coalesce(public.trigger_effects_target_controller(p_effects), 'any');

    if public.behavior_target_type_is_creature_only(v_target_type) then
      v_has_target := public.session_has_targetable_creature(p_session_id, p_controller_id, v_target_controller);
    else
      v_has_target := public.session_has_targetable_permanent(p_session_id, p_controller_id, v_target_controller, v_target_type);
    end if;

    if not v_has_target then
      return;
    end if;
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
      'timing', 'triggered'
    ),
    v_next_position
  );
end;
$$;

grant execute on function public.enqueue_triggered_ability(uuid, uuid, uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- choose_triggered_ability_targets — pick UP TO target_count legal targets at once.
-- Stores target_card_ids (jsonb array). The single-target RPC stays for count 1.
-- ---------------------------------------------------------------------------
create or replace function public.choose_triggered_ability_targets(
  p_session_id uuid, p_stack_item_id uuid, p_target_card_ids uuid[]
) returns public.game_stack_items
language plpgsql security definer set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
  v_target_type jsonb;
  v_count integer;
  v_max integer;
  v_id uuid;
  v_seen uuid[] := array[]::uuid[];
  v_ok boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where id = p_stack_item_id and session_id = p_session_id and status = 'pending'
  for update;

  if not found then
    raise exception 'Triggered ability stack item not found';
  end if;
  if v_stack_item.action_type <> 'triggered_ability'
    or coalesce((v_stack_item.payload ->> 'target_required')::boolean, false) is not true then
    raise exception 'Stack item does not require a trigger target';
  end if;
  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  v_count := coalesce(array_length(p_target_card_ids, 1), 0);
  v_max := greatest(1, coalesce((v_stack_item.payload ->> 'target_count')::integer, 1));
  if v_count < 1 or v_count > v_max then
    raise exception 'Choose between 1 and % target(s)', v_max;
  end if;

  v_target_type := v_stack_item.payload -> 'target_type';

  foreach v_id in array p_target_card_ids loop
    if v_id = any(v_seen) then
      raise exception 'A target may not be chosen more than once';
    end if;
    v_seen := array_append(v_seen, v_id);

    if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
      v_ok := public.creature_target_controller_ok(
        p_session_id, v_id, v_stack_item.controller_player_id,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any'));
    else
      v_ok := public.permanent_target_controller_ok(
        p_session_id, v_id, v_stack_item.controller_player_id,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any'), v_target_type);
    end if;
    if not v_ok then
      raise exception 'Target is not a legal target for this ability';
    end if;
  end loop;

  update public.game_stack_items
  set payload = payload || jsonb_build_object('target_card_ids', to_jsonb(p_target_card_ids), 'target_chosen', true)
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;

grant execute on function public.choose_triggered_ability_targets(uuid, uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- handle_triggered_ability (mig 114) — "target not chosen" now also accounts for
-- target_card_ids (the multi-target picker writes an array, not target_card_id).
-- ---------------------------------------------------------------------------
create or replace function public.handle_triggered_ability(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision_id uuid;
  v_target_type jsonb;
  v_has_target boolean;
begin
  if coalesce((p_stack_item.payload ->> 'target_required')::boolean, false)
    and nullif(p_stack_item.payload ->> 'target_card_id', '') is null
    and coalesce(jsonb_array_length(p_stack_item.payload -> 'target_card_ids'), 0) = 0
  then
    v_target_type := p_stack_item.payload -> 'target_type';
    if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
      v_has_target := public.session_has_targetable_creature(
        p_session_id,
        nullif(p_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(p_stack_item.payload ->> 'target_controller', 'any')
      );
    else
      v_has_target := public.session_has_targetable_permanent(
        p_session_id,
        nullif(p_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(p_stack_item.payload ->> 'target_controller', 'any'),
        v_target_type
      );
    end if;

    if v_has_target then
      raise exception 'Triggered ability requires a target';
    end if;
  end if;

  v_decision_id := public.apply_trigger_effects(p_session_id, p_stack_item.id, 0);
  if v_decision_id is not null then
    return jsonb_build_object(
      'awaiting_decision', true,
      'decision_id', v_decision_id,
      'stack_item_id', p_stack_item.id
    );
  end if;
  return null;
end;
$$;

revoke all on function public.handle_triggered_ability(uuid, public.game_stack_items) from public;

-- ---------------------------------------------------------------------------
-- apply_trigger_effects (mig 111) — the targeted-effect dispatch (else branch) now
-- applies to EACH id in target_card_ids when present (multi-target trigger); the
-- single-target path (target_card_id) is unchanged. Everything else verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.apply_trigger_effects(
  p_session_id uuid,
  p_stack_item_id uuid,
  p_start_index integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.game_stack_items;
  v_effects jsonb;
  v_target uuid;
  v_targets jsonb;
  v_tid uuid;
  v_controller uuid;
  v_count integer;
  v_i integer;
  v_effect jsonb;
  v_type text;
  v_amount integer;
  v_options jsonb;
  v_decision_id uuid;
  v_filter text;
  v_name text;
  v_len integer;
  v_decider uuid;
  v_who text;
  v_queue jsonb;
begin
  select * into v_item from public.game_stack_items where id = p_stack_item_id;
  if not found then
    return null;
  end if;

  v_effects := coalesce(v_item.payload -> 'effects', '[]'::jsonb);
  v_target := nullif(v_item.payload ->> 'target_card_id', '')::uuid;
  v_targets := v_item.payload -> 'target_card_ids';
  v_controller := nullif(v_item.payload ->> 'controller_player_id', '')::uuid;
  v_count := jsonb_array_length(v_effects);
  v_i := greatest(0, coalesce(p_start_index, 0));

  while v_i < v_count loop
    v_effect := v_effects -> v_i;
    v_type := lower(coalesce(v_effect ->> 'type', ''));

    if v_type in ('scry', 'surveil') then
      v_amount := coalesce((v_effect ->> 'amount')::integer, 1);
      select coalesce(
               jsonb_agg(jsonb_build_object('game_card_id', top.id, 'name', c.name, 'library_position', top.zone_position)
                 order by top.zone_position asc, top.id asc),
               '[]'::jsonb)
        into v_options
      from (
        select id, card_id, zone_position from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc limit v_amount
      ) top
      join public.cards c on c.id = top.card_id;

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, v_type, initcap(v_type) || ' ' || v_amount, v_options, 0, jsonb_array_length(v_options))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'search_library' then
      v_filter := v_effect -> 'filter' ->> 'type_line';
      v_name := v_effect -> 'filter' ->> 'name';
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', lib.id, 'name', c.name) order by c.name, lib.id), '[]'::jsonb)
        into v_options
      from public.game_cards lib join public.cards c on c.id = lib.card_id
      where lib.session_id = p_session_id and lib.owner_id = v_controller and lib.zone = 'library'
        and (v_filter is null or c.type_line ilike '%' || v_filter || '%')
        and (v_name is null or c.name ilike '%' || v_name || '%');

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'search_library',
        'Search your library'
          || case when v_filter is not null then ' for a ' || v_filter else '' end
          || case when v_name is not null then ' named ' || v_name else '' end,
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        jsonb_build_object(
          'to', coalesce(v_effect ->> 'to', v_effect ->> 'destination', 'hand'),
          'tapped', coalesce((v_effect ->> 'tapped')::boolean, false),
          'reveal', coalesce((v_effect ->> 'reveal')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'discard' then
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', h.id, 'name', c.name) order by h.zone_position, h.id), '[]'::jsonb)
        into v_options
      from public.game_cards h join public.cards c on c.id = h.card_id
      where h.session_id = p_session_id and h.owner_id = v_controller and h.zone = 'hand';

      v_len := jsonb_array_length(v_options);
      if v_len = 0 then v_i := v_i + 1; continue; end if;
      v_amount := least(coalesce((v_effect ->> 'count')::integer, 1), v_len);

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_cards', 'Discard ' || v_amount, v_options, v_amount, v_amount, jsonb_build_object('to', 'graveyard'))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'may' then
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'confirm', coalesce(v_effect ->> 'prompt', 'You may'), '[]'::jsonb, 0, 0,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_player' then
      v_filter := lower(coalesce(v_effect ->> 'filter', 'any'));
      select coalesce(
               jsonb_agg(jsonb_build_object('player_id', sp.player_id, 'username', p.username) order by sp.seat_number),
               '[]'::jsonb)
        into v_options
      from public.game_session_players sp
      left join public.profiles p on p.id = sp.player_id
      where sp.session_id = p_session_id
        and (v_filter <> 'opponent' or sp.player_id is distinct from v_controller);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_player', 'Choose a player', v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'sacrifice' then
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
      v_filter := v_effect -> 'filter' ->> 'type_line';

      if v_who = 'each_opponent' then
        select coalesce(jsonb_agg(to_jsonb(sp.player_id::text) order by sp.seat_number), '[]'::jsonb)
          into v_queue
        from public.game_session_players sp
        where sp.session_id = p_session_id and sp.player_id is distinct from v_controller;
      elsif v_who = 'opponent' then
        select coalesce(jsonb_agg(to_jsonb(one.player_id::text) order by one.seat_number), '[]'::jsonb)
          into v_queue
        from (
          select player_id, seat_number from public.game_session_players
          where session_id = p_session_id and player_id is distinct from v_controller
          order by seat_number limit 1
        ) one;
      else
        v_queue := jsonb_build_array(v_controller::text);
      end if;

      v_decision_id := public.park_edict_sacrifice(
        p_session_id, p_stack_item_id, coalesce((v_effect ->> 'count')::integer, 1), v_filter, v_queue
      );
      if v_decision_id is null then v_i := v_i + 1; continue; end if;

      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'return_from_graveyard' then
      v_filter := v_effect -> 'filter' ->> 'type_line';
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id), '[]'::jsonb)
        into v_options
      from public.game_cards gy join public.cards c on c.id = gy.card_id
      where gy.session_id = p_session_id and gy.owner_id = v_controller and gy.zone = 'graveyard'
        and (case when v_filter is not null then c.type_line ilike '%' || v_filter || '%'
                  else c.type_line ilike '%creature%' end);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'return_from_graveyard',
        'Return up to ' || coalesce((v_effect ->> 'count'), '1') || ' from your graveyard',
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        jsonb_build_object('to', coalesce(v_effect ->> 'to', 'hand')))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    else
      -- Targeted trigger effect dispatch. Multi-target (target_card_ids present) →
      -- apply to each chosen target; otherwise the single target_card_id path. A
      -- non-targeted effect goes through the single path once (apply_targeted_…
      -- routes it to the untargeted applier), so it is never double-applied.
      if jsonb_typeof(v_targets) = 'array' and jsonb_array_length(v_targets) > 0
         and public.trigger_effect_target_type(v_effect) is not null then
        for v_tid in select (value)::uuid from jsonb_array_elements_text(v_targets)
        loop
          perform public.apply_targeted_triggered_ability_effects(
            p_session_id, v_controller, v_item.source_card_id, jsonb_build_array(v_effect), v_tid
          );
        end loop;
      else
        perform public.apply_targeted_triggered_ability_effects(
          p_session_id, v_controller, v_item.source_card_id, jsonb_build_array(v_effect), v_target
        );
      end if;
    end if;

    v_i := v_i + 1;
  end loop;

  return null;
end;
$$;

grant execute on function public.apply_trigger_effects(uuid, uuid, integer) to authenticated;
