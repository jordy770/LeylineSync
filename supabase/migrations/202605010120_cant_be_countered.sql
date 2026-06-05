-- "Can't be countered": a static spell property authored as a top-level
-- `cant_be_countered: true` on the card's V2 behavior script. Rather than stamp a
-- flag through every cast path (spell_effect / modal / permanent / targeted), we
-- read the targeted spell's SOURCE-CARD behavior at counter-resolution time. When
-- the spell is uncounterable the counter still resolves (and the counterspell
-- itself still goes to the graveyard via its own cast path) — it just fails to
-- cancel the target (rule 701.5e: an unaffected spell is unaffected).
--
-- Reproduces handle_counter_spell from migration 104 verbatim except the added
-- v_cant_be_countered lookup and the guard around the cancellation block.

create or replace function public.handle_counter_spell(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_stack_item public.game_stack_items;
  v_next_graveyard_position integer;
  v_cant_be_countered boolean := false;
begin
  select *
  into v_target_stack_item
  from public.game_stack_items
  where id = nullif(p_stack_item.payload ->> 'target_stack_item_id', '')::uuid
    and session_id = p_session_id
    and status = 'pending'
  for update;

  if found then
    if v_target_stack_item.id = p_stack_item.id then
      raise exception 'A stack item cannot counter itself';
    end if;

    -- Is the targeted spell uncounterable? Read its source card's behavior.
    if v_target_stack_item.source_card_id is not null then
      select coalesce((cards.script ->> 'cant_be_countered')::boolean, false)
      into v_cant_be_countered
      from public.game_cards
      join public.cards on cards.id = game_cards.card_id
      where game_cards.id = v_target_stack_item.source_card_id
        and game_cards.session_id = p_session_id;
    end if;

    if not coalesce(v_cant_be_countered, false) then
      if v_target_stack_item.action_type = 'cast_permanent'
        and v_target_stack_item.source_card_id is not null
      then
        select coalesce(max(zone_position), -1) + 1
        into v_next_graveyard_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'graveyard';

        update public.game_cards
        set
          zone = 'graveyard',
          zone_position = v_next_graveyard_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_target_stack_item.source_card_id
          and session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'stack';
      end if;

      update public.game_stack_items
      set
        status = 'cancelled',
        resolved_at = now()
      where id = v_target_stack_item.id;
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.handle_counter_spell(uuid, public.game_stack_items) from public;
