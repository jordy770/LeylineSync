create table if not exists public.game_turn_state (
  session_id uuid primary key,
  active_player_id uuid not null,
  turn_number integer not null default 1,
  phase text not null default 'beginning',
  step text not null default 'untap',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_turn_state_phase_check
    check (phase in ('beginning', 'main_1', 'combat', 'main_2', 'ending')),
  constraint game_turn_state_step_check
    check (step in (
      'untap',
      'upkeep',
      'draw',
      'precombat_main',
      'beginning_of_combat',
      'declare_attackers',
      'declare_blockers',
      'combat_damage',
      'end_of_combat',
      'postcombat_main',
      'end',
      'cleanup'
    ))
);

create or replace function public.set_game_turn_state_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_game_turn_state_updated_at on public.game_turn_state;

create trigger set_game_turn_state_updated_at
before update on public.game_turn_state
for each row
execute function public.set_game_turn_state_updated_at();

create or replace function public.initialize_turn_state(
  p_session_id uuid,
  p_active_player_id uuid
)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_state public.game_turn_state;
begin
  if p_active_player_id <> auth.uid() then
    raise exception 'Cannot initialize turn state for another player';
  end if;

  insert into public.game_turn_state (
    session_id,
    active_player_id,
    turn_number,
    phase,
    step
  )
  values (
    p_session_id,
    p_active_player_id,
    1,
    'beginning',
    'untap'
  )
  on conflict (session_id) do update
  set session_id = excluded.session_id
  returning * into v_turn_state;

  return v_turn_state;
end;
$$;

grant select on public.game_turn_state to authenticated;
grant execute on function public.initialize_turn_state(uuid, uuid) to authenticated;
