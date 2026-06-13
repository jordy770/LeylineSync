-- Cycling — "Cycling {cost}: Discard this card, draw a card." A from-hand
-- ability authored as a top-level `cycling` cost string (mirrors flashback).
-- New cycle_card RPC pays the cost, discards the card, and draws one. Any
-- priority. Sheltered Thicket, Bountiful Landscape, Migration Path.

create or replace function public.cycle_card(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_cycling_cost text;
  v_next_gy integer;
  v_next_hand integer;
  v_drawn uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select * into v_turn_state from public.game_turn_state
  where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;
  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cycle a card';
  end if;

  select * into v_card from public.game_cards
  where id = p_game_card_id and session_id = p_session_id
    and owner_id = auth.uid() and zone = 'hand'
  for update;
  if not found then
    raise exception 'Card not found in your hand';
  end if;

  v_cycling_cost := public.effective_script(p_session_id, p_game_card_id) ->> 'cycling';
  if v_cycling_cost is null then
    raise exception 'This card has no cycling ability';
  end if;

  -- Pay the cycling cost (may be empty for a 0-cost cycle).
  if btrim(v_cycling_cost) <> '' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_cycling_cost, p_generic_payment);
  end if;

  -- Discard this card (hand -> graveyard).
  select coalesce(max(zone_position), -1) + 1 into v_next_gy
  from public.game_cards
  where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';
  update public.game_cards
  set zone = 'graveyard', zone_position = v_next_gy, is_tapped = false
  where id = p_game_card_id;

  -- Draw a card.
  select id into v_drawn
  from public.game_cards
  where session_id = p_session_id and owner_id = auth.uid() and zone = 'library'
  order by zone_position asc, id asc
  limit 1 for update skip locked;

  if v_drawn is not null then
    select coalesce(max(zone_position), -1) + 1 into v_next_hand
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'hand';
    update public.game_cards
    set zone = 'hand', zone_position = v_next_hand, is_tapped = false
    where id = v_drawn;
  end if;

  return v_drawn;
end;
$$;
grant execute on function public.cycle_card(uuid, uuid, jsonb) to authenticated;
