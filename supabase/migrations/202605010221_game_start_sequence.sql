-- Game start sequence: random first player, 7-card opening hands, London
-- mulligan (the missing pre-game flow).
--   start_game_session (creator-only, every player must have a spawned
--     library): locks the session, randomizes the first player, deals 7 to
--     everyone, marks every opening hand undecided; in a TWO-player game flags
--     skip_next_draw (CR 103.8a — the starting player skips their first draw
--     step; multiplayer draws normally).
--   mulligan_hand: hand -> library, reshuffle, draw 7 again (London).
--   keep_opening_hand(bottom_ids): exactly N = mulligans cards from hand to the
--     library bottom, then the hand is kept.
--   advance_step's draw branch consumes skip_next_draw instead of drawing.
-- opening_hand_kept defaults TRUE so pre-existing/legacy sessions (started
-- before this migration) are never blocked by the new flow.

alter table public.game_session_players
  add column if not exists mulligans integer not null default 0,
  add column if not exists opening_hand_kept boolean not null default true;

alter table public.game_turn_state
  add column if not exists skip_next_draw boolean not null default false;
-- Generated from supabase/functions_src (start_game_session, mulligan_hand, keep_opening_hand, advance_step) — those files are
-- the canonical current definitions; edit them, not past migrations.

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

create or replace function public.mulligan_hand(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kept boolean;
  v_mulligans integer;
  v_i integer;
  v_card uuid;
  v_pos integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select opening_hand_kept, mulligans into v_kept, v_mulligans
  from public.game_session_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;
  if not found then
    raise exception 'Current user is not a player in this session';
  end if;
  if v_kept then
    raise exception 'You have already kept your opening hand';
  end if;

  -- Hand back into the library…
  update public.game_cards
  set zone = 'library'
  where session_id = p_session_id and owner_id = auth.uid() and zone = 'hand';

  -- …shuffle (reassign every library position randomly)…
  update public.game_cards gc
  set zone_position = shuffled.rn
  from (
    select id, row_number() over (order by random()) - 1 as rn
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'library'
  ) shuffled
  where gc.id = shuffled.id;

  -- …draw seven again (London: always seven; keep bottoms the difference).
  for v_i in 1..7 loop
    select id into v_card
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'library'
    order by zone_position asc, id asc
    limit 1
    for update skip locked;
    exit when v_card is null;

    select coalesce(max(zone_position), -1) + 1 into v_pos
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'hand';

    update public.game_cards
    set zone = 'hand', zone_position = v_pos, is_tapped = false
    where id = v_card;
  end loop;

  update public.game_session_players
  set mulligans = mulligans + 1
  where session_id = p_session_id and player_id = auth.uid();

  return v_mulligans + 1;
end;
$$;
grant execute on function public.mulligan_hand(uuid) to authenticated;

create or replace function public.keep_opening_hand(
  p_session_id uuid,
  p_bottom_card_ids uuid[] default array[]::uuid[]
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kept boolean;
  v_mulligans integer;
  v_bottom uuid[];
  v_card uuid;
  v_pos integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select opening_hand_kept, mulligans into v_kept, v_mulligans
  from public.game_session_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;
  if not found then
    raise exception 'Current user is not a player in this session';
  end if;
  if v_kept then
    raise exception 'You have already kept your opening hand';
  end if;

  v_bottom := coalesce(p_bottom_card_ids, array[]::uuid[]);
  if cardinality(v_bottom) <> v_mulligans then
    raise exception 'Put exactly % card(s) on the bottom of your library (one per mulligan)', v_mulligans;
  end if;
  if (select count(distinct e) from unnest(v_bottom) e) <> cardinality(v_bottom) then
    raise exception 'Each card can only be bottomed once';
  end if;
  if cardinality(v_bottom) > 0 and (
    select count(*) from public.game_cards
    where id = any(v_bottom) and session_id = p_session_id
      and owner_id = auth.uid() and zone = 'hand'
  ) <> cardinality(v_bottom) then
    raise exception 'Bottomed cards must come from your hand';
  end if;

  foreach v_card in array v_bottom loop
    select coalesce(max(zone_position), -1) + 1 into v_pos
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'library';

    update public.game_cards
    set zone = 'library', zone_position = v_pos
    where id = v_card;
  end loop;

  update public.game_session_players
  set opening_hand_kept = true
  where session_id = p_session_id and player_id = auth.uid();

  return true;
end;
$$;
grant execute on function public.keep_opening_hand(uuid, uuid[]) to authenticated;

create or replace function public.advance_step(p_session_id uuid)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_required_player_id uuid;
  v_next_active_player_id uuid;
  v_next_priority_player_id uuid;
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_next_lands_played_this_turn integer;
  v_drawn_card_id uuid;
  v_next_hand_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot advance a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_required_player_id := coalesce(v_current_state.priority_player_id, v_current_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can advance the step';
  end if;

  perform public.clear_mana_pool_for_step(
    p_session_id,
    v_current_state.phase,
    v_current_state.step
  );

  perform public.expire_continuous_effects_for_step(
    p_session_id,
    v_current_state.turn_number,
    v_current_state.phase,
    v_current_state.step
  );

  v_next_active_player_id := v_current_state.active_player_id;
  v_next_priority_player_id := v_current_state.active_player_id;
  v_next_turn_number := v_current_state.turn_number;
  v_next_lands_played_this_turn := coalesce(v_current_state.lands_played_this_turn, 0);
  v_next_phase := v_current_state.phase;
  v_next_step := v_current_state.step;

  case v_current_state.step
    when 'untap' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set is_tapped = false
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true;

      v_next_phase := 'beginning';
      v_next_step := 'upkeep';
    when 'upkeep' then
      v_next_phase := 'beginning';
      v_next_step := 'draw';
    when 'draw' then
      if coalesce(v_current_state.skip_next_draw, false) then
        -- CR 103.8a (mig 221): in a TWO-player game the starting player skips
        -- the draw step of their first turn. start_game_session sets the flag;
        -- consume it instead of drawing.
        update public.game_turn_state
        set skip_next_draw = false
        where session_id = p_session_id;
      else
        select coalesce(max(zone_position), -1) + 1
        into v_next_hand_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id
          and zone = 'hand';

        select id
        into v_drawn_card_id
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id
          and zone = 'library'
        order by zone_position asc, id asc
        limit 1
        for update skip locked;

        if v_drawn_card_id is null then
          raise exception 'Library is empty';
        end if;

        update public.game_cards
        set
          zone = 'hand',
          zone_position = v_next_hand_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_drawn_card_id;
      end if;

      v_next_phase := 'main_1';
      v_next_step := 'precombat_main';
    when 'precombat_main' then
      v_next_phase := 'combat';
      v_next_step := 'beginning_of_combat';
    when 'beginning_of_combat' then
      v_next_phase := 'combat';
      v_next_step := 'declare_attackers';
    when 'declare_attackers' then
      v_next_phase := 'combat';
      v_next_step := 'declare_blockers';

      select defending_player_id
      into v_next_priority_player_id
      from public.game_combat_assignments
      where session_id = p_session_id
        and turn_number = v_current_state.turn_number
        and blocker_card_id is null
      order by created_at
      limit 1;

      v_next_priority_player_id := coalesce(v_next_priority_player_id, v_current_state.active_player_id);
    when 'declare_blockers' then
      -- Menace: a blocked attacker with menace must have two or more blockers.
      -- Checked here (block declaration is finished) — a lone blocker is illegal.
      -- Blockers live one-row-per-blocker in game_combat_blockers.
      if exists (
        select 1
        from public.game_combat_blockers cb
        where cb.session_id = p_session_id
          and cb.turn_number = v_current_state.turn_number
          and public.card_has_menace(p_session_id, cb.attacker_card_id)
        group by cb.attacker_card_id
        having count(*) = 1
      ) then
        raise exception 'A creature with menace must be blocked by two or more creatures';
      end if;

      v_next_priority_player_id := v_current_state.active_player_id;
      v_next_phase := 'combat';
      v_next_step := 'combat_damage';
    when 'combat_damage' then
      v_next_phase := 'combat';
      v_next_step := 'end_of_combat';
    when 'end_of_combat' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      v_next_phase := 'main_2';
      v_next_step := 'postcombat_main';
    when 'postcombat_main' then
      v_next_phase := 'ending';
      v_next_step := 'end';
    when 'end' then
      v_next_phase := 'ending';
      v_next_step := 'cleanup';
    when 'cleanup' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set damage_marked = 0
      where session_id = p_session_id
        and damage_marked <> 0;

      -- Hand the turn to the next LIVING player by seat order (skip eliminated).
      select next_player.player_id
      into v_next_active_player_id
      from public.game_session_players current_player
      join public.game_session_players next_player
        on next_player.session_id = current_player.session_id
       and next_player.seat_number > current_player.seat_number
       and next_player.life_total > 0
      where current_player.session_id = p_session_id
        and current_player.player_id = v_current_state.active_player_id
      order by next_player.seat_number
      limit 1;

      if v_next_active_player_id is null then
        select player_id
        into v_next_active_player_id
        from public.game_session_players
        where session_id = p_session_id
          and life_total > 0
        order by seat_number
        limit 1;
      end if;

      if v_next_active_player_id is null then
        raise exception 'No players found for game session';
      end if;

      v_next_priority_player_id := v_next_active_player_id;
      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_lands_played_this_turn := 0;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    active_player_id = v_next_active_player_id,
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    lands_played_this_turn = v_next_lands_played_this_turn,
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;
grant execute on function public.advance_step(uuid) to authenticated;
