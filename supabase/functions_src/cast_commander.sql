-- supabase/functions_src/cast_commander.sql
-- CANONICAL (mig 291): seeded from 202605010136_commander_command_zone.sql
-- (the only prior definition — verified per bug-682). Printed cost now runs
-- through reduced_mana_cost so static discounts reach command-zone casts.

create or replace function public.cast_commander(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn public.game_turn_state;
  v_card public.game_cards;
  v_type_line text;
  v_mana_cost text;
  v_tax integer;
  v_pending integer := 0;
  v_next_stack_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
  if v_turn.active_player_id <> auth.uid() then
    raise exception 'A commander can only be cast by the active player';
  end if;
  if v_turn.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'A commander can only be cast during a main phase';
  end if;

  select count(*) into v_pending
  from public.game_stack_items
  where session_id = p_session_id and status = 'pending';
  if v_pending > 0 then
    raise exception 'A commander can only be cast while the stack is empty';
  end if;

  -- The caster's commander, in their command zone.
  select game_cards.* into v_card
  from public.game_cards
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.is_commander = true
    and game_cards.zone = 'command'
  for update of game_cards;
  if not found then
    raise exception 'Commander not found in your command zone';
  end if;

  select cards.type_line, cards.mana_cost
  into v_type_line, v_mana_cost
  from public.cards where cards.id = v_card.card_id;

  v_tax := 2 * v_card.command_zone_casts;

  -- Pay the printed cost (after static cost reductions — mig 291: Nogi /
  -- Dragonlord's Servant discount command-zone casts too), then the tax
  -- (extra generic). Two calls keep the math simple; both run in this RPC's
  -- transaction, so either failing rolls back. Nuance: the reduction applies
  -- to the printed part only — by strict rules it could also eat commander
  -- tax when the printed generic runs out.
  perform public.pay_mana_cost(p_session_id, auth.uid(),
    public.reduced_mana_cost(p_session_id, auth.uid(), p_game_card_id, v_mana_cost),
    p_generic_payment,
    p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_type_line, ''),
      'is_commander', true));
  if v_tax > 0 then
    perform public.pay_mana_cost(p_session_id, auth.uid(), '{' || v_tax || '}', null,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_type_line, ''),
        'is_commander', true));
  end if;

  -- A cast from the command zone bumps the tax for next time (CR 903.8).
  update public.game_cards
  set command_zone_casts = command_zone_casts + 1,
      zone = 'stack',
      zone_position = 0,
      is_tapped = false,
      damage_marked = 0
  where id = p_game_card_id;

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position
  )
  values (
    p_session_id, auth.uid(), p_game_card_id, 'cast_permanent',
    jsonb_build_object('timing', 'sorcery', 'card_id', v_card.card_id, 'type_line', v_type_line),
    v_next_stack_position
  );

  update public.game_turn_state
  set priority_player_id = active_player_id,
      priority_cycle_started_by = null,
      priority_pass_count = 0
  where session_id = p_session_id;

  select * into v_card from public.game_cards where id = p_game_card_id;
  return v_card;
end;
$$;
grant execute on function public.cast_commander(uuid, uuid, jsonb) to authenticated;
