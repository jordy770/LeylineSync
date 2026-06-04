-- Deathtouch support.
--
-- Any amount of damage (>= 1) dealt by a source with deathtouch is lethal to a
-- creature. Combined with the existing trample rule (assign minimum-lethal per
-- blocker, then trample the remainder to the defending player), a deathtouch +
-- trample attacker only needs to assign 1 to each blocker and the rest tramples
-- through automatically.
--
-- Destruction is tracked with a per-card boolean flag set during damage
-- resolution and read by move_lethal_damaged_creatures_to_graveyard. The flag is
-- cleared at the end of every resolve_combat_damage call, so it never persists
-- between passes or turns.

alter table public.game_cards
  add column if not exists dealt_deathtouch_damage boolean not null default false;

comment on column public.game_cards.dealt_deathtouch_damage is
  'True when this creature was dealt damage by a deathtouch source during the current combat damage resolution. Read by the lethal-damage mover, cleared after each resolve.';

-- Extend effect_type constraint to include deathtouch.
alter table public.game_continuous_effects
drop constraint if exists game_continuous_effects_effect_type_check;

alter table public.game_continuous_effects
add constraint game_continuous_effects_effect_type_check
check (
  effect_type in (
    'mana_does_not_empty',
    'additional_land_plays',
    'haste',
    'vigilance',
    'indestructible',
    'trample',
    'first_strike',
    'double_strike',
    'flying',
    'reach',
    'deathtouch'
  )
);

-- Helper: does a game card have an active deathtouch effect?
create or replace function public.card_has_deathtouch(
  p_session_id uuid,
  p_game_card_id uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'deathtouch'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;

-- move_lethal_damaged_creatures_to_graveyard: also destroys creatures that were
-- dealt damage by a deathtouch source this combat, even below their toughness.
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
        or game_cards.damage_marked >= coalesce(
          cards.toughness,
          case
            when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
              then split_part(cards.power_toughness, '/', 2)::integer
            else null
          end
        )
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
    dealt_deathtouch_damage = false
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

-- register_card_continuous_effects: adds deathtouch to the script allowlist,
-- the default 'source' mapping, and the keyword mapping.
create or replace function public.register_card_continuous_effects(
  p_session_id uuid,
  p_source_card_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_card public.game_cards;
  v_script jsonb;
  v_keywords jsonb;
  v_keyword text;
  v_keyword_effect_type text;
  v_effect jsonb;
  v_effect_type text;
  v_affected text;
  v_affected_player_id uuid;
  v_affected_card_id uuid;
  v_source_zone_required text;
  v_payload jsonb;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.*
  into v_source_card
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id;

  if not found then
    raise exception 'Source card not found';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and source_card_id = p_source_card_id
    and payload ->> 'registered_from_card_script' = 'true';

  if v_source_card.zone <> 'battlefield' or v_source_card.static_effects_suppressed then
    return 0;
  end if;

  select
    coalesce(v_source_card.copied_script, cards.script),
    coalesce(cards.keywords, '[]'::jsonb)
  into v_script, v_keywords
  from public.cards
  where cards.id = v_source_card.card_id;

  for v_effect in
    select value
    from jsonb_array_elements(coalesce(v_script -> 'continuous_effects', '[]'::jsonb))
  loop
    v_effect_type := coalesce(v_effect ->> 'effect_type', v_effect ->> 'type');

    if v_effect_type not in (
      'mana_does_not_empty',
      'additional_land_plays',
      'haste',
      'vigilance',
      'indestructible',
      'trample',
      'first_strike',
      'double_strike',
      'flying',
      'reach',
      'deathtouch'
    ) then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
    end if;

    v_affected := coalesce(
      v_effect ->> 'affected',
      case
        when v_effect_type in (
          'haste',
          'vigilance',
          'indestructible',
          'trample',
          'first_strike',
          'double_strike',
          'flying',
          'reach',
          'deathtouch'
        ) then 'source'
        else 'controller'
      end
    );
    v_affected_player_id := null;
    v_affected_card_id := null;

    if v_affected in ('all', 'all_players') then
      v_affected_player_id := null;
    elsif v_affected in ('controller', 'self') then
      v_affected_player_id := coalesce(v_source_card.controller_player_id, v_source_card.owner_id);
    elsif v_affected in ('source', 'this') then
      v_affected_card_id := p_source_card_id;
    else
      raise exception 'Unsupported continuous effect affected value: %', v_affected;
    end if;

    v_source_zone_required := coalesce(v_effect ->> 'source_zone_required', 'battlefield');

    if v_source_zone_required not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
      raise exception 'Unsupported source zone requirement: %', v_source_zone_required;
    end if;

    if v_effect_type = 'additional_land_plays' then
      v_payload := jsonb_build_object(
        'amount',
        coalesce((v_effect ->> 'amount')::integer, 1)
      );
    elsif v_effect_type = 'mana_does_not_empty' then
      v_payload := jsonb_build_object(
        'colors',
        coalesce(v_effect -> 'colors', '[]'::jsonb)
      );
    else
      v_payload := '{}'::jsonb;
    end if;

    v_payload := coalesce(v_effect -> 'payload', v_payload)
      || jsonb_build_object('registered_from_card_script', true);

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_player_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required,
      expires_at_turn_number,
      expires_at_phase,
      expires_at_step
    )
    values (
      p_session_id,
      p_source_card_id,
      v_affected_player_id,
      v_affected_card_id,
      v_effect_type,
      v_payload,
      v_source_zone_required,
      nullif(v_effect ->> 'expires_at_turn_number', '')::integer,
      nullif(v_effect ->> 'expires_at_phase', ''),
      nullif(v_effect ->> 'expires_at_step', '')
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  for v_keyword in
    select lower(replace(replace(keyword, ' ', '_'), '-', '_'))
    from jsonb_array_elements_text(v_keywords) as keyword
  loop
    v_keyword_effect_type := case v_keyword
      when 'haste'         then 'haste'
      when 'vigilance'     then 'vigilance'
      when 'indestructible' then 'indestructible'
      when 'trample'       then 'trample'
      when 'first_strike'  then 'first_strike'
      when 'double_strike' then 'double_strike'
      when 'flying'        then 'flying'
      when 'reach'         then 'reach'
      when 'deathtouch'    then 'deathtouch'
      else null
    end;

    if v_keyword_effect_type is null then
      continue;
    end if;

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required
    )
    values (
      p_session_id,
      p_source_card_id,
      p_source_card_id,
      v_keyword_effect_type,
      jsonb_build_object('registered_from_card_script', true, 'registered_from_keywords', true),
      'battlefield'
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  return v_registered_count;
end;
$$;

-- resolve_combat_damage: deathtouch makes any assigned damage (>= 1) lethal.
-- A deathtouch attacker assigns 1 to each blocker (then trample excess to the
-- defending player); a deathtouch blocker's damage is likewise marked lethal.
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
      coalesce(
        attacker_card.power,
        case
          when attacker_card.power_toughness ~ '^[0-9]+/[0-9]+$'
            then split_part(attacker_card.power_toughness, '/', 1)::integer
          else 0
        end,
        0
      ) as attacker_power
    from public.game_combat_assignments combat
    left join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
     and attacker_instance.zone = 'battlefield'
    left join public.cards attacker_card
      on attacker_card.id = attacker_instance.card_id
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
          coalesce(
            blocker_card.power,
            case
              when blocker_card.power_toughness ~ '^[0-9]+/[0-9]+$'
                then split_part(blocker_card.power_toughness, '/', 1)::integer
              else 0
            end,
            0
          ) as blocker_power,
          coalesce(
            blocker_card.toughness,
            case
              when blocker_card.power_toughness ~ '^[0-9]+/[0-9]+$'
                then split_part(blocker_card.power_toughness, '/', 2)::integer
              else null
            end,
            0
          ) as blocker_toughness
        from public.game_combat_blockers blockers
        join public.game_cards blocker_instance
          on blocker_instance.id = blockers.blocker_card_id
         and blocker_instance.zone = 'battlefield'
        left join public.cards blocker_card
          on blocker_card.id = blocker_instance.card_id
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

  -- Clear the deathtouch flag so it never persists beyond this resolution.
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

-- Seed test cards for deathtouch.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, script)
select
  gen_random_uuid(),
  'Deathtouch Viper Test',
  'Creature - Snake',
  '{B}',
  '1/1',
  $json${
    "continuous_effects": [
      { "type": "deathtouch", "affected": "source", "source_zone_required": "battlefield" }
    ]
  }$json$::jsonb
where not exists (
  select 1 from public.cards where lower(name) = 'deathtouch viper test'
);

insert into public.cards (id, name, type_line, mana_cost, power_toughness, script)
select
  gen_random_uuid(),
  'Deathtouch Trampler Test',
  'Creature - Beast',
  '{3}{B}{G}',
  '5/5',
  $json${
    "continuous_effects": [
      { "type": "deathtouch", "affected": "source", "source_zone_required": "battlefield" },
      { "type": "trample",    "affected": "source", "source_zone_required": "battlefield" }
    ]
  }$json$::jsonb
where not exists (
  select 1 from public.cards where lower(name) = 'deathtouch trampler test'
);

grant execute on function public.card_has_deathtouch(uuid, uuid) to authenticated;
grant execute on function public.move_lethal_damaged_creatures_to_graveyard(uuid) to authenticated;
grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated;
grant execute on function public.resolve_combat_damage(uuid) to authenticated;
