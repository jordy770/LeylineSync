-- supabase/functions_src/cycle_card.sql
-- CANONICAL current definition (created in mig 228).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

-- Cycling (mig 228): "Cycling {cost} — {cost}, Discard this card: Draw a card."
-- A from-hand activated ability authored as a top-level `cycling` cost string
-- (like flashback). Pay the cost, put the card into its owner's graveyard, draw
-- one. Any-priority (instant speed).
--
-- Basic landcycling (mig 427): top-level `landcycling` cost string. Same
-- pay-and-discard flow, but instead of drawing it parks a stack-less
-- `search_library` decision (options = basic lands in the owner's library,
-- reveal, to hand; the existing submit branch shuffles). Returns the decision
-- id in that mode, the drawn card id in plain-cycling mode.
-- NOTE signature change 3→4 args: the migration must DROP the old
-- (uuid, uuid, jsonb) overload first.
create or replace function public.cycle_card(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null,
  p_landcycle boolean default false
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

  if p_landcycle then
    v_cycling_cost := public.effective_script(p_session_id, p_game_card_id) ->> 'landcycling';
    if v_cycling_cost is null then
      raise exception 'This card has no landcycling ability';
    end if;
  else
    v_cycling_cost := public.effective_script(p_session_id, p_game_card_id) ->> 'cycling';
    if v_cycling_cost is null then
      raise exception 'This card has no cycling ability';
    end if;
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

  -- Basic landcycling: park a stack-less search_library decision instead of
  -- drawing. Options = basic land cards in the owner's library; the existing
  -- submit_decision search_library branch shuffles and places the pick. An
  -- empty library of basics still parks (min 0) so the shuffle always happens.
  if p_landcycle then
    insert into public.game_pending_decisions
      (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
    values (
      p_session_id, auth.uid(), null, 'search_library',
      'Search your library for a basic land card',
      (select coalesce(jsonb_agg(jsonb_build_object('game_card_id', lib.id, 'name', c.name) order by c.name, lib.id), '[]'::jsonb)
       from public.game_cards lib
       join public.cards c on c.id = lib.card_id
       where lib.session_id = p_session_id and lib.owner_id = auth.uid() and lib.zone = 'library'
         and c.type_line ilike '%basic%' and c.type_line ilike '%land%'),
      0, 1,
      jsonb_build_object('to', 'hand', 'tapped', false, 'reveal', true))
    returning id into v_drawn;
    return v_drawn;
  end if;

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
    -- Cycling's replacement draw is a real draw (mig 401): tally + broadcast.
    perform public.fire_watcher_triggers(
      p_session_id, v_drawn, auth.uid(), 'card_drawn',
      jsonb_build_object('draw_number', public.note_card_drawn(p_session_id, auth.uid())));
  end if;

  return v_drawn;
end;
$$;
grant execute on function public.cycle_card(uuid, uuid, jsonb, boolean) to authenticated;
