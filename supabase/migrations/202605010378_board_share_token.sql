-- Spectator board link + cast support.
--
-- The big-screen board could only be opened by a logged-in session member
-- (page redirect + get_board_state auth gate). For casting to a TV (Presentation
-- API / any smart-TV browser) the receiving device has no session, so:
--   * game_sessions.board_token — an unguessable per-session spectator key.
--   * get_board_state_by_token — token-gated, callable by ANON. Rather than
--     reproducing get_board_state minus its gates, it validates the token and
--     then IMPERSONATES the session host for the rest of the transaction
--     (set_config('request.jwt.claims', …, is_local => true)): the nested
--     helpers (get_turn_state/get_session_players/get_stack_items/…) all filter
--     on auth.uid() membership, and the host is by definition a member. The
--     local setting dies with the transaction. Everything returned is public
--     board state (battlefield only, no hidden zones).
--   * get_board_share_token — member-gated token fetch for the Cast/share UI.
-- The spectator board POLLS this RPC (realtime delivers nothing to anon under
-- RLS — the board hook's fallback poll already covers that path by design).

alter table public.game_sessions
  add column if not exists board_token uuid not null default gen_random_uuid();

comment on column public.game_sessions.board_token is
  'Spectator key: grants read-only board-view polling via get_board_state_by_token.';

-- Clean up the abandoned intermediate approach (earlier local-only iteration).
drop function if exists public.build_board_state_json(uuid);

-- ---------------------------------------------------------------------------
-- 1. Spectator path: token gate → impersonate the host → the mig-371 board fn.
-- ---------------------------------------------------------------------------
create or replace function public.get_board_state_by_token(
  p_session_id uuid,
  p_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_host uuid;
begin
  select created_by into v_host
  from public.game_sessions
  where id = p_session_id and board_token = p_token and p_token is not null;
  if v_host is null then
    raise exception 'Invalid board link';
  end if;

  -- Transaction-local claims: auth.uid() resolves to the host for the nested
  -- membership-filtered helpers. Reset automatically at transaction end.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_host, 'role', 'authenticated')::text,
    true
  );

  return public.get_board_state(p_session_id);
end;
$$;
grant execute on function public.get_board_state_by_token(uuid, uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Members fetch the share token for the Cast / copy-link UI.
-- ---------------------------------------------------------------------------
create or replace function public.get_board_share_token(
  p_session_id uuid
) returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_token uuid;
begin
  if auth.uid() is null or not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Not a player in this session';
  end if;
  select board_token into v_token from public.game_sessions where id = p_session_id;
  return v_token;
end;
$$;
grant execute on function public.get_board_share_token(uuid) to authenticated;
