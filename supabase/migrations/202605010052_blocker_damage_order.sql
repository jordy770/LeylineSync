alter table public.game_combat_blockers
add column if not exists damage_assignment_order integer;

with ordered_blockers as (
  select
    id,
    row_number() over (
      partition by assignment_id
      order by created_at, id
    ) - 1 as next_order
  from public.game_combat_blockers
)
update public.game_combat_blockers blockers
set damage_assignment_order = ordered_blockers.next_order
from ordered_blockers
where blockers.id = ordered_blockers.id
  and blockers.damage_assignment_order is null;

alter table public.game_combat_blockers
alter column damage_assignment_order set default 0;

alter table public.game_combat_blockers
alter column damage_assignment_order set not null;

create index if not exists game_combat_blockers_damage_order_idx
on public.game_combat_blockers (assignment_id, damage_assignment_order, created_at, id);

create or replace function public.declare_blocker(
  p_session_id uuid,
  p_blocker_card_id uuid,
  p_attacker_card_id uuid
)
returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
  v_blocker_type_line text;
  v_next_damage_assignment_order integer;
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
    raise exception 'Cannot declare blockers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'declare_blockers' then
    raise exception 'Blockers can only be declared during Declare Blockers Step';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can declare blockers';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and attacker_card_id = p_attacker_card_id
  for update;

  if not found then
    raise exception 'Attacker assignment not found';
  end if;

  if v_assignment.defending_player_id <> auth.uid() then
    raise exception 'Only the defending player can block this attacker';
  end if;

  perform 1
  from public.game_combat_blockers
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and blocker_card_id = p_blocker_card_id;

  if found then
    raise exception 'This blocker is already assigned';
  end if;

  select cards.type_line
  into v_blocker_type_line
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_blocker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
    and game_cards.is_tapped = false;

  if not found then
    raise exception 'Blocker card not found, not on battlefield, not controlled by defending player, or already tapped';
  end if;

  if coalesce(v_blocker_type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as blockers';
  end if;

  select coalesce(max(damage_assignment_order), -1) + 1
  into v_next_damage_assignment_order
  from public.game_combat_blockers
  where assignment_id = v_assignment.id;

  insert into public.game_combat_blockers (
    assignment_id,
    session_id,
    turn_number,
    attacker_card_id,
    blocker_card_id,
    blocking_player_id,
    damage_assignment_order
  )
  values (
    v_assignment.id,
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    p_blocker_card_id,
    auth.uid(),
    v_next_damage_assignment_order
  );

  update public.game_combat_assignments
  set blocker_card_id = coalesce(blocker_card_id, p_blocker_card_id)
  where id = v_assignment.id
  returning * into v_assignment;

  return v_assignment;
end;
$$;

create or replace function public.set_combat_blocker_order(
  p_session_id uuid,
  p_assignment_id uuid,
  p_blocker_card_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
  v_expected_count integer;
  v_new_count integer;
  v_updated_count integer := 0;
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
    raise exception 'Cannot set combat damage order in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step not in ('declare_blockers', 'combat_damage') then
    raise exception 'Blocker damage order can only be set before combat damage resolves';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can set blocker damage order';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where id = p_assignment_id
    and session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and damage_resolved = false
  for update;

  if not found then
    raise exception 'Combat assignment not found or already resolved';
  end if;

  if v_assignment.attacking_player_id <> auth.uid() then
    raise exception 'Only the attacking player can set blocker damage order';
  end if;

  select count(*)
  into v_expected_count
  from public.game_combat_blockers
  where assignment_id = p_assignment_id;

  select count(distinct blocker_card_id)
  into v_new_count
  from unnest(p_blocker_card_ids) as blocker_card_id;

  if v_expected_count <> v_new_count then
    raise exception 'Blocker order must include every blocker exactly once';
  end if;

  perform 1
  from unnest(p_blocker_card_ids) as requested_blocker(blocker_card_id)
  left join public.game_combat_blockers blockers
    on blockers.assignment_id = p_assignment_id
   and blockers.blocker_card_id = requested_blocker.blocker_card_id
  where blockers.id is null;

  if found then
    raise exception 'Blocker order contains a card that is not blocking this attacker';
  end if;

  with requested_order as (
    select
      blocker_card_id,
      ordinal_position - 1 as next_order
    from unnest(p_blocker_card_ids) with ordinality as ordered(blocker_card_id, ordinal_position)
  )
  update public.game_combat_blockers blockers
  set damage_assignment_order = requested_order.next_order
  from requested_order
  where blockers.assignment_id = p_assignment_id
    and blockers.blocker_card_id = requested_order.blocker_card_id;

  get diagnostics v_updated_count = row_count;

  return v_updated_count;
end;
$$;

drop function if exists public.get_combat_assignments(uuid);

create function public.get_combat_assignments(
  p_session_id uuid
)
returns table (
  id uuid,
  session_id uuid,
  turn_number integer,
  attacker_card_id uuid,
  attacker_name text,
  attacking_player_id uuid,
  attacking_username text,
  defending_player_id uuid,
  defending_username text,
  blocker_card_id uuid,
  blocker_name text,
  blocker_count integer,
  blockers jsonb,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with blocker_summary as (
    select
      blockers.assignment_id,
      (array_agg(blockers.blocker_card_id order by blockers.damage_assignment_order, blockers.created_at, blockers.id))[1] as first_blocker_card_id,
      string_agg(coalesce(cards.name, 'Unknown'), ', ' order by blockers.damage_assignment_order, blockers.created_at, blockers.id) as blocker_names,
      count(*)::integer as blocker_count,
      jsonb_agg(
        jsonb_build_object(
          'id', blockers.id,
          'blocker_card_id', blockers.blocker_card_id,
          'blocker_name', coalesce(cards.name, 'Unknown'),
          'damage_assignment_order', blockers.damage_assignment_order,
          'blocking_player_id', blockers.blocking_player_id
        )
        order by blockers.damage_assignment_order, blockers.created_at, blockers.id
      ) as blockers
    from public.game_combat_blockers blockers
    left join public.game_cards blocker_instance
      on blocker_instance.id = blockers.blocker_card_id
    left join public.cards
      on cards.id = blocker_instance.card_id
    group by blockers.assignment_id
  )
  select
    combat.id,
    combat.session_id,
    combat.turn_number,
    combat.attacker_card_id,
    coalesce(attacker_card.name, 'Unknown') as attacker_name,
    combat.attacking_player_id,
    coalesce(nullif(attacking_profile.username, ''), left(combat.attacking_player_id::text, 8)) as attacking_username,
    combat.defending_player_id,
    coalesce(nullif(defending_profile.username, ''), left(combat.defending_player_id::text, 8)) as defending_username,
    coalesce(blocker_summary.first_blocker_card_id, combat.blocker_card_id) as blocker_card_id,
    coalesce(blocker_summary.blocker_names, blocker_card.name) as blocker_name,
    coalesce(blocker_summary.blocker_count, 0) as blocker_count,
    coalesce(blocker_summary.blockers, '[]'::jsonb) as blockers,
    combat.created_at
  from public.game_combat_assignments combat
  join public.game_turn_state turn_state
    on turn_state.session_id = combat.session_id
   and turn_state.turn_number = combat.turn_number
  left join blocker_summary
    on blocker_summary.assignment_id = combat.id
  left join public.game_cards attacker_instance
    on attacker_instance.id = combat.attacker_card_id
  left join public.cards attacker_card
    on attacker_card.id = attacker_instance.card_id
  left join public.game_cards blocker_instance
    on blocker_instance.id = combat.blocker_card_id
  left join public.cards blocker_card
    on blocker_card.id = blocker_instance.card_id
  left join public.profiles attacking_profile
    on attacking_profile.id = combat.attacking_player_id
  left join public.profiles defending_profile
    on defending_profile.id = combat.defending_player_id
  where combat.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by combat.created_at;
$$;

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
  v_attacker_deals_damage boolean;
  v_blocker_has_first_strike boolean;
  v_blocker_has_double_strike boolean;
  v_blocker_deals_damage boolean;
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

        if v_is_first_strike_stage then
          v_blocker_deals_damage := v_blocker_has_first_strike or v_blocker_has_double_strike;
        else
          v_blocker_deals_damage := (not v_blocker_has_first_strike) or v_blocker_has_double_strike;
        end if;

        if v_attacker_deals_damage and v_remaining_attacker_damage > 0 then
          v_assigned_damage := least(v_remaining_attacker_damage, greatest(1, v_blocker.blocker_toughness));

          update public.game_cards
          set damage_marked = damage_marked + v_assigned_damage
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
          set damage_marked = damage_marked + v_blocker_damage
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

grant execute on function public.declare_blocker(uuid, uuid, uuid) to authenticated;
grant execute on function public.set_combat_blocker_order(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.get_combat_assignments(uuid) to authenticated;
grant execute on function public.resolve_combat_damage(uuid) to authenticated;
