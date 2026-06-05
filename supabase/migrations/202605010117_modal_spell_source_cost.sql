-- Near-term authoring — make modal spells PLAYABLE from a hand card. The engine
-- already resolves modal spells (mig 088/091: cast_modal_spell + choose_mode
-- decision + apply_modal_spell), but cast_modal_spell never handled the SOURCE
-- card: it didn't pay the card's mana cost nor move it to the graveyard, so a
-- hand-cast modal would be free and stay in hand. This reproduces cast_modal_spell
-- (mig 088) with the same source-card handling cast_spell_effect uses (mig 109):
-- timing + sorcery guards, pay_mana_cost when cast from hand, and the cast-time
-- move to the graveyard for an instant/sorcery. The modes/choose/decision logic is
-- verbatim. (IDE T-SQL false-positives on $$ bodies — ignore.)

create or replace function public.cast_modal_spell(
  p_session_id uuid,
  p_modes jsonb,
  p_choose integer default 1,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_session_status text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if jsonb_typeof(p_modes) <> 'array' or jsonb_array_length(p_modes) < 1 then
    raise exception 'Modal spell needs at least one mode';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
      into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- Timing: sorceries main-phase only, empty stack, active player; otherwise
  -- instant. A sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  if v_timing = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;
    select count(*) into v_pending
    from public.game_stack_items
    where session_id = p_session_id and status = 'pending';
    if v_pending > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  -- Cast from hand: pay the card's mana cost. No-op when sourceless or no mana_cost
  -- (the free-cast test fixtures).
  if p_source_card_id is not null and v_source_zone = 'hand'
    and v_source_mana_cost is not null and btrim(v_source_mana_cost) <> ''
  then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, null);
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'modal_spell',
    jsonb_build_object('modes', p_modes, 'choose', greatest(1, p_choose), 'timing', v_timing),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  insert into public.game_pending_decisions (
    session_id, deciding_player_id, source_stack_item_id, decision_type,
    prompt, options, min_choices, max_choices
  )
  values (
    p_session_id,
    auth.uid(),
    v_stack.id,
    'choose_mode',
    'Choose ' || greatest(1, p_choose) || ' mode(s)',
    p_modes,
    greatest(1, p_choose),
    greatest(1, p_choose)
  );

  -- Non-permanent spell: move the card from hand to the graveyard on cast.
  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (v_source_type_line ilike '%instant%' or v_source_type_line ilike '%sorcery%')
  then
    select coalesce(max(zone_position), -1) + 1 into v_next_graveyard
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';

    update public.game_cards
    set zone = 'graveyard', zone_position = v_next_graveyard, is_tapped = false, damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack;
end;
$$;

grant execute on function public.cast_modal_spell(uuid, jsonb, integer, uuid) to authenticated;
