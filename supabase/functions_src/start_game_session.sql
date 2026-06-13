-- supabase/functions_src/start_game_session.sql
-- CANONICAL current definition (created in mig 221).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

-- The pre-game start sequence (mig 221): the session creator presses "Start
-- game" once every player has spawned a deck. In one transaction:
--   1. lock the session (status open -> locked);
--   2. pick a RANDOM first player (active + priority, turn 1, untap);
--      in a TWO-player game flag skip_next_draw (CR 103.8a — the starting
--      player skips their first draw step; multiplayer games don't skip);
--   3. deal every player a 7-card opening hand off the top of their library;
--   4. mark every player's opening hand as undecided (opening_hand_kept =
--      false) — mulligan_hand / keep_opening_hand finish the sequence.
create or replace function public.start_game_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.game_sessions;
  v_player_count integer;
  v_missing integer;
  v_first uuid;
  v_player uuid;
  v_i integer;
  v_card uuid;
  v_pos integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_session
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session.created_by is distinct from auth.uid() then
    raise exception 'Only the session creator can start the game';
  end if;
  if v_session.status <> 'open' then
    raise exception 'Game already started (status: %)', v_session.status;
  end if;

  select count(*) into v_player_count
  from public.game_session_players
  where session_id = p_session_id;

  -- Every player needs a spawned library (7-card hands come off the top).
  select count(*) into v_missing
  from public.game_session_players sp
  where sp.session_id = p_session_id
    and not exists (
      select 1 from public.game_cards gc
      where gc.session_id = p_session_id and gc.owner_id = sp.player_id and gc.zone = 'library'
    );
  if v_missing > 0 then
    raise exception '% player(s) have no deck spawned yet', v_missing;
  end if;

  update public.game_sessions set status = 'locked' where id = p_session_id;

  -- Random first player.
  select player_id into v_first
  from public.game_session_players
  where session_id = p_session_id
  order by random()
  limit 1;

  insert into public.game_turn_state (
    session_id, active_player_id, priority_player_id, turn_number, phase, step, skip_next_draw
  )
  values (p_session_id, v_first, v_first, 1, 'beginning', 'untap', v_player_count = 2)
  on conflict (session_id) do update
  set active_player_id = excluded.active_player_id,
      priority_player_id = excluded.priority_player_id,
      turn_number = 1,
      phase = 'beginning',
      step = 'untap',
      skip_next_draw = excluded.skip_next_draw;

  -- Deal 7 to everyone; opening hands start undecided.
  for v_player in
    select player_id from public.game_session_players
    where session_id = p_session_id order by seat_number
  loop
    for v_i in 1..7 loop
      select id into v_card
      from public.game_cards
      where session_id = p_session_id and owner_id = v_player and zone = 'library'
      order by zone_position asc, id asc
      limit 1
      for update skip locked;
      exit when v_card is null;

      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards
      where session_id = p_session_id and owner_id = v_player and zone = 'hand';

      update public.game_cards
      set zone = 'hand', zone_position = v_pos, is_tapped = false
      where id = v_card;
    end loop;
  end loop;

  update public.game_session_players
  set mulligans = 0, opening_hand_kept = false
  where session_id = p_session_id;

  return jsonb_build_object('first_player_id', v_first, 'players', v_player_count);
end;
$$;
grant execute on function public.start_game_session(uuid) to authenticated;
