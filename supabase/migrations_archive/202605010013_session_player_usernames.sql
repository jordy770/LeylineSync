create or replace function public.get_session_players(
  p_session_id uuid
)
returns table (
  session_id uuid,
  player_id uuid,
  username text,
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
    coalesce(
      nullif(profiles.username, ''),
      left(game_session_players.player_id::text, 8)
    ) as username,
    game_session_players.seat_number,
    game_session_players.life_total,
    game_session_players.joined_at
  from public.game_session_players
  left join public.profiles
    on profiles.id = game_session_players.player_id
  where game_session_players.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by game_session_players.seat_number;
$$;

grant execute on function public.get_session_players(uuid) to authenticated;
