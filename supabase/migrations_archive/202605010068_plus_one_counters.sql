-- +1/+1 counters.
--
-- Each +1/+1 counter raises a creature's power and toughness by 1. Counters are
-- permanent state stored on the game_cards row. Combat damage resolution and the
-- lethal-damage mover use "effective" power/toughness (printed value + counters)
-- via helper functions so every consumer sees the same numbers.

alter table public.game_cards
  add column if not exists plus_one_counters integer not null default 0;

comment on column public.game_cards.plus_one_counters is
  'Number of +1/+1 counters on this permanent. Each raises effective power and toughness by 1.';

-- Effective power = printed power (or parsed from power_toughness) + counters.
create or replace function public.card_effective_power(
  p_session_id uuid,
  p_game_card_id uuid
)
returns integer
language sql
security definer
set search_path = public
as $$
  select coalesce(
    cards.power,
    case
      when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
        then split_part(cards.power_toughness, '/', 1)::integer
      else 0
    end,
    0
  ) + coalesce(game_cards.plus_one_counters, 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

-- Effective toughness = printed toughness (or parsed) + counters.
create or replace function public.card_effective_toughness(
  p_session_id uuid,
  p_game_card_id uuid
)
returns integer
language sql
security definer
set search_path = public
as $$
  select coalesce(
    cards.toughness,
    case
      when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
        then split_part(cards.power_toughness, '/', 2)::integer
      else 0
    end,
    0
  ) + coalesce(game_cards.plus_one_counters, 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

-- Add or remove +1/+1 counters on a permanent. Clamps at 0.
create or replace function public.adjust_card_counters(
  p_session_id uuid,
  p_game_card_id uuid,
  p_delta integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  update public.game_cards
  set plus_one_counters = greatest(0, plus_one_counters + p_delta)
  where id = p_game_card_id
    and session_id = p_session_id
  returning plus_one_counters into v_new_count;

  if not found then
    raise exception 'Card not found in this session';
  end if;

  -- Adding counters can lift a creature above lethal marked damage; removing
  -- counters can drop it below. Re-check lethal state after the change.
  perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);

  return v_new_count;
end;
$$;

-- move_lethal_damaged_creatures_to_graveyard: compare marked damage against
-- effective toughness (printed + counters) instead of printed toughness only.
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
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  with lethal_cards as (
    select
      game_cards.id,
      game_cards.owner_id,
      row_number() over (
        partition by game_cards.owner_id
        order by game_cards.zone_position, game_cards.id
      ) - 1 as graveyard_offset
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield'
      and game_cards.damage_marked > 0
      and coalesce(cards.type_line, '') ilike '%creature%'
      and not public.card_has_indestructible(p_session_id, game_cards.id)
      and (
        game_cards.dealt_deathtouch_damage = true
        or game_cards.damage_marked >= public.card_effective_toughness(p_session_id, game_cards.id)
      )
  ),
  graveyard_positions as (
    select
      game_cards.owner_id,
      coalesce(max(game_cards.zone_position), -1) + 1 as next_graveyard_position
    from public.game_cards
    where game_cards.session_id = p_session_id
      and game_cards.zone = 'graveyard'
    group by game_cards.owner_id
  )
  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = coalesce(graveyard_positions.next_graveyard_position, 0) + lethal_cards.graveyard_offset,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  from lethal_cards
  left join graveyard_positions
    on graveyard_positions.owner_id = lethal_cards.owner_id
  where game_cards.id = lethal_cards.id;

  get diagnostics v_destroyed_count = row_count;

  if v_destroyed_count > 0 then
    perform public.rebuild_scripted_continuous_effects(p_session_id);
  end if;

  return v_destroyed_count;
end;
$$;

-- resolve_combat_damage: use effective power/toughness so +1/+1 counters affect
-- damage dealt and lethal thresholds.
create or replace function public.resolve_combat_damage(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_required_player_id uuid;
  v_assignment record;
  v_blocker record;
  v_attacker_damage integer;
  v_remaining_attacker_damage integer;
  v_blocker_damage integer;
  v_assigned_damage integer;
  v_has_blockers boolean;
  v_is_first_strike_stage boolean := false;
  v_attacker_has_first_strike boolean;
  v_attacker_has_double_strike boolean;
  v_attacker_has_deathtouch boolean;
  v_attacker_deals_damage boolean;
  v_blocker_has_first_strike boolean;
  v_blocker_has_double_strike boolean;
  v_blocker_has_deathtouch boolean;
  v_blocker_deals_damage boolean;
  v_lethal_per_blocker integer;
  v_total_player_damage integer := 0;
  v_total_creature_damage integer := 0;
  v_destroyed_count integer := 0;
  v_resolved_count integer := 0;
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
    raise exception 'Cannot resolve combat damage in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'combat_damage' then
    raise exception 'Combat damage can only be resolved during Combat Damage Step';
  end if;

  v_required_player_id := coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can resolve combat damage';
  end if;

  select exists (
    select 1
    from public.game_combat_assignments combat
    left join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
     and attacker_instance.zone = 'battlefield'
    left join public.game_combat_blockers blockers
      on blockers.assignment_id = combat.id
    left join public.game_cards blocker_instance
      on blocker_instance.id = blockers.blocker_card_id
     and blocker_instance.zone = 'battlefield'
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
      and combat.first_strike_damage_resolved = false
      and (
        public.card_has_first_strike(p_session_id, attacker_instance.id)
        or public.card_has_double_strike(p_session_id, attacker_instance.id)
        or public.card_has_first_strike(p_session_id, blocker_instance.id)
        or public.card_has_double_strike(p_session_id, blocker_instance.id)
      )
  )
  into v_is_first_strike_stage;

  for v_assignment in
    select
      combat.id,
      combat.attacker_card_id,
      combat.defending_player_id,
      attacker_instance.id is not null as attacker_on_battlefield,
      public.card_effective_power(p_session_id, combat.attacker_card_id) as attacker_power
    from public.game_combat_assignments combat
    left join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
     and attacker_instance.zone = 'battlefield'
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
      and (
        v_is_first_strike_stage = false
        or combat.first_strike_damage_resolved = false
      )
    order by combat.created_at
    for update of combat
  loop
    if not v_assignment.attacker_on_battlefield then
      if not v_is_first_strike_stage then
        update public.game_combat_assignments
        set damage_resolved = true
        where id = v_assignment.id;
      end if;

      continue;
    end if;

    v_attacker_damage := greatest(0, v_assignment.attacker_power);
    v_remaining_attacker_damage := v_attacker_damage;
    v_attacker_has_first_strike := public.card_has_first_strike(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_double_strike := public.card_has_double_strike(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_deathtouch := public.card_has_deathtouch(p_session_id, v_assignment.attacker_card_id);

    if v_is_first_strike_stage then
      v_attacker_deals_damage := v_attacker_has_first_strike or v_attacker_has_double_strike;
    else
      v_attacker_deals_damage := (not v_attacker_has_first_strike) or v_attacker_has_double_strike;
    end if;

    select exists (
      select 1
      from public.game_combat_blockers blockers
      where blockers.assignment_id = v_assignment.id
    )
    into v_has_blockers;

    if not v_has_blockers then
      if v_attacker_deals_damage and v_attacker_damage > 0 then
        update public.game_session_players
        set life_total = greatest(0, life_total - v_attacker_damage)
        where session_id = p_session_id
          and player_id = v_assignment.defending_player_id;

        v_total_player_damage := v_total_player_damage + v_attacker_damage;
      end if;
    else
      for v_blocker in
        select
          blockers.blocker_card_id,
          public.card_effective_power(p_session_id, blockers.blocker_card_id) as blocker_power,
          public.card_effective_toughness(p_session_id, blockers.blocker_card_id) as blocker_toughness
        from public.game_combat_blockers blockers
        join public.game_cards blocker_instance
          on blocker_instance.id = blockers.blocker_card_id
         and blocker_instance.zone = 'battlefield'
        where blockers.assignment_id = v_assignment.id
        order by blockers.damage_assignment_order, blockers.created_at, blockers.id
      loop
        v_blocker_damage := greatest(0, v_blocker.blocker_power);
        v_blocker_has_first_strike := public.card_has_first_strike(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_double_strike := public.card_has_double_strike(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_deathtouch := public.card_has_deathtouch(p_session_id, v_blocker.blocker_card_id);

        if v_is_first_strike_stage then
          v_blocker_deals_damage := v_blocker_has_first_strike or v_blocker_has_double_strike;
        else
          v_blocker_deals_damage := (not v_blocker_has_first_strike) or v_blocker_has_double_strike;
        end if;

        if v_attacker_deals_damage and v_remaining_attacker_damage > 0 then
          -- Deathtouch: 1 damage is lethal, so only 1 needs to be assigned per blocker.
          if v_attacker_has_deathtouch then
            v_lethal_per_blocker := 1;
          else
            v_lethal_per_blocker := greatest(1, v_blocker.blocker_toughness);
          end if;

          v_assigned_damage := least(v_remaining_attacker_damage, v_lethal_per_blocker);

          update public.game_cards
          set
            damage_marked = damage_marked + v_assigned_damage,
            dealt_deathtouch_damage = dealt_deathtouch_damage or v_attacker_has_deathtouch
          where id = v_blocker.blocker_card_id
            and session_id = p_session_id
            and zone = 'battlefield';

          if not found then
            raise exception 'Blocker card not found on battlefield';
          end if;

          v_total_creature_damage := v_total_creature_damage + v_assigned_damage;
          v_remaining_attacker_damage := v_remaining_attacker_damage - v_assigned_damage;
        end if;

        if v_blocker_deals_damage and v_blocker_damage > 0 then
          update public.game_cards
          set
            damage_marked = damage_marked + v_blocker_damage,
            dealt_deathtouch_damage = dealt_deathtouch_damage or v_blocker_has_deathtouch
          where id = v_assignment.attacker_card_id
            and session_id = p_session_id
            and zone = 'battlefield';

          if found then
            v_total_creature_damage := v_total_creature_damage + v_blocker_damage;
          end if;
        end if;
      end loop;

      if v_attacker_deals_damage
        and v_remaining_attacker_damage > 0
        and public.card_has_trample(p_session_id, v_assignment.attacker_card_id)
      then
        update public.game_session_players
        set life_total = greatest(0, life_total - v_remaining_attacker_damage)
        where session_id = p_session_id
          and player_id = v_assignment.defending_player_id;

        v_total_player_damage := v_total_player_damage + v_remaining_attacker_damage;
      end if;
    end if;

    if v_is_first_strike_stage then
      update public.game_combat_assignments
      set first_strike_damage_resolved = true
      where id = v_assignment.id;
    else
      update public.game_combat_assignments
      set damage_resolved = true
      where id = v_assignment.id;
    end if;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  if v_is_first_strike_stage then
    update public.game_combat_assignments
    set first_strike_damage_resolved = true
    where session_id = p_session_id
      and turn_number = v_turn_state.turn_number
      and damage_resolved = false
      and first_strike_damage_resolved = false;
  else
    update public.game_combat_assignments
    set damage_resolved = true
    where session_id = p_session_id
      and turn_number = v_turn_state.turn_number
      and damage_resolved = false;
  end if;

  v_destroyed_count := public.move_lethal_damaged_creatures_to_graveyard(p_session_id);

  update public.game_cards
  set dealt_deathtouch_damage = false
  where session_id = p_session_id
    and dealt_deathtouch_damage = true;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'assignments_resolved',
    v_resolved_count,
    'damage_stage',
    case when v_is_first_strike_stage then 'first_strike' else 'regular' end,
    'total_damage',
    v_total_player_damage,
    'total_player_damage',
    v_total_player_damage,
    'total_creature_damage',
    v_total_creature_damage,
    'creatures_destroyed',
    v_destroyed_count,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$$;

grant execute on function public.card_effective_power(uuid, uuid) to authenticated;
grant execute on function public.card_effective_toughness(uuid, uuid) to authenticated;
grant execute on function public.adjust_card_counters(uuid, uuid, integer) to authenticated;
grant execute on function public.move_lethal_damaged_creatures_to_graveyard(uuid) to authenticated;
grant execute on function public.resolve_combat_damage(uuid) to authenticated;
