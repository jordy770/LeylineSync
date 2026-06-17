-- supabase/functions_src/handle_cast_permanent.sql
-- CANONICAL current definition. Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.
--
-- Resolves a permanent spell (creature/artifact/enchantment/Aura) off the stack
-- onto the battlefield. BUGFIX: the move to the battlefield must stamp
-- entered_battlefield_turn_number — without it the card keeps its NULL value and
-- declare_attacker's `coalesce(entered, turn) >= turn` treats every hard-cast
-- creature as permanently summoning-sick. (Tokens/effect-created permanents enter
-- via other paths that already stamp it, which is why only some creatures stuck.)

create or replace function public.handle_cast_permanent(p_session_id uuid, p_stack_item public.game_stack_items)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_next_battlefield_position integer;
  v_turn_number integer;
  v_type_line text;
  v_mana_cost text;
  v_target_card_id uuid;
  v_target_legal boolean;
begin
  if p_stack_item.source_card_id is null then
    raise exception 'Permanent spell has no source card';
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_battlefield_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_stack_item.controller_player_id
    and zone = 'battlefield';

  select turn_number into v_turn_number
  from public.game_turn_state
  where session_id = p_session_id;

  update public.game_cards
  set
    zone = 'battlefield',
    zone_position = v_next_battlefield_position,
    -- Genuine entry (the card is leaving the stack): stamp the turn it entered so
    -- summoning sickness is tracked. Mirrors cast_card_from_hand / move_card_to_zone.
    entered_battlefield_turn_number = coalesce(v_turn_number, entered_battlefield_turn_number, 0),
    controller_player_id = coalesce(controller_player_id, owner_id),
    is_tapped = false,
    damage_marked = 0
  where id = p_stack_item.source_card_id
    and session_id = p_session_id
    and owner_id = p_stack_item.controller_player_id
    and zone = 'stack';

  if not found then
    raise exception 'Permanent spell source card not found on stack';
  end if;

  select cards.type_line, cards.mana_cost
  into v_type_line, v_mana_cost
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_stack_item.source_card_id;

  -- Aura: attach to the stored target if it is still a legal creature without
  -- protection from the Aura's colour; otherwise the Aura goes to the graveyard.
  if coalesce(v_type_line, '') ilike '%aura%' then
    v_target_card_id := nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid;

    v_target_legal := v_target_card_id is not null
      and exists (
        select 1 from public.game_cards gc
        join public.cards c on c.id = gc.card_id
        where gc.id = v_target_card_id
          and gc.session_id = p_session_id
          and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%'
      )
      and not public.card_has_protection_from_any(
        p_session_id, v_target_card_id, public.card_color_set(v_mana_cost)
      );

    if v_target_legal then
      perform public.attach_permanent(p_session_id, p_stack_item.source_card_id, v_target_card_id);
    else
      perform public.put_in_graveyard(p_session_id, p_stack_item.source_card_id);
    end if;
  end if;

  return null;
end;
$function$;
