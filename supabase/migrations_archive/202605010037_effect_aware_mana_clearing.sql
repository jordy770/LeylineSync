create table if not exists public.game_continuous_effects (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  source_card_id uuid references public.game_cards(id) on delete set null,
  affected_player_id uuid,
  affected_card_id uuid references public.game_cards(id) on delete cascade,
  effect_type text not null,
  payload jsonb not null default '{}'::jsonb,
  expires_at_turn_number integer,
  expires_at_phase text,
  expires_at_step text,
  created_at timestamptz not null default now(),
  constraint game_continuous_effects_effect_type_check
    check (effect_type in ('mana_does_not_empty'))
);

create index if not exists game_continuous_effects_session_type_idx
on public.game_continuous_effects (session_id, effect_type);

alter table public.game_continuous_effects enable row level security;

drop policy if exists "Session players can read continuous effects"
on public.game_continuous_effects;

create policy "Session players can read continuous effects"
on public.game_continuous_effects
for select
to authenticated
using (public.is_session_player(session_id, auth.uid()));

create or replace function public.clear_mana_pool_for_step(
  p_session_id uuid,
  p_phase text,
  p_step text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_player record;
  v_retained_colors text[];
  v_new_pool jsonb;
  v_color text;
  v_updated_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  for v_player in
    select
      player_id,
      coalesce(mana_pool, v_empty_pool) as mana_pool
    from public.game_players
    where session_id = p_session_id
    for update
  loop
    select coalesce(array_agg(distinct retained.color), '{}'::text[])
    into v_retained_colors
    from public.game_continuous_effects effects
    cross join lateral jsonb_array_elements_text(
      coalesce(effects.payload -> 'colors', '[]'::jsonb)
    ) as retained(color)
    where effects.session_id = p_session_id
      and effects.effect_type = 'mana_does_not_empty'
      and (effects.affected_player_id is null or effects.affected_player_id = v_player.player_id);

    v_new_pool := v_empty_pool;

    foreach v_color in array array['W', 'U', 'B', 'R', 'G', 'C']
    loop
      if v_color = any(v_retained_colors) then
        v_new_pool := v_new_pool || jsonb_build_object(
          v_color,
          coalesce((v_player.mana_pool ->> v_color)::integer, 0)
        );
      end if;
    end loop;

    if v_new_pool <> v_player.mana_pool then
      update public.game_players
      set mana_pool = v_new_pool
      where session_id = p_session_id
        and player_id = v_player.player_id;

      v_updated_count := v_updated_count + 1;
    end if;
  end loop;

  return v_updated_count;
end;
$$;

create or replace function public.expire_continuous_effects_for_step(
  p_session_id uuid,
  p_turn_number integer,
  p_phase text,
  p_step text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and (
      (expires_at_turn_number is not null and expires_at_turn_number < p_turn_number)
      or (
        expires_at_phase = p_phase
        and (expires_at_step is null or expires_at_step = p_step)
      )
    );

  get diagnostics v_deleted_count = row_count;

  return v_deleted_count;
end;
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
  v_required_player_id uuid;
  v_next_active_player_id uuid;
  v_next_priority_player_id uuid;
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_next_lands_played_this_turn integer;
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

  v_required_player_id := coalesce(v_current_state.priority_player_id, v_current_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can advance the step';
  end if;

  perform public.clear_mana_pool_for_step(
    p_session_id,
    v_current_state.phase,
    v_current_state.step
  );

  perform public.expire_continuous_effects_for_step(
    p_session_id,
    v_current_state.turn_number,
    v_current_state.phase,
    v_current_state.step
  );

  v_next_active_player_id := v_current_state.active_player_id;
  v_next_priority_player_id := v_current_state.active_player_id;
  v_next_turn_number := v_current_state.turn_number;
  v_next_lands_played_this_turn := coalesce(v_current_state.lands_played_this_turn, 0);
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
        is_tapped = false,
        damage_marked = 0
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

      select defending_player_id
      into v_next_priority_player_id
      from public.game_combat_assignments
      where session_id = p_session_id
        and turn_number = v_current_state.turn_number
        and blocker_card_id is null
      order by created_at
      limit 1;

      v_next_priority_player_id := coalesce(v_next_priority_player_id, v_current_state.active_player_id);
    when 'declare_blockers' then
      v_next_priority_player_id := v_current_state.active_player_id;
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

      update public.game_cards
      set damage_marked = 0
      where session_id = p_session_id
        and damage_marked <> 0;

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

      v_next_priority_player_id := v_next_active_player_id;
      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_lands_played_this_turn := 0;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    active_player_id = v_next_active_player_id,
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    lands_played_this_turn = v_next_lands_played_this_turn,
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;

grant select on public.game_continuous_effects to authenticated;
grant execute on function public.clear_mana_pool_for_step(uuid, text, text) to authenticated;
grant execute on function public.expire_continuous_effects_for_step(uuid, integer, text, text) to authenticated;
grant execute on function public.advance_step(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_continuous_effects'
  ) then
    alter publication supabase_realtime add table public.game_continuous_effects;
  end if;
end;
$$;
