-- 202605010324_clear_deck_from_session
-- Lobby "change deck": clear_deck_from_session removes the caller's spawned cards
-- (status='open' only) so they can pick another deck and lock in again — the
-- inverse of spawn_deck_for_session, which otherwise hard-blocks a second spawn.
-- Generated from supabase/functions_src (clear_deck_from_session) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.clear_deck_from_session(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status into v_status
  from public.game_sessions where id = p_session_id;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_status <> 'open' then
    raise exception 'Cannot change your deck after the game has started';
  end if;

  -- Pre-game the caller's only cards are the freshly seeded library + command
  -- zone, so this clears exactly their deck. No turn/combat/continuous-effect
  -- rows reference them yet (those appear once cards hit the battlefield in-game).
  delete from public.game_cards
  where session_id = p_session_id and owner_id = auth.uid();
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('cleared', v_deleted);
end;
$$;

grant execute on function public.clear_deck_from_session(uuid) to authenticated;
grant execute on function public.clear_deck_from_session(uuid) to service_role;
