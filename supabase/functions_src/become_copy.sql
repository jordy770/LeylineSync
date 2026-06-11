-- supabase/functions_src/become_copy.sql
-- CANONICAL current definition (new in mig 240, become-copy).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

-- An EXISTING card becomes a copy of another game card: its card_id is pointed
-- at the copied card's catalog row (name/type/P/T/script follow), copied_script
-- carries over (copy of a copy), and copy_original_card_id remembers what to
-- revert to. Reverts happen in two places:
--   • leaving the battlefield — revert_copy_before_leave (BEFORE UPDATE
--     trigger), so the graveyard/hand/exile card is the original again;
--   • until-end-of-turn copies (Sarkhan, Soul Aflame) — advance_step reverts
--     at the end step via copy_revert_at_turn.
-- p_except keywords are granted as plain (unflagged) effect rows on the card,
-- so they survive intermediate re-registers; BOTH revert paths delete every
-- row the card sources before re-registering, which clears them.
-- p_fire_etb fires the NEW script's enters-the-battlefield triggers (Frostkite
-- "enters as a copy" — the copied card's ETB happens in real rules). Watcher
-- broadcasts are NOT re-fired (the physical entry already broadcast once).
create or replace function public.become_copy(
  p_session_id uuid,
  p_card_id uuid,
  p_copied_game_card_id uuid,
  p_except jsonb default null,
  p_until_eot boolean default false,
  p_fire_etb boolean default false
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_copied public.game_cards;
  v_turn integer;
  v_kw text;
begin
  select * into v_copied
  from public.game_cards
  where id = p_copied_game_card_id and session_id = p_session_id;
  if not found or p_card_id is null or p_card_id = p_copied_game_card_id then
    return false;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  update public.game_cards
  set card_id = v_copied.card_id,
      copied_script = v_copied.copied_script,
      -- Keep the FIRST original through chained copies.
      copy_original_card_id = coalesce(copy_original_card_id, card_id),
      copy_revert_at_turn = case when p_until_eot then coalesce(v_turn, 0)
                                 else copy_revert_at_turn end
  where id = p_card_id and session_id = p_session_id;

  perform public.register_card_continuous_effects(p_session_id, p_card_id);

  if p_except ? 'power' or p_except ? 'toughness' then
    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
    values (
      p_session_id, p_card_id, p_card_id, 'set_pt',
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
      values (p_session_id, p_card_id, p_card_id, v_kw, '{}'::jsonb, 'battlefield');
    end if;
  end loop;

  if p_fire_etb then
    perform public.fire_card_triggers(
      p_session_id, p_card_id, array['enters_the_battlefield', 'etb', 'enters']);
  end if;

  return true;
end;
$$;
grant execute on function public.become_copy(uuid, uuid, uuid, jsonb, boolean, boolean) to authenticated;
grant execute on function public.become_copy(uuid, uuid, uuid, jsonb, boolean, boolean) to service_role;
