create or replace function public.is_session_player(
  p_session_id uuid,
  p_player_id uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.game_session_players
    where session_id = p_session_id
      and player_id = p_player_id
  );
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
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_drawn_card_id uuid;
  v_next_hand_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_current_state.active_player_id <> auth.uid() then
    raise exception 'Only the active player can advance the step';
  end if;

  v_next_turn_number := v_current_state.turn_number;
  v_next_phase := v_current_state.phase;
  v_next_step := v_current_state.step;

  case v_current_state.step
    when 'untap' then
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
        is_tapped = false
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
    when 'declare_blockers' then
      v_next_phase := 'combat';
      v_next_step := 'combat_damage';
    when 'combat_damage' then
      v_next_phase := 'combat';
      v_next_step := 'end_of_combat';
    when 'end_of_combat' then
      v_next_phase := 'main_2';
      v_next_step := 'postcombat_main';
    when 'postcombat_main' then
      v_next_phase := 'ending';
      v_next_step := 'end';
    when 'end' then
      v_next_phase := 'ending';
      v_next_step := 'cleanup';
    when 'cleanup' then
      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;

grant execute on function public.is_session_player(uuid, uuid) to authenticated;
grant execute on function public.advance_step(uuid) to authenticated;
