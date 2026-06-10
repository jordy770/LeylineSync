-- supabase/functions_src/put_in_graveyard.sql
-- CANONICAL current definition (seeded from 202605010193_creatures_died_this_turn.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
  v_turn integer;
  v_next_graveyard_position integer;
  v_had_counters integer;
  v_undying boolean := false;
  v_next_bf_position integer;
begin
  select g.owner_id, coalesce(g.controller_player_id, g.owner_id), (c.type_line ilike '%creature%'),
         coalesce(g.plus_one_counters, 0)
  into v_owner_id, v_controller_id, v_is_creature, v_had_counters
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

  -- Tally "creatures that died under your control this turn" (turn-stamped: the
  -- count belongs to the stored turn, so it reads as 0 once the turn changes).
  if v_is_creature and v_controller_id is not null then
    select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
    update public.game_session_players
    set turn_creatures_died = case when turn_creatures_died_turn = coalesce(v_turn, 0)
                                   then turn_creatures_died + 1 else 1 end,
        turn_creatures_died_turn = coalesce(v_turn, 0)
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
