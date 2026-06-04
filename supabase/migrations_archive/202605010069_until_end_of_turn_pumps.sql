-- Until-end-of-turn power/toughness pumps (Giant Growth style).
--
-- A pump is a game_continuous_effects row of type 'pump' targeting a creature,
-- carrying {power, toughness} in its payload. It expires during the cleanup step
-- via the existing expire_continuous_effects_for_step machinery. The effective
-- P/T helpers fold pumps in alongside +1/+1 counters, so combat resolution and
-- displays all see the buffed numbers.

-- Extend effect_type constraint to include pump.
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
    'deathtouch',
    'pump'
  )
);

-- Effective power = printed + counters + active pump effects.
create or replace function public.card_effective_power(
  p_session_id uuid,
  p_game_card_id uuid
)
returns integer
language sql
security definer
set search_path = public
as $$
  select
    coalesce(
      cards.power,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 1)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
      ), 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

-- Effective toughness = printed + counters + active pump effects.
create or replace function public.card_effective_toughness(
  p_session_id uuid,
  p_game_card_id uuid
)
returns integer
language sql
security definer
set search_path = public
as $$
  select
    coalesce(
      cards.toughness,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 2)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'toughness')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
      ), 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

-- Create a +power/+toughness pump on a target creature, lasting until the end
-- of the current turn (expires during the cleanup step).
create or replace function public.create_pt_pump(
  p_session_id uuid,
  p_target_card_id uuid,
  p_power integer,
  p_toughness integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  perform 1
  from public.game_cards
  where id = p_target_card_id
    and session_id = p_session_id;

  if not found then
    raise exception 'Target card not found in this session';
  end if;

  insert into public.game_continuous_effects (
    session_id,
    source_card_id,
    affected_card_id,
    effect_type,
    payload,
    source_zone_required,
    expires_at_phase,
    expires_at_step
  )
  values (
    p_session_id,
    p_target_card_id,
    p_target_card_id,
    'pump',
    jsonb_build_object('power', p_power, 'toughness', p_toughness, 'until_end_of_turn', true),
    'battlefield',
    'ending',
    'cleanup'
  );

  -- A negative pump can drop a creature to lethal; re-check state.
  perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
end;
$$;

-- get_combat_assignments: expose the attacker's effective power/toughness so the
-- declare-blockers and combat-damage views can show real (buffed) numbers.
create or replace function public.get_combat_assignments(
  p_session_id uuid
)
returns table (
  id uuid,
  session_id uuid,
  turn_number integer,
  attacker_card_id uuid,
  attacker_name text,
  attacker_power integer,
  attacker_toughness integer,
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
    public.card_effective_power(combat.session_id, combat.attacker_card_id) as attacker_power,
    public.card_effective_toughness(combat.session_id, combat.attacker_card_id) as attacker_toughness,
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

grant execute on function public.card_effective_power(uuid, uuid) to authenticated;
grant execute on function public.card_effective_toughness(uuid, uuid) to authenticated;
grant execute on function public.create_pt_pump(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.get_combat_assignments(uuid) to authenticated;
