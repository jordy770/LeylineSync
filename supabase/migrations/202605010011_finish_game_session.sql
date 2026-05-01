create or replace function public.finish_game_session(
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
    status = 'finished',
    finished_at = coalesce(finished_at, now())
  where id = p_session_id
    and created_by = auth.uid()
    and status <> 'finished';

  if not found then
    raise exception 'Game session not found, already finished, or not created by current user';
  end if;

  return true;
end;
$$;

grant execute on function public.finish_game_session(uuid) to authenticated;
