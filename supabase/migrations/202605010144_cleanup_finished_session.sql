-- Operational — explicit cleanup of a FINISHED game's runtime data.
--
-- maybe_finish_game_session only flips status to 'finished'; the per-card / per-stack
-- / per-effect rows linger forever. This adds an EXPLICIT RPC (not folded into
-- maybe_finish, so finishing stays cheap and the data survives for any immediate
-- post-game review) that deletes the bulky runtime rows for a finished session while
-- KEEPING game_sessions + game_session_players (the result: winner, seats, life).
--
-- Callable by a session member (cleans up their own finished game) or by a service-
-- role scheduled job (auth.uid() is null in that context). Refuses non-finished
-- sessions. Deletes children before parents to respect FKs.

create or replace function public.cleanup_finished_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_deleted_cards integer;
begin
  -- A session member may clean their own game; a service-role job (no auth.uid)
  -- may clean any. Authenticated non-members are refused.
  if auth.uid() is not null and not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status into v_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_status <> 'finished' then
    raise exception 'Only a finished game session can be cleaned up';
  end if;

  -- Runtime rows, children-before-parents. game_sessions + game_session_players are
  -- intentionally kept (history / winner / final life).
  delete from public.game_damage_prevention where session_id = p_session_id;
  delete from public.game_commander_damage where session_id = p_session_id;
  delete from public.game_pending_decisions where session_id = p_session_id;
  delete from public.game_combat_blockers where session_id = p_session_id;
  delete from public.game_combat_assignments where session_id = p_session_id;
  delete from public.game_continuous_effects where session_id = p_session_id;
  delete from public.game_stack_items where session_id = p_session_id;
  delete from public.game_action_log where session_id = p_session_id;

  delete from public.game_cards where session_id = p_session_id;
  get diagnostics v_deleted_cards = row_count;

  delete from public.game_turn_state where session_id = p_session_id;
  delete from public.game_players where session_id = p_session_id;

  return jsonb_build_object('cleaned', true, 'cards_deleted', v_deleted_cards);
end;
$$;

grant execute on function public.cleanup_finished_session(uuid) to authenticated, service_role;
