-- 202605010310_opportunistic_dragon_target_filter
-- Enforce an optional type-line restriction on a triggered ability's target —
-- Opportunistic Dragon (mig 246) "choose target Human or artifact an opponent
-- controls" was approximated as "any permanent". A trigger effect may now carry
--   target_filter: { type_line_any: ["Human","Artifact"] }   (or type_line: "X")
-- which is plumbed into the stack payload (enqueue), gates whether the trigger is
-- even put on the stack (no legal target → not enqueued), and is enforced when the
-- controller picks the target (choose_triggered_ability_creature_target). The
-- client picker reads the same payload field. Two small helpers below;
-- enqueue/choose are canonical in supabase/functions_src.
-- (IDE T-SQL diagnostics false-positive on $$ bodies — ignore.)

-- ── card_type_line_matches_filter — type-line OR / substring match ────────────
create or replace function public.card_type_line_matches_filter(
  p_type_line text, p_filter jsonb
) returns boolean language sql immutable as $$
  select case
    when p_filter is null then true
    when p_type_line is null then false
    when jsonb_typeof(p_filter -> 'type_line_any') = 'array' then
      exists (
        select 1 from jsonb_array_elements_text(p_filter -> 'type_line_any') as w(word)
        where p_type_line ilike '%' || w.word || '%'
      )
    when p_filter ->> 'type_line' is not null then
      p_type_line ilike '%' || (p_filter ->> 'type_line') || '%'
    else true
  end;
$$;
grant all on function public.card_type_line_matches_filter(text, jsonb) to anon, authenticated, service_role;

-- ── trigger_effects_target_filter — the filter from the first targeted effect ─
create or replace function public.trigger_effects_target_filter(p_effects jsonb)
returns jsonb language sql immutable as $$
  select effects.effect -> 'target_filter'
  from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
  where public.trigger_effect_target_type(effects.effect) is not null
  limit 1;
$$;
grant all on function public.trigger_effects_target_filter(jsonb) to anon, authenticated, service_role;

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

create or replace function public.choose_triggered_ability_creature_target(
  p_session_id uuid, p_stack_item_id uuid, p_target_card_id uuid
) returns public.game_stack_items
language plpgsql security definer set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
  v_target_type jsonb;
  v_target_type_line text;
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
    or coalesce((v_stack_item.payload ->> 'target_required')::boolean, false) is not true
  then
    raise exception 'Stack item does not require a trigger target';
  end if;

  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  v_target_type := v_stack_item.payload -> 'target_type';

  if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
    if not public.creature_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any')
    ) then
      raise exception 'Target is not a legal creature for this ability';
    end if;
  else
    if not public.permanent_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any'), v_target_type
    ) then
      raise exception 'Target is not a legal permanent for this ability';
    end if;
  end if;

  -- Type-line restriction (mig 310): a payload `target_filter` narrows the legal
  -- targets by type line (Opportunistic Dragon: Human or artifact). Null = no
  -- restriction.
  if v_stack_item.payload -> 'target_filter' is not null then
    select c.type_line into v_target_type_line
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_target_card_id and gc.session_id = p_session_id;

    if not public.card_type_line_matches_filter(v_target_type_line, v_stack_item.payload -> 'target_filter') then
      raise exception 'Target does not match this ability''s type restriction';
    end if;
  end if;

  -- Protection: the chosen target can't have protection from the trigger source's
  -- colour(s). The source card's mana cost gives its colours.
  if public.card_has_protection_from_any(
       p_session_id, p_target_card_id,
       public.card_color_set((
         select c.mana_cost
         from public.game_cards gc
         join public.cards c on c.id = gc.card_id
         where gc.id = v_stack_item.source_card_id
       ))) then
    raise exception 'Target has protection from this ability''s colour';
  end if;

  update public.game_stack_items
  set payload = payload || jsonb_build_object('target_card_id', p_target_card_id, 'target_chosen', true)
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;
grant all on function public.choose_triggered_ability_creature_target(uuid, uuid, uuid) to anon, authenticated, service_role;
