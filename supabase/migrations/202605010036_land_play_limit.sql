alter table public.game_turn_state
add column if not exists lands_played_this_turn integer not null default 0;

alter table public.game_turn_state
drop constraint if exists game_turn_state_lands_played_this_turn_check;

alter table public.game_turn_state
add constraint game_turn_state_lands_played_this_turn_check
check (lands_played_this_turn >= 0);

create or replace function public.cast_card_from_hand(
  p_session_id uuid,
  p_game_card_id uuid
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_card_type_line text;
  v_card_mana_cost text;
  v_pending_stack_count integer := 0;
  v_next_battlefield_position integer;
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
    raise exception 'Cannot cast cards in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast cards';
  end if;

  select game_cards.*
  into v_card
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.zone = 'hand'
  for update of game_cards;

  if not found then
    raise exception 'Card not found in hand or not owned by current user';
  end if;

  select cards.type_line, cards.mana_cost
  into v_card_type_line, v_card_mana_cost
  from public.cards
  where cards.id = v_card.card_id;

  if coalesce(v_card_type_line, '') ilike '%instant%'
    or coalesce(v_card_type_line, '') ilike '%sorcery%'
  then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Cards can only be played by the active player in this first implementation';
  end if;

  if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Cards can only be played during a main phase';
  end if;

  select count(*)
  into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending';

  if v_pending_stack_count > 0 then
    raise exception 'Cards can only be played while the stack is empty';
  end if;

  if coalesce(v_card_type_line, '') ilike '%land%' then
    if coalesce(v_turn_state.lands_played_this_turn, 0) >= 1 then
      raise exception 'You have already played a land this turn';
    end if;

    update public.game_turn_state
    set lands_played_this_turn = lands_played_this_turn + 1
    where session_id = p_session_id;
  else
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_card_mana_cost);
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_battlefield_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'battlefield';

  update public.game_cards
  set
    zone = 'battlefield',
    zone_position = v_next_battlefield_position,
    is_tapped = false,
    damage_marked = 0
  where id = p_game_card_id
  returning * into v_card;

  return v_card;
end;
$$;

create or replace function public.advance_step(
  p_session_id uuid
)
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

      select next_player.player_id
      into v_next_active_player_id
      from public.game_session_players current_player
      join public.game_session_players next_player
        on next_player.session_id = current_player.session_id
       and next_player.seat_number > current_player.seat_number
      where current_player.session_id = p_session_id
        and current_player.player_id = v_current_state.active_player_id
      order by next_player.seat_number
      limit 1;

      if v_next_active_player_id is null then
        select player_id
        into v_next_active_player_id
        from public.game_session_players
        where session_id = p_session_id
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

grant execute on function public.cast_card_from_hand(uuid, uuid) to authenticated;
grant execute on function public.advance_step(uuid) to authenticated;
