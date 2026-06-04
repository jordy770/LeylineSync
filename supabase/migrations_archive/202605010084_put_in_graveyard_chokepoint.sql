-- Phase 0 (rules-engine cleanup): centralize the battlefield -> graveyard
-- transition into a single primitive, public.put_in_graveyard.
--
-- Before this, three places inlined the same "move a battlefield permanent to its
-- owner's graveyard with leave-the-battlefield cleanup" logic:
--   * move_lethal_damaged_creatures_to_graveyard (state-based deaths: combat, damage)
--   * resolve_top_of_stack            -> destroy_creature
--   * apply_targeted_triggered_ability_effects -> destroy
--
-- Centralizing means future changes to that transition — most immediately the
-- finality counter ("if it would die, exile it instead") and other death
-- replacement effects — live in ONE function instead of being duplicated. It is
-- also the natural seam for moving resolution into application code later.
--
-- Behavior-preserving, with one deliberate, harmless unification: the SBA mover
-- previously left controller_player_id untouched on death; put_in_graveyard sets
-- it back to owner_id (as the destroy paths already did). A card in the graveyard
-- is owned, not controlled, so this only normalises a stolen creature's row.

-- 1. The single battlefield -> graveyard primitive.
--    Acts only on a card currently on the battlefield (the dies / leaves-to-grave
--    transition); returns whether it moved. Does NOT rebuild continuous effects or
--    fire triggers — the per-row zone-change trigger (trg_a_fire_zone_change) still
--    fires dies/leaves automatically, and callers rebuild once after a batch.
create or replace function public.put_in_graveyard(
  p_session_id uuid,
  p_game_card_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_next_graveyard_position integer;
begin
  select owner_id
  into v_owner_id
  from public.game_cards
  where id = p_game_card_id
    and session_id = p_session_id
    and zone = 'battlefield';

  if not found then
    return false;
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_graveyard_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = v_owner_id
    and zone = 'graveyard';

  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = v_next_graveyard_position,
    controller_player_id = owner_id,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  where id = p_game_card_id;

  return true;
end;
$$;

-- 2. State-based death mover: snapshot the dying set (same conditions as migration
--    074), then route each through put_in_graveyard. Snapshotting first preserves
--    the "evaluate the dying set once" semantics of the prior set-based UPDATE.
create or replace function public.move_lethal_damaged_creatures_to_graveyard(
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_destroyed_count integer := 0;
  v_dying uuid[];
  v_card uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select array_agg(
    game_cards.id
    order by game_cards.owner_id, game_cards.zone_position, game_cards.id
  )
  into v_dying
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.session_id = p_session_id
    and game_cards.zone = 'battlefield'
    and coalesce(cards.type_line, '') ilike '%creature%'
    and (
      -- 704.5f: toughness 0 or less. Ignores indestructible and damage.
      public.card_effective_toughness(p_session_id, game_cards.id) <= 0
      or (
        -- 704.5g: lethal marked damage. Indestructible prevents this.
        game_cards.damage_marked > 0
        and not public.card_has_indestructible(p_session_id, game_cards.id)
        and (
          game_cards.dealt_deathtouch_damage = true
          or game_cards.damage_marked >= public.card_effective_toughness(p_session_id, game_cards.id)
        )
      )
    );

  foreach v_card in array coalesce(v_dying, array[]::uuid[])
  loop
    if public.put_in_graveyard(p_session_id, v_card) then
      v_destroyed_count := v_destroyed_count + 1;
    end if;
  end loop;

  if v_destroyed_count > 0 then
    perform public.rebuild_scripted_continuous_effects(p_session_id);
  end if;

  return v_destroyed_count;
end;
$$;

-- 3. apply_targeted_triggered_ability_effects: route the destroy branch through
--    put_in_graveyard. Reproduces migration 083's body otherwise.
create or replace function public.apply_targeted_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb,
  p_target_card_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect jsonb;
  v_eff_type text;
  v_eff_amount integer;
  v_target_owner_id uuid;
  v_next_hand_position integer;
  v_next_exile_position integer;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    if not public.trigger_effect_requires_creature_target(v_effect) then
      perform public.apply_triggered_ability_effects(
        p_session_id,
        p_controller_id,
        p_source_card_id,
        jsonb_build_array(v_effect)
      );
      continue;
    end if;

    -- Targeted trigger effects fizzle harmlessly if the target is gone.
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := coalesce((v_effect ->> 'amount')::integer, 0);

    if v_eff_type = 'deal_damage' then
      if p_target_card_id is not null and v_eff_amount > 0 then
        update public.game_cards
        set damage_marked = damage_marked + v_eff_amount
        where id = p_target_card_id
          and session_id = p_session_id
          and zone = 'battlefield';

        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;

    elsif v_eff_type = 'destroy' then
      perform public.put_in_graveyard(p_session_id, p_target_card_id);

    elsif v_eff_type = 'exile' then
      select owner_id
      into v_target_owner_id
      from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      if found then
        select coalesce(max(zone_position), -1) + 1
        into v_next_exile_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_owner_id
          and zone = 'exile';

        update public.game_cards
        set
          zone = 'exile',
          zone_position = v_next_exile_position,
          controller_player_id = owner_id,
          is_tapped = false,
          damage_marked = 0,
          dealt_deathtouch_damage = false,
          plus_one_counters = 0
        where id = p_target_card_id;
      end if;

    elsif v_eff_type = 'bounce' then
      select owner_id
      into v_target_owner_id
      from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      if found then
        select coalesce(max(zone_position), -1) + 1
        into v_next_hand_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_owner_id
          and zone = 'hand';

        update public.game_cards
        set
          zone = 'hand',
          zone_position = v_next_hand_position,
          controller_player_id = owner_id,
          is_tapped = false,
          damage_marked = 0,
          dealt_deathtouch_damage = false,
          plus_one_counters = 0
        where id = p_target_card_id;
      end if;

    elsif v_eff_type in ('tap', 'untap') then
      update public.game_cards
      set is_tapped = (v_eff_type = 'tap')
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

    elsif v_eff_type = 'add_counters' then
      if p_target_card_id is not null and v_eff_amount > 0 then
        update public.game_cards
        set plus_one_counters = greatest(0, plus_one_counters + v_eff_amount)
        where id = p_target_card_id
          and session_id = p_session_id
          and zone = 'battlefield';
      end if;
    end if;
  end loop;
end;
$$;

-- 4. resolve_top_of_stack: route the destroy_creature branch through
--    put_in_graveyard. Reproduces migration 083's body otherwise.
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
  v_target_card_id uuid;
  v_target_owner_id uuid;
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
  v_next_hand_position integer;
  v_next_exile_position integer;
  v_finish_state jsonb;
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
  elsif v_stack_item.action_type = 'deal_damage_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_card_id is not null and v_amount > 0 then
      update public.game_cards
      set damage_marked = damage_marked + v_amount
      where id = v_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
    end if;
  elsif v_stack_item.action_type = 'pump_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    if v_target_card_id is not null
      and exists (
        select 1 from public.game_cards
        where id = v_target_card_id
          and session_id = p_session_id
          and zone = 'battlefield'
      )
    then
      perform public.create_pt_pump(
        p_session_id,
        v_target_card_id,
        coalesce((v_stack_item.payload ->> 'power')::integer, 0),
        coalesce((v_stack_item.payload ->> 'toughness')::integer, 0)
      );
    end if;
  elsif v_stack_item.action_type = 'destroy_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;
    perform public.put_in_graveyard(p_session_id, v_target_card_id);
  elsif v_stack_item.action_type = 'exile_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_exile_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'exile';

      update public.game_cards
      set
        zone = 'exile',
        zone_position = v_next_exile_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = v_target_card_id;
    end if;
  elsif v_stack_item.action_type = 'bounce_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_hand_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'hand';

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_hand_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = v_target_card_id;
    end if;
  elsif v_stack_item.action_type in ('tap_creature', 'untap_creature') then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    update public.game_cards
    set is_tapped = (v_stack_item.action_type = 'tap_creature')
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';
  elsif v_stack_item.action_type = 'add_counters_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_card_id is not null and v_amount > 0 then
      update public.game_cards
      set plus_one_counters = greatest(0, plus_one_counters + v_amount)
      where id = v_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;
  elsif v_stack_item.action_type = 'draw_cards' then
    perform public.apply_triggered_ability_effects(
      p_session_id,
      v_stack_item.controller_player_id,
      null,
      jsonb_build_array(
        jsonb_build_object('type', 'draw', 'amount', coalesce((v_stack_item.payload ->> 'amount')::integer, 1))
      )
    );
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

  update public.game_stack_items
  set
    status = 'resolved',
    resolved_at = now()
  where id = v_stack_item.id;

  perform public.rebuild_scripted_continuous_effects(p_session_id);

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'resolved_stack_item_id',
    v_stack_item.id,
    'action_type',
    v_stack_item.action_type,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$$;

grant execute on function public.put_in_graveyard(uuid, uuid) to authenticated;
grant execute on function public.move_lethal_damaged_creatures_to_graveyard(uuid) to authenticated;
grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
