create table if not exists public.game_combat_assignments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  turn_number integer not null,
  attacker_card_id uuid not null references public.game_cards(id) on delete cascade,
  attacking_player_id uuid not null,
  defending_player_id uuid not null,
  blocker_card_id uuid references public.game_cards(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint game_combat_assignments_attacker_unique
    unique (session_id, turn_number, attacker_card_id)
);

create index if not exists game_combat_assignments_session_turn_idx
on public.game_combat_assignments (session_id, turn_number);

alter table public.game_combat_assignments enable row level security;

drop policy if exists "Players can read combat assignments in their sessions"
on public.game_combat_assignments;

create policy "Players can read combat assignments in their sessions"
on public.game_combat_assignments
for select
to authenticated
using (public.is_session_player(session_id, auth.uid()));

create or replace function public.declare_attacker(
  p_session_id uuid,
  p_attacker_card_id uuid,
  p_defending_player_id uuid
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
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_defending_player_id) then
    raise exception 'Defending player is not a player in this session';
  end if;

  if p_defending_player_id = auth.uid() then
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

  update public.game_cards
  set is_tapped = true
  where id = p_attacker_card_id
    and session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'battlefield'
    and is_tapped = false;

  if not found then
    raise exception 'Attacker card not found, not on battlefield, not owned by active player, or already tapped';
  end if;

  insert into public.game_combat_assignments (
    session_id,
    turn_number,
    attacker_card_id,
    attacking_player_id,
    defending_player_id
  )
  values (
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    auth.uid(),
    p_defending_player_id
  )
  returning * into v_assignment;

  return v_assignment;
end;
$$;

create or replace function public.clear_combat_assignments(
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  delete from public.game_combat_assignments
  where session_id = p_session_id;

  get diagnostics v_deleted_count = row_count;

  return v_deleted_count;
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
    combat.blocker_card_id,
    blocker_card.name as blocker_name,
    combat.created_at
  from public.game_combat_assignments combat
  join public.game_turn_state turn_state
    on turn_state.session_id = combat.session_id
   and turn_state.turn_number = combat.turn_number
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

create or replace function public.advance_step(
  p_session_id uuid
)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_next_active_player_id uuid;
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_drawn_card_id uuid;
  v_next_hand_position integer;
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
    raise exception 'Cannot advance a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_current_state.active_player_id <> auth.uid() then
    raise exception 'Only the active player can advance the step';
  end if;

  v_next_active_player_id := v_current_state.active_player_id;
  v_next_turn_number := v_current_state.turn_number;
  v_next_phase := v_current_state.phase;
  v_next_step := v_current_state.step;

  case v_current_state.step
    when 'untap' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set is_tapped = false
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true;

      v_next_phase := 'beginning';
      v_next_step := 'upkeep';
    when 'upkeep' then
      v_next_phase := 'beginning';
      v_next_step := 'draw';
    when 'draw' then
      select coalesce(max(zone_position), -1) + 1
      into v_next_hand_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'hand';

      select id
      into v_drawn_card_id
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'library'
      order by zone_position asc, id asc
      limit 1
      for update skip locked;

      if v_drawn_card_id is null then
        raise exception 'Library is empty';
      end if;

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_hand_position,
        is_tapped = false
      where id = v_drawn_card_id;

      v_next_phase := 'main_1';
      v_next_step := 'precombat_main';
    when 'precombat_main' then
      v_next_phase := 'combat';
      v_next_step := 'beginning_of_combat';
    when 'beginning_of_combat' then
      v_next_phase := 'combat';
      v_next_step := 'declare_attackers';
    when 'declare_attackers' then
      v_next_phase := 'combat';
      v_next_step := 'declare_blockers';
    when 'declare_blockers' then
      v_next_phase := 'combat';
      v_next_step := 'combat_damage';
    when 'combat_damage' then
      v_next_phase := 'combat';
      v_next_step := 'end_of_combat';
    when 'end_of_combat' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      v_next_phase := 'main_2';
      v_next_step := 'postcombat_main';
    when 'postcombat_main' then
      v_next_phase := 'ending';
      v_next_step := 'end';
    when 'end' then
      v_next_phase := 'ending';
      v_next_step := 'cleanup';
    when 'cleanup' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      select next_player.player_id
      into v_next_active_player_id
      from public.game_session_players current_player
      join public.game_session_players next_player
        on next_player.session_id = current_player.session_id
       and next_player.seat_number > current_player.seat_number
      where current_player.session_id = p_session_id
        and current_player.player_id = v_current_state.active_player_id
      order by next_player.seat_number
      limit 1;

      if v_next_active_player_id is null then
        select player_id
        into v_next_active_player_id
        from public.game_session_players
        where session_id = p_session_id
        order by seat_number
        limit 1;
      end if;

      if v_next_active_player_id is null then
        raise exception 'No players found for game session';
      end if;

      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    active_player_id = v_next_active_player_id,
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;

grant select on public.game_combat_assignments to authenticated;
grant execute on function public.declare_attacker(uuid, uuid, uuid) to authenticated;
grant execute on function public.clear_combat_assignments(uuid) to authenticated;
grant execute on function public.get_combat_assignments(uuid) to authenticated;
grant execute on function public.advance_step(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_combat_assignments'
  ) then
    alter publication supabase_realtime add table public.game_combat_assignments;
  end if;
end;
$$;
