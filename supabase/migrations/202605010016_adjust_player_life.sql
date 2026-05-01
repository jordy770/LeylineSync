create or replace function public.adjust_player_life(
  p_session_id uuid,
  p_target_player_id uuid,
  p_delta integer
)
returns public.game_session_players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_player public.game_session_players;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_delta = 0 then
    raise exception 'Life total delta cannot be zero';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_target_player_id) then
    raise exception 'Target player is not a player in this session';
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
    raise exception 'Cannot change life totals in a finished game session';
  end if;

  update public.game_session_players
  set life_total = greatest(0, life_total + p_delta)
  where session_id = p_session_id
    and player_id = p_target_player_id
  returning * into v_player;

  if not found then
    raise exception 'Target player not found';
  end if;

  return v_player;
end;
$$;

grant execute on function public.adjust_player_life(uuid, uuid, integer) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_session_players'
  ) then
    alter publication supabase_realtime add table public.game_session_players;
  end if;
end;
$$;
