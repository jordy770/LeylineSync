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

  if v_card_type_line ilike '%instant%' or v_card_type_line ilike '%sorcery%' then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  if v_card_type_line not ilike '%land%' then
    if v_turn_state.active_player_id <> auth.uid() then
      raise exception 'Nonland cards can only be cast by the active player in this first implementation';
    end if;

    if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Nonland cards can only be cast during a main phase';
    end if;

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

grant execute on function public.cast_card_from_hand(uuid, uuid) to authenticated;
