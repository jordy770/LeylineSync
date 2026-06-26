-- supabase/functions_src/create_copy_token.sql
-- CANONICAL current definition (new in mig 239, copy primitive).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

-- Create a token that's a copy of an existing game card (any zone: battlefield
-- permanent for Will of the Temur, a stack/cast card for Reflections of
-- Littjara's spell copy). The copy points at the SAME catalog row (card_id), so
-- name, type line, P/T and script all come along; copied_script carries over so
-- a copy of a copy keeps the copied values. game_cards.is_token marks it a
-- token even though the catalog row isn't one (cease/nontoken consumers check
-- both flags).
--
-- p_except ({power, toughness, keywords:[…]}) models "except it's a 4/4 … with
-- flying": a set_pt base-P/T override + keyword rows tied to the copy itself,
-- NOT script-flagged so register rebuilds keep them. Added TYPES ("a Dragon in
-- addition to its other types") are not modelled — type_line stays the copied
-- card's.
create or replace function public.create_copy_token(
  p_session_id uuid,
  p_recipient uuid,
  p_copied_game_card_id uuid,
  p_except jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.game_cards;
  v_turn integer;
  v_pos integer;
  v_new uuid;
  v_kw text;
begin
  select * into v_src
  from public.game_cards
  where id = p_copied_game_card_id and session_id = p_session_id;
  if not found or p_recipient is null then
    return null;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards
  where session_id = p_session_id and owner_id = p_recipient and zone = 'battlefield';

  insert into public.game_cards (
    session_id, card_id, owner_id, controller_player_id,
    zone, zone_position, is_tapped, damage_marked,
    position_x, position_y, entered_battlefield_turn_number,
    copied_script, is_token
  )
  values (
    p_session_id, v_src.card_id, p_recipient, p_recipient,
    'battlefield', v_pos, false, 0, 0, 0, coalesce(v_turn, 0),
    v_src.copied_script, true
  )
  returning id into v_new;

  perform public.register_card_continuous_effects(p_session_id, v_new);

  if p_except ? 'power' or p_except ? 'toughness' then
    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
    values (
      p_session_id, v_new, v_new, 'set_pt',
      jsonb_build_object(
        'power', coalesce((p_except ->> 'power')::integer, 0),
        'toughness', coalesce((p_except ->> 'toughness')::integer, 0)),
      'battlefield');
  end if;

  for v_kw in
    select lower(value) from jsonb_array_elements_text(coalesce(p_except -> 'keywords', '[]'::jsonb))
  loop
    if v_kw in ('flying', 'haste', 'trample', 'vigilance', 'first_strike',
                'double_strike', 'reach', 'deathtouch', 'indestructible') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
      values (p_session_id, v_new, v_new, v_kw, '{}'::jsonb, 'battlefield');
    end if;
  end loop;

  -- "Sacrifice/exile it at the beginning of the next end step" (Electroduplicate /
  -- Flameshadow Conjuring, mig 347): mark the copy for end-step cleanup; advance_step
  -- removes it. A token leaving the battlefield ceases to exist either way.
  if coalesce((p_except ->> 'cleanup_at_end_step')::boolean, false) then
    update public.game_cards
    set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('cleanup_at_end_step', coalesce(v_turn, 0)::text)
    where id = v_new and session_id = p_session_id;
  end if;

  return v_new;
end;
$$;
grant execute on function public.create_copy_token(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.create_copy_token(uuid, uuid, uuid, jsonb) to service_role;
