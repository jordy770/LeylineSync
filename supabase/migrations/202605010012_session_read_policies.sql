alter table public.game_sessions enable row level security;
alter table public.game_session_players enable row level security;

drop policy if exists "Players can read their sessions" on public.game_sessions;
drop policy if exists "Players can read players in their sessions" on public.game_session_players;
drop policy if exists "Players can read their own session memberships" on public.game_session_players;

create policy "Players can read their sessions"
on public.game_sessions
for select
to authenticated
using (
  exists (
    select 1
    from public.game_session_players
    where game_session_players.session_id = game_sessions.id
      and game_session_players.player_id = auth.uid()
  )
);

create policy "Players can read their own session memberships"
on public.game_session_players
for select
to authenticated
using (player_id = auth.uid());

create or replace function public.get_session_players(
  p_session_id uuid
)
returns table (
  session_id uuid,
  player_id uuid,
  seat_number integer,
  life_total integer,
  joined_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    game_session_players.session_id,
    game_session_players.player_id,
    game_session_players.seat_number,
    game_session_players.life_total,
    game_session_players.joined_at
  from public.game_session_players
  where game_session_players.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by game_session_players.seat_number;
$$;

grant execute on function public.get_session_players(uuid) to authenticated;
