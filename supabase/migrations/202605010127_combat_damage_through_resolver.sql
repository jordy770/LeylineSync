-- Phase 4 / F2.1c — route COMBAT damage to players through the prevention resolver.
--
-- Combat damage to the defending player (an unblocked attacker, and trample
-- spillover) bypassed the F2.1a resolver, so player prevention shields — including
-- combat_only / Fog-style ones — didn't stop combat damage. Now both player-damage
-- sites call apply_damage_to_player(..., is_combat => true), which consumes shields
-- first and returns the damage actually dealt (added to total_player_damage).
--
-- Reproduces resolve_combat_damage from its CURRENT definition (mig 122, the
-- over-assignment version) verbatim except those two damage sites. Creature combat
-- damage is unchanged (no creature shields are authorable yet — a later slice).
-- (IDE T-SQL false-positives on $$ — ignore.)

create or replace function public.resolve_combat_damage(
  p_session_id uuid,
  p_assignments jsonb default null
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
  -- Player-chosen assignment state
  v_chosen jsonb;
  v_trample_amount integer;
  -- Validation pre-pass state
  v_va_key text;
  v_va_chosen jsonb;
  v_va_assignment_id uuid;
  v_va_power integer;
  v_va_deathtouch boolean;
  v_va_trample boolean;
  v_va_blocker record;
  v_va_lethal integer;
  v_va_amt integer;
  v_va_sum integer;
  v_va_trample_amt integer;
  v_va_satisfied boolean;
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

  -- ── Validation pre-pass: reject illegal player-chosen distributions before any
  -- damage is written. Skips attackers not in this turn's unresolved combat.
  if p_assignments is not null and p_assignments <> 'null'::jsonb then
    for v_va_key in select jsonb_object_keys(p_assignments)
    loop
      select combat.id,
             public.card_effective_power(p_session_id, combat.attacker_card_id),
             public.card_has_deathtouch(p_session_id, combat.attacker_card_id),
             public.card_has_trample(p_session_id, combat.attacker_card_id)
      into v_va_assignment_id, v_va_power, v_va_deathtouch, v_va_trample
      from public.game_combat_assignments combat
      where combat.session_id = p_session_id
        and combat.turn_number = v_turn_state.turn_number
        and combat.attacker_card_id = v_va_key::uuid
        and combat.damage_resolved = false;

      if not found then
        continue;
      end if;

      v_va_chosen := p_assignments -> v_va_key;
      v_va_trample_amt := coalesce((v_va_chosen ->> 'trample')::integer, 0);
      if v_va_trample_amt < 0 then
        raise exception 'Combat damage assignment cannot be negative';
      end if;
      if v_va_trample_amt > 0 and not coalesce(v_va_trample, false) then
        raise exception 'Cannot assign trample damage: attacker has no trample';
      end if;

      v_va_sum := v_va_trample_amt;
      v_va_satisfied := true;

      for v_va_blocker in
        select blockers.blocker_card_id,
               public.card_effective_toughness(p_session_id, blockers.blocker_card_id) as toughness
        from public.game_combat_blockers blockers
        join public.game_cards blocker_instance
          on blocker_instance.id = blockers.blocker_card_id
         and blocker_instance.zone = 'battlefield'
        where blockers.assignment_id = v_va_assignment_id
        order by blockers.damage_assignment_order, blockers.created_at, blockers.id
      loop
        v_va_amt := coalesce((
          select (b ->> 'amount')::integer
          from jsonb_array_elements(coalesce(v_va_chosen -> 'blockers', '[]'::jsonb)) b
          where b ->> 'blocker_card_id' = v_va_blocker.blocker_card_id::text
          limit 1
        ), 0);

        if v_va_amt < 0 then
          raise exception 'Combat damage assignment cannot be negative';
        end if;

        if not v_va_satisfied and v_va_amt > 0 then
          raise exception 'Must assign lethal damage to earlier blockers before later ones';
        end if;

        v_va_lethal := case when coalesce(v_va_deathtouch, false) then 1
                            else greatest(1, v_va_blocker.toughness) end;
        if v_va_amt < v_va_lethal then
          v_va_satisfied := false;
        end if;

        v_va_sum := v_va_sum + v_va_amt;
      end loop;

      if v_va_trample_amt > 0 and not v_va_satisfied then
        raise exception 'Cannot assign trample damage before all blockers have lethal damage';
      end if;

      if v_va_sum > greatest(0, coalesce(v_va_power, 0)) then
        raise exception 'Assigned combat damage % exceeds attacker power %', v_va_sum, v_va_power;
      end if;
    end loop;
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

    -- This attacker's player-chosen distribution (null = auto-assign).
    v_chosen := case
      when p_assignments is not null and p_assignments <> 'null'::jsonb
        then p_assignments -> v_assignment.attacker_card_id::text
      else null
    end;

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
        -- Unblocked: route through the prevention resolver (combat damage).
        v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
          p_session_id, v_assignment.defending_player_id, v_attacker_damage,
          v_assignment.attacker_card_id, true
        );
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
          if v_chosen is not null then
            -- Player-chosen amount for this blocker (validated above); 0 if omitted.
            v_assigned_damage := least(
              v_remaining_attacker_damage,
              greatest(0, coalesce((
                select (b ->> 'amount')::integer
                from jsonb_array_elements(coalesce(v_chosen -> 'blockers', '[]'::jsonb)) b
                where b ->> 'blocker_card_id' = v_blocker.blocker_card_id::text
                limit 1
              ), 0))
            );
          else
            -- Auto: deathtouch makes 1 lethal, so only 1 needs assigning per blocker.
            if v_attacker_has_deathtouch then
              v_lethal_per_blocker := 1;
            else
              v_lethal_per_blocker := greatest(1, v_blocker.blocker_toughness);
            end if;

            v_assigned_damage := least(v_remaining_attacker_damage, v_lethal_per_blocker);
          end if;

          if v_assigned_damage > 0 then
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
        -- Auto: trample the entire remainder. Chosen: trample the requested amount
        -- (validated to be <= power and legal only when all blockers are lethal),
        -- capped at what is actually left.
        if v_chosen is not null then
          v_trample_amount := least(
            v_remaining_attacker_damage,
            greatest(0, coalesce((v_chosen ->> 'trample')::integer, 0))
          );
        else
          v_trample_amount := v_remaining_attacker_damage;
        end if;

        if v_trample_amount > 0 then
          -- Trample spillover to the player: also through the prevention resolver.
          v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
            p_session_id, v_assignment.defending_player_id, v_trample_amount,
            v_assignment.attacker_card_id, true
          );
        end if;
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

grant execute on function public.resolve_combat_damage(uuid, jsonb) to anon;
grant execute on function public.resolve_combat_damage(uuid, jsonb) to authenticated;
grant execute on function public.resolve_combat_damage(uuid, jsonb) to service_role;
