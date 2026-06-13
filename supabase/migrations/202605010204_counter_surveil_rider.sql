-- Sinister Sabotage — "Counter target spell. Surveil 1." A `surveil` rider on
-- the `counter` action, read by handle_counter_spell from the counter spell's
-- own script (mirrors Undermine's controller_loses_life, mig 190) and enqueued
-- as a triggered ability for the counter's caster — the trigger machinery parks
-- the surveil decision. Applies even when the target can't be countered.
-- Generated from supabase/functions_src (handle_counter_spell) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
  v_life_loss integer := 0;
  v_surveil integer := 0;
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

    -- Life-loss rider (Undermine): the countered spell's controller loses N life.
    -- The amount is on the counter spell's own `counter` action; it applies even
    -- when the target can't be countered (the life loss is a separate instruction).
    if p_stack_item.source_card_id is not null then
      select coalesce(max((act ->> 'controller_loses_life')::integer), 0)
      into v_life_loss
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      cross join lateral jsonb_array_elements(coalesce(c.script -> 'spell_effect' -> 'actions', '[]'::jsonb)) as act
      where gc.id = p_stack_item.source_card_id
        and gc.session_id = p_session_id
        and lower(act ->> 'type') = 'counter';
    end if;

    if coalesce(v_life_loss, 0) > 0 and v_target_stack_item.controller_player_id is not null then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_life_loss)
      where session_id = p_session_id
        and player_id = v_target_stack_item.controller_player_id;
      perform public.maybe_finish_game_session(p_session_id);
    end if;

    -- Surveil rider (mig 204, Sinister Sabotage "Counter target spell. Surveil 1"):
    -- read symmetrically from the counter spell's own `counter` action and enqueue
    -- as a triggered ability for the COUNTER's caster — the trigger machinery
    -- parks the surveil decision (the source instant being in the graveyard is
    -- fine; the label/effects ride in the payload). Applies even when the target
    -- can't be countered, like the life-loss rider.
    if p_stack_item.source_card_id is not null then
      select coalesce(max((act ->> 'surveil')::integer), 0)
      into v_surveil
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      cross join lateral jsonb_array_elements(coalesce(c.script -> 'spell_effect' -> 'actions', '[]'::jsonb)) as act
      where gc.id = p_stack_item.source_card_id
        and gc.session_id = p_session_id
        and lower(act ->> 'type') = 'counter';
    end if;

    if coalesce(v_surveil, 0) > 0 and p_stack_item.controller_player_id is not null then
      perform public.enqueue_triggered_ability(
        p_session_id, p_stack_item.controller_player_id, p_stack_item.source_card_id,
        'Surveil ' || v_surveil,
        jsonb_build_array(jsonb_build_object('type', 'surveil', 'amount', v_surveil)));
    end if;
  end if;

  return null;
end;
$$;
