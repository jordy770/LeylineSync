-- F3 — Protection (DEBT), slice 4b: EQUIPMENT + the equip ability.
--
-- Equipment (Artifact — Equipment) is cast as an ordinary permanent (no target) and
-- enters unattached. An `equip {cost}` activated ability — sorcery speed — attaches
-- it to a creature YOU control, moving it from any prior host. The equipment's
-- continuous effect (authored affected:'attached', like an Aura's) lands on the
-- equipped creature. When the equipped creature leaves, the equipment falls off but
-- stays on the battlefield (the cleanup trigger from mig 134 already handles this).
--
-- E gate: equipment can't be attached to a creature with protection from the
-- equipment's colour (its mana-cost colours).
--
-- Reuses attach_permanent + the attachment substrate from mig 134. The equip cost
-- (optional generic/coloured mana) is read from the equipment script's `equip_cost`.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

create or replace function public.equip(
  p_session_id uuid,
  p_equipment_card_id uuid,
  p_target_card_id uuid,
  p_generic_payment jsonb default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_state public.game_turn_state;
  v_session_status text;
  v_equipment public.game_cards;
  v_equip_type_line text;
  v_equip_mana_cost text;
  v_equip_cost text;
  v_pending_stack_count integer := 0;
  v_result public.game_cards;
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
    raise exception 'Cannot equip in a finished game session';
  end if;

  select * into v_turn_state
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;

  -- Equip is a sorcery-speed activated ability: your turn, a main phase, empty stack.
  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can equip';
  end if;
  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Equip can only be used by the active player';
  end if;
  if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Equip can only be used during a main phase';
  end if;

  select count(*) into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id and status = 'pending';
  if v_pending_stack_count > 0 then
    raise exception 'Equip can only be used while the stack is empty';
  end if;

  -- The equipment: a battlefield Equipment you control.
  select game_cards.* into v_equipment
  from public.game_cards
  where game_cards.id = p_equipment_card_id
    and game_cards.session_id = p_session_id
    and game_cards.zone = 'battlefield'
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
  for update of game_cards;
  if not found then
    raise exception 'Equipment not found on the battlefield under your control';
  end if;

  select cards.type_line, cards.mana_cost
  into v_equip_type_line, v_equip_mana_cost
  from public.cards where cards.id = v_equipment.card_id;

  if coalesce(v_equip_type_line, '') not ilike '%equipment%' then
    raise exception 'That permanent is not an Equipment';
  end if;

  -- The target: a creature YOU control.
  if not public.creature_target_controller_ok(p_session_id, p_target_card_id, auth.uid(), 'you') then
    raise exception 'Equip can only target a creature you control';
  end if;

  -- E gate: can't attach to a creature with protection from the equipment's colour.
  if public.card_has_protection_from_any(
       p_session_id, p_target_card_id, public.card_color_set(v_equip_mana_cost)
     ) then
    raise exception 'Target creature has protection from this Equipment''s colour and can''t be equipped by it';
  end if;

  -- Pay the equip cost (optional mana string in the equipment's script).
  v_equip_cost := nullif(btrim(coalesce(
    public.effective_script(p_session_id, p_equipment_card_id) ->> 'equip_cost', ''
  )), '');
  if v_equip_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_equip_cost, p_generic_payment);
  end if;

  perform public.attach_permanent(p_session_id, p_equipment_card_id, p_target_card_id);

  select * into v_result from public.game_cards where id = p_equipment_card_id;
  return v_result;
end;
$$;

grant execute on function public.equip(uuid, uuid, uuid, jsonb) to authenticated;
