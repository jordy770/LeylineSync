-- supabase/functions_src/turn_manifest_up.sql
-- CANONICAL current definition (new in mig 251, manifest).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

-- Turn a manifested (face-down) CREATURE card face up by paying its mana
-- cost (any time the controller has priority — no timing gate beyond
-- controller/auth checks). Clears the manifested marker, the blank
-- copied_script, and the 2/2 set_pt row, then re-registers the card's real
-- continuous effects. Turning face up is NOT a zone change: no ETB fires.
create or replace function public.turn_manifest_up(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_type text;
  v_cost text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select gc.* into v_card
  from public.game_cards gc
  where gc.id = p_game_card_id and gc.session_id = p_session_id
    and gc.zone = 'battlefield'
    and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
  for update;
  if not found then
    raise exception 'Card not found on your battlefield';
  end if;
  if not (coalesce(v_card.counters, '{}'::jsonb) ? 'manifested') then
    raise exception 'That card is not manifested';
  end if;

  select c.type_line, c.mana_cost into v_type, v_cost
  from public.cards c where c.id = v_card.card_id;
  if coalesce(v_type, '') not ilike '%creature%' then
    raise exception 'Only a creature card can be turned face up';
  end if;

  if v_cost is not null and btrim(v_cost) <> '' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_cost, p_generic_payment);
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id and source_card_id = p_game_card_id;

  update public.game_cards
  set counters = counters - 'manifested',
      copied_script = null
  where id = p_game_card_id and session_id = p_session_id
  returning * into v_card;

  perform public.register_card_continuous_effects(p_session_id, p_game_card_id);

  return v_card;
end;
$$;
grant execute on function public.turn_manifest_up(uuid, uuid, jsonb) to authenticated;
