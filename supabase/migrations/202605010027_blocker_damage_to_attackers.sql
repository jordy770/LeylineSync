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
  v_attacker_damage integer;
  v_blocker_damage integer;
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

  for v_assignment in
    select
      combat.id,
      combat.attacker_card_id,
      combat.defending_player_id,
      combat.blocker_card_id,
      coalesce(
        attacker_card.power,
        case
          when attacker_card.power_toughness ~ '^[0-9]+/[0-9]+$'
            then split_part(attacker_card.power_toughness, '/', 1)::integer
          else 0
        end,
        0
      ) as attacker_power,
      coalesce(
        blocker_card.power,
        case
          when blocker_card.power_toughness ~ '^[0-9]+/[0-9]+$'
            then split_part(blocker_card.power_toughness, '/', 1)::integer
          else 0
        end,
        0
      ) as blocker_power
    from public.game_combat_assignments combat
    join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
    left join public.cards attacker_card
      on attacker_card.id = attacker_instance.card_id
    left join public.game_cards blocker_instance
      on blocker_instance.id = combat.blocker_card_id
    left join public.cards blocker_card
      on blocker_card.id = blocker_instance.card_id
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
    order by combat.created_at
    for update of combat
  loop
    v_attacker_damage := greatest(0, v_assignment.attacker_power);
    v_blocker_damage := greatest(0, v_assignment.blocker_power);

    if v_assignment.blocker_card_id is null then
      if v_attacker_damage > 0 then
        update public.game_session_players
        set life_total = greatest(0, life_total - v_attacker_damage)
        where session_id = p_session_id
          and player_id = v_assignment.defending_player_id;

        v_total_player_damage := v_total_player_damage + v_attacker_damage;
      end if;
    else
      if v_attacker_damage > 0 then
        update public.game_cards
        set damage_marked = damage_marked + v_attacker_damage
        where id = v_assignment.blocker_card_id
          and session_id = p_session_id
          and zone = 'battlefield';

        if not found then
          raise exception 'Blocker card not found on battlefield';
        end if;

        v_total_creature_damage := v_total_creature_damage + v_attacker_damage;
      end if;

      if v_blocker_damage > 0 then
        update public.game_cards
        set damage_marked = damage_marked + v_blocker_damage
        where id = v_assignment.attacker_card_id
          and session_id = p_session_id
          and zone = 'battlefield';

        if not found then
          raise exception 'Attacker card not found on battlefield';
        end if;

        v_total_creature_damage := v_total_creature_damage + v_blocker_damage;
      end if;
    end if;

    update public.game_combat_assignments
    set damage_resolved = true
    where id = v_assignment.id;

    v_resolved_count := v_resolved_count + 1;
  end loop;

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
      and game_cards.damage_marked >= coalesce(
        cards.toughness,
        case
          when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
            then split_part(cards.power_toughness, '/', 2)::integer
          else null
        end
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
    damage_marked = 0
  from lethal_cards
  left join graveyard_positions
    on graveyard_positions.owner_id = lethal_cards.owner_id
  where game_cards.id = lethal_cards.id;

  get diagnostics v_destroyed_count = row_count;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'assignments_resolved',
    v_resolved_count,
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

grant execute on function public.resolve_combat_damage(uuid) to authenticated;
