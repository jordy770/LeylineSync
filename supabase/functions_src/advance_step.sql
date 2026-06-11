-- supabase/functions_src/advance_step.sql
-- CANONICAL current definition (seeded from 202605010194_menace_enforcement.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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

  -- Impulse play windows (mig 230, Atsushi: "until the end of your next turn").
  -- A play_from_exile permission survives the turn it was created in and expires
  -- when its owner leaves the end step of a LATER turn (their next turn).
  if v_current_state.step = 'end' then
    delete from public.game_continuous_effects ce
    where ce.session_id = p_session_id
      and ce.effect_type = 'play_from_exile'
      and ce.affected_player_id = v_current_state.active_player_id
      and coalesce((ce.payload ->> 'created_turn')::integer, 0) < v_current_state.turn_number;
  end if;

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

      -- Exert (mig 236, Glorybringer): an exerted creature "won't untap during
      -- your next untap step." Skip untapping it this once, then clear the marker
      -- so it untaps normally next time.
      update public.game_cards
      set is_tapped = false
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true
        and coalesce((counters ->> 'exerted')::integer, 0) = 0;

      update public.game_cards
      set counters = counters - 'exerted'
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and counters ? 'exerted';

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
