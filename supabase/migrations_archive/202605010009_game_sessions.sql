create table if not exists public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'open',
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  locked_at timestamptz,
  finished_at timestamptz,
  constraint game_sessions_status_check
    check (status in ('open', 'locked', 'finished'))
);

alter table public.game_sessions
add column if not exists status text not null default 'open';

alter table public.game_sessions
alter column status set default 'open';

alter table public.game_sessions
add column if not exists created_by uuid;

alter table public.game_sessions
alter column created_by set default auth.uid();

alter table public.game_sessions
add column if not exists created_at timestamptz not null default now();

alter table public.game_sessions
add column if not exists locked_at timestamptz;

alter table public.game_sessions
add column if not exists finished_at timestamptz;

update public.game_sessions
set status = 'open'
where status is null
   or status not in ('open', 'locked', 'finished');

alter table public.game_sessions
drop constraint if exists game_sessions_status_check;

alter table public.game_sessions
add constraint game_sessions_status_check
check (status in ('open', 'locked', 'finished'));

create table if not exists public.game_session_players (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  player_id uuid not null,
  seat_number integer not null,
  life_total integer not null default 20,
  joined_at timestamptz not null default now(),
  primary key (session_id, player_id),
  constraint game_session_players_seat_unique unique (session_id, seat_number),
  constraint game_session_players_life_total_check check (life_total >= 0)
);

alter table public.game_session_players
add column if not exists seat_number integer not null default 1;

alter table public.game_session_players
add column if not exists life_total integer not null default 20;

alter table public.game_session_players
add column if not exists joined_at timestamptz not null default now();

alter table public.game_session_players
drop constraint if exists game_session_players_life_total_check;

alter table public.game_session_players
add constraint game_session_players_life_total_check
check (life_total >= 0);

create index if not exists game_session_players_player_idx
on public.game_session_players (player_id, session_id);

create or replace function public.create_game_session()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.game_sessions (created_by)
  values (auth.uid())
  returning id into v_session_id;

  insert into public.game_session_players (
    session_id,
    player_id,
    seat_number,
    life_total
  )
  values (
    v_session_id,
    auth.uid(),
    1,
    20
  );

  insert into public.game_turn_state (
    session_id,
    active_player_id,
    turn_number,
    phase,
    step
  )
  values (
    v_session_id,
    auth.uid(),
    1,
    'beginning',
    'untap'
  )
  on conflict (session_id) do nothing;

  return v_session_id;
end;
$$;

create or replace function public.join_game_session(
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_seat_number integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select status
  into v_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_status <> 'open' then
    raise exception 'Game session is not open';
  end if;

  select seat_number
  into v_seat_number
  from public.game_session_players
  where session_id = p_session_id
    and player_id = auth.uid();

  if found then
    return v_seat_number;
  end if;

  select coalesce(max(seat_number), 0) + 1
  into v_seat_number
  from public.game_session_players
  where session_id = p_session_id;

  insert into public.game_session_players (
    session_id,
    player_id,
    seat_number,
    life_total
  )
  values (
    p_session_id,
    auth.uid(),
    v_seat_number,
    20
  );

  return v_seat_number;
end;
$$;

create or replace function public.lock_game_session(
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.game_sessions
  set
    status = 'locked',
    locked_at = coalesce(locked_at, now())
  where id = p_session_id
    and created_by = auth.uid()
    and status = 'open';

  if not found then
    raise exception 'Game session not found, not open, or not created by current user';
  end if;

  return true;
end;
$$;

grant select on public.game_sessions to authenticated;
grant select on public.game_session_players to authenticated;
grant execute on function public.create_game_session() to authenticated;
grant execute on function public.join_game_session(uuid) to authenticated;
grant execute on function public.lock_game_session(uuid) to authenticated;
