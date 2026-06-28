-- 202605010349_jaxis_copy
-- Jaxis: create_copy_token.except gains a dies_effect that stamps a
-- granted_dies_effect on the copy token ("when this token dies, draw a card").
-- put_in_graveyard now CAPTURES granted_dies_effect payloads before the zone
-- move (a token's cease trigger would otherwise delete them first) and fires
-- them after, so token dies-triggers work too.
-- Generated from supabase/functions_src (create_copy_token, put_in_graveyard) — those files are
-- the canonical current definitions; edit them, not past migrations.

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

  -- "It gains 'When this token dies, <effects>'" (Jaxis, mig 349): grant the copy
  -- a dies-trigger via a granted_dies_effect on itself (put_in_graveyard fires it).
  if jsonb_typeof(p_except -> 'dies_effect') = 'array' then
    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
    ) values (
      p_session_id, v_new, v_new, 'granted_dies_effect',
      jsonb_build_object('effects', p_except -> 'dies_effect'), 'battlefield');
  end if;

  return v_new;
end;
$$;
grant execute on function public.create_copy_token(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.create_copy_token(uuid, uuid, uuid, jsonb) to service_role;

create or replace function public.put_in_graveyard(p_session_id uuid, p_game_card_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_controller_id uuid;
  v_is_creature boolean;
  v_is_token boolean;
  v_turn integer;
  v_next_graveyard_position integer;
  v_had_counters integer;
  v_undying boolean := false;
  v_next_bf_position integer;
  v_rider record;
  v_rider_payloads jsonb := '[]'::jsonb;
begin
  select g.owner_id, coalesce(g.controller_player_id, g.owner_id), (c.type_line ilike '%creature%'),
         -- Token at either level: catalog tokens (cards.is_token) or copy
         -- tokens (game_cards.is_token, mig 239).
         coalesce(c.is_token, false) or coalesce(g.is_token, false), coalesce(g.plus_one_counters, 0)
  into v_owner_id, v_controller_id, v_is_creature, v_is_token, v_had_counters
  from public.game_cards g
  join public.cards c on c.id = g.card_id
  where g.id = p_game_card_id
    and g.session_id = p_session_id
    and g.zone = 'battlefield';

  if not found then
    return false;
  end if;

  -- Undying (mig 219, Geralf's Mindcrusher): "When this creature dies, if it
  -- had no +1/+1 counters on it, return it under its owner's control with a
  -- +1/+1 counter." Captured BEFORE the move (the move resets counters).
  if v_is_creature and v_had_counters = 0 then
    v_undying := coalesce(
      (public.effective_script(p_session_id, p_game_card_id) ->> 'undying')::boolean, false);
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_graveyard_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = v_owner_id
    and zone = 'graveyard';

  -- Granted dies-trigger (Clavileño / Jaxis / Feign Death, migs 344-349): a
  -- creature given "when this dies, <effects>" carries a granted_dies_effect.
  -- CAPTURE the payloads BEFORE the zone move — a TOKEN's cease trigger fires on
  -- that move and would delete the rows (and the token) first. Consume them too.
  if v_is_creature then
    select coalesce(jsonb_agg(payload), '[]'::jsonb) into v_rider_payloads
    from public.game_continuous_effects
    where session_id = p_session_id and effect_type = 'granted_dies_effect'
      and affected_card_id = p_game_card_id;
    delete from public.game_continuous_effects
    where session_id = p_session_id and effect_type = 'granted_dies_effect'
      and affected_card_id = p_game_card_id;
  end if;

  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = v_next_graveyard_position,
    controller_player_id = owner_id,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  where id = p_game_card_id;

  -- Fire the captured dies-triggers AFTER the move so a return_self_to_battlefield
  -- effect finds the card in its graveyard. (For tokens the card has already
  -- ceased, but the effects — draw, make a token — are player-level.)
  for v_rider in select value as payload from jsonb_array_elements(v_rider_payloads)
  loop
    perform public.apply_triggered_ability_effects(
      p_session_id, v_controller_id, p_game_card_id,
      coalesce(v_rider.payload -> 'effects', '[]'::jsonb));
  end loop;

  -- Tally "creatures that died under your control this turn" (turn-stamped: the
  -- count belongs to the stored turn, so it reads as 0 once the turn changes).
  if v_is_creature and v_controller_id is not null then
    select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
    update public.game_session_players
    set turn_creatures_died = case when turn_creatures_died_turn = coalesce(v_turn, 0)
                                   then turn_creatures_died + 1 else 1 end,
        turn_creatures_died_turn = coalesce(v_turn, 0),
        -- Nontoken-only tally (Gadrak): summed game-wide by resolve_count_amount.
        turn_nontoken_creatures_died = case
          when not v_is_token then
            case when turn_nontoken_creatures_died_turn = coalesce(v_turn, 0)
                 then turn_nontoken_creatures_died + 1 else 1 end
          when turn_nontoken_creatures_died_turn = coalesce(v_turn, 0)
            then turn_nontoken_creatures_died else 0 end,
        turn_nontoken_creatures_died_turn = case
          when not v_is_token then coalesce(v_turn, 0)
          else turn_nontoken_creatures_died_turn end
    where session_id = p_session_id and player_id = v_controller_id;
  end if;

  -- Undying return: AFTER the graveyard move (so dies triggers and the death
  -- tally fired normally), bring the card back under its OWNER's control with
  -- one +1/+1 counter. It then has a counter, so dying again stays dead.
  if v_undying then
    select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
    select coalesce(max(zone_position), -1) + 1
    into v_next_bf_position
    from public.game_cards
    where session_id = p_session_id and owner_id = v_owner_id and zone = 'battlefield';

    update public.game_cards
    set zone = 'battlefield',
        zone_position = v_next_bf_position,
        controller_player_id = owner_id,
        is_tapped = false,
        plus_one_counters = 1,
        entered_battlefield_turn_number = coalesce(v_turn, 0)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  return true;
end;
$$;
