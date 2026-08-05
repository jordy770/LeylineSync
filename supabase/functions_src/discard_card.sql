-- supabase/functions_src/discard_card.sql
-- CANONICAL current definition (new in 202605010434_madness.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Discard ONE card, honoring madness (CR 702.35): a HAND card whose script
-- carries a `madness` cost is discarded INTO EXILE instead, with a stack-less
-- madness_cast pending decision parked for its owner (pass_priority freezes on
-- pending decisions, so play halts until they choose). submit_decision's
-- madness_cast branch then casts it from exile for the madness cost or drops
-- it into the graveyard. Every other card takes the normal hand→graveyard
-- move. All discard paths (chooser picks, random/bulk discards) route through
-- this helper so madness can't be dodged by the discard style.

create or replace function public.discard_card(
  p_session_id uuid,
  p_game_card_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_zone text;
  v_name text;
  v_madness text;
  v_pos integer;
begin
  select gc.owner_id, gc.zone, c.name,
         nullif(public.effective_script(p_session_id, gc.id) ->> 'madness', '')
  into v_owner, v_zone, v_name, v_madness
  from public.game_cards gc
  join public.cards c on c.id = gc.card_id
  where gc.id = p_game_card_id and gc.session_id = p_session_id;

  if not found then
    return;
  end if;

  if v_madness is not null and v_zone = 'hand' then
    select coalesce(max(zone_position), -1) + 1 into v_pos
    from public.game_cards
    where session_id = p_session_id and owner_id = v_owner and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_pos, is_tapped = false, damage_marked = 0
    where id = p_game_card_id and session_id = p_session_id;

    insert into public.game_pending_decisions (
      session_id, deciding_player_id, source_stack_item_id, decision_type,
      prompt, options, min_choices, max_choices, params)
    values (
      p_session_id, v_owner, null, 'madness_cast',
      'Madness — cast ' || v_name || ' for ' || v_madness || '?',
      jsonb_build_array(jsonb_build_object('game_card_id', p_game_card_id, 'name', v_name)),
      0, 0,
      jsonb_build_object(
        'game_card_id', p_game_card_id,
        'cost', v_madness,
        'has_x', position('{X}' in v_madness) > 0));
    return;
  end if;

  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards
  where session_id = p_session_id and owner_id = v_owner and zone = 'graveyard';

  update public.game_cards
  set zone = 'graveyard', zone_position = v_pos, is_tapped = false, damage_marked = 0
  where id = p_game_card_id and session_id = p_session_id;
end;
$$;
grant execute on function public.discard_card(uuid, uuid) to authenticated;
grant execute on function public.discard_card(uuid, uuid) to service_role;
