-- Planeswalker combat (roadmap Tribal #4, slice 2). Attack a planeswalker; its
-- controller's planeswalker loses loyalty equal to the combat damage dealt to it.
--
--   * game_combat_assignments gains a nullable defending_planeswalker_id. When set, the
--     attack is against that planeswalker (its controller is still the defending_player
--     for the existing per-attacker logic).
--   * declare_attacker gains an optional p_defending_planeswalker_id (DROP the 3-arg
--     first — a defaulted 4th param would make 3-arg calls ambiguous, bug-421). It
--     derives the defending player from the planeswalker's controller.
--   * resolve_combat_damage (reproduced from mig 159) routes the UNBLOCKED and TRAMPLE
--     player-damage sites to the planeswalker's loyalty (apply_damage_to_planeswalker)
--     when the assignment targets one; toxic/poison only apply to a PLAYER. A 0-loyalty
--     SBA runs at combat end.
--
-- SCOPE: a creature blocking still takes/deals creature damage as normal (a blocked
-- attacker doesn't reach the planeswalker except via trample). Redirecting BURN/spell
-- damage to a planeswalker is separate (deferred). (IDE T-SQL false-positives on $$.)

alter table public.game_combat_assignments
  add column if not exists defending_planeswalker_id uuid references public.game_cards(id);

-- ===========================================================================
-- apply_damage_to_planeswalker — combat damage removes that many loyalty counters.
-- ===========================================================================
create or replace function public.apply_damage_to_planeswalker(
  p_session_id uuid, p_planeswalker_id uuid, p_amount integer
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(p_amount, 0) <= 0 or p_planeswalker_id is null then
    return;
  end if;
  update public.game_cards
  set counters = public.adjust_counter_bag(coalesce(counters, '{}'::jsonb), 'loyalty', -p_amount)
  where id = p_planeswalker_id and session_id = p_session_id and zone = 'battlefield';
end;
$$;
grant execute on function public.apply_damage_to_planeswalker(uuid, uuid, integer) to authenticated;
grant execute on function public.apply_damage_to_planeswalker(uuid, uuid, integer) to service_role;

-- ===========================================================================
-- declare_attacker (CURRENT = baseline) + p_defending_planeswalker_id. DROP the 3-arg
-- first so the 4-arg (4th defaulted) handles existing 3-arg player-attack calls.
-- ===========================================================================
drop function if exists public.declare_attacker(uuid, uuid, uuid);

create or replace function public.declare_attacker(
  p_session_id uuid,
  p_attacker_card_id uuid,
  p_defending_player_id uuid,
  p_defending_planeswalker_id uuid default null
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_attacker record;
  v_pw record;
  v_defending_player uuid := p_defending_player_id;
  v_assignment public.game_combat_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Attacking a planeswalker: the defending player is its controller.
  if p_defending_planeswalker_id is not null then
    select coalesce(gc.controller_player_id, gc.owner_id) as controller, c.type_line
    into v_pw
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_defending_planeswalker_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield';
    if not found or coalesce(v_pw.type_line, '') not ilike '%planeswalker%' then
      raise exception 'Defending planeswalker not found on the battlefield';
    end if;
    v_defending_player := v_pw.controller;
  end if;

  if not public.is_session_player(p_session_id, v_defending_player) then
    raise exception 'Defending player is not a player in this session';
  end if;

  if v_defending_player = auth.uid() then
    raise exception 'A player cannot attack themselves';
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
    raise exception 'Cannot declare attackers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Only the active player can declare attackers';
  end if;

  if v_turn_state.step <> 'declare_attackers' then
    raise exception 'Attackers can only be declared during Declare Attackers Step';
  end if;

  select
    game_cards.id,
    game_cards.is_tapped,
    game_cards.entered_battlefield_turn_number,
    cards.type_line
  into v_attacker
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_attacker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
  for update of game_cards;

  if not found then
    raise exception 'Attacker card not found, not on battlefield, or not controlled by active player';
  end if;

  if coalesce(v_attacker.type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as attackers';
  end if;

  if v_attacker.is_tapped then
    raise exception 'Tapped creatures cannot be declared as attackers';
  end if;

  if coalesce(v_attacker.entered_battlefield_turn_number, v_turn_state.turn_number) >= v_turn_state.turn_number
    and not public.card_has_haste(p_session_id, p_attacker_card_id)
  then
    raise exception 'Creature has summoning sickness';
  end if;

  update public.game_cards
  set is_tapped = true
  where id = p_attacker_card_id
    and not public.card_has_vigilance(p_session_id, p_attacker_card_id);

  insert into public.game_combat_assignments (
    session_id,
    turn_number,
    attacker_card_id,
    attacking_player_id,
    defending_player_id,
    defending_planeswalker_id
  )
  values (
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    auth.uid(),
    v_defending_player,
    p_defending_planeswalker_id
  )
  returning * into v_assignment;

  return v_assignment;
end;
$$;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid) to service_role;

-- ===========================================================================
-- resolve_combat_damage (CURRENT = mig 159) — route the UNBLOCKED + TRAMPLE player-
-- damage sites to a planeswalker's loyalty when the assignment targets one; 0-loyalty
-- SBA at the end. Everything else verbatim from 159.
-- ===========================================================================
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
  v_attacker_has_infect boolean;
  v_attacker_has_wither boolean;
  v_attacker_toxic integer;
  v_blocker_has_first_strike boolean;
  v_blocker_has_double_strike boolean;
  v_blocker_has_deathtouch boolean;
  v_blocker_deals_damage boolean;
  v_blocker_has_infect boolean;
  v_blocker_has_wither boolean;
  v_lethal_per_blocker integer;
  v_total_player_damage integer := 0;
  v_total_creature_damage integer := 0;
  v_destroyed_count integer := 0;
  v_resolved_count integer := 0;
  v_minus_dealt boolean := false;
  v_finish_state jsonb;
  v_chosen jsonb;
  v_trample_amount integer;
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

  -- ── Validation pre-pass (unchanged from mig 122/132).
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
      combat.defending_planeswalker_id,
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
    v_attacker_has_infect := public.card_has_infect(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_wither := public.card_has_wither(p_session_id, v_assignment.attacker_card_id);
    v_attacker_toxic := public.card_toxic_amount(p_session_id, v_assignment.attacker_card_id);

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
        if v_assignment.defending_planeswalker_id is not null then
          -- Attacking a planeswalker: combat damage removes loyalty (no poison/toxic).
          perform public.apply_damage_to_planeswalker(
            p_session_id, v_assignment.defending_planeswalker_id, v_attacker_damage);
        else
          -- Unblocked: infect deals power as poison (no life); else normal damage.
          if v_attacker_has_infect then
            perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_damage);
          else
            v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
              p_session_id, v_assignment.defending_player_id, v_attacker_damage,
              v_assignment.attacker_card_id, true
            );
          end if;
          -- Toxic N: poison in addition to dealing combat damage to the player.
          if v_attacker_toxic > 0 then
            perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_toxic);
          end if;
        end if;
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
        v_blocker_has_infect := public.card_has_infect(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_wither := public.card_has_wither(p_session_id, v_blocker.blocker_card_id);

        if v_is_first_strike_stage then
          v_blocker_deals_damage := v_blocker_has_first_strike or v_blocker_has_double_strike;
        else
          v_blocker_deals_damage := (not v_blocker_has_first_strike) or v_blocker_has_double_strike;
        end if;

        if v_attacker_deals_damage and v_remaining_attacker_damage > 0 then
          if v_chosen is not null then
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
            if v_attacker_has_deathtouch then
              v_lethal_per_blocker := 1;
            else
              v_lethal_per_blocker := greatest(1, v_blocker.blocker_toughness);
            end if;

            v_assigned_damage := least(v_remaining_attacker_damage, v_lethal_per_blocker);
          end if;

          if v_assigned_damage > 0 then
            -- Protection gate (colour): damage still ASSIGNED, only DEALT if no
            -- protection. The dealt portion routes through the shield resolver,
            -- as −1/−1 counters when the attacker has wither/infect.
            if not public.card_has_protection_from_any(
                 p_session_id, v_blocker.blocker_card_id,
                 public.game_card_color_set(p_session_id, v_assignment.attacker_card_id)
               ) then
              v_total_creature_damage := v_total_creature_damage + public.apply_damage_to_creature(
                p_session_id, v_blocker.blocker_card_id, v_assigned_damage,
                v_assignment.attacker_card_id, true, v_attacker_has_deathtouch, false,
                v_attacker_has_infect or v_attacker_has_wither
              );
              if v_attacker_has_infect or v_attacker_has_wither then
                v_minus_dealt := true;
              end if;
            end if;

            v_remaining_attacker_damage := v_remaining_attacker_damage - v_assigned_damage;
          end if;
        end if;

        if v_blocker_deals_damage and v_blocker_damage > 0 then
          if not public.card_has_protection_from_any(
               p_session_id, v_assignment.attacker_card_id,
               public.game_card_color_set(p_session_id, v_blocker.blocker_card_id)
             ) then
            v_total_creature_damage := v_total_creature_damage + public.apply_damage_to_creature(
              p_session_id, v_assignment.attacker_card_id, v_blocker_damage,
              v_blocker.blocker_card_id, true, v_blocker_has_deathtouch, false,
              v_blocker_has_infect or v_blocker_has_wither
            );
            if v_blocker_has_infect or v_blocker_has_wither then
              v_minus_dealt := true;
            end if;
          end if;
        end if;
      end loop;

      if v_attacker_deals_damage
        and v_remaining_attacker_damage > 0
        and public.card_has_trample(p_session_id, v_assignment.attacker_card_id)
      then
        if v_chosen is not null then
          v_trample_amount := least(
            v_remaining_attacker_damage,
            greatest(0, coalesce((v_chosen ->> 'trample')::integer, 0))
          );
        else
          v_trample_amount := v_remaining_attacker_damage;
        end if;

        if v_trample_amount > 0 then
          if v_assignment.defending_planeswalker_id is not null then
            -- Trample over from attacking a planeswalker → excess loyalty damage.
            perform public.apply_damage_to_planeswalker(
              p_session_id, v_assignment.defending_planeswalker_id, v_trample_amount);
          else
            -- Trample over to the player: infect → poison, else normal; toxic adds N.
            if v_attacker_has_infect then
              perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_trample_amount);
            else
              v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
                p_session_id, v_assignment.defending_player_id, v_trample_amount,
                v_assignment.attacker_card_id, true
              );
            end if;
            if v_attacker_toxic > 0 then
              perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_toxic);
            end if;
          end if;
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
  -- A planeswalker reduced to 0 loyalty by combat damage dies.
  perform public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id);

  -- −1/−1 combat damage (wither/infect): run annihilation (CR 122.3) once at end.
  if v_minus_dealt then
    perform public.recheck_counter_state(p_session_id);
  end if;

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
