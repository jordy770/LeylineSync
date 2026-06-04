-- Judge tool: pass priority on behalf of all players.
--
-- Useful for solo testing where one person drives every seat. Instead of
-- switching accounts to pass priority for each player, the judge passes the
-- whole round at once: the current priority pass is treated as the final one,
-- so pass_priority resolves the top of the stack (if any) or advances the step.
--
-- Implementation: make the judge the last player yet to pass, then delegate to
-- the real pass_priority. Aligning priority_player_id with auth.uid() satisfies
-- the authorization checks in pass_priority and advance_step, so all the normal
-- resolution/advance logic is reused unchanged.

create or replace function public.dev_pass_priority(
  p_session_id uuid
)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  perform 1
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  select count(*)
  into v_player_count
  from public.game_session_players
  where session_id = p_session_id;

  -- Treat this as the final pass of the round: hand priority to the judge and
  -- set the pass count so the next pass completes the cycle.
  update public.game_turn_state
  set
    priority_player_id = auth.uid(),
    priority_pass_count = greatest(0, v_player_count - 1)
  where session_id = p_session_id;

  return public.pass_priority(p_session_id);
end;
$$;

grant execute on function public.dev_pass_priority(uuid) to authenticated;
