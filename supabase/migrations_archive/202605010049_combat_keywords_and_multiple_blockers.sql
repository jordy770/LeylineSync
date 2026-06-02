create table if not exists public.game_combat_blockers (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.game_combat_assignments(id) on delete cascade,
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  turn_number integer not null,
  attacker_card_id uuid not null references public.game_cards(id) on delete cascade,
  blocker_card_id uuid not null references public.game_cards(id) on delete cascade,
  blocking_player_id uuid not null,
  created_at timestamptz not null default now(),
  constraint game_combat_blockers_unique_blocker_per_turn
    unique (session_id, turn_number, blocker_card_id)
);

create index if not exists game_combat_blockers_assignment_idx
on public.game_combat_blockers (assignment_id, created_at);

create index if not exists game_combat_blockers_session_turn_idx
on public.game_combat_blockers (session_id, turn_number);

insert into public.game_combat_blockers (
  assignment_id,
  session_id,
  turn_number,
  attacker_card_id,
  blocker_card_id,
  blocking_player_id,
  created_at
)
select
  assignments.id,
  assignments.session_id,
  assignments.turn_number,
  assignments.attacker_card_id,
  assignments.blocker_card_id,
  assignments.defending_player_id,
  assignments.created_at
from public.game_combat_assignments assignments
where assignments.blocker_card_id is not null
on conflict (session_id, turn_number, blocker_card_id) do nothing;

alter table public.game_combat_blockers enable row level security;

drop policy if exists "Session players can read combat blockers"
on public.game_combat_blockers;

create policy "Session players can read combat blockers"
on public.game_combat_blockers
for select
to authenticated
using (public.is_session_player(session_id, auth.uid()));

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
    'trample'
  )
);

create or replace function public.card_has_indestructible(
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
      and effects.effect_type = 'indestructible'
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

create or replace function public.card_has_trample(
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
      and effects.effect_type = 'trample'
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

  select coalesce(v_source_card.copied_script, cards.script)
  into v_script
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
      'trample'
    ) then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
    end if;

    v_affected := coalesce(
      v_effect ->> 'affected',
      case
        when v_effect_type in ('haste', 'vigilance', 'indestructible', 'trample') then 'source'
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

  return v_registered_count;
end;
$$;

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

  insert into public.game_combat_blockers (
    assignment_id,
    session_id,
    turn_number,
    attacker_card_id,
    blocker_card_id,
    blocking_player_id
  )
  values (
    v_assignment.id,
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    p_blocker_card_id,
    auth.uid()
  );

  update public.game_combat_assignments
  set blocker_card_id = coalesce(blocker_card_id, p_blocker_card_id)
  where id = v_assignment.id
  returning * into v_assignment;

  return v_assignment;
end;
$$;

create or replace function public.get_combat_assignments(
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
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with blocker_summary as (
    select
      blockers.assignment_id,
      (array_agg(blockers.blocker_card_id order by blockers.created_at, blockers.id))[1] as first_blocker_card_id,
      string_agg(coalesce(cards.name, 'Unknown'), ', ' order by blockers.created_at, blockers.id) as blocker_names
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

create or replace function public.get_combat_action_state(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_state public.game_turn_state;
  v_is_session_player boolean;
  v_attack_reason text;
  v_block_reason text;
  v_damage_reason text;
  v_blockable_attackers_count integer := 0;
  v_unresolved_combat_count integer := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Authentication required',
      'attack_reason', 'Authentication required',
      'block_reason', 'Authentication required',
      'damage_reason', 'Authentication required'
    );
  end if;

  v_is_session_player := public.is_session_player(p_session_id, auth.uid());

  if not v_is_session_player then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Current user is not a player in this session',
      'attack_reason', 'Current user is not a player in this session',
      'block_reason', 'Current user is not a player in this session',
      'damage_reason', 'Current user is not a player in this session',
      'current_player_id', auth.uid()
    );
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id;

  if not found then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Turn state not found',
      'attack_reason', 'Turn state not found',
      'block_reason', 'Turn state not found',
      'damage_reason', 'Turn state not found',
      'current_player_id', auth.uid()
    );
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    v_attack_reason := 'Only the active player can declare attackers';
  elsif v_turn_state.step <> 'declare_attackers' then
    v_attack_reason := 'Attackers can only be declared during Declare Attackers Step';
  end if;

  select count(*)
  into v_blockable_attackers_count
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and defending_player_id = auth.uid();

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    v_block_reason := 'Only the priority player can declare blockers';
  elsif v_turn_state.step <> 'declare_blockers' then
    v_block_reason := 'Blockers can only be declared during Declare Blockers Step';
  elsif v_blockable_attackers_count = 0 then
    v_block_reason := 'No attackers are attacking you';
  end if;

  select count(*)
  into v_unresolved_combat_count
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and damage_resolved = false;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    v_damage_reason := 'Only the priority player can resolve combat damage';
  elsif v_turn_state.step <> 'combat_damage' then
    v_damage_reason := 'Combat damage can only be resolved during Combat Damage Step';
  elsif v_unresolved_combat_count = 0 then
    v_damage_reason := 'No unresolved combat damage';
  end if;

  return jsonb_build_object(
    'can_declare_attackers',
    v_attack_reason is null,
    'can_declare_blockers',
    v_block_reason is null,
    'can_resolve_combat_damage',
    v_damage_reason is null,
    'reason',
    coalesce(v_attack_reason, v_block_reason, v_damage_reason),
    'attack_reason',
    v_attack_reason,
    'block_reason',
    v_block_reason,
    'damage_reason',
    v_damage_reason,
    'blockable_attackers_count',
    v_blockable_attackers_count,
    'unresolved_combat_count',
    v_unresolved_combat_count,
    'active_player_id',
    v_turn_state.active_player_id,
    'priority_player_id',
    coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id),
    'current_player_id',
    auth.uid(),
    'turn_number',
    v_turn_state.turn_number,
    'phase',
    v_turn_state.phase,
    'step',
    v_turn_state.step
  );
end;
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
    join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
    left join public.cards attacker_card
      on attacker_card.id = attacker_instance.card_id
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
    order by combat.created_at
    for update of combat
  loop
    v_attacker_damage := greatest(0, v_assignment.attacker_power);
    v_remaining_attacker_damage := v_attacker_damage;

    select exists (
      select 1
      from public.game_combat_blockers blockers
      join public.game_cards blocker_instance
        on blocker_instance.id = blockers.blocker_card_id
       and blocker_instance.zone = 'battlefield'
      where blockers.assignment_id = v_assignment.id
    )
    into v_has_blockers;

    if not v_has_blockers then
      if v_attacker_damage > 0 then
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
        order by blockers.created_at, blockers.id
      loop
        v_blocker_damage := greatest(0, v_blocker.blocker_power);

        if v_remaining_attacker_damage > 0 then
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
      end loop;

      if v_remaining_attacker_damage > 0
        and public.card_has_trample(p_session_id, v_assignment.attacker_card_id)
      then
        update public.game_session_players
        set life_total = greatest(0, life_total - v_remaining_attacker_damage)
        where session_id = p_session_id
          and player_id = v_assignment.defending_player_id;

        v_total_player_damage := v_total_player_damage + v_remaining_attacker_damage;
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
      and not public.card_has_indestructible(p_session_id, game_cards.id)
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

  perform public.rebuild_scripted_continuous_effects(p_session_id);

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

insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  power_toughness,
  script
)
select
  gen_random_uuid(),
  'Darksteel Myr',
  'Artifact Creature - Myr',
  '{3}',
  '0/1',
  jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'indestructible',
        'affected', 'source',
        'source_zone_required', 'battlefield'
      )
    )
  )
where not exists (
  select 1
  from public.cards
  where lower(name) = 'darksteel myr'
);

update public.cards
set
  type_line = 'Artifact Creature - Myr',
  mana_cost = '{3}',
  power_toughness = '0/1',
  script = jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'indestructible',
        'affected', 'source',
        'source_zone_required', 'battlefield'
      )
    )
  )
where lower(name) = 'darksteel myr';

insert into public.cards (
  id,
  name,
  type_line,
  mana_cost,
  power_toughness,
  script
)
select
  gen_random_uuid(),
  'Colossal Dreadmaw',
  'Creature - Dinosaur',
  '{4}{G}{G}',
  '6/6',
  jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'trample',
        'affected', 'source',
        'source_zone_required', 'battlefield'
      )
    )
  )
where not exists (
  select 1
  from public.cards
  where lower(name) = 'colossal dreadmaw'
);

update public.cards
set
  type_line = 'Creature - Dinosaur',
  mana_cost = '{4}{G}{G}',
  power_toughness = '6/6',
  script = jsonb_build_object(
    'continuous_effects',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'trample',
        'affected', 'source',
        'source_zone_required', 'battlefield'
      )
    )
  )
where lower(name) = 'colossal dreadmaw';

grant select on public.game_combat_blockers to authenticated;
grant execute on function public.card_has_indestructible(uuid, uuid) to authenticated;
grant execute on function public.card_has_trample(uuid, uuid) to authenticated;
grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated;
grant execute on function public.declare_blocker(uuid, uuid, uuid) to authenticated;
grant execute on function public.get_combat_assignments(uuid) to authenticated;
grant execute on function public.get_combat_action_state(uuid) to authenticated;
grant execute on function public.resolve_combat_damage(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_combat_blockers'
  ) then
    alter publication supabase_realtime add table public.game_combat_blockers;
  end if;
end;
$$;
