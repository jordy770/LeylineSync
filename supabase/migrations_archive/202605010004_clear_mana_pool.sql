create or replace function public.clear_mana_pool(
  p_session_id uuid,
  p_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
begin
  if p_player_id <> auth.uid() then
    raise exception 'Cannot clear another player mana pool';
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id)
  do update set mana_pool = excluded.mana_pool;

  return v_empty_pool;
end;
$$;

grant execute on function public.clear_mana_pool(uuid, uuid) to authenticated;
