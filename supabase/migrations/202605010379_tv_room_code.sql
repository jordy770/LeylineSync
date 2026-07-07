-- TV room code — the Jackbox pattern for couch play.
--
-- Casting from a phone is unreliable (Android Chrome can't present arbitrary
-- URLs to a Chromecast; iOS can't cast from the browser at all), and the
-- spectator link (mig 378) is too long to type on a TV remote. So: the TV
-- opens ONE stable address (/tv) and enters a short room code shown in the
-- lobby; the code resolves to the session + board_token and redirects to the
-- read-only spectator board.
--
-- Code space is 4 hex chars (~65k) and grants only what the spectator link
-- already grants: read-only public board state for a non-finished session.

alter table public.game_sessions
  add column if not exists tv_code text not null default upper(substr(md5(random()::text), 1, 4));

comment on column public.game_sessions.tv_code is
  'Short room code: /tv resolves it to the spectator board link while the session is not finished.';

create index if not exists game_sessions_tv_code_idx
  on public.game_sessions (tv_code) where status <> 'finished';

create or replace function public.get_board_access_by_code(
  p_code text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_token uuid;
begin
  -- Newest matching live session wins (hex codes may recycle across old games).
  select id, board_token into v_id, v_token
  from public.game_sessions
  where upper(tv_code) = upper(trim(p_code)) and status <> 'finished'
  order by created_at desc
  limit 1;

  if v_id is null then
    raise exception 'Unknown TV code';
  end if;

  return jsonb_build_object('session_id', v_id, 'board_token', v_token);
end;
$$;
grant execute on function public.get_board_access_by_code(text) to anon, authenticated, service_role;
